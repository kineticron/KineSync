/**
 * SkiaRevealLine — Skia Canvas per active lyric line.
 *
 * Uses Skia Paragraph API for full multi-script support (CJK, Arabic, etc.)
 * with system font fallback. Reveal sweeps clip the progress-colored paragraph
 * to each syllable's bounding rect.
 *
 * ponytail: one Canvas per active line replaces 24+ animated Views.
 * FlashList still handles scroll/virtualization.
 */
import { memo, useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import {
  Canvas,
  Group,
  Paragraph as SkiaParagraph,
  Skia,
  Shadow,
  rect,
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

import type { LyricSyllable } from "@/types/bridge";
import { getGraphemeCount, getGraphemes } from "@/lib/graphemes";

// ─── Constants (matching lyric-line.tsx) ────────────────────────────────────

const BASE_FONT_SIZE = 32;
const BASE_LINE_HEIGHT = 42;
// ponytail: match lyric-line.tsx oversized rendering (rendered at SCALE_ACTIVE, scaled down by container)
const SCALE_ACTIVE = 1.05;
const BG_FONT_SIZE = BASE_FONT_SIZE * 0.62;
const BG_LINE_HEIGHT = BASE_LINE_HEIGHT * 0.62;

const COLOR_ACTIVE_PENDING = "rgba(255,255,255,0.5)";
const COLOR_ACTIVE_PROGRESS = "#FFFFFF";
const COLOR_BG_PENDING = "rgba(255,255,255,0.32)";
const COLOR_BG_PROGRESS = "rgba(255,255,255,0.47)";

const SUSTAIN_MS_THRESHOLD = 680;
const MIN_MS_PER_CHAR_FOR_LETTER_SWEEP = 220;
const MAX_LETTER_SWEEP_CHARS = 5;
const WORD_SUSTAIN_MIN_MS = 920;
const SUSTAIN_GLOW_RADIUS_MAX = 7;
const SUSTAIN_SHORT_SCALE_BOOST = 0.068;
const SUSTAIN_LONG_SCALE_BOOST = 0.04;
const SUSTAIN_LONG_MS = 1200;

const REVEAL_SWEEP_EASING = ReanimatedEasing.out(ReanimatedEasing.ease);

// ─── Helpers ────────────────────────────────────────────────────────────────

type SustainMode = "none" | "solo" | "letter-sweep" | "word";

function getSustainMode(text: string, durationMs: number): SustainMode {
  const trimmed = String(text || "").trim();
  const charCount = getGraphemeCount(trimmed);
  if (charCount === 0 || durationMs < SUSTAIN_MS_THRESHOLD) return "none";
  if (charCount === 1) return "solo";
  const msPerChar = durationMs / charCount;
  if (msPerChar >= MIN_MS_PER_CHAR_FOR_LETTER_SWEEP) return "letter-sweep";
  if (charCount > MAX_LETTER_SWEEP_CHARS && durationMs >= WORD_SUSTAIN_MIN_MS)
    return "letter-sweep";
  return "none";
}

function clamp01(v: number) {
  "worklet";
  return Math.max(0, Math.min(1, v));
}

function getSyllableProgress(positionMs: number, startTime: number, endTime: number) {
  "worklet";
  const duration = Math.max(1, endTime - startTime);
  return clamp01((positionMs - startTime) / duration);
}

function getSustainActiveIntensity(
  progress: number,
  charIdx: number,
  totalChars: number,
  isSoloMode: boolean,
): number {
  "worklet";
  if (isSoloMode) {
    const p = clamp01(progress);
    if (p < 0.12) return (p / 0.12) * 0.55;
    if (p < 0.5) return 0.55 + ((p - 0.12) / 0.38) * 0.45;
    if (p < 0.88) return 1 - ((p - 0.5) / 0.38) * 0.45;
    return 0.55 * ((1 - p) / 0.12);
  }
  const activeLetterFloat = progress * totalChars;
  const charCenter = charIdx + 0.5;
  const distance = Math.abs(charCenter - activeLetterFloat);
  if (distance > 3.1) return 0;
  const falloff = Math.exp(-(distance * distance) * 0.48);
  const fadeIn = clamp01(progress / 0.12);
  const fadeOut = clamp01((1 - progress) / 0.12);
  return falloff * fadeIn * fadeOut;
}

// ─── Layout types ───────────────────────────────────────────────────────────

type SyllableLayout = {
  textStart: number;
  textEnd: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  sustainMode: SustainMode;
  rect: SkRect | null;
  glyphRects?: SkRect[];
};

// ─── Props ──────────────────────────────────────────────────────────────────

export type WordGroup = {
  syllableIndexes: number[];
  needsTrailingGap: boolean;
};

export type SkiaRevealLineProps = {
  syllables: LyricSyllable[];
  wordGroups?: WordGroup[];
  playbackPosition: number;
  isPlaying: boolean;
  anchorPositionMs: number;
  anchorMonotonicMs: number;
  containerWidth: number;
  isBackground?: boolean;
  fontScale?: number;
};

// ─── Main component ─────────────────────────────────────────────────────────

export const SkiaRevealLine = memo(function SkiaRevealLine({
  syllables,
  wordGroups,
  playbackPosition,
  isPlaying,
  anchorPositionMs,
  anchorMonotonicMs,
  containerWidth,
  isBackground = false,
  fontScale = 1,
}: SkiaRevealLineProps) {
  const fontSize = isBackground
    ? BG_FONT_SIZE * SCALE_ACTIVE * fontScale
    : BASE_FONT_SIZE * SCALE_ACTIVE * fontScale;

  const pendingColor = isBackground ? COLOR_BG_PENDING : COLOR_ACTIVE_PENDING;
  const progressColor = isBackground ? COLOR_BG_PROGRESS : COLOR_ACTIVE_PROGRESS;

  // Build paragraph text with word spacing, track syllable char offsets
  const { paragraphText, syllableLayouts } = useMemo(() => {
    const groups = wordGroups ?? syllables.map((_, i) => ({
      syllableIndexes: [i],
      needsTrailingGap: i < syllables.length - 1,
    }));

    let text = "";
    const layouts: SyllableLayout[] = [];

    for (const group of groups) {
      for (const sylIdx of group.syllableIndexes) {
        const syl = syllables[sylIdx];
        const start = text.length;
        text += syl.text;
        const end = text.length;
        const durationMs = Math.max(1, syl.endTime - syl.startTime);
        layouts.push({
          textStart: start,
          textEnd: end,
          startTime: syl.startTime,
          endTime: syl.endTime,
          durationMs,
          sustainMode: getSustainMode(syl.text, durationMs),
          rect: null,
        });
      }
      if (group.needsTrailingGap) {
        text += " ";
      }
    }

    return { paragraphText: text, syllableLayouts: layouts };
  }, [syllables, wordGroups]);

  // Build two paragraphs: one pending color, one progress color
  // System font manager handles all script fallback automatically
  const { pendingPara, progressPara, layouts, canvasHeight } = useMemo(() => {
    // ponytail: heightMultiplier matches RN lineHeight/fontSize ratio
    const lineHeight = isBackground
      ? BG_LINE_HEIGHT * SCALE_ACTIVE * fontScale
      : BASE_LINE_HEIGHT * SCALE_ACTIVE * fontScale;
    const heightMultiplier = lineHeight / fontSize;

    const buildPara = (color: string) => {
      const textStyle = {
        fontSize,
        fontFamilies: ["System"],
        color: Skia.Color(color),
        fontStyle: { weight: 700 as const },
        heightMultiplier,
      };
      const builder = Skia.ParagraphBuilder.Make({ textStyle });
      builder.addText(paragraphText);
      const para = builder.build();
      para.layout(containerWidth);
      return para;
    };

    const pending = buildPara(pendingColor);
    const progress = buildPara(progressColor);

    // Get bounding rects for each syllable from the pending paragraph
    const updatedLayouts = syllableLayouts.map((layout) => {
      const rects = pending.getRectsForRange(layout.textStart, layout.textEnd);
      const syllableRect = rects.length > 0 ? rects[0] : null;

      // For sustain tokens, get per-glyph rects
      let glyphRects: SkRect[] | undefined;
      if (layout.sustainMode !== "none") {
        glyphRects = [];
        for (let i = layout.textStart; i < layout.textEnd; i++) {
          const charRects = pending.getRectsForRange(i, i + 1);
          if (charRects.length > 0) {
            glyphRects.push(charRects[0]);
          }
        }
      }

      return { ...layout, rect: syllableRect, glyphRects };
    });

    return {
      pendingPara: pending,
      progressPara: progress,
      layouts: updatedLayouts,
      canvasHeight: pending.getHeight(),
    };
  }, [paragraphText, syllableLayouts, fontSize, containerWidth, pendingColor, progressColor]);

  return (
    <View style={{ width: containerWidth, height: canvasHeight }}>
      <Canvas style={StyleSheet.absoluteFill}>
        {/* Base layer: full paragraph in pending color */}
        <SkiaParagraph
          paragraph={pendingPara}
          x={0}
          y={0}
          width={containerWidth}
        />
        {/* Reveal layers: per-syllable clipped progress paragraph */}
        {layouts.map((layout, idx) => (
          <SkiaRevealToken
            key={`${layout.startTime}-${idx}`}
            layout={layout}
            progressPara={progressPara}
            containerWidth={containerWidth}
            playbackPosition={playbackPosition}
            isPlaying={isPlaying}
            fontSize={fontSize}
            isBackground={isBackground}
          />
        ))}
      </Canvas>
    </View>
  );
});

// ─── Per-syllable reveal clip ───────────────────────────────────────────────

const SkiaRevealToken = memo(function SkiaRevealToken({
  layout,
  progressPara,
  containerWidth,
  playbackPosition,
  isPlaying,
  fontSize,
  isBackground,
}: {
  layout: SyllableLayout;
  progressPara: SkParagraph;
  containerWidth: number;
  playbackPosition: number;
  isPlaying: boolean;
  fontSize: number;
  isBackground: boolean;
}) {
  if (!layout.rect) return null;

  const progress = useSharedValue(
    getSyllableProgress(playbackPosition, layout.startTime, layout.endTime),
  );

  // Drive progress with withTiming (same as syncRevealProgress in lyric-line.tsx)
  useEffect(() => {
    const nextProgress = getSyllableProgress(
      playbackPosition, layout.startTime, layout.endTime,
    );

    if (!isPlaying || nextProgress >= 1) {
      cancelAnimation(progress);
      progress.value = nextProgress;
      return;
    }

    const charCount = layout.textEnd - layout.textStart;
    const easing = charCount <= 2 ? ReanimatedEasing.linear : REVEAL_SWEEP_EASING;

    if (playbackPosition < layout.startTime) {
      cancelAnimation(progress);
      progress.value = nextProgress;
      progress.value = withDelay(
        Math.max(0, layout.startTime - playbackPosition),
        withTiming(1, {
          duration: Math.max(1, layout.endTime - layout.startTime),
          easing,
        }),
      );
      return;
    }

    cancelAnimation(progress);
    progress.value = withTiming(1, {
      duration: Math.max(1, layout.endTime - playbackPosition),
      easing,
    });
  }, [layout.endTime, layout.startTime, layout.textEnd, layout.textStart, isPlaying, playbackPosition, progress]);

  const syllableRect = layout.rect!;
  const syllableWidth = syllableRect.width;

  // Clip rect: reveals from left to right across the syllable bounds
  const clipRect = useDerivedValue(() => {
    const w = Math.max(0, syllableWidth) * clamp01(progress.value);
    return rect(syllableRect.x, syllableRect.y, w, syllableRect.height);
  });

  // Soft leading edge (slightly wider clip) — only visible once progress > 0
  const softClipRect = useDerivedValue(() => {
    const p = clamp01(progress.value);
    if (p <= 0) return rect(0, 0, 0, 0);
    const leadPx = isBackground ? 6 : 4;
    const w = Math.min(syllableWidth, syllableWidth * p + leadPx);
    return rect(syllableRect.x, syllableRect.y, w, syllableRect.height);
  });

  // Sustain glow blur
  const hasSustain = layout.sustainMode !== "none";
  const scaleBoost = layout.durationMs >= SUSTAIN_LONG_MS
    ? SUSTAIN_LONG_SCALE_BOOST
    : SUSTAIN_SHORT_SCALE_BOOST;

  const glowBlur = useDerivedValue(() => {
    if (!hasSustain) return 0;
    const p = progress.value;
    if (p <= 0 || p >= 1) return 0;
    const d = (p - 0.5) * 3;
    return SUSTAIN_GLOW_RADIUS_MAX * Math.exp(-(d * d));
  });

  return (
    <Group>
      {/* Progress reveal: clip the progress-colored paragraph to this syllable's sweep */}
      <Group clip={clipRect}>
        <SkiaParagraph
          paragraph={progressPara}
          x={0}
          y={0}
          width={containerWidth}
        />
      </Group>
      {/* Soft leading edge */}
      {!isBackground && (
        <Group clip={softClipRect} opacity={0.35}>
          <SkiaParagraph
            paragraph={progressPara}
            x={0}
            y={0}
            width={containerWidth}
          />
        </Group>
      )}
      {/* Sustain glow (blurred shadow over the revealed area) */}
      {hasSustain && (
        <Group clip={clipRect} layer>
          <Shadow
            dx={0}
            dy={0}
            blur={glowBlur}
            color={isBackground ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.24)"}
          />
          <SkiaParagraph
            paragraph={progressPara}
            x={0}
            y={0}
            width={containerWidth}
          />
        </Group>
      )}
    </Group>
  );
});
