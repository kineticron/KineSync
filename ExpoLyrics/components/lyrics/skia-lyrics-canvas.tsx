import { memo, useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import {
  Canvas,
  Group,
  Paragraph as SkiaParagraph,
  Shadow,
  Skia,
  TextAlign,
  usePathValue,
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
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { LYRICS_FONT_FAMILY } from "@/constants/lyrics-typography";
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

type SustainMode = "none" | "solo" | "letter-sweep";

type GlyphLayout = {
  rect: SkRect;
  revealStart: number;
  charIndex: number;
  totalChars: number;
  paragraph: SkParagraph;
  paragraphWidth: number;
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

type PendingSyllableLayout = {
  textStart: number;
  textEnd: number;
  glyphRanges: { start: number; end: number }[];
  startTime: number;
  endTime: number;
  durationMs: number;
  sustainMode: SustainMode;
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
  revealEnabled?: boolean;
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
  if (positionMs <= startTime) return 0;
  if (positionMs >= endTime) return 1;
  return (positionMs - startTime) / Math.max(1, endTime - startTime);
}

function getMonotonicNow() {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
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
  const intensity = smoothstep(activeIntensity);
  const maxScaleBoost =
    durationMs >= SUSTAIN_LONG_MS
      ? SUSTAIN_LONG_SCALE_BOOST
      : SUSTAIN_SHORT_SCALE_BOOST;
  const scale = 1 + maxScaleBoost * intensity;

  return {
    intensity,
    scale,
    translateY:
      -0.018 * fontSize * intensity - (scale - 1) * lineHeight * 0.5,
    glowRadius: interpolate(
      smoothstep(glowIntensity),
      [0, 0.12, 1],
      [0, 0, SUSTAIN_GLOW_RADIUS_MAX],
    ),
  };
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
  return (
    previousIndex !== undefined &&
    /\s$/u.test(syllables[previousIndex]?.text ?? "")
  );
}

function buildParagraphText(
  syllables: LyricSyllable[],
  groups: WordGroup[],
  alignRight: boolean,
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
      paragraphText += grapheme;
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
      // A semantic word is indivisible. Syllable and punctuation clusters are
      // joined explicitly so Paragraph can only wrap at real inter-word gaps.
      if (clusterIndex < clusters.length - 1) paragraphText += WORD_JOINER;
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
  revealEnabled = true,
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
    () => buildParagraphText(syllables, groups, alignRight),
    [alignRight, groups, syllables],
  );

  const { pendingParagraph, progressParagraph, layouts, paragraphHeight } =
    useMemo(() => {
      const fontFamilies = [LYRICS_FONT_FAMILY];
      const fontStyle = { weight: 700 as const };
      const heightMultiplier = lineHeight / fontSize;
      const paragraphStyle = {
        strutStyle: {
          strutEnabled: true,
          fontFamilies,
          fontStyle,
          fontSize,
          heightMultiplier,
          forceStrutHeight: true,
        },
      };
      const buildParagraph = (
        text: string,
        color: string,
        width: number,
        textAlign: TextAlign,
      ) => {
        const builder = Skia.ParagraphBuilder.Make({
          ...paragraphStyle,
          textAlign,
          textStyle: {
            color: Skia.Color(color),
            fontFamilies,
            fontSize,
            fontStyle,
            heightMultiplier,
          },
        });
        builder.addText(text);
        const paragraph = builder.build();
        paragraph.layout(width);
        return paragraph;
      };

      const textAlign = alignRight ? TextAlign.Right : TextAlign.Left;
      const pending = buildParagraph(
        paragraphText,
        COLOR_ACTIVE_PENDING,
        containerWidth,
        textAlign,
      );
      const progress = buildParagraph(
        paragraphText,
        COLOR_ACTIVE_PROGRESS,
        containerWidth,
        textAlign,
      );
      const resolvedLayouts = pendingLayouts.map((layout) => {
        const rects = pending.getRectsForRange(layout.textStart, layout.textEnd);
        const rectRevealStarts: number[] = [];
        let revealWidth = 0;
        rects.forEach((layoutRect) => {
          rectRevealStarts.push(revealWidth);
          revealWidth += layoutRect.width;
        });

        const glyphs =
          layout.sustainMode === "none"
            ? []
            : layout.glyphRanges.flatMap((range, charIndex) =>
                pending
                  .getRectsForRange(range.start, range.end)
                  .map((glyphRect) => {
                    const lineIndex = rects.findIndex(
                      (layoutRect) =>
                        glyphRect.y >= layoutRect.y - 0.5 &&
                        glyphRect.y <
                          layoutRect.y + layoutRect.height + 0.5,
                    );
                    const safeLineIndex = Math.max(0, lineIndex);
                    const lineRect = rects[safeLineIndex] ?? glyphRect;
                    const glyphText = paragraphText.slice(range.start, range.end);
                    const paragraphWidth = Math.max(
                      glyphRect.width + EFFECT_PADDING,
                      fontSize * 1.5,
                    );
                    return {
                      rect: glyphRect,
                      revealStart:
                        (rectRevealStarts[safeLineIndex] ?? 0) +
                        Math.max(0, glyphRect.x - lineRect.x),
                      charIndex,
                      totalChars: layout.glyphRanges.length,
                      paragraph: buildParagraph(
                        glyphText,
                        COLOR_ACTIVE_PROGRESS,
                        paragraphWidth,
                        TextAlign.Left,
                      ),
                      paragraphWidth,
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
    }, [
      alignRight,
      containerWidth,
      fontSize,
      lineHeight,
      paragraphText,
      pendingLayouts,
    ]);

  const revealGeometry = useMemo(
    () =>
      layouts.map((layout) => ({
        startTime: layout.startTime,
        endTime: layout.endTime,
        revealWidth: layout.revealWidth,
        rects: layout.rects.map((layoutRect, index) => ({
          x: layoutRect.x,
          y: layoutRect.y,
          width: layoutRect.width,
          height: layoutRect.height,
          revealStart: layout.rectRevealStarts[index] ?? 0,
        })),
      })),
    [layouts],
  );
  const linePosition = useSharedValue(playbackPosition);
  const syncRef = useRef({
    position: playbackPosition,
    monotonicMs: getMonotonicNow(),
  });
  const timelineEnd = useMemo(
    () =>
      Math.max(
        playbackPosition,
        ...syllables.map((syllable) => Number(syllable.endTime) || 0),
      ),
    [playbackPosition, syllables],
  );

  useEffect(() => {
    const now = getMonotonicNow();
    const previous = syncRef.current;
    const expectedPosition =
      previous.position + (isPlaying ? now - previous.monotonicMs : 0);
    const discontinuity = Math.abs(playbackPosition - expectedPosition);
    syncRef.current = { position: playbackPosition, monotonicMs: now };

    if (!revealEnabled || !isPlaying || timelineEnd <= playbackPosition) {
      cancelAnimation(linePosition);
      linePosition.value = playbackPosition;
      return;
    }

    // Preserve the running presentation value for ordinary bridge clock
    // corrections. Reset only for a real seek/discontinuity.
    if (discontinuity >= 220) {
      cancelAnimation(linePosition);
      linePosition.value = playbackPosition;
    }
    linePosition.value = withTiming(timelineEnd, {
      duration: Math.max(1, timelineEnd - playbackPosition),
      easing: ReanimatedEasing.linear,
    });
  }, [
    isPlaying,
    linePosition,
    playbackPosition,
    revealEnabled,
    timelineEnd,
  ]);

  const revealPath = usePathValue((path) => {
    "worklet";
    if (!revealEnabled) return;

    for (const syllable of revealGeometry) {
      const progress = getSyllableProgress(
        linePosition.value,
        syllable.startTime,
        syllable.endTime,
      );
      const revealedWidth = syllable.revealWidth * progress;
      for (const layoutRect of syllable.rects) {
        const width = Math.max(
          0,
          Math.min(
            layoutRect.width,
            revealedWidth - layoutRect.revealStart,
          ),
        );
        // Do not add zero-width geometry: antialiasing a degenerate rect can
        // leave a one-pixel white hairline before the syllable starts.
        if (width > 0.01) {
          path.addRect(
            rect(
              layoutRect.x + EFFECT_PADDING,
              layoutRect.y + EFFECT_PADDING,
              width,
              layoutRect.height,
            ),
          );
        }
      }
    }
  });

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
        <SkiaParagraph
          paragraph={pendingParagraph}
          x={EFFECT_PADDING}
          y={EFFECT_PADDING}
          width={containerWidth}
        />
        {revealEnabled && (
          <Group clip={revealPath}>
            <SkiaParagraph
              paragraph={progressParagraph}
              x={EFFECT_PADDING}
              y={EFFECT_PADDING}
              width={containerWidth}
            />
          </Group>
        )}
        {revealEnabled &&
          layouts.flatMap((layout, layoutIndex) =>
            layout.sustainMode === "none"
              ? []
              : layout.glyphs.map((glyph, glyphIndex) => (
                  <SkiaSustainGlyph
                    key={`${layoutIndex}-${glyphIndex}-${glyph.rect.x}-${glyph.rect.y}`}
                    glyph={glyph}
                    revealWidth={layout.revealWidth}
                    durationMs={layout.durationMs}
                    sustainMode={
                      layout.sustainMode as Exclude<SustainMode, "none">
                    }
                    linePosition={linePosition}
                    startTime={layout.startTime}
                    endTime={layout.endTime}
                    fontSize={fontSize}
                    lineHeight={lineHeight}
                  />
                )),
          )}
      </Canvas>
    </View>
  );
});



const SkiaSustainGlyph = memo(function SkiaSustainGlyph({
  glyph,
  revealWidth,
  durationMs,
  sustainMode,
  linePosition,
  startTime,
  endTime,
  fontSize,
  lineHeight,
}: {
  glyph: GlyphLayout;
  revealWidth: number;
  durationMs: number;
  sustainMode: Exclude<SustainMode, "none">;
  linePosition: SharedValue<number>;
  startTime: number;
  endTime: number;
  fontSize: number;
  lineHeight: number;
}) {
  const glyphRect = offsetRect(glyph.rect);
  const progress = useDerivedValue(() =>
    getSyllableProgress(linePosition.value, startTime, endTime),
  );
  const transform = useDerivedValue(() => {
    const visuals = getSustainVisuals(
      progress.value,
      glyph.charIndex,
      glyph.totalChars,
      durationMs,
      sustainMode === "solo",
      fontSize,
      lineHeight,
    );
    return [
      { translateY: visuals.translateY },
      { scale: visuals.scale },
    ];
  });
  const opacity = useDerivedValue(() => {
    const visuals = getSustainVisuals(
      progress.value,
      glyph.charIndex,
      glyph.totalChars,
      durationMs,
      sustainMode === "solo",
      fontSize,
      lineHeight,
    );
    const revealedWidth = revealWidth * clamp01(progress.value);
    const glyphReveal = clamp01(
      (revealedWidth - glyph.revealStart) / Math.max(1, glyph.rect.width),
    );
    return visuals.intensity * glyphReveal * 0.72;
  });
  const glowBlur = useDerivedValue(
    () =>
      getSustainVisuals(
        progress.value,
        glyph.charIndex,
        glyph.totalChars,
        durationMs,
        sustainMode === "solo",
        fontSize,
        lineHeight,
      ).glowRadius,
  );

  return (
    <Group
      origin={vec(
        glyphRect.x + glyphRect.width / 2,
        glyphRect.y + glyphRect.height / 2,
      )}
      transform={transform}
      opacity={opacity}
      layer
    >
      <Shadow
        dx={0}
        dy={0}
        blur={glowBlur}
        color="rgba(255,255,255,0.24)"
      />
      <SkiaParagraph
        paragraph={glyph.paragraph}
        x={glyphRect.x}
        y={glyphRect.y}
        width={glyph.paragraphWidth}
      />
    </Group>
  );
});

const styles = StyleSheet.create({
  canvas: {
    position: "absolute",
  },
});
