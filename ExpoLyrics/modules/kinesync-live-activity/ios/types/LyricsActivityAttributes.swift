import ActivityKit
import Foundation

// Compile once as KineSyncActivityTypes and link into both host and widget.
// Copying this source into differently named modules produces distinct types.
public struct LyricsActivityAttributes: ActivityAttributes {
  public struct SpikeSample: Codable, Hashable {
    public let lyric: String
    public let sequence: Int
    public let timestamp: String

    public init(lyric: String, sequence: Int, timestamp: String) {
      self.lyric = lyric
      self.sequence = sequence
      self.timestamp = timestamp
    }
  }

  public struct ContentState: Codable, Hashable {
    public var title: String
    public var artist: String
    public var album: String
    public var source: String
    public var status: String
    public var timingMode: String
    public var isPlaying: Bool
    // Tiny host-generated JPEG; counted in the ActivityKit content budget.
    public var artwork: String?
    public var spikeSample: SpikeSample?

    public init(title: String, artist: String, album: String, source: String,
                status: String, timingMode: String, isPlaying: Bool, artwork: String? = nil,
                spikeSample: SpikeSample? = nil) {
      self.title = title
      self.artist = artist
      self.album = album
      self.source = source
      self.status = status
      self.timingMode = timingMode
      self.isPlaying = isPlaying
      self.artwork = artwork
      self.spikeSample = spikeSample
    }
  }

  public let session: String
  public init(session: String) { self.session = session }
}
