import ActivityKit
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
    loadArtwork(next)

    guard let plugins = Bundle.main.builtInPlugInsURL,
          FileManager.default.fileExists(atPath: plugins.appendingPathComponent("KineSyncLyricsWidget.appex").path) else {
      await stop()
      setStatus("error", "Live Activity widget is missing. Reinstall with Sideloadly's Remove Extensions option disabled.")
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
    // Retire lyric presentations after installing the metadata-only widget.
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
          self.setStatus("dismissed", "Live Activity ended. Tap Restart Live Activity to show it again.")
          return
        }
      }
    }
  }

  private func publish(generation: Int, mayStart: Bool) async {
    guard generation == revision, let value = snapshot else { return }
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
          guard generation == revision else { return }
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
      // SDK 58 uses UIScene on iOS 27. Check foreground scenes directly;
      // retain the application fallback for older lifecycle configurations.
      let scenes = UIApplication.shared.connectedScenes
      let isForeground = scenes.isEmpty
        ? UIApplication.shared.applicationState == .active
        : scenes.contains { $0.activationState == .foregroundActive }
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

  private func endCurrentActivities() async {
    observation?.cancel()
    activity = nil
    lastState = nil
    let ending = Activity<LyricsActivityAttributes>.activities
    endingIDs.formUnion(ending.map(\.id))
    await updateTask?.value
    for existing in ending {
      await existing.end(nil, dismissalPolicy: .immediate)
    }
    endingIDs.subtract(ending.map(\.id))
  }

  func stop() async {
    artworkTask?.cancel()
    artworkKey = ""
    artwork = nil
    revision += 1
    let generation = revision
    await endCurrentActivities()
    guard generation == revision else { return }
    setStatus("idle", "Open KineSync to show playback details.")
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
