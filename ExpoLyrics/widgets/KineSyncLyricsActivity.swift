import ActivityKit
import KineSyncActivityTypes
import SwiftUI
import WidgetKit
import UIKit
import os

@main
struct KineSyncLyricsWidgetBundle: WidgetBundle {
  init() {
    Logger(subsystem: "dev.kineticron.KineSync.live-activity", category: "widget")
      .info("Registered widget for \(String(reflecting: LyricsActivityAttributes.self), privacy: .public)")
  }
  var body: some Widget { KineSyncLyricsActivity() }
}

struct KineSyncLyricsActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LyricsActivityAttributes.self) { context in
      LyricsBanner(state: context.state)
        .activityBackgroundTint(.black)
        .activitySystemActionForegroundColor(.white)
        .widgetURL(URL(string: "expolyrics://"))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 6) {
            LyricsArtwork(state: context.state, size: 28)
            Text("KineSync").font(.system(size: 11, weight: .semibold))
              .foregroundColor(.white).lineLimit(1)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          Image(systemName: context.state.isPlaying ? "play.fill" : "pause.fill")
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(.white)
            .frame(width: 24, height: 24)
            .accessibilityLabel(context.state.isPlaying ? "Playing" : "Paused")
        }
        DynamicIslandExpandedRegion(.bottom) {
          LyricsDetails(state: context.state)
            // Keep the footer clear of the Island's curved lower corners.
            .padding(.horizontal, 14)
            .padding(.bottom, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        // Apple's smaller reference device offers 52.33 x 36.67 pt per side.
        LyricsArtwork(state: context.state, size: 24)
      } compactTrailing: {
        Image(systemName: context.state.isPlaying ? "play.fill" : context.state.artist.isEmpty ? "music.note" : "pause.fill")
          .font(.system(size: 12, weight: .semibold))
          .foregroundColor(.white)
          .frame(width: 24, height: 24)
          .accessibilityLabel(context.state.isPlaying ? "Playing" : context.state.artist.isEmpty ? "Ready for music" : "Paused")
      } minimal: {
        Text("KS").font(.system(size: 12, weight: .bold)).foregroundColor(.white)
      }
      .widgetURL(URL(string: "expolyrics://"))
      .keylineTint(.white)
    }
  }
}

private struct LyricsBanner: View {
  let state: LyricsActivityAttributes.ContentState
  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      LyricsArtwork(state: state, size: 44)
      VStack(alignment: .leading, spacing: 4) {
        Text("KineSync").font(.system(size: 10, weight: .semibold))
          .foregroundColor(.white.opacity(0.65))
        LyricsDetails(state: state)
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(14)
    // Includes padding; below Apple's 160 pt maximum Lock Screen height.
    .frame(height: 110, alignment: .top)
    .clipped()
  }
}

private struct LyricsDetails: View {
  let state: LyricsActivityAttributes.ContentState
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(state.title.isEmpty ? "KineSync" : state.artist.isEmpty ? state.title : "\(state.title) · \(state.artist)")
        .font(.system(size: 12, weight: .semibold))
        .lineLimit(1)
        .frame(height: 15, alignment: .leading)
      Text("\(state.isPlaying || state.artist.isEmpty ? "" : "Paused · ")\(state.source)")
        .font(.system(size: 10, weight: .medium)).lineLimit(1)
        .foregroundColor(.white.opacity(0.8))
        .frame(height: 13, alignment: .leading)
      if !state.album.isEmpty {
        Text(state.album).font(.system(size: 10)).lineLimit(1).foregroundColor(.white.opacity(0.65))
          .frame(height: 13, alignment: .leading)
      }
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

private struct LyricsArtwork: View {
  let state: LyricsActivityAttributes.ContentState
  let size: CGFloat
  var body: some View {
    Group {
      if let artwork = state.artwork, let data = Data(base64Encoded: artwork),
         let image = UIImage(data: data) {
        Image(uiImage: image).resizable().scaledToFill()
          .accessibilityLabel("Album artwork")
      } else {
        LyricsMicrophone(mode: state.timingMode)
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: 5))
  }
}

// SwiftUI version of components/lyrics/lyrics-type-icon.tsx: diagonal handheld
// mic, outlined for line timing; filled with sparkles for karaoke. No font/bitmap
// assets, network access, App Group, or JS runtime is needed by the extension.
private struct LyricsMicrophone: View {
  let mode: String
  private var filled: Bool { mode == "karaoke" }
  var body: some View {
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
    .opacity(mode == "unknown" ? 0.6 : 1)
    .accessibilityLabel(filled ? "Karaoke lyrics" : mode == "static" ? "Static lyrics" : "Line lyrics")
  }
}
