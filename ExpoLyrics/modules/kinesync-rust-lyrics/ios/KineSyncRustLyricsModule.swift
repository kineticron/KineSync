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
      AsyncFunction("setAnchor") { (view: KineSyncRustLyricsView, value: String) in
        // Expo's ViewDefinitionBuilder routes owner AsyncFunctions to main.
        MainActor.assumeIsolated { view.setAnchor(value) }
      }
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
  let snap: Bool
}
private struct TrackIdentity: Decodable { let generation: UInt64 }

// Only the serial queue touches Rust. Retirement is asynchronous and retains the
// layer until the last bounded frame and surface destruction have completed.
private final class RustOwner: @unchecked Sendable {
  // Shared serialization also orders old-owner retirement before a rapid remount
  // can create/configure another wgpu surface on the same retained layer.
  private static let worker = DispatchQueue(label: "dev.kineticron.rust-lyrics", qos: .userInteractive, autoreleaseFrequency: .workItem)
  private let queue = RustOwner.worker
  private let layer: CAMetalLayer
  private let report: @MainActor ([String: Any]) -> Void
  private var handle: UInt64 = 0
  private let gate = NSLock()
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
  private struct SurfaceInput {
    let track: String
    let anchor: Anchor?
    let size: CGSize
    let scale: CGFloat
  }
  // Under gate: one pending latest snapshot and one scheduled drain at most.
  private var pendingUpdate: SurfaceInput?
  private var pendingAnchor: Anchor?
  private var pendingSnap = false
  private var inputScheduled = false

