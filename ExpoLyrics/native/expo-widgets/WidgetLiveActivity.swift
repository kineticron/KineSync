import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

// KineSyncDirectLiveActivityRenderer
//
// expo-widgets normally loads the serialized layout from an App Group and
// evaluates it with ExpoWidgets.bundle. Re-signers such as Sideloadly may not
// preserve the App Group entitlement, and a missing runtime bundle otherwise
// causes WidgetLiveActivity to render EmptyView. KineSync's activity state
// already contains everything needed to render, so decode it directly here.

struct LiveActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var name: String
    var props: String
  }
}

private struct KineSyncLyricsActivityState: Decodable {
  var title: String
  var subtitle: String
  var source: String
  var lyricsMode: String
  var currentLineText: String
  var isPlaying: Bool
  var progress: Double
  var accentHex: String

  static let fallback = KineSyncLyricsActivityState(
    title: "KineSync",
    subtitle: "Live lyrics",
    source: "KineSync",
    lyricsMode: "unknown",
    currentLineText: "Waiting for lyrics…",
    isPlaying: false,
    progress: 0,
    accentHex: "8B5CF6"
  )

  var displayTitle: String {
    title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "KineSync" : title
  }

  var displaySubtitle: String {
    subtitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ? "Unknown artist"
      : subtitle
  }

  var displaySource: String {
    source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "KineSync" : source
  }

  var displayLyric: String {
    if !currentLineText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return currentLineText
    }
    return lyricsMode == "static"
      ? "Lyrics are available in KineSync"
      : "Waiting for the next lyric…"
  }

  var clampedProgress: Double {
    min(1, max(0, progress))
  }

  var accent: Color {
    Color(kineSyncHex: accentHex)
  }
}

private extension Color {
  init(kineSyncHex value: String) {
    let cleaned = value.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var rgb: UInt64 = 0x8B5CF6
    if cleaned.count == 6 {
      Scanner(string: cleaned).scanHexInt64(&rgb)
    }
    self.init(
      red: Double((rgb >> 16) & 0xFF) / 255,
      green: Double((rgb >> 8) & 0xFF) / 255,
      blue: Double(rgb & 0xFF) / 255
    )
  }
}

private func decodeKineSyncState(_ contextState: LiveActivityAttributes.ContentState)
  -> KineSyncLyricsActivityState
{
  guard contextState.name == "KineSyncLyrics",
        let data = contextState.props.data(using: .utf8),
        let state = try? JSONDecoder().decode(KineSyncLyricsActivityState.self, from: data)
  else {
    print("[KineSyncDirectLiveActivityRenderer] Falling back to placeholder content")
    return .fallback
  }
  return state
}

@available(iOS 16.1, *)
public struct WidgetLiveActivity: Widget {
  public init() {}

  public var body: some WidgetConfiguration {
    ActivityConfiguration(for: LiveActivityAttributes.self) { context in
      KineSyncLiveActivityBanner(state: decodeKineSyncState(context.state))
        .activityBackgroundTint(.black)
        .activitySystemActionForegroundColor(.white)
        .widgetURL(URL(string: "expolyrics:///"))
    } dynamicIsland: { context in
      let state = decodeKineSyncState(context.state)

      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          VStack(alignment: .leading, spacing: 3) {
            Image(systemName: "mic.fill")
              .font(.system(size: 18, weight: .semibold))
              .foregroundStyle(state.accent)
            Text("KineSync")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(.white.opacity(0.72))
              .lineLimit(1)
          }
          .padding(.leading, 6)
          .padding(.top, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          VStack(alignment: .trailing, spacing: 3) {
            Image(systemName: state.isPlaying ? "waveform" : "pause.fill")
              .font(.system(size: 17, weight: .semibold))
              .foregroundStyle(.white)
            Text("\(Int(state.clampedProgress * 100))%")
              .font(.caption2.weight(.semibold).monospacedDigit())
              .foregroundStyle(.white.opacity(0.72))
          }
          .padding(.trailing, 6)
          .padding(.top, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          KineSyncLiveActivityExpandedBottom(state: state)
        }
      } compactLeading: {
        Image(systemName: "mic.fill")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(state.accent)
      } compactTrailing: {
        Text("\(Int(state.clampedProgress * 100))%")
          .font(.system(size: 11, weight: .semibold, design: .rounded))
          .foregroundStyle(.white)
          .monospacedDigit()
          .frame(minWidth: 28)
      } minimal: {
        Image(systemName: "mic.fill")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(state.accent)
      }
      .keylineTint(state.accent)
      .widgetURL(URL(string: "expolyrics:///"))
    }
  }
}

@available(iOS 16.1, *)
private struct KineSyncLiveActivityBanner: View {
  let state: KineSyncLyricsActivityState

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .center, spacing: 12) {
        Image(systemName: "mic.fill")
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(state.accent)
          .frame(width: 28, height: 28)

        VStack(alignment: .leading, spacing: 2) {
          Text(state.displayTitle)
            .font(.headline.weight(.semibold))
            .foregroundStyle(.white)
            .lineLimit(1)
          Text(state.displaySubtitle)
            .font(.subheadline)
            .foregroundStyle(.white.opacity(0.78))
            .lineLimit(1)
        }

        Spacer(minLength: 4)

        Image(systemName: state.isPlaying ? "waveform" : "pause.fill")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(.white)
      }

      Text(state.displayLyric)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.white)
        .lineLimit(2)

      ProgressView(value: state.clampedProgress)
        .tint(state.accent)

      Text(state.displaySource)
        .font(.caption2)
        .foregroundStyle(.white.opacity(0.58))
        .lineLimit(1)
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 16)
  }
}

@available(iOS 16.1, *)
private struct KineSyncLiveActivityExpandedBottom: View {
  let state: KineSyncLyricsActivityState

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        VStack(alignment: .leading, spacing: 1) {
          Text(state.displayTitle)
            .font(.headline.weight(.semibold))
            .foregroundStyle(.white)
            .lineLimit(1)
          Text(state.displaySubtitle)
            .font(.caption)
            .foregroundStyle(.white.opacity(0.72))
            .lineLimit(1)
        }

        Spacer(minLength: 0)

        Text(state.displaySource)
          .font(.caption2)
          .foregroundStyle(.white.opacity(0.58))
          .lineLimit(1)
      }

      Text(state.displayLyric)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.white)
        .lineLimit(2)

      ProgressView(value: state.clampedProgress)
        .tint(state.accent)
    }
    .padding(.horizontal, 6)
    .padding(.top, 5)
    .padding(.bottom, 7)
  }
}
