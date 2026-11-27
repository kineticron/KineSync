import CoreText
import ExpoModulesCore
import QuartzCore
import UIKit
import KineSyncLyrics

public final class KineSyncRustLyricsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KineSyncRustLyrics")
    Function("abiVersion") { kr_abi_version() }
    Function("monotonicMs") { CACurrentMediaTime() * 1000 }
    #if DEBUG
    Function("frameTraceAvailable") { kr_frame_trace_available() }
    #endif
    View(KineSyncRustLyricsView.self) {
      #if DEBUG
      Events("onStatus", "onFrameTrace", "onFrameTraceReset")
      #else
      Events("onStatus")
      #endif
      Prop("trackJson") { (view: KineSyncRustLyricsView, value: String) in view.setTrack(value) }
      Prop("active") { (view: KineSyncRustLyricsView, value: Bool) in view.setActive(value) }
      #if DEBUG
      Prop("traceSession") { (view: KineSyncRustLyricsView, value: String) in view.setFrameTrace(value) }
      Prop("tracePanelVisible") { (view: KineSyncRustLyricsView, value: Bool) in view.setTracePanelVisible(value) }
      AsyncFunction("exportFrameTrace") { (view: KineSyncRustLyricsView, session: String, promise: Promise) in
        MainActor.assumeIsolated { view.exportFrameTrace(session, promise) }
      }
      AsyncFunction("copyLayout") { (view: KineSyncRustLyricsView, promise: Promise) in
        MainActor.assumeIsolated { view.copyLayout(promise) }
      }
      #endif
      AsyncFunction("setAnchor") { (view: KineSyncRustLyricsView, value: String) in
        // Expo's ViewDefinitionBuilder routes owner AsyncFunctions to main.
        MainActor.assumeIsolated { view.setAnchor(value) }
      }
      AsyncFunction("setFollowing") { (view: KineSyncRustLyricsView, value: Bool, epoch: Double, generation: Double, gesture: Bool) in
        MainActor.assumeIsolated { view.setFollowing(value, epoch: epoch, generation: generation, gesture: gesture) }
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
#if DEBUG
private struct FrameRequest: Sendable {
  let token: UInt64
  let id: UInt64
  let segment: UInt64
}
private struct TraceCapture: Sendable {
  let token: UInt64
  let generation: UInt64
  let surface: UInt64
  let startedMs: Double
  let session: String
}
#else
private typealias FrameRequest = Void
#endif

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
  #if DEBUG
  private var traceCapture: TraceCapture?
  private var traceSummaryRevision: UInt64?
  #endif
  // Bundle bytes are cached once, loaded on the worker, never resolved via Metro per frame.
  private static let fontBundle: Bundle? = {
    let url = [Bundle.main, Bundle(for: KineSyncRustLyricsModule.self)].compactMap { $0.url(forResource: "KineSyncLyricsFonts", withExtension: "bundle") }.first
    return url.flatMap { Bundle(url: $0) }
  }()
  private static let fontBytes: (Data, Data)? = {
    guard let bundle = fontBundle,
          let regular = bundle.url(forResource: "SF-Pro-Display-Regular", withExtension: "otf"),
          let bold = bundle.url(forResource: "SF-Pro-Display-Bold", withExtension: "otf"),
          let regularData = try? Data(contentsOf: regular), let boldData = try? Data(contentsOf: bold) else { return nil }
    return (regularData, boldData)
  }()
  // Register the bundled Simplified Chinese fallback before Fontique's CoreText
  // scan runs in kr_create. The fonts are process scoped and already loaded from
  // KineSyncLyricsFonts.bundle, so this adds no per-frame work or network access.
  private static func registerBundledCJKFonts() -> Bool {
    guard let bundle = fontBundle else { return false }
    var ready = true
    for name in ["NotoSansCJKsc-Regular", "NotoSansCJKsc-Bold"] {
      guard let url = bundle.url(forResource: name, withExtension: "otf") else {
        ready = false
        continue
      }
      var error: Unmanaged<CFError>?
      if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) { continue }
      // A second renderer owner can find these fonts already registered.
      if let error = error?.takeRetainedValue(), CFErrorGetCode(error) == 105 { continue }
      ready = false
    }
    return ready
  }
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
  #if DEBUG
  private func layoutReceipt() -> String {
    let capacity = kr_copy_layout_json(handle, nil, 0)
    guard capacity > 0, capacity <= 8_000_000 else { return "" }
    var bytes = [UInt8](repeating: 0, count: capacity)
    let actual = bytes.withUnsafeMutableBufferPointer { kr_copy_layout_json(handle, $0.baseAddress, $0.count) }
    guard actual == capacity else { return "" }
    return String(decoding: bytes.dropLast(), as: UTF8.self)
  }
  #endif
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
    failed = true
    #if DEBUG
    var bytes = [CChar](repeating: 0, count: 2048)
    let capacity = bytes.count
    bytes.withUnsafeMutableBufferPointer { buffer in kr_copy_error(buffer.baseAddress, capacity) }
    emit(["state": "error", "message": String(cString: bytes)])
    #else
    emit(["state": "error", "message": "Lyrics renderer unavailable."])
    #endif
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
      let resumed = result == 1
      DispatchQueue.main.async { completion(resumed) }
    }
  }
  func hitTest(_ x: Double, _ y: Double, _ completion: @escaping @MainActor (Int32) -> Void) {
    queue.async {
      var index: Int32 = -1
      if self.permitted(), self.handle != 0, !self.failed { index = kr_hit_test(self.handle, x, y) }
      DispatchQueue.main.async { completion(index) }
    }
  }
  #if DEBUG
  func copyLayout(_ completion: @escaping @MainActor (String?) -> Void) {
    queue.async {
      let receipt = self.permitted() && self.handle != 0 ? self.layoutReceipt() : ""
      DispatchQueue.main.async { completion(receipt.isEmpty ? nil : receipt) }
    }
  }
  #endif
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
      guard Self.registerBundledCJKFonts() else {
        self.failed = true
        self.emit(["state": "error", "message": "Bundled CJK lyric font unavailable; rebuild with KineSyncLyricsFonts.bundle"])
        return
      }
      self.handle = kr_create(Unmanaged.passUnretained(self.layer).toOpaque(), width, height, Float(scale))
      if self.handle == 0 { self.failure(); return }
      #if DEBUG
      if let capture = self.traceCapture { self.applyFrameTrace(capture) }
      #endif
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
  #if DEBUG
  private func applyFrameTrace(_ capture: TraceCapture?) {
    _ = kr_frame_trace_set(handle, capture?.token ?? 0, capture?.generation ?? 0,
                           capture?.surface ?? 0, capture?.startedMs ?? 0)
  }

  func setFrameTrace(_ capture: TraceCapture?) {
    queue.async {
      guard self.permitted(), self.traceCapture?.token != capture?.token else { return }
      self.traceCapture = capture
      if self.handle != 0 { self.applyFrameTrace(capture) }
    }
  }

  func setTraceSummaryRevision(_ revision: UInt64?) {
    gate.lock(); defer { gate.unlock() }
    traceSummaryRevision = revision
  }

  private func canCopyTrace(_ summaryRevision: UInt64?) -> Bool {
    gate.lock(); defer { gate.unlock() }
    return !retired && (summaryRevision == nil || traceSummaryRevision == summaryRevision)
  }

  func copyFrameTrace(capture: TraceCapture, cutoff: Double, segment: UInt64, summaryRevision: UInt64?,
                      completion: @escaping @MainActor (String?) -> Void) {
    queue.async {
      let now = CACurrentMediaTime() * 1000
      var json: String?
      if self.canCopyTrace(summaryRevision), self.handle != 0,
         self.traceCapture?.token == capture.token, self.currentGeneration == capture.generation, !self.failed {
        let export = summaryRevision == nil
        let capacity = export ? 512 * 1024 : 8192
        var bytes = Data(count: capacity)
        let count = bytes.withUnsafeMutableBytes { buffer in
          kr_frame_trace_copy_json(self.handle, cutoff, now, segment, export,
                                   buffer.bindMemory(to: UInt8.self).baseAddress, capacity)
        }
        if count > 0 && Int(count) <= capacity {
          bytes.count = Int(count)
          json = String(data: bytes, encoding: .utf8)
        }
      }
      let result = json
      DispatchQueue.main.async { completion(result) }
    }
  }
  #endif

  func draw(targetMs: Double, resumeStepMs: Double, request: FrameRequest?,
            completion: @escaping @MainActor (Int32, UInt64, Bool, Double) -> Void) {
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
      #if DEBUG
      if let request, let capture = self.traceCapture, capture.token == request.token,
         capture.generation == self.currentGeneration {
        result = kr_frame_trace_render(self.handle, frameTarget, sampled, resumeStepMs, request.id, request.segment)
      } else {
        result = kr_render(self.handle, frameTarget, sampled, resumeStepMs)
      }
      #else
      result = kr_render(self.handle, frameTarget, sampled, resumeStepMs)
      #endif
      if result < 0 { self.failure(); return }
      var m = KRMetrics()
      if kr_metrics(self.handle, &m) < 0 { self.failure(); return }
      animating = m.animating != 0
      nextCue = m.next_cue_native_ms
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
  #if DEBUG
  @objc func tracePulse(_ timer: Timer) { view?.tracePulse() }
  #endif
}

