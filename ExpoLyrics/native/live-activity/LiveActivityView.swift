import ActivityKit
import SwiftUI
import WidgetKit

struct LiveActivitySyllableToken: Decodable, Hashable {
  let t: String
  let s: Double
  let e: Double
}

enum LyricsRevealPlayback {
  static func projectedPositionMs(
    at date: Date,
    anchorMs: Double,
    anchorEpochMs: Double,
    isPlaying: Bool
  ) -> Double {
    if !isPlaying {
      return max(0, anchorMs)
    }
    let elapsed = date.timeIntervalSince1970 * 1000 - anchorEpochMs
    return max(0, anchorMs + elapsed)
  }

  static func lineProgress(positionMs: Double, startMs: Double, endMs: Double) -> Double {
    let duration = max(1, endMs - startMs)
    return min(1, max(0, (positionMs - startMs) / duration))
  }

  static func parseSyllables(_ payload: String?) -> [LiveActivitySyllableToken] {
    guard let payload, !payload.isEmpty, let data = payload.data(using: .utf8) else {
      return []
    }
    return (try? JSONDecoder().decode([LiveActivitySyllableToken].self, from: data)) ?? []
  }
}

struct LyricsRevealSweepText: View {
  let text: String
  let progress: Double
  let brightColor: Color
  let dimColor: Color
  var font: Font = .subheadline.weight(.semibold)
  var lineLimit: Int = 2

  var body: some View {
    ZStack(alignment: .leading) {
      Text(text)
        .font(font)
        .foregroundStyle(dimColor)
        .lineLimit(lineLimit)
        .multilineTextAlignment(.leading)

      Text(text)
        .font(font)
        .foregroundStyle(brightColor)
        .lineLimit(lineLimit)
        .multilineTextAlignment(.leading)
        .mask(alignment: .leading) {
          GeometryReader { proxy in
            Rectangle()
              .frame(width: max(0, proxy.size.width * min(1, max(0, progress))))
          }
        }
    }
  }
}

struct LyricsKaraokeRevealRow: View {
  let syllables: [LiveActivitySyllableToken]
  let positionMs: Double
  let brightColor: Color
  let dimColor: Color
  var font: Font = .subheadline.weight(.semibold)
  var lineLimit: Int = 2

  var body: some View {
    HStack(spacing: 0) {
      ForEach(Array(syllables.enumerated()), id: \.offset) { _, syllable in
        let progress = LyricsRevealPlayback.lineProgress(
          positionMs: positionMs,
          startMs: syllable.s,
          endMs: syllable.e
        )
        LyricsRevealSweepText(
          text: syllable.t,
          progress: progress,
          brightColor: brightColor,
          dimColor: dimColor,
          font: font,
          lineLimit: 1
        )
        .fixedSize(horizontal: true, vertical: false)
      }
    }
    .lineLimit(lineLimit)
  }
}

struct LyricsRevealLineView: View {
  let contentState: LiveActivityAttributes.ContentState
  let brightColor: Color
  let dimColor: Color
  var font: Font = .subheadline.weight(.semibold)
  var lineLimit: Int = 2

  var body: some View {
    if let text = contentState.currentLineText, !text.isEmpty,
       let anchorMs = contentState.playbackAnchorMs,
       let anchorEpochMs = contentState.playbackAnchorEpochMs {
      TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: false)) { timeline in
        let positionMs = LyricsRevealPlayback.projectedPositionMs(
          at: timeline.date,
          anchorMs: anchorMs,
          anchorEpochMs: anchorEpochMs,
          isPlaying: contentState.isPlayingLive ?? false
        )

        if contentState.lyricsMode == "karaoke",
           !LyricsRevealPlayback.parseSyllables(contentState.syllablePayload).isEmpty {
          LyricsKaraokeRevealRow(
            syllables: LyricsRevealPlayback.parseSyllables(contentState.syllablePayload),
            positionMs: positionMs,
            brightColor: brightColor,
            dimColor: dimColor,
            font: font,
            lineLimit: lineLimit
          )
        } else {
          let startMs = contentState.lineStartMs ?? 0
          let endMs = contentState.lineEndMs ?? startMs
          let progress = LyricsRevealPlayback.lineProgress(
            positionMs: positionMs,
            startMs: startMs,
            endMs: endMs
          )
          LyricsRevealSweepText(
            text: text,
            progress: progress,
            brightColor: brightColor,
            dimColor: dimColor,
            font: font,
            lineLimit: lineLimit
          )
        }
      }
    } else if let text = contentState.currentLineText, !text.isEmpty {
      Text(text)
        .font(font)
        .foregroundStyle(brightColor)
        .lineLimit(lineLimit)
        .multilineTextAlignment(.leading)
    }
  }
}

struct LiveActivityView: View {
  let contentState: LiveActivityAttributes.ContentState
  let attributes: LiveActivityAttributes

  private let primaryText = Color.white
  private let secondaryText = Color.white.opacity(0.78)
  private let mutedText = Color.white.opacity(0.62)
  private let dimLyricText = Color.white.opacity(0.42)

  var micAccent: Color {
    attributes.progressViewTint.map { Color(hex: $0) }
      ?? Color(red: 0.55, green: 0.36, blue: 0.96)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 12) {
        lyricsMicIcon(mode: contentState.lyricsMode, color: micAccent)

        VStack(alignment: .leading, spacing: 2) {
          Text(displayTitle)
            .font(.headline)
            .fontWeight(.semibold)
            .foregroundStyle(primaryText)

          if let artist = displayArtist {
            Text(artist)
              .font(.subheadline)
              .foregroundStyle(secondaryText)
          }

          if let source = contentState.source, !source.isEmpty {
            Text(source)
              .font(.caption)
              .foregroundStyle(mutedText)
          }
        }

        Spacer(minLength: 0)
      }

      if contentState.lyricsMode != "static" {
        Text(contentState.currentLineText?.isEmpty == false ? contentState.currentLineText! : "Live lyrics are active")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(primaryText)
          .lineLimit(2)
      }

      if let progress = contentState.progress {
        ProgressView(value: progress)
          .tint(primaryText)
      }
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 16)
    .background(Color.black)
  }

  private var displayTitle: String {
    let trimmed = contentState.title.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "ExpoLyrics" : trimmed
  }

  private var displayArtist: String? {
    let trimmed = contentState.subtitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? nil : trimmed
  }

  private func lyricsMicIcon(mode: String?, color: Color) -> some View {
    let symbolName = mode == "karaoke" ? "mic.fill" : "mic"
    let opacity = mode == "unknown" ? 0.45 : 1.0

    return Image(systemName: symbolName)
      .font(.system(size: 22, weight: .semibold))
      .foregroundStyle(color.opacity(opacity))
      .frame(width: 28, height: 28)
  }
}
