import ActivityKit
import KineSyncActivityTypes
import ExpoModulesCore
import Foundation
import UIKit
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
  }
}

private struct LyricsSnapshot: Decodable {
  struct Line: Decodable {
    let startMs: Double
    let endMs: Double
    let text: String
  }
  let trackId: String
  let title: String
  let artist: String
  let album: String
  let source: String
  let status: String
  let timingMode: String
  let instrumental: Bool
  let isPlaying: Bool
  let positionMs: Double
  let durationMs: Double
  let sampledAtMs: Double
  let lines: [Line]?
}

@MainActor
private final class LyricsActivityController {
  static let shared = LyricsActivityController()
  private let logger = Logger(subsystem: "dev.kineticron.KineSync.live-activity", category: "host")
  private let sessionVersion = "lyrics-v4"
  private var activity: Activity<LyricsActivityAttributes>?
  private var snapshot: LyricsSnapshot?
  private var lines: [LyricsSnapshot.Line] = []
  private var anchorUptime = ProcessInfo.processInfo.systemUptime
  private var anchorPositionMs = 0.0
  private var lastState: LyricsActivityAttributes.ContentState?
  private var lastStaleDate: Date?
  private var timer: Task<Void, Never>?
  private var observation: Task<Void, Never>?
  private var updateTask: Task<Void, Never>?
  private var endingIDs = Set<String>()
  private var revision = 0
  private var suppressedTrack: String?
  private var report: (([String: String]) -> Void)?
  private var status = ["state": "idle", "message": "Open KineSync to show live lyrics."]

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
    timer?.cancel()
    if let timeline = next.lines { lines = timeline }
    else if snapshot?.trackId != next.trackId { lines = [] }
    if retry || snapshot?.trackId != next.trackId { suppressedTrack = nil }
    snapshot = next
    anchorUptime = ProcessInfo.processInfo.systemUptime
    let deliveryMs = max(0, min(5000, Date().timeIntervalSince1970 * 1000 - next.sampledAtMs))
    anchorPositionMs = max(0, next.positionMs + (next.isPlaying ? deliveryMs : 0))

