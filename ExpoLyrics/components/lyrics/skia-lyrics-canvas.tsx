import { memo, useEffect, useMemo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import {
  Canvas,
  Group,
  Paragraph as SkiaParagraph,
  Shadow,
  Skia,
  TextAlign,
  rect,
  vec,
  type SkParagraph,
  type SkRect,
} from "@shopify/react-native-skia";
import {
  cancelAnimation,
  Easing as ReanimatedEasing,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { getGraphemeCount, getGraphemes } from "@/lib/graphemes";
import type { LyricSyllable } from "@/types/bridge";

const BASE_FONT_SIZE = 32;
const BASE_LINE_HEIGHT = 42;
const SCALE_ACTIVE = 1.05;
const COLOR_ACTIVE_PENDING = "rgba(255,255,255,0.5)";
const COLOR_ACTIVE_PROGRESS = "#FFFFFF";
const SUSTAIN_MS_THRESHOLD = 680;
const MIN_MS_PER_CHAR_FOR_LETTER_SWEEP = 220;
const MAX_LETTER_SWEEP_CHARS = 5;
const WORD_SUSTAIN_MIN_MS = 920;
const SUSTAIN_SHORT_SCALE_BOOST = 0.068;
const SUSTAIN_LONG_SCALE_BOOST = 0.04;
const SUSTAIN_LONG_MS = 1200;
const SUSTAIN_GLOW_RADIUS_MAX = 7;
const EFFECT_PADDING = 12;
const WORD_JOINER = "\u2060";
const ZERO_WIDTH_BREAK = "\u200b";
const NO_BREAK_SPACE = "\u00a0";
const REVEAL_SWEEP_EASING = ReanimatedEasing.out(ReanimatedEasing.ease);

type SustainMode = "none" | "solo" | "letter-sweep";

type GlyphLayout = {
  rect: SkRect;
  revealStart: number;
  charIndex: number;
  totalChars: number;
};

type SyllableLayout = {
  startTime: number;
  endTime: number;
  durationMs: number;
  sustainMode: SustainMode;
  rects: SkRect[];
  rectRevealStarts: number[];
  revealWidth: number;
  glyphs: GlyphLayout[];
};

type PendingSyllableLayout = Omit<
  SyllableLayout,
  "rects" | "rectRevealStarts" | "revealWidth" | "glyphs"
> & {
  textStart: number;
  textEnd: number;
  glyphRanges: { start: number; end: number }[];
};

export type WordGroup = {
  syllableIndexes: number[];
  clusters?: number[][];
  needsTrailingGap: boolean;
};

export type SkiaRevealLineProps = {
  syllables: LyricSyllable[];
  wordGroups?: WordGroup[];
  playbackPosition: number;
  isPlaying: boolean;
  containerWidth: number;
  fontScale?: number;
  alignRight?: boolean;
  preventClusterWrapping?: boolean;
};

function clamp01(value: number) {
  "worklet";
  return Math.max(0, Math.min(1, value));
}

function interpolate(value: number, input: number[], output: number[]) {
  "worklet";
  if (value <= input[0]) return output[0];
  if (value >= input[input.length - 1]) return output[output.length - 1];
  for (let index = 0; index < input.length - 1; index += 1) {
    if (value >= input[index] && value <= input[index + 1]) {
      const progress =
        (value - input[index]) / (input[index + 1] - input[index]);
      return output[index] + progress * (output[index + 1] - output[index]);
    }
  }
  return output[output.length - 1];
}

function smoothstep(value: number) {
  "worklet";
  const progress = clamp01(value);
  return progress * progress * (3 - 2 * progress);
}

function getSyllableProgress(
  positionMs: number,
  startTime: number,
  endTime: number,
) {
  "worklet";
  const duration = Math.max(1, endTime - startTime);
  return clamp01((positionMs - startTime) / duration);
}

function getSustainMode(text: string, durationMs: number): SustainMode {
  const charCount = getGraphemeCount(String(text || "").trim());
  if (charCount === 0 || durationMs < SUSTAIN_MS_THRESHOLD) return "none";
  if (charCount === 1) return "solo";
  if (durationMs / charCount >= MIN_MS_PER_CHAR_FOR_LETTER_SWEEP) {
    return "letter-sweep";
  }
  if (charCount > MAX_LETTER_SWEEP_CHARS && durationMs >= WORD_SUSTAIN_MIN_MS) {
    return "letter-sweep";
  }
  return "none";
}

function getSustainVisuals(
  progress: number,
  charIndex: number,
  totalChars: number,
  durationMs: number,
  isSoloMode: boolean,
  fontSize: number,
  lineHeight: number,
) {
  "worklet";
  const activeIntensity = isSoloMode
    ? interpolate(progress, [0, 0.12, 0.5, 0.88, 1], [0, 0.55, 1, 0.55, 0])
    : (() => {
        const distance = Math.abs(charIndex + 0.5 - progress * totalChars);
        if (distance > 3.1) return 0;
        return (
          Math.exp(-(distance * distance) * 0.48) *
          smoothstep(progress / 0.12) *
          smoothstep((1 - progress) / 0.12)
        );
      })();
  const glowIntensity = isSoloMode
    ? activeIntensity
    : (() => {
        const distance = Math.abs(charIndex + 0.5 - progress * totalChars);
        if (distance > 5.5) return 0;
        return (
          Math.exp(-(distance * distance) * 0.16) *
          smoothstep(progress / 0.16) *
          smoothstep((1 - progress) / 0.16)
        );
      })();
  const easedIntensity = smoothstep(activeIntensity);
  const maxScaleBoost =
    durationMs >= SUSTAIN_LONG_MS
      ? SUSTAIN_LONG_SCALE_BOOST
      : SUSTAIN_SHORT_SCALE_BOOST;
  const scale = 1 + maxScaleBoost * easedIntensity;
  const opacity = interpolate(easedIntensity, [0, 0.2, 1], [0.82, 0.92, 1]);

  return {
    scale,
    opacity,
    translateY:
      -0.018 * fontSize * easedIntensity - (scale - 1) * lineHeight * 0.5,
    glowRadius: interpolate(
      smoothstep(glowIntensity),
      [0, 0.12, 1],
      [0, 0, SUSTAIN_GLOW_RADIUS_MAX],
    ),
  };
}

function getTokenRise(progress: number, fontSize: number) {
  "worklet";
  return interpolate(clamp01(progress), [0, 1], [0.01 * fontSize, -0.04 * fontSize]);
}

function getCompletedOpacity(progress: number, baseOpacity: number) {
  "worklet";
  const completionBlend = smoothstep((progress - 0.94) / 0.06);
  return baseOpacity + (1 - baseOpacity) * completionBlend;
}

function offsetRect(source: SkRect) {
  return rect(
    source.x + EFFECT_PADDING,
    source.y + EFFECT_PADDING,
    source.width,
    source.height,
  );
}

function getGroupClusters(group: WordGroup) {
  return group.clusters?.length
    ? group.clusters
    : group.syllableIndexes.map((index) => [index]);
}

function shouldAddLeadingGap(
  groups: WordGroup[],
  syllables: LyricSyllable[],
  groupIndex: number,
) {
  if (groupIndex <= 0) return false;
  const previous = groups[groupIndex - 1];
  if (previous.needsTrailingGap) return true;
  const previousIndex = previous.syllableIndexes.at(-1);
  return previousIndex !== undefined && /\s$/u.test(syllables[previousIndex]?.text ?? "");
}

function buildParagraphText(
  syllables: LyricSyllable[],
  groups: WordGroup[],
  alignRight: boolean,
  preventClusterWrapping: boolean,
) {
  let paragraphText = "";
  const layouts: PendingSyllableLayout[] = [];

  const appendSyllable = (syllableIndex: number) => {
    const syllable = syllables[syllableIndex];
    const displayText = alignRight
      ? String(syllable.text || "").replace(/\s+$/u, "")
      : String(syllable.text || "");
    const graphemes = getGraphemes(displayText);
    const textStart = paragraphText.length;
    const glyphRanges: { start: number; end: number }[] = [];

    graphemes.forEach((grapheme, index) => {
      const previous = graphemes[index - 1] ?? "";
      if (index > 0 && !/\s/u.test(previous) && !/\s/u.test(grapheme)) {
        paragraphText += WORD_JOINER;
      }
      const start = paragraphText.length;
      paragraphText +=
        preventClusterWrapping && /\s/u.test(grapheme)
          ? NO_BREAK_SPACE
          : grapheme;
      glyphRanges.push({ start, end: paragraphText.length });
    });

    const durationMs = Math.max(1, syllable.endTime - syllable.startTime);
    layouts.push({
      textStart,
      textEnd: paragraphText.length,
      glyphRanges,
      startTime: syllable.startTime,
      endTime: syllable.endTime,
      durationMs,
      sustainMode: getSustainMode(displayText, durationMs),
    });
  };

  groups.forEach((group, groupIndex) => {
    if (alignRight && shouldAddLeadingGap(groups, syllables, groupIndex)) {
      paragraphText += " ";
    }
    const clusters = getGroupClusters(group);
    clusters.forEach((cluster, clusterIndex) => {
      cluster.forEach((syllableIndex, syllableIndexInCluster) => {
        if (syllableIndexInCluster > 0) paragraphText += WORD_JOINER;
        appendSyllable(syllableIndex);
      });
      if (clusterIndex < clusters.length - 1) {
        paragraphText += preventClusterWrapping ? WORD_JOINER : ZERO_WIDTH_BREAK;
      }
    });
    if (!alignRight && group.needsTrailingGap) paragraphText += " ";
  });

  return { paragraphText, layouts };
}

export const SkiaRevealLine = memo(function SkiaRevealLine({
  syllables,
  wordGroups,
  playbackPosition,
  isPlaying,
  containerWidth,
  fontScale = 1,
  alignRight = false,
  preventClusterWrapping = false,
}: SkiaRevealLineProps) {
  const fontSize = BASE_FONT_SIZE * SCALE_ACTIVE * fontScale;
  const lineHeight = BASE_LINE_HEIGHT * SCALE_ACTIVE * fontScale;
  const groups = useMemo(
    () =>
      wordGroups ??
      syllables.map((_, index) => ({
        syllableIndexes: [index],
        clusters: [[index]],
        needsTrailingGap: index < syllables.length - 1,
      })),
    [syllables, wordGroups],
  );
  const { paragraphText, layouts: pendingLayouts } = useMemo(
    () =>
      buildParagraphText(
        syllables,
        groups,
        alignRight,
        preventClusterWrapping,
      ),
    [alignRight, groups, preventClusterWrapping, syllables],
  );

  const { pendingParagraph, progressParagraph, layouts, paragraphHeight } =
    useMemo(() => {
      const buildParagraph = (color: string) => {
        const fontFamilies = [
          Platform.OS === "android" ? "sans-serif" : "System",
        ];
        const fontStyle = { weight: 700 as const };
        const heightMultiplier = lineHeight / fontSize;
        const textStyle = {
          color: Skia.Color(color),
          fontFamilies,
          fontSize,
          fontStyle,
          heightMultiplier,
        };
        const builder = Skia.ParagraphBuilder.Make({
          textAlign: alignRight ? TextAlign.Right : TextAlign.Left,
          strutStyle: {
            strutEnabled: true,
            fontFamilies,
            fontStyle,
            fontSize,
            heightMultiplier,
            forceStrutHeight: true,
          },
          textStyle,
        });
        builder.addText(paragraphText);
        const paragraph = builder.build();
        paragraph.layout(containerWidth);
        return paragraph;
      };

      const pending = buildParagraph(COLOR_ACTIVE_PENDING);
      const progress = buildParagraph(COLOR_ACTIVE_PROGRESS);
      const resolvedLayouts = pendingLayouts.map((layout) => {
        const rects = pending.getRectsForRange(layout.textStart, layout.textEnd);
        const rectRevealStarts: number[] = [];
        let revealWidth = 0;
        rects.forEach((layoutRect) => {
          rectRevealStarts.push(revealWidth);
          revealWidth += layoutRect.width;
        });

        const glyphs = layout.glyphRanges.flatMap((range, charIndex) =>
          pending.getRectsForRange(range.start, range.end).map((glyphRect) => {
            const lineIndex = rects.findIndex(
              (layoutRect) =>
                glyphRect.y >= layoutRect.y - 0.5 &&
                glyphRect.y < layoutRect.y + layoutRect.height + 0.5,
            );
            const safeLineIndex = Math.max(0, lineIndex);
            const lineRect = rects[safeLineIndex] ?? glyphRect;
            return {
              rect: glyphRect,
              revealStart:
                (rectRevealStarts[safeLineIndex] ?? 0) +
                Math.max(0, glyphRect.x - lineRect.x),
              charIndex,
              totalChars: layout.glyphRanges.length,
            };
          }),
        );

        return {
          startTime: layout.startTime,
          endTime: layout.endTime,
          durationMs: layout.durationMs,
          sustainMode: layout.sustainMode,
          rects,
          rectRevealStarts,
          revealWidth,
          glyphs,
        } satisfies SyllableLayout;
      });

      return {
        pendingParagraph: pending,
        progressParagraph: progress,
        layouts: resolvedLayouts,
        paragraphHeight: pending.getHeight(),
      };
    }, [alignRight, containerWidth, fontSize, lineHeight, paragraphText, pendingLayouts]);

  return (
    <View style={{ width: containerWidth, height: paragraphHeight }}>
      <Canvas
        style={[
          styles.canvas,
          {
            left: -EFFECT_PADDING,
            top: -EFFECT_PADDING,
            width: containerWidth + EFFECT_PADDING * 2,
            height: paragraphHeight + EFFECT_PADDING * 2,
          },
        ]}
      >
        {layouts.map((layout, index) => (
          <SkiaRevealToken
            key={`${layout.startTime}-${index}`}
            layout={layout}
            pendingParagraph={pendingParagraph}
            progressParagraph={progressParagraph}
            paragraphWidth={containerWidth}
            playbackPosition={playbackPosition}
            isPlaying={isPlaying}
            fontSize={fontSize}
            lineHeight={lineHeight}
          />
        ))}
      </Canvas>
    </View>
  );
});

const SkiaRevealToken = memo(function SkiaRevealToken({
  layout,
  pendingParagraph,
  progressParagraph,
  paragraphWidth,
  playbackPosition,
  isPlaying,
  fontSize,
  lineHeight,
}: {
  layout: SyllableLayout;
  pendingParagraph: SkParagraph;
  progressParagraph: SkParagraph;
  paragraphWidth: number;
  playbackPosition: number;
  isPlaying: boolean;
  fontSize: number;
  lineHeight: number;
}) {
  const progress = useSharedValue(
    getSyllableProgress(playbackPosition, layout.startTime, layout.endTime),
  );

  useEffect(() => {
    const nextProgress = getSyllableProgress(
      playbackPosition,
      layout.startTime,
      layout.endTime,
    );
    if (!isPlaying || nextProgress >= 1) {
      cancelAnimation(progress);
      progress.value = nextProgress;
      return;
    }
    const easing =
      layout.glyphs.length <= 2
        ? ReanimatedEasing.linear
        : REVEAL_SWEEP_EASING;
    cancelAnimation(progress);
    progress.value = nextProgress;
    if (playbackPosition < layout.startTime) {
      progress.value = withDelay(
        Math.max(0, layout.startTime - playbackPosition),
        withTiming(1, {
          duration: layout.durationMs,
          easing,
        }),
      );
      return;
    }
    progress.value = withTiming(1, {
      duration: Math.max(1, layout.endTime - playbackPosition),
      easing,
    });
  }, [
    isPlaying,
    layout.durationMs,
    layout.endTime,
    layout.glyphs.length,
    layout.startTime,
    playbackPosition,
    progress,
  ]);

  if (layout.rects.length === 0) return null;

  if (layout.sustainMode !== "none" && layout.glyphs.length > 0) {
    return (
      <Group>
        {layout.glyphs.map((glyph, index) => (
          <SkiaSustainGlyph
            key={`${glyph.rect.x}-${glyph.rect.y}-${index}`}
            glyph={glyph}
            revealWidth={layout.revealWidth}
            durationMs={layout.durationMs}
            sustainMode={layout.sustainMode as Exclude<SustainMode, "none">}
            progress={progress}
            pendingParagraph={pendingParagraph}
            progressParagraph={progressParagraph}
            paragraphWidth={paragraphWidth}
            fontSize={fontSize}
            lineHeight={lineHeight}
          />
        ))}
      </Group>
    );
  }

  return (
    <Group>
      {layout.rects.map((layoutRect, index) => (
        <SkiaRevealFragment
          key={`${layoutRect.x}-${layoutRect.y}-${index}`}
          layoutRect={layoutRect}
          revealStart={layout.rectRevealStarts[index] ?? 0}
          revealWidth={layout.revealWidth}
          progress={progress}
          pendingParagraph={pendingParagraph}
          progressParagraph={progressParagraph}
          paragraphWidth={paragraphWidth}
          fontSize={fontSize}
        />
      ))}
    </Group>
  );
});

function useRevealClip(
  layoutRect: SkRect,
  revealStart: number,
  revealWidth: number,
  progress: SharedValue<number>,
  leadWidth = 0,
) {
  return useDerivedValue(() => {
    const revealed = revealWidth * clamp01(progress.value) + leadWidth;
    const width = Math.max(
      0,
      Math.min(layoutRect.width, revealed - revealStart),
    );
    return rect(
      layoutRect.x + EFFECT_PADDING,
      layoutRect.y + EFFECT_PADDING,
      width,
      layoutRect.height,
    );
  });
}

const SkiaRevealFragment = memo(function SkiaRevealFragment({
  layoutRect,
  revealStart,
  revealWidth,
  progress,
  pendingParagraph,
  progressParagraph,
  paragraphWidth,
  fontSize,
}: {
  layoutRect: SkRect;
  revealStart: number;
  revealWidth: number;
  progress: SharedValue<number>;
  pendingParagraph: SkParagraph;
  progressParagraph: SkParagraph;
  paragraphWidth: number;
  fontSize: number;
}) {
  const progressClip = useRevealClip(
    layoutRect,
    revealStart,
    revealWidth,
    progress,
  );
  const softClip = useRevealClip(
    layoutRect,
    revealStart,
    revealWidth,
    progress,
    3,
  );
  const transform = useDerivedValue(() => [
    { translateY: getTokenRise(progress.value, fontSize) },
  ]);

  return (
    <Group transform={transform}>
      <Group clip={offsetRect(layoutRect)}>
        <SkiaParagraph
          paragraph={pendingParagraph}
          x={EFFECT_PADDING}
          y={EFFECT_PADDING}
          width={paragraphWidth}
        />
      </Group>
      <Group clip={softClip} opacity={0.35}>
        <SkiaParagraph
          paragraph={progressParagraph}
          x={EFFECT_PADDING}
          y={EFFECT_PADDING}
          width={paragraphWidth}
        />
      </Group>
      <Group clip={progressClip}>
        <SkiaParagraph
          paragraph={progressParagraph}
          x={EFFECT_PADDING}
          y={EFFECT_PADDING}
          width={paragraphWidth}
        />
      </Group>
    </Group>
  );
});

const SkiaSustainGlyph = memo(function SkiaSustainGlyph({
  glyph,
  revealWidth,
  durationMs,
  sustainMode,
  progress,
  pendingParagraph,
  progressParagraph,
  paragraphWidth,
  fontSize,
  lineHeight,
}: {
  glyph: GlyphLayout;
  revealWidth: number;
  durationMs: number;
  sustainMode: Exclude<SustainMode, "none">;
  progress: SharedValue<number>;
  pendingParagraph: SkParagraph;
  progressParagraph: SkParagraph;
  paragraphWidth: number;
  fontSize: number;
  lineHeight: number;
}) {
  const glyphRect = offsetRect(glyph.rect);
  const progressClip = useRevealClip(
    glyph.rect,
    glyph.revealStart,
    revealWidth,
    progress,
  );
  const transform = useDerivedValue(() => {
    const visuals = getSustainVisuals(
      clamp01(progress.value),
      glyph.charIndex,
      glyph.totalChars,
      durationMs,
      sustainMode === "solo",
      fontSize,
      lineHeight,
    );
    return [
      { translateY: getTokenRise(progress.value, fontSize) + visuals.translateY },
      { scale: visuals.scale },
    ];
  });
  const opacity = useDerivedValue(() => {
    const visuals = getSustainVisuals(
      clamp01(progress.value),
      glyph.charIndex,
      glyph.totalChars,
      durationMs,
      sustainMode === "solo",
      fontSize,
      lineHeight,
    );
    return getCompletedOpacity(progress.value, visuals.opacity);
  });
  const pendingOpacity = useDerivedValue(() => {
    const visuals = getSustainVisuals(
      clamp01(progress.value),
      glyph.charIndex,
      glyph.totalChars,
      durationMs,
      sustainMode === "solo",
      fontSize,
      lineHeight,
    );
    return visuals.opacity * clamp01((1 - progress.value) / 0.035);
  });
  const glowBlur = useDerivedValue(
    () =>
      getSustainVisuals(
        clamp01(progress.value),
        glyph.charIndex,
        glyph.totalChars,
        durationMs,
        sustainMode === "solo",
        fontSize,
        lineHeight,
      ).glowRadius,
  );

  return (
    <Group origin={vec(glyphRect.x + glyphRect.width / 2, glyphRect.y + glyphRect.height / 2)} transform={transform}>
      <Group opacity={pendingOpacity} layer>
        <Shadow dx={0} dy={0} blur={glowBlur} color="rgba(255,255,255,0.24)" />
        <Group clip={glyphRect}>
          <SkiaParagraph
            paragraph={pendingParagraph}
            x={EFFECT_PADDING}
            y={EFFECT_PADDING}
            width={paragraphWidth}
          />
        </Group>
      </Group>
      <Group opacity={opacity} layer>
        <Shadow dx={0} dy={0} blur={glowBlur} color="rgba(255,255,255,0.24)" />
        <Group clip={progressClip}>
          <SkiaParagraph
            paragraph={progressParagraph}
            x={EFFECT_PADDING}
            y={EFFECT_PADDING}
            width={paragraphWidth}
          />
        </Group>
      </Group>
    </Group>
  );
});

const styles = StyleSheet.create({
  canvas: {
    position: "absolute",
  },
});
