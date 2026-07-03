import ActivityKit
import SwiftUI
import WidgetKit

private enum IslandPalette {
  static let primary = Color.white
  static let secondary = Color.white.opacity(0.78)
  static let muted = Color.white.opacity(0.62)
  static let lyricDim = Color.white.opacity(0.42)
  static let background = Color.black
  static let defaultAccent = Color(red: 0.55, green: 0.36, blue: 0.96)
}

@available(iOS 16.1, *)
struct LiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LiveActivityAttributes.self) { context in
      LiveActivityView(contentState: context.state, attributes: context.attributes)
        .activityBackgroundTint(IslandPalette.background)
        .activitySystemActionForegroundColor(IslandPalette.primary)
        .applyWidgetURL(from: context.attributes.deepLinkUrl)
    } dynamicIsland: { context in
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading, priority: 1) {
          Text(context.state.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "ExpoLyrics" : context.state.title)
            .font(.headline.weight(.semibold))
            .foregroundStyle(IslandPalette.primary)
            .lineLimit(1)
          .dynamicIsland(verticalPlacement: .belowIfTooWide)
          .padding(.leading, 6)
          .applyWidgetURL(from: context.attributes.deepLinkUrl)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Image(systemName: "mic.fill")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(IslandPalette.primary)
            .padding(.trailing, 6)
            .applyWidgetURL(from: context.attributes.deepLinkUrl)
        }
        DynamicIslandExpandedRegion(.bottom) {
          if context.state.lyricsMode != "static" {
            Text(context.state.currentLineText?.isEmpty == false ? context.state.currentLineText! : "Live lyrics are active")
              .font(.footnote.weight(.semibold))
              .foregroundStyle(IslandPalette.primary)
              .lineLimit(2)
            .padding(.horizontal, 6)
            .applyWidgetURL(from: context.attributes.deepLinkUrl)
          }
        }
      } compactLeading: {
        Text("♪")
          .font(.system(size: 16, weight: .bold, design: .rounded))
          .foregroundStyle(IslandPalette.primary)
          .applyWidgetURL(from: context.attributes.deepLinkUrl)
      } compactTrailing: {
        Text("LIVE")
          .font(.system(size: 10, weight: .bold, design: .rounded))
          .foregroundStyle(IslandPalette.primary)
        .applyWidgetURL(from: context.attributes.deepLinkUrl)
      } minimal: {
        Text("♪")
          .font(.system(size: 12, weight: .bold, design: .rounded))
          .foregroundStyle(IslandPalette.primary)
        .applyWidgetURL(from: context.attributes.deepLinkUrl)
      }
      .keylineTint(IslandPalette.primary)
    }
  }

  private func islandAccent(from hex: String?) -> Color {
    hex.map { Color(hex: $0) } ?? IslandPalette.defaultAccent
  }

  @ViewBuilder
  private func compactTrailingView(
    state: LiveActivityAttributes.ContentState,
    timerType: LiveActivityAttributes.DynamicIslandTimerType,
    accent: Color
  ) -> some View {
    if let progress = state.progress {
      Text("\(Int((min(1, max(0, progress))) * 100))%")
        .font(.system(size: 11, weight: .semibold, design: .rounded))
        .foregroundStyle(IslandPalette.primary)
        .monospacedDigit()
        .frame(minWidth: 24)
    } else if let endDate = state.timerEndDateInMilliseconds, timerType == .digital {
      compactTimer(endDate: endDate, timerType: timerType)
    } else {
      lyricsMicIcon(mode: state.lyricsMode, color: accent)
    }
  }

  @ViewBuilder
  private func minimalView(
    state: LiveActivityAttributes.ContentState,
    accent: Color,
    timerType: LiveActivityAttributes.DynamicIslandTimerType
  ) -> some View {
    if timerType == .digital, let endDate = state.timerEndDateInMilliseconds {
      compactTimer(endDate: endDate, timerType: timerType)
    } else {
      lyricsMicIcon(mode: state.lyricsMode, color: IslandPalette.primary)
    }
  }

  @ViewBuilder
  private func compactTimer(
    endDate: Double,
    timerType: LiveActivityAttributes.DynamicIslandTimerType
  ) -> some View {
    if timerType == .digital {
      Text(timerInterval: Date.toTimerInterval(miliseconds: endDate))
        .font(.system(size: 12, weight: .semibold, design: .rounded))
        .monospacedDigit()
        .foregroundStyle(IslandPalette.primary)
        .minimumScaleFactor(0.8)
        .frame(maxWidth: 44)
        .multilineTextAlignment(.trailing)
    } else {
      circularTimer(endDate: endDate)
        .tint(IslandPalette.primary)
    }
  }

  private func circularTimer(endDate: Double) -> some View {
    ProgressView(
      timerInterval: Date.toTimerInterval(miliseconds: endDate),
      countsDown: false,
      label: { EmptyView() },
      currentValueLabel: { EmptyView() }
    )
    .progressViewStyle(.circular)
    .frame(width: 16, height: 16)
  }

  private func lyricsMicIcon(mode: String?, color: Color) -> some View {
    let symbolName = mode == "karaoke" ? "mic.fill" : "mic"
    let opacity = mode == "unknown" ? 0.85 : 1.0

    return Image(systemName: symbolName)
      .font(.system(size: 15, weight: .semibold))
      .symbolRenderingMode(.monochrome)
      .foregroundStyle(color.opacity(opacity))
      .frame(width: 22, height: 22)
  }

  @ViewBuilder
  private func dynamicIslandExpandedLeading(
    title: String,
    artist: String?
  ) -> some View {
    let displayTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ? "ExpoLyrics"
      : title

    VStack(alignment: .leading, spacing: 2) {
      Spacer(minLength: 0)
      Text(displayTitle)
        .font(.headline)
        .foregroundStyle(IslandPalette.primary)
        .fontWeight(.semibold)
        .lineLimit(1)
      if let artist, !artist.isEmpty {
        Text(artist)
          .font(.subheadline)
          .foregroundStyle(IslandPalette.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
  }

  private func dynamicIslandExpandedBottom(
    contentState: LiveActivityAttributes.ContentState,
    source: String?
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if contentState.lyricsMode != "static" {
        if let line = contentState.currentLineText, !line.isEmpty {
          LyricsRevealLineView(
            contentState: contentState,
            brightColor: IslandPalette.primary,
            dimColor: IslandPalette.lyricDim,
            font: .footnote.weight(.semibold),
            lineLimit: 2
          )
        } else {
          Text("Waiting for lyrics")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(IslandPalette.muted)
            .lineLimit(1)
        }
      }

      if let source, !source.isEmpty {
        Text(source)
          .font(.caption2)
          .foregroundStyle(IslandPalette.muted)
          .lineLimit(1)
      }
    }
  }
}
