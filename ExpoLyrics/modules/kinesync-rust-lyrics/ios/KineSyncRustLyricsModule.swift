import ExpoModulesCore
import QuartzCore
import UIKit
import KineSyncLyrics

public final class KineSyncRustLyricsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KineSyncRustLyrics")
    Function("abiVersion") { kr_abi_version() }
    Function("monotonicMs") { CACurrentMediaTime() * 1000 }
    View(KineSyncRustLyricsView.self) {
      Events("onStatus", "onMetrics")
      Prop("trackJson") { (view: KineSyncRustLyricsView, value: String) in view.setTrack(value) }
      Prop("active") { (view: KineSyncRustLyricsView, value: Bool) in view.setActive(value) }
      AsyncFunction("setAnchor") { (view: KineSyncRustLyricsView, value: String) in view.setAnchor(value) }
    }
  }
}

private struct Anchor: Decodable {
  let generation: UInt64
  let sequence: UInt64
  let positionMs: Double
  let nativeMs: Double
  let playing: Bool
  let rate: Double
}
private struct TrackIdentity: Decodable { let generation: UInt64 }

// Only this serial queue touches a Rust handle. Layer remains strongly retained
// until synchronous retirement has drained submissions and dropped the surface.
private final class RustOwner: @unchecked Sendable {
  private let queue = DispatchQueue(label: "dev.kineticron.rust-lyrics", qos: .userInteractive)
  private let layer: CAMetalLayer
  private let report: ([String: Any]) -> Void
  private var handle: UInt64 = 0
  private var retired = false
  private var visible = false
  private var failed = false
  private var track = ""
  private var currentGeneration: UInt64 = 0
  private var appliedTrack = ""
  private var anchor: Anchor?
  private var size = CGSize.zero
  private var scale: CGFloat = 1
  private var lastMetrics = 0.0

  init(layer: CAMetalLayer, report: @escaping ([String: Any]) -> Void) {
    self.layer = layer
    self.report = report
  }
  private func emit(_ event: [String: Any]) {
    var tagged = event
    tagged["generation"] = currentGeneration
    let snapshot = tagged
    DispatchQueue.main.async { self.report(snapshot) }
  }
  private func failure() {
    var bytes = [CChar](repeating: 0, count: 2048)
    kr_copy_error(&bytes, bytes.count)
    failed = true
    emit(["state": "error", "message": String(cString: bytes)])
  }
  private func applyAnchor() {
    guard handle != 0, let anchor else { return }
    if kr_set_anchor(handle, anchor.generation, anchor.sequence, anchor.positionMs,
                     anchor.nativeMs, CACurrentMediaTime() * 1000, anchor.playing, anchor.rate) < 0 { failure() }
  }
  func update(track: String, anchor: Anchor?, size: CGSize, scale: CGFloat) {
    queue.async {
      guard !self.retired else { return }
      let identity = track.data(using: .utf8).flatMap { try? JSONDecoder().decode(TrackIdentity.self, from: $0) }
      if self.failed {
        guard let identity, identity.generation > self.currentGeneration else { return }
        if self.handle != 0 { _ = kr_destroy(self.handle); self.handle = 0 }
        self.failed = false; self.appliedTrack = ""
      }
      self.track = track
      if let identity { self.currentGeneration = identity.generation }
      if let anchor { self.anchor = anchor }
      guard size.width > 0, size.height > 0 else { return }
      let width = UInt32(min(8192, ceil(size.width * scale)))
      let height = UInt32(min(8192, ceil(size.height * scale)))
      if self.handle == 0 {
        guard kr_abi_version() == 1 else { self.failed = true; self.emit(["state": "error", "message": "Rust ABI mismatch"]); return }
        self.handle = kr_create(Unmanaged.passUnretained(self.layer).toOpaque(), width, height, Float(scale))
        if self.handle == 0 { self.failure(); return }
      } else if self.size != size || self.scale != scale {
        if kr_resize(self.handle, width, height, Float(scale)) < 0 { self.failure(); return }
      }
      self.size = size
      self.scale = scale
      if !track.isEmpty && track != self.appliedTrack {
        let result = track.utf8CString.withUnsafeBytes { buffer in
          kr_set_track(self.handle, buffer.baseAddress!.assumingMemoryBound(to: UInt8.self), buffer.count - 1)
        }
        if result < 0 { self.failure(); return }
        self.appliedTrack = track
        self.emit(["state": "ready", "message": "Rust Metal surface and live track ready"])
      }
      self.applyAnchor()
    }
  }
  func setAnchor(_ value: Anchor) {
    queue.async {
      guard !self.retired, !self.failed else { return }
      self.anchor = value
      self.applyAnchor()
    }
  }
  func setVisible(_ value: Bool) {
    // Main-thread lifecycle barrier. Worker never waits for main-thread callbacks.
    if value { queue.async { self.visible = true } }
    else { queue.sync { self.visible = false } }
  }
  func draw(completion: @escaping (Int32, UInt64) -> Void) {
    queue.async {
      var result: Int32 = 1
      defer {
        let status = result
        let generation = self.currentGeneration
        DispatchQueue.main.async { completion(status, generation) }
      }
      guard self.visible, !self.retired, !self.failed, self.handle != 0 else { return }
      let sampled = CACurrentMediaTime() * 1000
      result = kr_render(self.handle, sampled)
      if result < 0 { self.failure(); return }
      let now = CACurrentMediaTime()
      if result == 0 && now - self.lastMetrics >= 1 {
        self.lastMetrics = now
        var m = KRMetrics()
        if kr_metrics(self.handle, &m) < 0 { self.failure(); return }
        self.emit(["state": "metrics", "frames": m.frames, "generation": m.generation,
                   "sampleNativeMs": sampled, "playing": self.anchor?.playing ?? false, "rate": self.anchor?.rate ?? 1,
                   "positionMs": m.position_ms, "cpuSceneMs": m.cpu_scene_ms,
                   "cpuEncodeMs": m.cpu_encode_ms, "gpuIntervalMs": m.gpu_interval_ms,
                   "waitMs": m.wait_ms, "presentWaitMs": m.present_wait_ms,
                   "layoutMs": m.layout_ms, "width": m.width, "height": m.height,
                   "note": "GPU interval includes submission gaps, excludes final blit. Last-frame samples, not phone performance conclusions."])
      }
    }
  }
  func dispose() {
    queue.sync {
      guard !self.retired else { return }
      self.retired = true
      self.visible = false
      if self.handle != 0 { _ = kr_destroy(self.handle); self.handle = 0 }
    }
  }
}