#if DEBUG
@MainActor
private final class CallbackTrace {
  enum Action: String, Hashable { case request, busy, idle, inactive }

  private struct Sample {
    let id: UInt64
    let segment: UInt64
    let arrivalMs: Double
    let timestampMs: Double
    let targetMs: Double
    let requestedHz: Double
    let action: Action
    let warmup: Bool
    let intervalMs: Double?
    let missed: Int
    let recordCpuMs: Double

    func export() -> [String: Any] {
      var result: [String: Any] = [
        "id": id, "segment": segment, "arrivalMs": arrivalMs, "timestampMs": timestampMs,
        "targetMs": targetMs, "requestedHz": requestedHz, "action": action.rawValue,
        "warmup": warmup, "missedCallbackVsyncsEstimate": missed, "recordCpuMs": recordCpuMs
      ]
      if let intervalMs { result["intervalMs"] = intervalMs }
      return result
    }
  }

  private static let capacity = 1200
  private static let windowMs = 5000.0
  static var nextToken: UInt64 = 0
  let capture: TraceCapture
  private var samples = [Sample?](repeating: nil, count: CallbackTrace.capacity)
  private var start = 0
  private var count = 0
  private var overwritten = 0
  private var segment: UInt64 = 1
  private var previousTimestamp: Double?
  private var segmentPeriod = 0.0
  private var stableCount = 0
  private var summaryCpuMs = 0.0
  var lastSummaryDeliveryMs = -Double.infinity
  var summaryPending = false
  var exportPending = false

