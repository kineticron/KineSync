import ActivityKit
import AVFoundation
import KineSyncActivityTypes
import ExpoModulesCore
import Foundation
import UIKit
import ImageIO
import os

public final class KineSyncLiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KineSyncLiveActivity")
    Events("onStatus")

    AsyncFunction("sync") { (json: String, retry: Bool) async throws -> [String: String] in
      let snapshot = try JSONDecoder().decode(LyricsSnapshot.self, from: Data(json.utf8))
      return await LyricsActivityController.shared.sync(snapshot, retry: retry) { [weak self] status in
        self?.sendEvent("onStatus", status)
      }
    }

    AsyncFunction("stop") { () async -> Void in
      await LyricsActivityController.shared.stop()
    }

    AsyncFunction("startCarPlaySpike") { () async -> Void in
      await LyricsActivityController.shared.startCarPlaySpike()
    }
    AsyncFunction("stopCarPlaySpike") { () async -> Void in
      await LyricsActivityController.shared.stopCarPlaySpike()
    }
    AsyncFunction("getCarPlaySpikeStatus") { () async -> [String: String] in
      await LyricsActivityController.shared.carPlaySpikeStatus()
    }
    AsyncFunction("getCarPlaySpikeLog") { () async throws -> String in
      try await LyricsActivityController.shared.carPlaySpikeLog()
    }
  }
}

@MainActor
private final class CarPlaySpikeRun {
  static let session = "carplay-spike-v1"
  static let duration = 15 * 60
  let id = UUID().uuidString
  var activity: Activity<LyricsActivityAttributes>?
  var player: AVAudioPlayer?
  var audioActive = false
  var interruption: NSObjectProtocol?
  var preparation: Task<Void, Never>?
  var updates: Task<Void, Never>?
  var observation: Task<Void, Never>?
  var expiry: Task<Void, Never>?
  var cleanup: Task<Void, Never>?
  var cleanupBackgroundTask = UIBackgroundTaskIdentifier.invalid
  var sample: LyricsActivityAttributes.SpikeSample?
  var previousAttempt: ContinuousClock.Instant?
  var elapsedMilliseconds: Double?

  func releaseCleanupBackgroundTask() {
    let identifier = cleanupBackgroundTask
    guard identifier != .invalid else { return }
    cleanupBackgroundTask = .invalid
    UIApplication.shared.endBackgroundTask(identifier)
  }
}

extension LyricsActivityController {
  private static let spikeLines = [
    "Blue lights cross the avenue",
    "Paper moons drift out of view",
    "Rain keeps time on window glass",
    "Quiet streets let echoes pass",
  ]
  private static let spikeLogLimit = 256 * 1024

  func startCarPlaySpike() {
    guard spike == nil else { return }
    if let unavailable = activityAvailability() {
      spikeState = unavailable.state
      spikeMessage = unavailable.message
      return
    }
    guard isForeground else {
      spikeState = "error"
      spikeMessage = "Open KineSync in the foreground to start the spike."
      return
    }
    let run = CarPlaySpikeRun()
    // Reserve the owner before awaiting old metadata updates and activity ends.
    spike = run
    spikeState = "starting"
    spikeMessage = "Preparing the local Live Activity."
    revision += 1
    cancelArtwork()
    setStatus("idle", "Playback details are paused during the CarPlay spike.")
    run.preparation = Task {
      guard !Task.isCancelled, spike === run else { return }
      await endCurrentActivities(includeSpike: true)
      guard !Task.isCancelled, spike === run else { return }
      guard isForeground else {
        finishSpike(run, state: "error", message: "KineSync left the foreground before the activity could start.")
        return
      }
      prepareSpike(run)
    }
  }

  func stopCarPlaySpike() async {
    guard let run = spike else { return }
    finishSpike(run, state: "idle", message: "Spike stopped.")
    await run.cleanup?.value
  }

  func carPlaySpikeStatus() -> [String: String] {
    var result = ["state": spikeState, "message": spikeMessage, "lifecycle": spikeLifecycle]
    result["logError"] = spikeLogError
    if let sample = spike?.sample {
      result["lyric"] = sample.lyric
      result["sequence"] = String(sample.sequence)
      result["timestamp"] = sample.timestamp
    }
    return result
  }

