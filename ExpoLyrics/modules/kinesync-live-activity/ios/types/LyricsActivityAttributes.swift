import ActivityKit
import Foundation

// Compile once as KineSyncActivityTypes and link into both host and widget.
// Copying this source into differently named modules produces distinct types.
public struct LyricsActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public var title: String
    public var artist: String
    public var album: String
    public var source: String
    public var status: String
    public var lyric: String
    public var timingMode: String
    public var isPlaying: Bool

    public init(title: String, artist: String, album: String, source: String,
                status: String, lyric: String, timingMode: String, isPlaying: Bool) {
      self.title = title
      self.artist = artist
      self.album = album
      self.source = source
      self.status = status
      self.lyric = lyric
      self.timingMode = timingMode
      self.isPlaying = isPlaying
    }
  }

  public let session: String
  public init(session: String) { self.session = session }
}