  init(capture: TraceCapture) { self.capture = capture }

  func activeSegment(phase: String) -> UInt64 {
    phase == "active" && stableCount == 3 ? segment : 0
  }

  func pause() {
    if previousTimestamp != nil { segment &+= 1 }
    previousTimestamp = nil
    segmentPeriod = 0
    stableCount = 0
  }

  private func popFirst() {
    samples[start] = nil
    start = (start + 1) % Self.capacity
    count -= 1
  }

  private func evict(_ nowMs: Double) {
    while count > 0, let first = samples[start], nowMs - first.arrivalMs > Self.windowMs { popFirst() }
  }

  func record(id: UInt64, display: CADisplayLink, arrival: Double, requestedHz: Double, action: Action) -> FrameRequest {
    let began = CACurrentMediaTime()
    let timestamp = display.timestamp * 1000
    let target = display.targetTimestamp * 1000
    let period = target - timestamp
    let active = (action == .request || action == .busy) && period.isFinite && period > 0
    var interval: Double?
    var missed = 0
    if active {
      if let previousTimestamp, abs(period - segmentPeriod) <= max(0.35, segmentPeriod * 0.08),
         timestamp > previousTimestamp {
        stableCount = min(stableCount + 1, 3)
        interval = timestamp - previousTimestamp
        if stableCount == 3, let interval {
          let steps = interval / segmentPeriod
          let rounded = steps.rounded()
          if rounded <= 600, abs(steps - rounded) <= 0.20 { missed = Int(max(0, rounded - 1)) }
        }
      } else {
        pause()
        segmentPeriod = period
      }
      previousTimestamp = timestamp
    } else {
      pause()
    }
    let now = arrival * 1000
    evict(now)
    if count == Self.capacity {
      popFirst()
      overwritten += 1
    }
    let index = (start + count) % Self.capacity
    count += 1
    samples[index] = Sample(id: id, segment: segment, arrivalMs: now, timestampMs: timestamp, targetMs: target,
                            requestedHz: requestedHz, action: action, warmup: active && stableCount < 3,
                            intervalMs: interval, missed: missed, recordCpuMs: (CACurrentMediaTime() - began) * 1000)
    return FrameRequest(token: capture.token, id: id, segment: segment)
  }