  private func prepareSpike(_ run: CarPlaySpikeRun) {
    let audio = AVAudioSession.sharedInstance()
    do {
      let player = try AVAudioPlayer(data: Self.silentWAV())
      player.numberOfLoops = -1
      try audio.setCategory(.playback, mode: .default, options: [.mixWithOthers])
      try audio.setActive(true)
      run.audioActive = true
      run.player = player
      run.interruption = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification, object: audio, queue: .main
      ) { [weak self, weak run] notification in
        guard let rawValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: rawValue) == .began else { return }
        Task { @MainActor in
          guard let self, let run else { return }
          self.finishSpike(run, state: "error", message: "The silent audio session was interrupted.")
        }
      }
      guard player.play() else {
        finishSpike(run, state: "error", message: "AVAudioPlayer could not start silent playback.")
        return
      }
    } catch {
      finishSpike(run, state: "error", message: "Silent audio setup failed: \(error.localizedDescription)")
      return
    }

    let clock = ContinuousClock()
    let deadline = clock.now + .seconds(CarPlaySpikeRun.duration)
    let staleDate = Date().addingTimeInterval(TimeInterval(CarPlaySpikeRun.duration))
    let content = spikeContent(run, operation: "request", staleDate: staleDate)
    let activity: Activity<LyricsActivityAttributes>
    do {
      activity = try Activity.request(
        attributes: LyricsActivityAttributes(session: CarPlaySpikeRun.session), content: content, pushType: nil
      )
      run.activity = activity
      writeSpikeLog(run, operation: "request", phase: "completion", outcome: "returned")
    } catch {
      writeSpikeLog(run, operation: "request", phase: "completion", outcome: "error", error: String(reflecting: error))
      finishSpike(run, state: "error", message: "ActivityKit request failed: \(error.localizedDescription)")
      return
    }
    spikeState = "running"
    spikeMessage = "Silent audio is playing. ActivityKit returned locally."
    run.observation = Task {
      for await state in activity.activityStateUpdates {
        guard !Task.isCancelled, spike === run else { return }
        if state == .dismissed || state == .ended {
          finishSpike(run, state: "idle", message: "The spike Live Activity ended or was dismissed.")
          return
        }
      }
    }
    run.expiry = Task {
      do {
        try await clock.sleep(until: deadline, tolerance: nil)
      } catch { return }
      finishSpike(run, state: "idle", message: "The 15-minute spike expired.")
    }
    run.updates = Task {
      while !Task.isCancelled, spike === run {
        let next = (run.previousAttempt ?? clock.now) + .seconds(3)
        do {
          try await clock.sleep(until: next, tolerance: nil)
        } catch { return }
        guard !Task.isCancelled, spike === run, clock.now < deadline else { return }
        guard activity.activityState != .dismissed, activity.activityState != .ended else {
          finishSpike(run, state: "idle", message: "The spike Live Activity ended or was dismissed.")
          return
        }
        guard run.player?.isPlaying == true else {
          finishSpike(run, state: "error", message: "Silent audio playback stopped.")
          return
        }
        let content = spikeContent(run, operation: "update", staleDate: staleDate)
        await activity.update(content)
        // Record a return even if Stop arrived while the API call was in flight.
        writeSpikeLog(run, operation: "update", phase: "completion", outcome: "returned")
      }
    }
  }

  private func finishSpike(_ run: CarPlaySpikeRun, state: String, message: String) {
    guard spike === run, run.cleanup == nil else { return }
    spikeState = "stopping"
    spikeMessage = message
    // Keep the host runnable while ActivityKit finishes after silent audio stops.
    run.cleanupBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "CarPlay spike cleanup") { [weak run] in
      // UIKit invokes expiration on the main thread. Release before returning.
      MainActor.assumeIsolated {
        run?.releaseCleanupBackgroundTask()
      }
    }
    run.preparation?.cancel()
    run.updates?.cancel()
    run.observation?.cancel()
    run.expiry?.cancel()
    if let interruption = run.interruption {
      NotificationCenter.default.removeObserver(interruption)
      run.interruption = nil
    }
    run.player?.stop()
    run.player = nil
    var audioError: String?
    if run.audioActive {
      do {
        try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      } catch {
        audioError = "Audio deactivation failed: \(error.localizedDescription)"
      }
      run.audioActive = false
    }
    // Keep the reservation until any in-flight ActivityKit update has returned.
    run.cleanup = Task {
      await run.preparation?.value
      await run.updates?.value
      if let activity = run.activity, activity.activityState != .dismissed, activity.activityState != .ended {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      writeSpikeLog(run, operation: "stop", phase: "completion", outcome: state, error: audioError, detail: message)
      run.releaseCleanupBackgroundTask()
      spike = nil
      spikeState = audioError == nil ? state : "error"
      spikeMessage = audioError.map { "\(message) \($0)" } ?? message
      if isForeground, let snapshot, let report {
        _ = await sync(snapshot, retry: false, report: report)
      }
    }
  }

  private func spikeContent(_ run: CarPlaySpikeRun, operation: String, staleDate: Date) -> ActivityContent<LyricsActivityAttributes.ContentState> {
    let now = ContinuousClock.now
    run.elapsedMilliseconds = run.previousAttempt.map {
      let elapsed = $0.duration(to: now).components
      return Double(elapsed.seconds) * 1_000 + Double(elapsed.attoseconds) / 1e15
    }
    run.previousAttempt = now
    let sequence = (run.sample?.sequence ?? 0) + 1
    let sample = LyricsActivityAttributes.SpikeSample(
      lyric: Self.spikeLines[(sequence - 1) % Self.spikeLines.count],
      sequence: sequence, timestamp: spikeTimestamp.string(from: Date())
    )
    run.sample = sample
    writeSpikeLog(run, operation: operation, phase: "attempt", timestamp: sample.timestamp)
    let state = LyricsActivityAttributes.ContentState(
      title: "CarPlay spike", artist: "", album: "", source: "", status: "",
      timingMode: "unknown", isPlaying: false, spikeSample: sample
    )
    return ActivityContent(state: state, staleDate: staleDate, relevanceScore: 100)
  }

  private var spikeLifecycle: String {
    if isForeground { return "active" }
    switch UIApplication.shared.applicationState {
    case .active, .inactive: return "inactive"
    case .background: return "background"
    @unknown default: return "unknown"
    }
  }

  private func spikeLogURL() throws -> URL {
    try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("carplay-spike.jsonl")
  }

  func carPlaySpikeLog() throws -> String {
    let url = try spikeLogURL()
    do {
      return try String(contentsOf: url, encoding: .utf8)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      return ""
    }
  }

  private func writeSpikeLog(_ run: CarPlaySpikeRun, operation: String, phase: String,
                             timestamp: String? = nil, outcome: String? = nil,
                             error: String? = nil, detail: String? = nil) {
    var record: [String: Any] = [
      "runId": run.id, "operation": operation, "phase": phase,
      "timestamp": timestamp ?? spikeTimestamp.string(from: Date()),
      "sequence": run.sample?.sequence ?? 0, "lifecycle": spikeLifecycle,
    ]
    record["elapsedSincePreviousAttemptMs"] = run.elapsedMilliseconds.map { $0 as Any } ?? NSNull()
    record["outcome"] = outcome
    record["error"] = error
    record["detail"] = detail
    do {
      var line = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
      spikeLogger.notice("\(String(decoding: line, as: UTF8.self), privacy: .public)")
      line.append(0x0a)
      let url = try spikeLogURL()
      if FileManager.default.fileExists(atPath: url.path) {
        let file = try FileHandle(forWritingTo: url)
        defer { try? file.close() }
        let size = try file.seekToEnd()
        if size + UInt64(line.count) <= UInt64(Self.spikeLogLimit) {
          try file.write(contentsOf: line)
          return
        }
      }
      try line.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    } catch {
      spikeLogError = "Could not write carplay-spike.jsonl: \(error.localizedDescription)"
      spikeLogger.error("\(error.localizedDescription, privacy: .public)")
    }
  }

  private static func silentWAV() -> Data {
    // Half a second of 8 kHz, mono, signed 16-bit PCM. Zero samples are silence.
    let sampleRate: UInt32 = 8_000
    let bytes = sampleRate / 2 * 2
    var data = Data("RIFF".utf8)
    func append<T: FixedWidthInteger>(_ value: T) {
      var littleEndian = value.littleEndian
      withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }
    append(bytes + 36)
    data.append(contentsOf: "WAVEfmt ".utf8)
    append(UInt32(16))
    append(UInt16(1)) // PCM format
    append(UInt16(1)) // Mono
    append(sampleRate)
    append(sampleRate * 2)
    append(UInt16(2)) // Block alignment
    append(UInt16(16))
    data.append(contentsOf: "data".utf8)
    append(bytes)
    data.append(Data(repeating: 0, count: Int(bytes)))
    return data
  }
}

