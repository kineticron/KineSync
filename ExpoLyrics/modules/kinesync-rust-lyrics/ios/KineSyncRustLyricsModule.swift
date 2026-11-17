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
      AsyncFunction("copyLayout") { (view: KineSyncRustLyricsView, promise: Promise) in
        MainActor.assumeIsolated { view.copyLayout(promise) }
      }
      AsyncFunction("setAnchor") { (view: KineSyncRustLyricsView, value: String) in
        // Expo's ViewDefinitionBuilder routes owner AsyncFunctions to main.
        MainActor.assumeIsolated { view.setAnchor(value) }
      }
      AsyncFunction("setFollowing") { (view: KineSyncRustLyricsView, value: Bool, epoch: Double, generation: Double) in
        MainActor.assumeIsolated { view.setFollowing(value, epoch: epoch, generation: generation) }
      }
      AsyncFunction("scrollBy") { (view: KineSyncRustLyricsView, dy: Double) in
        MainActor.assumeIsolated { view.scrollBy(dy) }
      }
      AsyncFunction("fling") { (view: KineSyncRustLyricsView, velocity: Double) in
        MainActor.assumeIsolated { view.fling(velocity) }
      }
      AsyncFunction("hitTest") { (view: KineSyncRustLyricsView, x: Double, y: Double, promise: Promise) in
        MainActor.assumeIsolated { view.hitTest(x, y, promise) }
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
private struct TrackIdentity: Decodable { let generation: UInt64; let track_id: String }

// Only the serial queue touches Rust. Retirement is asynchronous and retains the
// layer until the last bounded frame and surface destruction have completed.
// HAL configuration synchronously dispatches only CAMetalLayer setters to main.
// Main must never wait for this worker. Never hold gate across a Rust call,
// because main lifecycle callbacks also take gate. GPU waits stay on worker.
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
  // Bundle bytes are cached once, loaded on the worker, never resolved via Metro per frame.
  private static let fontBytes: (Data, Data)? = {
    let url = [Bundle.main, Bundle(for: KineSyncRustLyricsModule.self)].compactMap { $0.url(forResource: "KineSyncLyricsFonts", withExtension: "bundle") }.first
    guard let url,
          let bundle = Bundle(url: url),
          let regular = bundle.url(forResource: "SF-Pro-Display-Regular", withExtension: "otf"),
          let bold = bundle.url(forResource: "SF-Pro-Display-Bold", withExtension: "otf"),
          let regularData = try? Data(contentsOf: regular), let boldData = try? Data(contentsOf: bold) else { return nil }
    return (regularData, boldData)
  }()
  private func installFonts() -> Bool {
    guard let (regular, bold) = Self.fontBytes else {
      failed = true; emit(["state": "error", "message": "Bundled Rust lyric fonts unavailable; rebuild with KineSyncLyricsFonts.bundle"]); return false
    }
    let result = regular.withUnsafeBytes { r in bold.withUnsafeBytes { b in
      kr_set_fonts(handle, r.baseAddress!.assumingMemoryBound(to: UInt8.self), r.count,
                   b.baseAddress!.assumingMemoryBound(to: UInt8.self), b.count)
    } }
    if result < 0 { failure(); return false }
    return true
  }
  private func layoutReceipt() -> String {
    let capacity = kr_copy_layout_json(handle, nil, 0)
    guard capacity > 0, capacity <= 8_000_000 else { return "" }
    var bytes = [UInt8](repeating: 0, count: capacity)
    let actual = bytes.withUnsafeMutableBufferPointer { kr_copy_layout_json(handle, $0.baseAddress, $0.count) }
    guard actual == capacity else { return "" }
    return String(decoding: bytes.dropLast(), as: UTF8.self)
  }
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
    assert(Thread.isMainThread, "RustOwner must be created on main")
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
  // Gestures bypass the latest-wins anchor coalescer: every drag delta and the
  // follow handoff must arrive in touch order. The shared serial queue still
  // orders them against frames, anchors, resize and track replacement.
  func setFollowing(_ value: Bool) {
    queue.async {
      guard self.permitted(), self.handle != 0, !self.failed else { return }
      if kr_set_following(self.handle, value) < 0 { self.failure() }
    }
  }
  func scrollBy(_ dy: Double) {
    guard dy.isFinite else { return }
    queue.async {
      guard self.permitted(), self.handle != 0, !self.failed else { return }
      if kr_scroll_by(self.handle, dy) < 0 { self.failure() }
    }
  }
  func fling(_ velocity: Double, nativeMs: Double, completion: @escaping @MainActor (Bool) -> Void) {
    guard velocity.isFinite, nativeMs.isFinite, nativeMs >= 0 else { return }
    queue.async {
      guard self.permitted(), self.handle != 0, !self.failed else { return }
      let result = kr_fling(self.handle, velocity, nativeMs)
      if result < 0 { self.failure(); return }
      if result == 1 { DispatchQueue.main.async { completion(true) } }
    }
  }
  func hitTest(_ x: Double, _ y: Double, _ completion: @escaping @MainActor (Int32) -> Void) {
    queue.async {
      var index: Int32 = -1
      if self.permitted(), self.handle != 0, !self.failed { index = kr_hit_test(self.handle, x, y) }
      DispatchQueue.main.async { completion(index) }
    }
  }
  func copyLayout(_ completion: @escaping @MainActor (String?) -> Void) {
    queue.async {
      let receipt = self.permitted() && self.handle != 0 ? self.layoutReceipt() : ""
      DispatchQueue.main.async { completion(receipt.isEmpty ? nil : receipt) }
    }
  }
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
    #if DEBUG
    dispatchPrecondition(condition: .onQueue(queue))
    assert(!Thread.isMainThread, "GPU creation and resize must stay on worker")
    #endif
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
      guard kr_abi_version() == 11 else { self.failed = true; self.emit(["state": "error", "message": "Rust ABI mismatch"]); return }
      self.handle = kr_create(Unmanaged.passUnretained(self.layer).toOpaque(), width, height, Float(scale))
      if self.handle == 0 { self.failure(); return }
      if !self.installFonts() { return }
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
  func draw(targetMs: Double, resumeStepMs: Double, completion: @escaping @MainActor (Int32, UInt64, Bool, Double) -> Void) {
    queue.async {
      #if DEBUG
      dispatchPrecondition(condition: .onQueue(self.queue))
      assert(!Thread.isMainThread, "GPU acquire and Outdated recovery must stay on worker")
      #endif
      var result: Int32 = 1
      var animating = false
      var nextCue = -1.0
      defer {
        let status = result
        let generation = self.currentGeneration
        let settling = animating
        let wakeup = nextCue
        DispatchQueue.main.async { completion(status, generation, settling, wakeup) }
      }
      guard self.permitted(rendering: true), !self.failed, self.handle != 0 else { return }
      let sampled = CACurrentMediaTime() * 1000
      // Never replay a target which became stale while input/resize work ran.
      let frameTarget = max(targetMs, sampled)
      result = kr_render(self.handle, frameTarget, sampled, resumeStepMs)
      if result < 0 { self.failure(); return }
      var m = KRMetrics()
      if kr_metrics(self.handle, &m) < 0 { self.failure(); return }
      animating = m.animating != 0
      nextCue = m.next_cue_native_ms
      let now = CACurrentMediaTime()
      if result == 0 && now - self.lastMetrics >= 1 {
        self.lastMetrics = now
        self.emit(["state": "metrics", "frames": m.frames, "generation": m.generation,
                   "sampleNativeMs": sampled, "targetNativeMs": m.target_native_ms, "playing": self.anchor?.playing ?? false, "rate": self.anchor?.rate ?? 1,
                   "positionMs": m.position_ms, "cpuSceneMs": m.cpu_scene_ms,
                   "visibleChanges": m.visible_changes != 0, "nextCueNativeMs": m.next_cue_native_ms,
                   "cpuEncodeMs": m.cpu_encode_ms, "gpuIntervalMs": m.gpu_interval_ms,
                   "waitMs": m.wait_ms, "cpuBlitMs": m.cpu_blit_ms,
                   "acquireMs": m.acquire_ms, "blitSubmitMs": m.blit_submit_ms,
                   "pollMs": m.poll_ms, "presentCallMs": m.present_call_ms,
                   "gpuCompleted": m.completed, "gpuOutstanding": m.outstanding, "gpuBusy": m.gpu_busy,
                   "gpuRendering": (m.capabilities & 1) != 0, "computeBlur": (m.capabilities & 2) != 0,
                   "adapterTimestampQuery": (m.capabilities & 4) != 0,
                   "adapterEncoderTimestamp": (m.capabilities & 8) != 0,
                   "enabledBracketFeatures": (m.capabilities & 16) != 0,
                   "profilerReason": (m.capabilities & 4) == 0 ? "adapter has no timestamp queries" :
                     (m.capabilities & 8) == 0 ? "adapter has no encoder timestamp feature (required by whole-Vello bracket)" :
                     "live timestamp readback disabled to avoid an extra worker/GPU wait",
                   "layoutMs": m.layout_ms, "width": m.width, "height": m.height,
                   "note": "CPU wall costs only. GPU completed counts blit work callbacks; present-call rate is not scanout. Submit cost is final blit submit only; Vello internal submits remain in encode."])
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

final class KineSyncRustLyricsView: ExpoView, UIGestureRecognizerDelegate {
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
  private var trackId = ""
  private var anchor: Anchor?
  private var enabled = true
  // Desired follow ownership. Kept here so a handoff sent before the native
  // owner exists is replayed when the owner is created or the track changes.
  private var following = true
  // Invalidates an asynchronous release handoff after a newer touch, track or
  // follow command. A stale completion must never resume a later gesture.
  private var followEpoch: UInt64 = 0
  // A queued JS touch-down false must not undo a release recapture. It clears
  // on a new touch, explicit follow true, or track identity change.
  private var releasePending = false
  // JS ownership epochs order touches, parent changes and track resets. Native
  // rejects true commands from an older epoch and while a newer touch is active.
  private var ownershipEpoch: UInt64 = 0
  private var ownershipFloor: UInt64 = 0
  private var touchActive = false
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
  private var resumePending = false
  private var nextCueNativeMs = -1.0
  private var cueWork: DispatchWorkItem?
  private var cueDeadline = -1.0
  private var callbacks: UInt64 = 0
  private var submitted: UInt64 = 0
  private var idle: UInt64 = 0
  private var busyCallbacks: UInt64 = 0
  private var inactive: UInt64 = 0
  private var noDrawable: UInt64 = 0
  private var presentCalls: UInt64 = 0
  private var missedObservedEstimate: UInt64 = 0
  private var requestedHz = 0.0
  private var windowStart = 0.0
  private var windowCallbacks: UInt64 = 0
  private var windowPresentCalls: UInt64 = 0
  private var windowBusyCallbacks: UInt64 = 0
  private var windowMissedEstimate: UInt64 = 0
  private var previousStep = 0.0
  private var tickMs = 0.0
  private var intervalMs = 0.0
  private var previousTick = 0.0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .clear
    isOpaque = false
    metal.backgroundColor = .clear
    metal.isOpaque = false
    (metal.layer as? CAMetalLayer)?.isOpaque = false
    (metal.layer as? CAMetalLayer)?.backgroundColor = UIColor.clear.cgColor
    (metal.layer as? CAMetalLayer)?.presentsWithTransaction = false
    addSubview(metal)
    let pan = UIPanGestureRecognizer(target: self, action: #selector(manualPan(_:)))
    pan.cancelsTouchesInView = false
    pan.delegate = self
    addGestureRecognizer(pan)
    target.view = self
    NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.willResignActiveNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(foregrounded), name: UIApplication.didBecomeActiveNotification, object: nil)
  }
  // UIKit owns translation/velocity sampling. JS only classifies taps and holds;
  // it never sends per-move scrolling commands.
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                         shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
  @objc private func manualPan(_ pan: UIPanGestureRecognizer) {
    switch pan.state {
    case .began:
      takeOwnership()
      fallthrough
    case .changed:
      let dy = pan.translation(in: self).y
      pan.setTranslation(.zero, in: self)
      owner?.scrollBy(-Double(dy))
      markDirty(); lifecycle()
    case .ended:
      fling(-Double(pan.velocity(in: self).y) / 1000.0)
    case .cancelled, .failed:
      fling(0)
    default: break
    }
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      link?.invalidate(); link = nil
      retryWork?.cancel(); retryWork = nil
      cancelCue()
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
          // Never extrapolate a first/resume callback's tiny window into "fps".
          guard elapsed >= 1 else { return }
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
          metrics["busyCallbacksInWindow"] = self.busyCallbacks - self.windowBusyCallbacks
          metrics["missedIntervalsInWindow"] = self.missedObservedEstimate - self.windowMissedEstimate
          metrics["presentCallRate"] = elapsed > 0 ? Double(self.presentCalls - self.windowPresentCalls) / elapsed : 0
          self.windowStart = CACurrentMediaTime()
          self.windowCallbacks = self.callbacks; self.windowPresentCalls = self.presentCalls
          self.windowBusyCallbacks = self.busyCallbacks; self.windowMissedEstimate = self.missedObservedEstimate
          self.onMetrics(metrics)
        } else {
          if event["state"] as? String == "error" {
            self.failed = true; self.metal.isHidden = true
            self.link?.invalidate(); self.link = nil
          }
          if event["state"] as? String == "ready" {
            self.markDirty()
            self.lifecycle()
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
    ownershipEpoch = 0; ownershipFloor = 0; touchActive = false
    // Only a track identity change restores follow. Translation, credit and
    // layout revisions keep the user's manual ownership.
    if identity.track_id != trackId {
      trackId = identity.track_id
      following = true
      releasePending = false
      followEpoch &+= 1
    }
    failed = false; metal.isHidden = true
    track = value; markDirty()
    refresh(); lifecycle()
  }
  func copyLayout(_ promise: Promise) {
    guard let owner else { promise.reject("ERR_RUST_LAYOUT", "Rust owner unavailable"); return }
    owner.copyLayout { receipt in
      if let receipt { promise.resolve(receipt) }
      else { promise.reject("ERR_RUST_LAYOUT", "No prepared Rust layout receipt") }
    }
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
  func setFollowing(_ value: Bool, epoch: Double, generation commandGeneration: Double) {
    guard epoch.isFinite, epoch >= 0, commandGeneration.isFinite, commandGeneration >= 0,
          UInt64(commandGeneration) == generation else { return }
    let nextEpoch = UInt64(epoch)
    guard followCommandAllowed(value, nextEpoch: nextEpoch, identity: UInt64(commandGeneration)) else { return }
    ownershipEpoch = nextEpoch
    if value { ownershipFloor = max(ownershipFloor, nextEpoch) }
    releasePending = false
    following = value
    followEpoch &+= 1
    owner?.setFollowing(value)
    // A paused/settled surface still needs frames while the spring settles.
    markDirty()
    lifecycle()
  }
  // A true from before a newer touch, or while that touch owns the viewport,
  // must not reclaim follow even when its JS callback is delayed.
  private func followCommandAllowed(_ value: Bool, nextEpoch: UInt64, identity: UInt64) -> Bool {
    guard identity == self.generation, nextEpoch > self.ownershipEpoch else { return false }
    guard !value || (!self.touchActive && nextEpoch > self.ownershipFloor) else { return false }
    guard value || !self.releasePending else { return false }
    return true
  }
  // Native drag starts ownership without consuming a JS epoch. The following
  // JS false command still records the epoch and keeps command ordering intact.
  private func takeOwnership() {
    releasePending = false
    following = false
    followEpoch &+= 1
    owner?.setFollowing(false)
    markDirty()
    lifecycle()
  }
  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    // Invalidate an in-flight release before JS or the pan recognizer can
    // deliver the next ownership command.
    releasePending = false
    touchActive = true
    ownershipFloor = max(ownershipFloor, ownershipEpoch &+ 1)
    followEpoch &+= 1
    super.touchesBegan(touches, with: event)
  }
  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    touchActive = false
    super.touchesEnded(touches, with: event)
  }
  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    touchActive = false
    super.touchesCancelled(touches, with: event)
  }
  func scrollBy(_ dy: Double) {
    guard dy.isFinite, dy != 0 else { return }
    owner?.scrollBy(dy)
    markDirty()
    lifecycle()
  }
  func fling(_ velocity: Double) {
    guard velocity.isFinite else { return }
    let releaseSession = session
    let releaseGeneration = generation
    let releaseEpoch = followEpoch
    releasePending = true
    owner?.fling(velocity, nativeMs: CACurrentMediaTime() * 1000) { [weak self] resumed in
      guard let self, resumed,
            self.session == releaseSession,
            self.generation == releaseGeneration,
            self.followEpoch == releaseEpoch,
            !self.failed else { return }
      self.following = true
      self.onStatus(["state": "follow", "generation": releaseGeneration,
                     "ownershipEpoch": self.ownershipEpoch,
                     "message": "Auto-follow resumed near the active line"])
    }
    markDirty()
    lifecycle()
  }
  func hitTest(_ x: Double, _ y: Double, _ promise: Promise) {
    guard x.isFinite, y.isFinite else { promise.reject("ERR_RUST_HIT", "Invalid lyric hit-test point"); return }
    guard let owner else { promise.resolve(Int32(-1)); return }
    owner.hitTest(x, y) { index in promise.resolve(index) }
  }
  private func refresh() {
    guard window != nil, foreground, enabled, !failed else { return }
    owner?.update(track: track, anchor: anchor, size: bounds.size, scale: window?.screen.scale ?? UIScreen.main.scale)
    owner?.setFollowing(following)
  }
  @objc private func background() { foreground = false; lifecycle() }
  @objc private func foregrounded() { foreground = true; markDirty(); refresh(); lifecycle() }
  private func lifecycle() {
    let visible = window != nil && foreground && enabled && !failed && bounds.width > 0 && bounds.height > 0
    owner?.setVisible(visible)
    if !visible { retryWork?.cancel(); retryWork = nil; cancelCue(); resumePending = false }
    if visible && retryWork == nil && !retryBlocked && (dirty || animating) {
      cancelCue()
      if link == nil {
        let next = CADisplayLink(target: target, selector: #selector(DisplayTarget.tick(_:)))
        let maximum = Float(min(120, window?.screen.maximumFramesPerSecond ?? 60))
        requestedHz = Double(maximum)
        next.preferredFrameRateRange = CAFrameRateRange(minimum: maximum, maximum: maximum, preferred: maximum)
        windowStart = CACurrentMediaTime()
        windowCallbacks = callbacks; windowPresentCalls = presentCalls
        windowBusyCallbacks = busyCallbacks; windowMissedEstimate = missedObservedEstimate
        next.add(to: .main, forMode: .common)
        link = next
      }
    } else {
      link?.invalidate(); link = nil; previousTick = 0; previousStep = 0
      if visible && !busy && retryWork == nil && !retryBlocked {
        resumePending = anchor?.playing == true && (anchor?.rate ?? 0) > 0
        scheduleCue()
      }
    }
  }
  private func cancelCue() {
    cueWork?.cancel(); cueWork = nil; cueDeadline = -1
  }
  private func scheduleCue() {
    guard nextCueNativeMs.isFinite, nextCueNativeMs >= 0,
          anchor?.playing == true, (anchor?.rate ?? 0) > 0 else { cancelCue(); return }
    if cueWork != nil && cueDeadline == nextCueNativeMs { return }
    cancelCue()
    let deadline = nextCueNativeMs
    let revision = frameRevision
    let epoch = session
    // Rearm one display interval early. The next vsync still supplies the
    // actual target, and a late timer never replays its stored cue time.
    let hz = Double(min(120, window?.screen.maximumFramesPerSecond ?? 60))
    let delay = max(0, (deadline - CACurrentMediaTime() * 1000) / 1000 - 1 / hz)
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.session == epoch, self.frameRevision == revision,
            self.nextCueNativeMs == deadline, self.cueDeadline == deadline, self.cueWork != nil,
            self.window != nil, self.foreground,
            self.enabled, !self.failed, self.anchor?.playing == true,
            (self.anchor?.rate ?? 0) > 0 else { return }
      self.cancelCue()
      self.markDirty()
      self.lifecycle()
    }
    cueDeadline = deadline
    cueWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
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
    guard dirty || animating else {
      idle &+= 1; lifecycle(); return
    }
    guard let owner else { inactive &+= 1; return }
    busy = true; dirty = false; submitted &+= 1
    let epoch = session
    let requestedRevision = frameRevision
    let resumeStepMs = resumePending ? max(0, display.targetTimestamp - display.timestamp) * 1000 : 0
    resumePending = false
    owner.draw(targetMs: display.targetTimestamp * 1000, resumeStepMs: resumeStepMs) { [weak self] result, renderedGeneration, settling, nextCue in
      guard let self, self.session == epoch else { return }
      self.busy = false
      if result == 0 { self.presentCalls &+= 1 }
      if result == 2 { self.noDrawable &+= 1 }
      if result == 3 { self.dirty = true } // capacity retry at next fresh vsync
      guard self.frameRevision == requestedRevision, renderedGeneration == self.generation else {
        self.lifecycle(); return
      }
      self.animating = settling
      if result != 0 && resumeStepMs > 0 { self.resumePending = true }
      if result == 3 {
        // No backoff and no stored target; completion polling continues at vsync.
      } else if result == 2 {
        self.scheduleRetry(revision: requestedRevision, epoch: epoch)
      } else if result == 1 {
        // No anchor/track yet. A new input/ready handshake will rearm, not a frame loop.
        self.retryBlocked = true
      } else if result == 0 {
        self.nextCueNativeMs = nextCue
        self.retryCount = 0
        self.metal.isHidden = false
        if self.surfaceWaiting || self.displayedGeneration != renderedGeneration {
          self.surfaceWaiting = false
          self.displayedGeneration = renderedGeneration
          self.onStatus(["state": "presented", "generation": renderedGeneration, "message": "Rust submitted a present call for the current track"])
        }
      }
      self.lifecycle()
    }
  }
  private func markDirty() {
    cancelCue()
    nextCueNativeMs = -1
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
    cueWork?.cancel()
    retryWork?.cancel()
    link?.invalidate()
    NotificationCenter.default.removeObserver(self)
    owner?.dispose()
  }
}
