import ActivityKit
import SwiftUI
import WidgetKit

@main
struct KineSyncLyricsWidgetBundle: WidgetBundle {
  var body: some Widget { KineSyncLyricsActivity() }
}

struct KineSyncLyricsActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LyricsActivityAttributes.self) { context in
      LyricsBanner(state: context.state, stale: context.isStale)
        .activityBackgroundTint(.black)
        .activitySystemActionForegroundColor(.white)
        .widgetURL(URL(string: "expolyrics://"))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          LyricsMicrophone(mode: context.state.timingMode).frame(width: 24, height: 24)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Image(systemName: context.state.isPlaying ? "play.fill" : "pause.fill")
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(.white)
            .frame(width: 24, height: 24)
            .accessibilityLabel(context.state.isPlaying ? "Playing" : "Paused")
        }
        DynamicIslandExpandedRegion(.bottom) {
          LyricsDetails(state: context.state, stale: context.isStale)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: 108, alignment: .top)
            .clipped()
        }
      } compactLeading: {
        // Apple's smaller reference device offers 52.33 x 36.67 pt per side.
        LyricsMicrophone(mode: context.state.timingMode).frame(width: 22, height: 22)
      } compactTrailing: {
        Text(context.isStale ? "Open" : context.state.isPlaying ? context.state.lyric : "Paused")
          .font(.system(size: 12, weight: .semibold))
          .foregroundColor(.white)
          .lineLimit(1)
          .truncationMode(.tail)
          .frame(width: 48, height: 28)
          .clipped()
      } minimal: {
        LyricsMicrophone(mode: context.state.timingMode).frame(width: 22, height: 22)
      }
      .widgetURL(URL(string: "expolyrics://"))
      .keylineTint(.white)
    }
  }
}

private struct LyricsBanner: View {
  let state: LyricsActivityAttributes.ContentState
  let stale: Bool
  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      LyricsMicrophone(mode: state.timingMode).frame(width: 28, height: 28)
      LyricsDetails(state: state, stale: stale)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(14)
    // Includes padding; below Apple's 160 pt maximum Lock Screen height.
    .frame(height: 140, alignment: .top)
    .clipped()
  }
}

private struct LyricsDetails: View {
  let state: LyricsActivityAttributes.ContentState
  let stale: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text("\(state.title) · \(state.artist)")
        .font(.system(size: 12, weight: .semibold))
        .lineLimit(1)
        .frame(height: 15, alignment: .leading)
      if !state.album.isEmpty {
        Text(state.album).font(.system(size: 10)).lineLimit(1).foregroundColor(.white.opacity(0.65))
          .frame(height: 13, alignment: .leading)
      }
      Text(stale ? "Open KineSync to refresh lyrics" : state.lyric)
        .font(.system(size: 17, weight: .bold))
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: 42, alignment: .leading)
      Text("\(state.isPlaying ? "" : "Paused · ")\(state.source)")
        .font(.system(size: 10, weight: .medium)).lineLimit(1)
        .foregroundColor(.white.opacity(0.8))
        .frame(height: 13, alignment: .leading)
      if !state.status.isEmpty {
        Text(state.status).font(.system(size: 10)).lineLimit(1).foregroundColor(.white.opacity(0.65))
          .frame(height: 13, alignment: .leading)
      }
    }
    .foregroundColor(.white)
    .truncationMode(.tail)
    .multilineTextAlignment(.leading)
    // Fixed point sizes keep every presentation inside its system budget.
    .dynamicTypeSize(.large)
  }
}

// SwiftUI version of components/lyrics/lyrics-type-icon.tsx: diagonal handheld
// mic, outlined for line timing; filled with sparkles for karaoke. No font/bitmap
// assets, network access, App Group, or JS runtime is needed by the extension.
private struct LyricsMicrophone: View {
  let mode: String
  private var filled: Bool { mode == "karaoke" }
  var body: some View {
    GeometryReader { geometry in
      ZStack {
        VStack(spacing: -0.5) {
          ZStack {
            Circle().stroke(Color.white, lineWidth: 1.7)
            if filled { Circle().fill(Color.white) }
          }.frame(width: 10, height: 10)
          if !filled {
            Capsule().stroke(Color.white, lineWidth: 1).frame(width: 7, height: 2)
          }
          ZStack {
            RoundedRectangle(cornerRadius: 2).stroke(Color.white, lineWidth: 1.5)
            if filled { RoundedRectangle(cornerRadius: 2).fill(Color.white) }
          }.frame(width: 4, height: 11)
        }
        .rotationEffect(.degrees(45))
        if filled {
          Image(systemName: "sparkle").font(.system(size: 6)).offset(x: -8, y: -8)
          Image(systemName: "sparkle").font(.system(size: 5)).offset(x: 8, y: 8)
        }
      }
      .foregroundColor(.white)
      .frame(width: 24, height: 24)
      .scaleEffect(min(geometry.size.width, geometry.size.height) / 24)
      .frame(width: geometry.size.width, height: geometry.size.height)
    }
    .opacity(mode == "unknown" ? 0.6 : 1)
    .accessibilityLabel(filled ? "Karaoke lyrics" : mode == "static" ? "Static lyrics" : "Line lyrics")
  }
}