private struct LyricsSnapshot: Decodable {
  let trackId: String
  let title: String
  let artist: String
  let album: String
  let artworkUrl: String?
  let source: String
  let status: String
  let timingMode: String
  let isPlaying: Bool
}

@MainActor
private final class LyricsActivityController {
  static let shared = LyricsActivityController()
  private let logger = Logger(subsystem: "dev.kineticron.KineSync.live-activity", category: "host")
  private let sessionVersion = "metadata-v1"
  private var activity: Activity<LyricsActivityAttributes>?
  private var snapshot: LyricsSnapshot?
  private var lastState: LyricsActivityAttributes.ContentState?
  private var observation: Task<Void, Never>?
  private var updateTask: Task<Void, Never>?
  private var endingIDs = Set<String>()
  private var revision = 0
  private var artworkKey = ""
  private var artwork: String?
  private var artworkTask: Task<Void, Never>?
  private var suppressedTrack: String?
  private var report: (([String: String]) -> Void)?
  private var status = ["state": "idle", "message": "Open KineSync to show playback details."]
  private var spike: CarPlaySpikeRun?
  private var spikeState = "idle"
  private var spikeMessage = "Ready to start a local Live Activity."
  private var spikeLogError: String?
  private let spikeLogger = Logger(subsystem: "dev.kineticron.KineSync.live-activity", category: "carplay-spike")
  private let spikeTimestamp: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private func setStatus(_ state: String, _ message: String) {
    let next = ["state": state, "message": message]
    if status != next {
      status = next
      report?(next)
    }
  }

