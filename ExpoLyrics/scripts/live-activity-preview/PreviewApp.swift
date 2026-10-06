import ActivityKit
import KineSyncActivityTypes
import SwiftUI
import os

// CI-only host for the real widget. Does not include React Native, cookies,
// Spotify, pairing credentials, or a network-dependent playback fixture.
@main
struct PreviewApp: App {
  @State private var status = "Starting Live Activity"
  var body: some Scene {
    WindowGroup {
      Text(status)
        .task {
          do {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            for activity in Activity<LyricsActivityAttributes>.activities {
              await activity.end(nil, dismissalPolicy: .immediate)
            }
            let state = LyricsActivityAttributes.ContentState(
              title: "KineSync", artist: "", album: "",
              source: "Preview", status: "Waiting for a song", lyric: "Ready for music",
              timingMode: "unknown", isPlaying: false
            )
            let activity = try Activity.request(
              attributes: LyricsActivityAttributes(session: "lyrics-v4"),
              content: ActivityContent(state: state, staleDate: nil), pushType: nil
            )
            status = "Started Live Activity: \(activity.id)"
            Logger(subsystem: "dev.kineticron.KineSync.live-activity", category: "preview")
              .info("Started preview \(activity.id, privacy: .public)")
          } catch {
            status = "Live Activity failed: \(error.localizedDescription)"
            Logger(subsystem: "dev.kineticron.KineSync.live-activity", category: "preview")
              .error("Preview failed: \(error.localizedDescription, privacy: .public)")
          }
        }
    }
  }
}
