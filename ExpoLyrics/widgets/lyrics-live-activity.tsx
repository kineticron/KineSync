import {
  HStack,
  Image,
  ProgressView,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  activityBackgroundTint,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  minimumScaleFactor,
  monospacedDigit,
  padding,
  progressViewStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  type LiveActivityEnvironment,
} from "expo-widgets";

export type LyricsLiveActivityProps = {
  title: string;
  subtitle: string;
  source: string;
  lyricsMode: "karaoke" | "interpolated" | "static" | "unknown";
  currentLineText: string;
  isPlaying: boolean;
  progress: number;
  accentHex: string;
};

const LyricsLiveActivity = (
  props: LyricsLiveActivityProps,
  environment: LiveActivityEnvironment,
) => {
  "widget";

  const primary = "#FFFFFF";
  const secondary = environment.isLuminanceReduced ? "#A3A3A3" : "#C7C7CC";
  const muted = environment.isLuminanceReduced ? "#737373" : "#8E8E93";
  const accent = `#${props.accentHex || "8B5CF6"}`;
  const title = props.title || "KineSync";
  const artist = props.subtitle || "Unknown artist";
  const source = props.source || "KineSync";
  const lyric =
    props.currentLineText ||
    (props.lyricsMode === "static"
      ? "Lyrics are available in KineSync"
      : "Waiting for the next lyric…");
  const progress = Math.min(1, Math.max(0, props.progress || 0));
  const progressPercent = Math.round(progress * 100);

  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={10}
        modifiers={[
          padding({ horizontal: 18, vertical: 16 }),
          activityBackgroundTint("#000000"),
        ]}>
        <HStack alignment="center" spacing={12}>
          <Image systemName="mic.fill" size={24} color={accent} />
          <VStack alignment="leading" spacing={2}>
            <Text
              modifiers={[
                font({ textStyle: "headline", weight: "semibold" }),
                foregroundStyle(primary),
                lineLimit(1),
              ]}>
              {title}
            </Text>
            <Text
              modifiers={[
                font({ textStyle: "subheadline" }),
                foregroundStyle(secondary),
                lineLimit(1),
              ]}>
              {artist}
            </Text>
          </VStack>
          <Spacer minLength={4} />
          <Image
            systemName={props.isPlaying ? "waveform" : "pause.fill"}
            size={16}
            color={primary}
          />
        </HStack>
        <Text
          modifiers={[
            font({ textStyle: "subheadline", weight: "semibold" }),
            foregroundStyle(primary),
            lineLimit(2),
          ]}>
          {lyric}
        </Text>
        <ProgressView
          value={progress}
          modifiers={[
            progressViewStyle("linear"),
            tint(accent),
            frame({ maxWidth: 460 }),
          ]}
        />
        <Text
          modifiers={[
            font({ textStyle: "caption2" }),
            foregroundStyle(muted),
            lineLimit(1),
          ]}>
          {source}
        </Text>
      </VStack>
    ),
    compactLeading: <Image systemName="mic.fill" size={15} color={accent} />,
    compactTrailing: (
      <Text
        modifiers={[
          font({ size: 11, weight: "semibold", design: "rounded" }),
          foregroundStyle(primary),
          monospacedDigit(),
          minimumScaleFactor(0.8),
          frame({ minWidth: 28 }),
        ]}>
        {progressPercent}%
      </Text>
    ),
    minimal: <Image systemName="mic.fill" size={13} color={accent} />,
    expandedLeading: (
      <VStack
        alignment="leading"
        spacing={3}
        modifiers={[padding({ leading: 6, top: 4 })]}>
        <Image systemName="mic.fill" size={18} color={accent} />
        <Text
          modifiers={[
            font({ size: 11, weight: "semibold" }),
            foregroundStyle(secondary),
            lineLimit(1),
          ]}>
          KineSync
        </Text>
      </VStack>
    ),
    expandedTrailing: (
      <VStack
        alignment="trailing"
        spacing={3}
        modifiers={[padding({ trailing: 6, top: 4 })]}>
        <Image
          systemName={props.isPlaying ? "waveform" : "pause.fill"}
          size={17}
          color={primary}
        />
        <Text
          modifiers={[
            font({ size: 11, weight: "semibold", design: "rounded" }),
            foregroundStyle(secondary),
            monospacedDigit(),
          ]}>
          {progressPercent}%
        </Text>
      </VStack>
    ),
    expandedBottom: (
      <VStack
        alignment="leading"
        spacing={7}
        modifiers={[padding({ horizontal: 6, top: 5, bottom: 7 })]}>
        <HStack alignment="firstTextBaseline" spacing={8}>
          <VStack alignment="leading" spacing={1}>
            <Text
              modifiers={[
                font({ textStyle: "headline", weight: "semibold" }),
                foregroundStyle(primary),
                lineLimit(1),
              ]}>
              {title}
            </Text>
            <Text
              modifiers={[
                font({ textStyle: "caption" }),
                foregroundStyle(secondary),
                lineLimit(1),
              ]}>
              {artist}
            </Text>
          </VStack>
          <Spacer minLength={0} />
          <Text
            modifiers={[
              font({ size: 10 }),
              foregroundStyle(muted),
              lineLimit(1),
            ]}>
            {source}
          </Text>
        </HStack>
        <Text
          modifiers={[
            font({ textStyle: "footnote", weight: "semibold" }),
            foregroundStyle(primary),
            lineLimit(2),
          ]}>
          {lyric}
        </Text>
        <ProgressView
          value={progress}
          modifiers={[
            progressViewStyle("linear"),
            tint(accent),
            frame({ maxWidth: 460 }),
          ]}
        />
      </VStack>
    ),
  };
};

export default createLiveActivity<LyricsLiveActivityProps>(
  "KineSyncLyrics",
  LyricsLiveActivity,
);