  func sync(_ next: LyricsSnapshot, retry: Bool, report: @escaping ([String: String]) -> Void) async -> [String: String] {
    self.report = report
    revision += 1
    let generation = revision
    if retry || snapshot?.trackId != next.trackId { suppressedTrack = nil }
    snapshot = next
    guard spike == nil else { return status }
    loadArtwork(next)

    if let unavailable = activityAvailability() {
      await stop()
      guard spike == nil else { return status }
      setStatus(unavailable.state, unavailable.message)
      return status
    }

    // Restart really creates a fresh presentation. A .active ActivityKit state
    // only acknowledges the session; it does not confirm a widget was rendered.
    if retry {
      await endCurrentActivities()
      guard generation == revision else { return status }
    }
    // Retire outdated presentations, including an orphaned spike after relaunch.
    for existing in Activity<LyricsActivityAttributes>.activities where existing.attributes.session != sessionVersion {
      guard generation == revision, spike == nil else { return status }
      endingIDs.insert(existing.id)
      await existing.end(nil, dismissalPolicy: .immediate)
      endingIDs.remove(existing.id)
    }
    guard generation == revision else { return status }
    // Recover a surviving activity after a JS reload/relaunch and remove duplicates.
    if activity == nil {
      let existing = Activity<LyricsActivityAttributes>.activities.filter {
        $0.attributes.session == sessionVersion && !endingIDs.contains($0.id)
          && ($0.activityState == .active || $0.activityState == .stale)
      }
      if let first = existing.first { adopt(first) }
      for duplicate in existing.dropFirst() {
        await duplicate.end(nil, dismissalPolicy: .immediate)
      }
    }
    guard generation == revision else { return status }
    await publish(generation: generation, mayStart: true)
    return status
  }

