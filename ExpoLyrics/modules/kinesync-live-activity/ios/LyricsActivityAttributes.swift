import ActivityKit
import Foundation

// This SAME file is compiled into the host module and the WidgetKit extension.
// Keep the timeline in the host; only this small state travels through ActivityKit.
struct LyricsActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var title: String
    var artist: String
    var album: String
    var source: String
    var status: String
    var lyric: String
    var timingMode: String
    var isPlaying: Bool
  }

  let session: String
}