  func snapshot(now: Double, requestedHz: Double, phase: String, export: Bool) -> [String: Any] {
    let began = CACurrentMediaTime()
    evict(now)
    let window = (0..<count).compactMap { samples[(start + $0) % Self.capacity] }.filter { $0.arrivalMs <= now }
    let active = activeSegment(phase: phase)
    let intervals = window.filter { $0.segment == active && !$0.warmup }.compactMap(\.intervalMs)
    let windowMs = min(Self.windowMs, max(0, now - capture.startedMs))
    var actions: [Action: Int] = [:]
    for sample in window { actions[sample.action, default: 0] += 1 }
    var summary: [String: Any] = [
      "requestedHz": requestedHz, "phase": phase == "active" && stableCount < 3 ? "warmup" : phase,
      "deliveredCallbacks": window.count, "busyCallbacks": actions[.busy, default: 0],
      "inactiveCallbacks": actions[.inactive, default: 0], "idleCallbacks": actions[.idle, default: 0],
      "estimatedMissedCallbackVsyncs": window.reduce(0) { $0 + $1.missed }, "overwritten": overwritten,
      "windowMs": windowMs, "activeSegment": active, "previousSummaryCpuMs": summaryCpuMs
    ]
    if windowMs > 0 { summary["windowCallbackHz"] = Double(window.count) * 1000 / windowMs }
    if !intervals.isEmpty {
      summary["activeCallbackHz"] = Double(intervals.count) * 1000 / intervals.reduce(0, +)
      summary["callbackIntervalMs"] = distribution(intervals)
    }
    if active != 0 { summary["budgetMs"] = segmentPeriod }
    if let value = distribution(window.map(\.recordCpuMs)) { summary["recordCpuMs"] = value }
    let result: [String: Any] = export ? ["summary": summary, "callbacks": window.map { $0.export() }] : summary
    summaryCpuMs = (CACurrentMediaTime() - began) * 1000
    return result
  }

  private func distribution(_ values: [Double]) -> [String: Any]? {
    let sorted = values.sorted()
    guard let worst = sorted.last else { return nil }
    return ["count": sorted.count, "p50": sorted[(sorted.count + 1) / 2 - 1],
            "p95": sorted[(sorted.count * 95 + 99) / 100 - 1], "worst": worst]
  }
}
#endif