  private func activityAvailability() -> (state: String, message: String)? {
    guard let plugins = Bundle.main.builtInPlugInsURL,
          FileManager.default.fileExists(atPath: plugins.appendingPathComponent("KineSyncLyricsWidget.appex").path) else {
      return ("error", "Live Activity widget is missing. Reinstall with Sideloadly's Remove Extensions option disabled.")
    }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      return ("disabled", "Allow Live Activities for KineSync in iOS Settings.")
    }

    // Inspect the installed extension after sideloading, since a signer can
    // rewrite identifiers independently of the original IPA's packaging.
    let widgetURL = plugins.appendingPathComponent("KineSyncLyricsWidget.appex")
    guard let widget = Bundle(url: widgetURL),
          let hostID = Bundle.main.bundleIdentifier,
          let widgetID = widget.bundleIdentifier,
          widgetID.hasPrefix(hostID + "."),
          (widget.infoDictionary?["NSExtension"] as? [String: Any])?["NSExtensionPointIdentifier"] as? String == "com.apple.widgetkit-extension" else {
      return ("error", "Installed lyrics extension has an invalid bundle ID or extension type. Check Sideloadly's extension signing settings.")
    }
    logger.info("Installed host \(hostID, privacy: .public), widget \(widgetID, privacy: .public), iOS \(UIDevice.current.systemVersion, privacy: .public)")