    guard let plugins = Bundle.main.builtInPlugInsURL,
          FileManager.default.fileExists(atPath: plugins.appendingPathComponent("KineSyncLyricsWidget.appex").path) else {
      await stop()
      setStatus("error", "Lyrics widget is missing. Reinstall with Sideloadly's Remove Extensions option disabled.")
      return status
    }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      await stop()
      setStatus("disabled", "Allow Live Activities for KineSync in iOS Settings.")
      return status
    }

    // Inspect the installed extension after sideloading, since a signer can
    // rewrite identifiers independently of the original IPA's packaging.
    let widgetURL = plugins.appendingPathComponent("KineSyncLyricsWidget.appex")
    guard let widget = Bundle(url: widgetURL),
          let hostID = Bundle.main.bundleIdentifier,
          let widgetID = widget.bundleIdentifier,
          widgetID.hasPrefix(hostID + "."),
          (widget.infoDictionary?["NSExtension"] as? [String: Any])?["NSExtensionPointIdentifier"] as? String == "com.apple.widgetkit-extension" else {
      await stop()
      setStatus("error", "Installed lyrics extension has an invalid bundle ID or extension type. Check Sideloadly's extension signing settings.")
      return status
    }
    logger.info("Installed host \(hostID, privacy: .public), widget \(widgetID, privacy: .public), iOS \(UIDevice.current.systemVersion, privacy: .public)")

    // Restart really creates a fresh presentation. A .active ActivityKit state
    // only acknowledges the session; it does not confirm a widget was rendered.
    if retry {
      await endCurrentActivities()
      guard generation == revision else { return status }
    }
    // Retire pre-fix presentations after installing a new widget binary.
    for existing in Activity<LyricsActivityAttributes>.activities where existing.attributes.session != sessionVersion {
      endingIDs.insert(existing.id)
      await existing.end(nil, dismissalPolicy: .immediate)
      endingIDs.remove(existing.id)
    }
    guard generation == revision else { return status }
    // Recover a surviving activity after a JS reload/relaunch and remove duplicates.
    if activity == nil {
      let existing = Activity<LyricsActivityAttributes>.activities.filter {
        !endingIDs.contains($0.id) && ($0.activityState == .active || $0.activityState == .stale)
      }
      if let first = existing.first { adopt(first) }
      for duplicate in existing.dropFirst() {
        await duplicate.end(nil, dismissalPolicy: .immediate)
      }
    }
    guard generation == revision else { return status }
    await publish(generation: generation, mayStart: true)
    if generation == revision { schedule(generation: generation) }
    return status
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
          self.timer?.cancel()
          self.setStatus("dismissed", "Live Activity ended. Tap Restart live lyrics to show it again.")
          return
        }
      }
    }
  }

  private func position(_ value: LyricsSnapshot) -> Double {
    let elapsed = value.isPlaying ? (ProcessInfo.processInfo.systemUptime - anchorUptime) * 1000 : 0
    let projected = max(0, anchorPositionMs + elapsed)
    return projected
  }

  // Find the next real line boundary. No per-word or frame-rate ActivityKit updates.
  private func nextBoundary(_ value: LyricsSnapshot, position: Double) -> Double {
    if value.durationMs > 0 && position >= value.durationMs {
      return value.durationMs + 15000
    }
    var boundary = value.durationMs > position ? value.durationMs : position + 30000
    if value.timingMode != "static" {
      for line in lines {
        if line.startMs > position { boundary = min(boundary, line.startMs) }
        if line.endMs > position { boundary = min(boundary, line.endMs) }
      }
    }
    return boundary
  }

  private func publish(generation: Int, mayStart: Bool) async {
    guard generation == revision, let value = snapshot else { return }
    let current = position(value)
    // Keep the existing session when playback disappears or pauses. A local
    // replacement cannot start while the host is in the background.
    let idle = value.trackId.isEmpty
    let finished = value.durationMs > 0 && current >= value.durationMs
    if let activity, activity.activityState == .dismissed || activity.activityState == .ended {
      suppressedTrack = value.trackId
      self.activity = nil
    }
    if suppressedTrack == value.trackId { return }

    let line = idle || value.timingMode == "static" ? nil : lines.first {
      current >= $0.startMs && current < $0.endMs
    }
    let fallback = idle ? "Ready for music" : finished ? "Waiting for next song" : value.instrumental ? "Instrumental" : value.timingMode == "static"
      ? "Lyrics are not timed" : lines.isEmpty ? "Waiting for lyrics" : "Instrumental break"
    var state = LyricsActivityAttributes.ContentState(
      title: idle ? "KineSync" : value.title, artist: idle ? "" : value.artist,
      album: idle ? "" : value.album, source: value.source,
      status: idle ? "Waiting for a song" : value.status,
      lyric: idle || finished ? fallback : line?.text ?? fallback,
      timingMode: idle ? "unknown" : value.timingMode, isPlaying: !idle && value.isPlaying && !finished
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
      state.lyric = String(state.lyric.prefix(limit))
      limit /= 2
    } while ((try? JSONEncoder().encode(state).count) ?? Int.max) > 2800 && limit > 0
    guard let encoded = try? JSONEncoder().encode(state), encoded.count <= 2800 else {
      setStatus("error", "Live lyrics exceeded the iOS content limit.")
      return
    }
    let staleDate: Date? = !idle && value.isPlaying && !finished
      ? Date(timeIntervalSinceNow: max(0.1, (nextBoundary(value, position: current) - current) / 1000) + 1)
      : nil
    // Small clock corrections should not trigger an otherwise identical render.
    let deadlineChanged = abs((staleDate?.timeIntervalSince1970 ?? 0) - (lastStaleDate?.timeIntervalSince1970 ?? 0)) > 1
    let content = ActivityContent(state: state, staleDate: staleDate, relevanceScore: 100)
    if let active = activity {
      if state != lastState || deadlineChanged {
        // A timer update can overlap an incoming seek/track change across await.
        // Serialize ActivityKit writes so the newest snapshot always wins.
        let previous = updateTask
        let update = Task {
          await previous?.value
          guard generation == revision else { return }
          await active.update(content)
        }
        updateTask = update
        await update.value
      }
    } else {
      guard mayStart else {
        setStatus("idle", "Open KineSync to show live lyrics.")
        return
      }
      // SDK 58 uses UIScene on iOS 27. Check foreground scenes directly;
      // retain the application fallback for older lifecycle configurations.
      let scenes = UIApplication.shared.connectedScenes
      let isForeground = scenes.isEmpty
        ? UIApplication.shared.applicationState == .active
        : scenes.contains { $0.activationState == .foregroundActive }
      guard isForeground else {
        setStatus("waiting", "Open KineSync to start live lyrics.")
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
        setStatus("error", "Could not start live lyrics: \(error.localizedDescription)")
        return
      }
    }
    guard generation == revision else { return }
    lastState = state
    lastStaleDate = staleDate
    setStatus("active", idle ? "Live Activity started - waiting for a song" : state.isPlaying ? "Live Activity started" : "Live Activity paused")
  }

  private func schedule(generation: Int) {
    guard activity != nil, let value = snapshot, generation == revision,
          !value.trackId.isEmpty, value.isPlaying else { return }
    let current = position(value)
    // Idle, paused and finished presentations have no timers or stale deadline.
    guard value.durationMs <= 0 || current < value.durationMs else { return }
    let seconds = max(0.1, min(30, (nextBoundary(value, position: current) - current) / 1000))
    timer = Task { [weak self] in
      do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
      catch { return }
      guard !Task.isCancelled, let self, generation == self.revision else { return }
      await self.publish(generation: generation, mayStart: false)
      if !Task.isCancelled { self.schedule(generation: generation) }
    }
  }

  private func endCurrentActivities() async {
    timer?.cancel()
    observation?.cancel()
    activity = nil
    lastState = nil
    lastStaleDate = nil
    let ending = Activity<LyricsActivityAttributes>.activities
    endingIDs.formUnion(ending.map(\.id))
    await updateTask?.value
    for existing in ending {
      await existing.end(nil, dismissalPolicy: .immediate)
    }
    endingIDs.subtract(ending.map(\.id))
  }

  func stop() async {
    revision += 1
    let generation = revision
    await endCurrentActivities()
    guard generation == revision else { return }
    setStatus("idle", "Open KineSync to show live lyrics.")
  }
}
