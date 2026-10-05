import ActivityKit
import SwiftUI
import os

// CI-only host for the real widget. Does not include React Native, cookies,
// Spotify, pairing credentials, or a network-dependent playback fixture.
@main
struct PreviewApp: App {
  var body: some Scene {
    WindowGroup {
      Text("KineSync Live Activity preview")
        .task {
          do {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            for activity in Activity<LyricsActivityAttributes>.activities {
              await activity.end(nil, dismissalPolicy: .immediate)
            }
            let state = LyricsActivityAttributes.ContentState(
              title: "KineSync", artist: "Widget preview", album: "",
              source: "Preview", status: "", lyric: "Live lyrics are ready",
              timingMode: "karaoke", isPlaying: true
            )
            let activity = try Activity.request(
              attributes: LyricsActivityAttributes(session: "lyrics-v2"),
              content: ActivityContent(state: state, staleDate: nil), pushType: nil
            )
            Logger(subsystem: "dev.kineticron.KineSync.live-activity", category: "preview")
              .info("Started preview \(activity.id, privacy: .public)")
          } catch {
            Logger(subsystem: "dev.kineticron.KineSync.live-activity", category: "preview")
              .error("Preview failed: \(error.localizedDescription, privacy: .public)")
          }
        }
    }
  }
}