    return nil
  }

  private var isForeground: Bool {
    // Prefer foreground scenes on scene-based iOS versions.
    let scenes = UIApplication.shared.connectedScenes
    return scenes.isEmpty
      ? UIApplication.shared.applicationState == .active
      : scenes.contains { $0.activationState == .foregroundActive }
  }

  private func adopt(_ value: Activity<LyricsActivityAttributes>) {
    activity = value
    lastState = nil
    observation?.cancel()
    observation = Task { [weak self] in
      for await state in value.activityStateUpdates {
        guard !Task.isCancelled, let self, self.activity?.id == value.id else { return }
        if state == .dismissed || state == .ended {
          self.suppressedTrack = self.snapshot?.trackId
          self.activity = nil
          self.setStatus("dismissed", "Live Activity ended.")
          return
        }
      }
    }
  }

  private func publish(generation: Int, mayStart: Bool) async {
    guard generation == revision, spike == nil, let value = snapshot else { return }
    // Keep the existing session when playback disappears or pauses. A local
    // replacement cannot start while the host is in the background.
    let idle = value.trackId.isEmpty
    if let activity, activity.activityState == .dismissed || activity.activityState == .ended {
      suppressedTrack = value.trackId
      self.activity = nil
    }
    if suppressedTrack == value.trackId { return }

    var state = LyricsActivityAttributes.ContentState(
      title: idle ? "KineSync" : value.title, artist: idle ? "" : value.artist,
      album: idle ? "" : value.album, source: value.source,
      status: idle ? "Waiting for a song" : value.status,
      timingMode: idle ? "unknown" : value.timingMode, isPlaying: !idle && value.isPlaying,
      artwork: idle ? nil : artwork
    )
    // Budget the actual Swift Codable JSON, including escaping and multibyte text.
    // Leave >1 KB for immutable attributes and ActivityKit encoding overhead.
    var limit = 240
    repeat {
      state.title = String(state.title.prefix(limit))
      state.artist = String(state.artist.prefix(limit))
      state.album = String(state.album.prefix(limit / 2))
      state.source = String(state.source.prefix(limit / 2))
      state.status = String(state.status.prefix(limit))
      limit /= 2
    } while ((try? JSONEncoder().encode(state).count) ?? Int.max) > 2800 && limit > 0
    guard let encoded = try? JSONEncoder().encode(state), encoded.count <= 2800 else {
      setStatus("error", "Live Activity exceeded the iOS content limit.")
      return
    }
    let content = ActivityContent(state: state, staleDate: nil, relevanceScore: 100)
    if let active = activity {
      if state != lastState {
        // Artwork loading can overlap an incoming track change across await.
        // Serialize ActivityKit writes so the newest snapshot always wins.
        let previous = updateTask
        let update = Task {
          await previous?.value
          guard generation == revision, spike == nil else { return }
          await active.update(content)
        }
        updateTask = update
        await update.value
      }
    } else {
      guard mayStart else {
        setStatus("idle", "Open KineSync to show playback details.")
        return
      }
      guard isForeground else {
        setStatus("waiting", "Open KineSync to start the Live Activity.")
        return
      }
      do {
        adopt(try Activity.request(
          attributes: LyricsActivityAttributes(session: sessionVersion), content: content, pushType: nil
        ))
        logger.info("Requested activity with attributes \(String(reflecting: LyricsActivityAttributes.self), privacy: .public)")
      } catch {
        // Keep the actual ActivityKit reason visible; never silently swallow a failure.
        suppressedTrack = value.trackId
        setStatus("error", "Could not start Live Activity: \(error.localizedDescription)")
        return
      }
    }
    guard generation == revision else { return }
    lastState = state
    setStatus("active", idle ? "Live Activity started - waiting for a song" : state.isPlaying ? "Live Activity started" : "Live Activity paused")
  }

  private func endCurrentActivities(includeSpike: Bool = false) async {
    observation?.cancel()
    activity = nil
    lastState = nil
    let ending = Activity<LyricsActivityAttributes>.activities.filter {
      includeSpike || $0.attributes.session != CarPlaySpikeRun.session
    }
    endingIDs.formUnion(ending.map(\.id))
    await updateTask?.value
    for existing in ending {
      await existing.end(nil, dismissalPolicy: .immediate)
    }
    endingIDs.subtract(ending.map(\.id))
  }

  func stop() async {
    guard spike == nil else { return }
    cancelArtwork()
    revision += 1
    let generation = revision
    await endCurrentActivities()
    guard generation == revision else { return }
    setStatus("idle", "Open KineSync to show playback details.")
  }

  private func cancelArtwork() {
    artworkTask?.cancel()
    artworkKey = ""
    artwork = nil
  }

  private func loadArtwork(_ value: LyricsSnapshot) {
    let source = value.trackId.isEmpty ? "" : value.artworkUrl ?? ""
    let key = value.trackId + "\n" + source
    guard key != artworkKey else { return }
    artworkTask?.cancel()
    artworkKey = key
    artwork = nil // Never display the previous song's cover while loading.
    guard !source.isEmpty else { return }
    artworkTask = Task { [weak self] in
      do {
        let data: Data
        if source.hasPrefix("data:image/"), let comma = source.firstIndex(of: ","),
           source[..<comma].hasSuffix(";base64"), source.utf8.count <= 7_000_000,
           let decoded = Data(base64Encoded: String(source[source.index(after: comma)...])) {
          data = decoded
        } else {
          guard let url = URL(string: source), ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return }
          // HTTP is also used by a paired desktop on the local network.
          let request = URLRequest(url: url, timeoutInterval: 10)
          let (download, response) = try await URLSession.shared.data(for: request)
          guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { return }
          data = download
        }
        guard !Task.isCancelled, data.count <= 5_000_000,
              let encoded = Self.thumbnail(data), let self, self.artworkKey == key else { return }
        self.artwork = encoded
        // A newer playback snapshot can arrive during the download. Publish using
        // its current revision, never the revision that started this request.
        await self.publish(generation: self.revision, mayStart: false)
      } catch {
        // Missing/offline artwork leaves the playback presentation usable.
      }
    }
  }

  private static func thumbnail(_ data: Data) -> String? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    for size in [48, 32] {
      let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: size,
      ]
      guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { continue }
      let image = UIImage(cgImage: cgImage)
      for quality in [0.5, 0.25, 0.1] {
        if let jpeg = image.jpegData(compressionQuality: quality), jpeg.count <= 900 {
          return jpeg.base64EncodedString()
        }
      }
    }
    return nil
  }
}