  init(layer: CAMetalLayer, report: @escaping @MainActor ([String: Any]) -> Void) {
    self.layer = layer
    self.report = report
  }
  private func permitted(rendering: Bool = false) -> Bool {
    gate.lock(); defer { gate.unlock() }
    return !retired && (!rendering || visible)
  }
  private func emit(_ event: [String: Any]) {
    var tagged = event
    tagged["generation"] = currentGeneration
    let snapshot = tagged
    DispatchQueue.main.async { self.report(snapshot) }
  }
  private func failure() {
    var bytes = [CChar](repeating: 0, count: 2048)
    let capacity = bytes.count
    bytes.withUnsafeMutableBufferPointer { buffer in kr_copy_error(buffer.baseAddress, capacity) }
    failed = true
    emit(["state": "error", "message": String(cString: bytes)])
  }
  private func applyAnchor(forceSnap: Bool = false) {
    guard handle != 0, let anchor else { return }
    if kr_set_anchor(handle, anchor.generation, anchor.sequence, anchor.positionMs,
                     anchor.nativeMs, CACurrentMediaTime() * 1000, anchor.playing, anchor.rate, anchor.snap || forceSnap) < 0 { failure() }
  }
  func update(track: String, anchor: Anchor?, size: CGSize, scale: CGFloat) {
    enqueue(update: SurfaceInput(track: track, anchor: anchor, size: size, scale: scale))
  }
  func setAnchor(_ value: Anchor) { enqueue(anchor: value) }
  private func enqueue(update: SurfaceInput? = nil, anchor: Anchor? = nil) {
    gate.lock()
    guard !retired else { gate.unlock(); return }
    if let update { pendingUpdate = update }
    if let anchor {
      pendingAnchor = anchor
      pendingSnap = pendingSnap || anchor.snap
    }
    let schedule = !inputScheduled
    inputScheduled = true
    gate.unlock()
    guard schedule else { return }
    queue.async { self.drainInput() }
  }
  private func drainInput() {
    gate.lock()
    let update = pendingUpdate
    let anchor = pendingAnchor
    let forceSnap = pendingSnap
    pendingSnap = false
    pendingUpdate = nil; pendingAnchor = nil; inputScheduled = false
    gate.unlock()
    guard permitted() else { return }
    if let update { applyUpdate(track: update.track, anchor: update.anchor, size: update.size, scale: update.scale, forceSnap: forceSnap) }
    if let anchor, !failed, anchor.generation == currentGeneration,
       anchor.sequence > (self.anchor?.sequence ?? 0) {
      self.anchor = anchor
      applyAnchor(forceSnap: forceSnap)
    }
  }
  private func applyUpdate(track: String, anchor: Anchor?, size: CGSize, scale: CGFloat, forceSnap: Bool) {
    guard self.permitted() else { return }
    let identity = track.data(using: .utf8).flatMap { try? JSONDecoder().decode(TrackIdentity.self, from: $0) }
    if self.failed {
      guard let identity, identity.generation > self.currentGeneration else { return }
      if self.handle != 0 { _ = kr_destroy(self.handle); self.handle = 0 }
      self.failed = false; self.appliedTrack = ""
    }
    self.track = track
    if let identity, identity.generation != self.currentGeneration {
      self.currentGeneration = identity.generation
      self.anchor = nil
    }
    if let anchor, anchor.generation == self.currentGeneration,
       anchor.sequence >= (self.anchor?.sequence ?? 0) { self.anchor = anchor }
    guard size.width > 0, size.height > 0 else { return }
    let width = UInt32(min(8192, ceil(size.width * scale)))
    let height = UInt32(min(8192, ceil(size.height * scale)))
    if self.handle == 0 {
      guard kr_abi_version() == 2 else { self.failed = true; self.emit(["state": "error", "message": "Rust ABI mismatch"]); return }
      self.handle = kr_create(Unmanaged.passUnretained(self.layer).toOpaque(), width, height, Float(scale))
      if self.handle == 0 { self.failure(); return }
    } else if self.size != size || self.scale != scale {
      if kr_resize(self.handle, width, height, Float(scale)) < 0 { self.failure(); return }
    }
    self.size = size
    self.scale = scale
    if !track.isEmpty && track != self.appliedTrack {
      let data = Data(track.utf8)
      let result = data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) -> Int32 in
        kr_set_track(self.handle, buffer.baseAddress!.assumingMemoryBound(to: UInt8.self), buffer.count)
      }
      if result < 0 { self.failure(); return }
      self.appliedTrack = track
      self.emit(["state": "ready", "message": "Rust Metal surface and live track ready"])
    }
    self.applyAnchor(forceSnap: forceSnap)
  }
  func setVisible(_ value: Bool) {
    // Immediate gate only; lifecycle never waits for GPU/worker completion on main.
    gate.lock(); visible = value; gate.unlock()
  }
  func draw(targetMs: Double, completion: @escaping @MainActor (Int32, UInt64, Bool) -> Void) {
    queue.async {
      var result: Int32 = 1
      var animating = false
      defer {
        let status = result
        let generation = self.currentGeneration
        let settling = animating
        DispatchQueue.main.async { completion(status, generation, settling) }
      }
      guard self.permitted(rendering: true), !self.failed, self.handle != 0 else { return }
      let sampled = CACurrentMediaTime() * 1000
      result = kr_render(self.handle, targetMs)
      if result < 0 { self.failure(); return }
      var m = KRMetrics()
      if kr_metrics(self.handle, &m) < 0 { self.failure(); return }
      animating = m.animating != 0
      let now = CACurrentMediaTime()
      if result == 0 && now - self.lastMetrics >= 1 {
        self.lastMetrics = now
        self.emit(["state": "metrics", "frames": m.frames, "generation": m.generation,
                   "sampleNativeMs": sampled, "targetNativeMs": targetMs, "playing": self.anchor?.playing ?? false, "rate": self.anchor?.rate ?? 1,
                   "positionMs": m.position_ms, "cpuSceneMs": m.cpu_scene_ms,
                   "cpuEncodeMs": m.cpu_encode_ms, "gpuIntervalMs": m.gpu_interval_ms,
                   "waitMs": m.wait_ms, "presentWaitMs": m.present_wait_ms,
                   "gpuRendering": (m.capabilities & 1) != 0, "computeBlur": (m.capabilities & 2) != 0,
                   "adapterTimestampQuery": (m.capabilities & 4) != 0,
                   "adapterEncoderTimestamp": (m.capabilities & 8) != 0,
                   "enabledBracketFeatures": (m.capabilities & 16) != 0,
                   "profilerReason": (m.capabilities & 4) == 0 ? "adapter has no timestamp queries" :
                     (m.capabilities & 8) == 0 ? "adapter has no encoder timestamp feature (required by whole-Vello bracket)" :
                     "live timestamp readback disabled to avoid an extra worker/GPU wait",
                   "layoutMs": m.layout_ms, "width": m.width, "height": m.height,
                   "note": "Encode is CPU wall time; present+wait is worker submit/present/GPU-completion wall time, not scanout or pure GPU time."])
      }
    }
  }
  func dispose() {
    gate.lock()
    let shouldRetire = !retired
    retired = true; visible = false
    pendingUpdate = nil; pendingAnchor = nil
    pendingSnap = false
    gate.unlock()
    guard shouldRetire else { return }
    // Closure owns self/layer until queued work drains. No sync wait on UIKit.
    queue.async {
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
  private var animating = false
  private var callbacks: UInt64 = 0
  private var submitted: UInt64 = 0
  private var idle: UInt64 = 0
  private var busyCallbacks: UInt64 = 0
  private var inactive: UInt64 = 0
  private var noDrawable: UInt64 = 0
  private var presented: UInt64 = 0
  private var missedObservedEstimate: UInt64 = 0
  private var requestedHz = 0.0
  private var windowStart = 0.0
  private var windowCallbacks: UInt64 = 0
  private var windowPresented: UInt64 = 0
  private var previousStep = 0.0
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
      session &+= 1; busy = false; animating = false
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
          let elapsed = CACurrentMediaTime() - self.windowStart
          metrics["callbackTotal"] = self.callbacks
          metrics["submitted"] = self.submitted
          metrics["idle"] = self.idle
          metrics["busy"] = self.busyCallbacks
          metrics["inactive"] = self.inactive
          metrics["noDrawable"] = self.noDrawable
          metrics["missedObservedIntervalsEstimate"] = self.missedObservedEstimate
          metrics["requestedHz"] = self.requestedHz
          metrics["windowSeconds"] = elapsed
          metrics["deliveredCallbackHz"] = elapsed > 0 ? Double(self.callbacks - self.windowCallbacks) / elapsed : 0
          metrics["presentedFps"] = elapsed > 0 ? Double(self.presented - self.windowPresented) / elapsed : 0
          self.windowStart = CACurrentMediaTime()
          self.windowCallbacks = self.callbacks; self.windowPresented = self.presented
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
    generation = identity.generation; sequence = 0; anchor = nil; animating = false
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
    if visible && retryWork == nil && !retryBlocked && (dirty || animating || (anchor?.playing == true && (anchor?.rate ?? 1) > 0)) {
      if link == nil {
        let next = CADisplayLink(target: target, selector: #selector(DisplayTarget.tick(_:)))
        let maximum = Float(min(120, window?.screen.maximumFramesPerSecond ?? 60))
        requestedHz = Double(maximum)
        next.preferredFrameRateRange = CAFrameRateRange(minimum: min(30, maximum), maximum: maximum, preferred: maximum)
        windowStart = CACurrentMediaTime()
        windowCallbacks = callbacks; windowPresented = presented
        next.add(to: .main, forMode: .common)
        link = next
      }
    } else { link?.invalidate(); link = nil; previousTick = 0; previousStep = 0 }
  }
  fileprivate func tick(_ display: CADisplayLink) {
    let start = CACurrentMediaTime()
    defer { tickMs = (CACurrentMediaTime() - start) * 1000 }
    callbacks &+= 1
    guard window != nil, foreground, enabled, !failed, !retryBlocked, retryWork == nil else {
      inactive &+= 1; lifecycle(); return
    }
    if previousTick > 0 {
      let gap = display.timestamp - previousTick
      intervalMs = gap * 1000
      // An estimate only: system cadence changes can also lengthen this gap.
      if previousStep > 0 {
        missedObservedEstimate &+= UInt64(max(0, (gap / previousStep).rounded() - 1))
      }
    }
    previousTick = display.timestamp
    previousStep = display.targetTimestamp - display.timestamp
    if busy { busyCallbacks &+= 1; return }
    guard dirty || animating || (anchor?.playing == true && (anchor?.rate ?? 1) > 0) else {
      idle &+= 1; lifecycle(); return
    }
    guard let owner else { inactive &+= 1; return }
    busy = true; dirty = false; submitted &+= 1
    let epoch = session
    let requestedRevision = frameRevision
    owner.draw(targetMs: display.targetTimestamp * 1000) { [weak self] result, renderedGeneration, settling in
      guard let self, self.session == epoch else { return }
      self.busy = false
      if result == 0 { self.presented &+= 1 }
      if result == 2 { self.noDrawable &+= 1 }
      guard self.frameRevision == requestedRevision, renderedGeneration == self.generation else {
        self.lifecycle(); return
      }
      self.animating = settling
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