private final class MetalHost: UIView {
  override class var layerClass: AnyClass { CAMetalLayer.self }
}
@MainActor
private final class DisplayTarget: NSObject {
  weak var view: KineSyncRustLyricsView?
  @objc func tick(_ link: CADisplayLink) { view?.tick(link) }
}

final class KineSyncRustLyricsView: ExpoView {
  let onStatus = EventDispatcher()
  let onMetrics = EventDispatcher()
  private let metal = MetalHost()
  private let target = DisplayTarget()
  private var owner: RustOwner?
  private var link: CADisplayLink?
  private var session: UInt64 = 0
  private var generation: UInt64 = 0
  private var sequence: UInt64 = 0
  private var track = ""
  private var anchor: Anchor?
  private var enabled = true
  private var foreground = UIApplication.shared.applicationState == .active
  private var busy = false
  private var dirty = true
  private var frameRevision: UInt64 = 0
  private var retryCount = 0
  private var retryBlocked = false
  private var retryWork: DispatchWorkItem?
  private static let retryDelays: [TimeInterval] = [0.1, 0.2, 0.4, 0.8]
  private var displayedGeneration: UInt64 = 0
  private var surfaceWaiting = false
  private var failed = false
  private var skipped: UInt64 = 0
  private var tickMs = 0.0
  private var intervalMs = 0.0
  private var previousTick = 0.0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    metal.backgroundColor = .clear
    metal.isOpaque = false
    (metal.layer as? CAMetalLayer)?.isOpaque = false
    addSubview(metal)
    target.view = self
    NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.willResignActiveNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(foregrounded), name: UIApplication.didBecomeActiveNotification, object: nil)
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      link?.invalidate(); link = nil
      retryWork?.cancel(); retryWork = nil
      owner?.dispose(); owner = nil
      session &+= 1; busy = false
    } else if owner == nil {
      session &+= 1
      let epoch = session
      failed = false; metal.isHidden = true; markDirty()
      owner = RustOwner(layer: metal.layer as! CAMetalLayer) { [weak self] event in
        guard let self, self.session == epoch,
              (event["generation"] as? UInt64) == self.generation else { return }
        if event["state"] as? String == "metrics" {
          var metrics = event
          metrics["uiTickMs"] = self.tickMs
          metrics["displayIntervalMs"] = self.intervalMs
          metrics["skippedDisplayCallbacks"] = self.skipped
          self.onMetrics(metrics)
        } else {
          if event["state"] as? String == "error" {
            self.failed = true; self.metal.isHidden = true
            self.link?.invalidate(); self.link = nil
          }
          self.onStatus(event)
        }
      }
      refresh()
    }
    lifecycle()
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    metal.frame = bounds
    metal.contentScaleFactor = window?.screen.scale ?? UIScreen.main.scale
    markDirty()
    refresh()
    lifecycle()
  }
  func setTrack(_ value: String) {
    guard value.utf8.count <= 2_000_000,
          let data = value.data(using: .utf8), let identity = try? JSONDecoder().decode(TrackIdentity.self, from: data), identity.generation > generation else { return }
    generation = identity.generation; sequence = 0; anchor = nil
    failed = false; metal.isHidden = true
    track = value; markDirty()
    refresh(); lifecycle()
  }
  func setAnchor(_ value: String) {
    guard let data = value.data(using: .utf8), let next = try? JSONDecoder().decode(Anchor.self, from: data) else {
      failed = true; metal.isHidden = true
      lifecycle()
      onStatus(["state": "error", "generation": generation, "message": "Invalid Rust playback anchor"])
      return
    }
    guard next.generation == generation, next.sequence > sequence else { return }
    sequence = next.sequence; anchor = next; markDirty()
    owner?.setAnchor(next)
    lifecycle()
  }
  func setActive(_ value: Bool) {
    enabled = value
    if value { markDirty(); refresh() }
    lifecycle()
  }
  private func refresh() {
    guard window != nil, foreground, enabled, !failed else { return }
    owner?.update(track: track, anchor: anchor, size: bounds.size, scale: window?.screen.scale ?? UIScreen.main.scale)
  }
  @objc private func background() { foreground = false; lifecycle() }
  @objc private func foregrounded() { foreground = true; markDirty(); refresh(); lifecycle() }
  private func lifecycle() {
    let visible = window != nil && foreground && enabled && !failed && bounds.width > 0 && bounds.height > 0
    owner?.setVisible(visible)
    if !visible { retryWork?.cancel(); retryWork = nil }
    if visible && retryWork == nil && !retryBlocked && (dirty || (anchor?.playing == true && (anchor?.rate ?? 1) > 0)) {
      if link == nil {
        let next = CADisplayLink(target: target, selector: #selector(DisplayTarget.tick(_:)))
        next.add(to: .main, forMode: .common)
        link = next
      }
    } else { link?.invalidate(); link = nil; previousTick = 0 }
  }
  fileprivate func tick(_ display: CADisplayLink) {
    guard window != nil, foreground, enabled, !failed, !retryBlocked, retryWork == nil else { lifecycle(); return }
    let start = CACurrentMediaTime()
    if previousTick > 0 { intervalMs = (display.timestamp - previousTick) * 1000 }
    previousTick = display.timestamp
    if busy { skipped &+= 1; return }
    guard dirty || (anchor?.playing == true && (anchor?.rate ?? 1) > 0) else { lifecycle(); return }
    guard let owner else { return }
    busy = true; dirty = false
    let epoch = session
    let requestedRevision = frameRevision
    owner.draw { [weak self] result, renderedGeneration in
      guard let self, self.session == epoch else { return }
      self.busy = false
      guard self.frameRevision == requestedRevision, renderedGeneration == self.generation else {
        self.lifecycle(); return
      }
      if result == 2 {
        self.scheduleRetry(revision: requestedRevision, epoch: epoch)
      } else if result == 1 {
        // No anchor/track yet. A new input/ready handshake will rearm, not a frame loop.
        self.retryBlocked = true
      } else if result == 0 {
        self.retryCount = 0
        self.metal.isHidden = false
        if self.surfaceWaiting || self.displayedGeneration != renderedGeneration {
          self.surfaceWaiting = false
          self.displayedGeneration = renderedGeneration
          self.onStatus(["state": "presented", "generation": renderedGeneration, "message": "Rust is presenting the current track"])
        }
      }
      self.lifecycle()
    }
    tickMs = (CACurrentMediaTime() - start) * 1000
  }
  private func markDirty() {
    dirty = true
    frameRevision &+= 1
    retryCount = 0
    retryBlocked = false
    retryWork?.cancel(); retryWork = nil
  }
  private func scheduleRetry(revision: UInt64, epoch: UInt64) {
    dirty = true
    guard retryCount < Self.retryDelays.count else {
      retryBlocked = true
      surfaceWaiting = true
      metal.isHidden = true
      onStatus(["state": "waiting", "generation": generation,
                "message": "Rust surface unavailable after bounded retries. Resume, seek, resize or recreate to retry."])
      return
    }
    let delay = Self.retryDelays[retryCount]
    retryCount += 1
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.session == epoch, self.frameRevision == revision,
            self.window != nil, self.foreground, self.enabled, !self.failed else { return }
      self.retryWork = nil
      self.lifecycle()
    }
    retryWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }
  deinit {
    retryWork?.cancel()
    link?.invalidate()
    NotificationCenter.default.removeObserver(self)
    owner?.dispose()
  }
}