final class KineSyncRustLyricsView: ExpoView, UIGestureRecognizerDelegate {
  let onStatus = EventDispatcher()
  #if DEBUG
  let onFrameTrace = EventDispatcher()
  let onFrameTraceReset = EventDispatcher()
  private var requestedHz = 0.0
  private var traceRequested = ""
  private var tracePanelVisible = false
  private var traceSummaryRevision: UInt64 = 0
  private var traceCallbackID: UInt64 = 0
  private var frameTrace: CallbackTrace?
  private var traceTimer: Timer?
  #endif
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
  private var releaseRecaptured = false
  private var releaseSerial: UInt64 = 0
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
      refresh()
    }
    #if DEBUG
    syncFrameTrace()
    #endif
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
    releasePending = false; releaseRecaptured = false
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
    refresh()
    #if DEBUG
    syncFrameTrace()
    #endif
    lifecycle()
  }
  #if DEBUG
  func setFrameTrace(_ session: String) {
    traceRequested = session.utf8.count <= 80 && kr_frame_trace_available() ? session : ""
    syncFrameTrace()
  }

  func setTracePanelVisible(_ visible: Bool) {
    tracePanelVisible = visible
    syncTraceTimer()
  }

  private func syncFrameTrace() {
    let parts = traceRequested.split(separator: ":", omittingEmptySubsequences: false)
    if parts.count == 3, UInt64(parts[0]) == generation, let surface = UInt64(parts[1]),
       let run = UInt64(parts[2]), run > 0, window != nil, let owner {
      if frameTrace?.capture.session != traceRequested {
        CallbackTrace.nextToken &+= 1
        let capture = TraceCapture(token: CallbackTrace.nextToken, generation: generation, surface: surface,
                                   startedMs: CACurrentMediaTime() * 1000, session: traceRequested)
        frameTrace = CallbackTrace(capture: capture)
        owner.setFrameTrace(capture)
        emitTraceReset(capture, token: capture.token, active: true)
      }
    } else if let previous = frameTrace {
      frameTrace = nil
      owner?.setFrameTrace(nil)
      CallbackTrace.nextToken &+= 1
      emitTraceReset(previous.capture, token: CallbackTrace.nextToken, active: false)
    }
    syncTraceTimer()
  }

  private func emitTraceReset(_ capture: TraceCapture, token: UInt64, active: Bool) {
    onFrameTraceReset(["token": token, "session": capture.session, "generation": capture.generation,
                       "surface": capture.surface, "active": active])
  }

  private func syncTraceTimer() {
    if tracePanelVisible, frameTrace != nil, let owner {
      guard traceTimer == nil else { return }
      traceSummaryRevision &+= 1
      owner.setTraceSummaryRevision(traceSummaryRevision)
      let timer = Timer(timeInterval: 0.5, target: target, selector: #selector(DisplayTarget.tracePulse(_:)),
                        userInfo: nil, repeats: true)
      timer.tolerance = 0.05
      RunLoop.main.add(timer, forMode: .common)
      traceTimer = timer
    } else if traceTimer != nil {
      traceTimer?.invalidate()
      traceTimer = nil
      traceSummaryRevision &+= 1
      owner?.setTraceSummaryRevision(nil)
    }
  }

  private func recordTrace(_ display: CADisplayLink, _ start: Double, _ action: CallbackTrace.Action) -> FrameRequest? {
    guard let frameTrace else { return nil }
    traceCallbackID &+= 1
    return frameTrace.record(id: traceCallbackID, display: display, arrival: start, requestedHz: requestedHz, action: action)
  }

  private var tracePhase: String {
    if !foreground || window == nil || !enabled || failed || bounds.isEmpty { return "inactive" }
    if retryBlocked || retryWork != nil { return "waiting" }
    if link == nil { return "idle" }
    return "active"
  }

  fileprivate func tracePulse() {
    let now = CACurrentMediaTime() * 1000
    guard foreground, tracePanelVisible, let owner, let trace = frameTrace, !trace.summaryPending, !trace.exportPending,
          now - trace.lastSummaryDeliveryMs >= 500 else { return }
    let phase = tracePhase
    let segment = trace.activeSegment(phase: phase)
    let callbacks = trace.snapshot(now: now, requestedHz: requestedHz, phase: phase, export: false)
    let summaryRevision = traceSummaryRevision
    trace.summaryPending = true
    owner.copyFrameTrace(capture: trace.capture, cutoff: now, segment: segment, summaryRevision: summaryRevision) { [weak self, weak trace] worker in
      guard let self, let trace, self.frameTrace === trace else { return }
      trace.summaryPending = false
      guard self.foreground, self.tracePanelVisible, self.traceSummaryRevision == summaryRevision,
            self.generation == trace.capture.generation else { return }
      trace.lastSummaryDeliveryMs = CACurrentMediaTime() * 1000
      self.onFrameTrace([
        "worker": worker ?? "", "snapshotMs": now, "generation": trace.capture.generation,
        "surface": trace.capture.surface, "token": trace.capture.token, "session": trace.capture.session,
        "callbacks": callbacks
      ])
    }
  }

  func exportFrameTrace(_ session: String, _ promise: Promise) {
    guard let owner, let trace = frameTrace, trace.capture.session == session, !trace.exportPending else {
      promise.reject("ERR_RUST_TRACE", "Frame trace export is unavailable or already in progress.")
      return
    }
    trace.exportPending = true
    let now = CACurrentMediaTime() * 1000
    let phase = tracePhase
    let callbacks = trace.snapshot(now: now, requestedHz: requestedHz, phase: phase, export: true)
    owner.copyFrameTrace(capture: trace.capture, cutoff: now, segment: trace.activeSegment(phase: phase),
                         summaryRevision: nil) { [weak self, weak trace] worker in
      guard let self, let trace, self.frameTrace === trace, self.generation == trace.capture.generation,
            self.traceRequested == session, self.window != nil else {
        promise.reject("ERR_RUST_TRACE", "The trace ended before export.")
        return
      }
      trace.exportPending = false
      guard let worker else {
        promise.reject("ERR_RUST_TRACE", "The renderer could not export the trace.")
        return
      }
      do {
        let capture = ["token": trace.capture.token, "generation": trace.capture.generation, "surface": trace.capture.surface]
        let payload: [String: Any] = ["capture": capture, "session": session, "records": callbacks]
        let data = try JSONSerialization.data(withJSONObject: payload)
        let callbackJSON = String(decoding: data, as: UTF8.self)
        let json = "{\"version\":2,\"snapshotMs\":\(now),\"callbacks\":\(callbackJSON),\"worker\":\(worker)}"
        guard json.utf8.count <= 1024 * 1024 - 1024 else {
          promise.reject("ERR_RUST_TRACE_SIZE", "Capture exceeds the share limit. Start a shorter capture and try again.")
          return
        }
        promise.resolve(json)
      } catch {
        promise.reject("ERR_RUST_TRACE", "Callback records could not be encoded.")
      }
    }
  }

  func copyLayout(_ promise: Promise) {
    guard let owner else { promise.reject("ERR_RUST_LAYOUT", "Rust owner unavailable"); return }
    owner.copyLayout { receipt in
      if let receipt { promise.resolve(receipt) }
      else { promise.reject("ERR_RUST_LAYOUT", "No prepared Rust layout receipt") }
    }
  }
  #endif
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
  func setFollowing(_ value: Bool, epoch: Double, generation commandGeneration: Double, gesture: Bool) {
    guard epoch.isFinite, epoch >= 0, commandGeneration.isFinite, commandGeneration >= 0,
          UInt64(commandGeneration) == generation else { return }
    let nextEpoch = UInt64(epoch)
    // A delayed touch-down false belongs to the release gesture even when the
    // near recapture already won physical ownership. Record its epoch without
    // undoing the recapture, then re-announce the recapture at that epoch so JS
    // can accept the current gesture instead of rejecting an older event.
    if lateGestureOwnershipAllowed(value, gesture: gesture, nextEpoch: nextEpoch, identity: UInt64(commandGeneration)) {
      ownershipEpoch = nextEpoch
      if releaseRecaptured { emitRecapturedFollow() }
      return
    }
    guard followCommandAllowed(value, nextEpoch: nextEpoch, identity: UInt64(commandGeneration)) else { return }
    ownershipEpoch = nextEpoch
    if value { ownershipFloor = max(ownershipFloor, nextEpoch) }
    releasePending = false
    releaseRecaptured = false
    following = value
    followEpoch &+= 1
    owner?.setFollowing(value)
    // A paused/settled surface still needs frames while the spring settles.
    markDirty()
    lifecycle()
  }
  private func lateGestureOwnershipAllowed(_ value: Bool, gesture: Bool, nextEpoch: UInt64, identity: UInt64) -> Bool {
    guard identity == self.generation, nextEpoch > self.ownershipEpoch else { return false }
    guard !value, gesture, self.releasePending else { return false }
    return true
  }
  private func emitRecapturedFollow() {
    onStatus(["state": "follow", "generation": generation,
              "ownershipEpoch": ownershipEpoch,
              "message": "Auto-follow resumed near the active line"])
  }
  // A true from before a newer touch, or while that touch owns the viewport,
  // must not reclaim follow even when its JS callback is delayed.
  private func followCommandAllowed(_ value: Bool, nextEpoch: UInt64, identity: UInt64) -> Bool {
    guard identity == self.generation, nextEpoch > self.ownershipEpoch else { return false }
    guard !value || (!self.touchActive && nextEpoch > self.ownershipFloor) else { return false }
    return true
  }
  // Native drag starts ownership without consuming a JS epoch. The following
  // JS false command still records the epoch and keeps command ordering intact.
  private func takeOwnership() {
    releasePending = false
    releaseRecaptured = false
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
    releaseRecaptured = false
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
    releaseSerial &+= 1
    let serial = releaseSerial
    releasePending = true
    releaseRecaptured = false
    owner?.fling(velocity, nativeMs: CACurrentMediaTime() * 1000) { [weak self] resumed in
      guard let self,
            self.session == releaseSession,
            self.generation == releaseGeneration,
            self.followEpoch == releaseEpoch,
            self.releaseSerial == serial,
            !self.failed else { return }
      if resumed {
        self.following = true
        self.releaseRecaptured = true
        self.emitRecapturedFollow()
      } else {
        self.releasePending = false
        self.releaseRecaptured = false
      }
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
        #if DEBUG
        requestedHz = Double(maximum)
        #endif
        next.preferredFrameRateRange = CAFrameRateRange(minimum: maximum, maximum: maximum, preferred: maximum)
        next.add(to: .main, forMode: .common)
        link = next
      }
    } else {
      #if DEBUG
      if link != nil { frameTrace?.pause() }
      #endif
      link?.invalidate(); link = nil
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
    #if DEBUG
    let start = frameTrace == nil ? 0 : CACurrentMediaTime()
    #endif
    guard window != nil, foreground, enabled, !failed, !retryBlocked, retryWork == nil else {
      #if DEBUG
      _ = recordTrace(display, start, .inactive)
      #endif
      lifecycle(); return
    }
    if busy {
      #if DEBUG
      _ = recordTrace(display, start, .busy)
      #endif
      return
    }
    guard dirty || animating else {
      #if DEBUG
      _ = recordTrace(display, start, .idle)
      #endif
      lifecycle(); return
    }
    guard let owner else {
      #if DEBUG
      _ = recordTrace(display, start, .inactive)
      #endif
      return
    }
    busy = true; dirty = false
    let epoch = session
    let requestedRevision = frameRevision
    let resumeStepMs = resumePending ? max(0, display.targetTimestamp - display.timestamp) * 1000 : 0
    resumePending = false
    #if DEBUG
    let request = recordTrace(display, start, .request)
    #else
    let request: FrameRequest? = nil
    #endif
    owner.draw(targetMs: display.targetTimestamp * 1000, resumeStepMs: resumeStepMs, request: request) { [weak self] result, renderedGeneration, settling, nextCue in
      guard let self, self.session == epoch else { return }
      self.busy = false
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
    #if DEBUG
    traceTimer?.invalidate()
    #endif
    NotificationCenter.default.removeObserver(self)
    owner?.dispose()
  }
}
