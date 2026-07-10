/**
 * SkiaRevealLine — Skia Canvas per active lyric line.
 *
 * Replaces the 2-3 stacked overflow:hidden Reanimated.Views per syllable token
 * with a single <Canvas> that draws clip-masked text. Only used on active lines.
 *
 * ponytail: one Canvas per active line replaces 24+ animated Views.
 * FlashList still handles scroll/virtualization — this only handles the visual reveal.
 */
import { memo, useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import {
  Canvas,
  Fill,
  Group,
  Text as SkiaText,
  matchFont,
  rect,
  Shadow,
  type SkFont,
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
import { getGraphemeCount } from "@/lib/graphemes";

// ─── Constants (matching lyric-line.tsx) ────────────────────────────────────

const BASE_FONT_SIZE = 32;
const BASE_LINE_HEIGHT = 42;
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

function getRevealClipWidth(
  baseWidth: number,
  progress: number,
) {
  "worklet";
  const safeBase = Math.max(0, baseWidth);
  const p = clamp01(progress);
  return safeBase * p;
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

function getMonotonicNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function getSustainBlur(progress: number): number {
  "worklet";
  const d = (progress - 0.5) * 3;
  const intensity = Math.exp(-(d * d));
  return SUSTAIN_GLOW_RADIUS_MAX * intensity;
}

// ─── Layout types ───────────────────────────────────────────────────────────

type LayoutToken = {
  text: string;
  x: number;
  y: number;
  width: number;
  startTime: number;
  endTime: number;
  sustainMode: SustainMode;
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
    ? BG_FONT_SIZE * fontScale
    : BASE_FONT_SIZE * fontScale;
  const lineHeight = isBackground
    ? BG_LINE_HEIGHT * fontScale
    : BASE_LINE_HEIGHT * fontScale;

  const font = useMemo(
    () =>
      matchFont({
        fontFamily: "System",
        fontSize,
        fontWeight: "bold",
        fontStyle: "normal",
      }),
    [fontSize],
  );

  // Layout tokens respecting word groups and spaces
  // ponytail: wrapping only happens at word boundaries (between groups with needsTrailingGap)
  const tokens = useMemo(() => {
    if (!font) return [];
    const maxWidth = containerWidth;
    const result: LayoutToken[] = [];
    const spaceWidth = font.measureText(" ").width;

    // If no word groups provided, build a naive one (each syllable is its own group)
    const groups = wordGroups ?? syllables.map((_, i) => ({
      syllableIndexes: [i],
      needsTrailingGap: i < syllables.length - 1,
    }));

    let x = 0;
    let y = 0;

    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const group = groups[gIdx];

      // Measure total word group width (all syllables in this group)
      let groupWidth = 0;
      for (const sylIdx of group.syllableIndexes) {
        groupWidth += font.measureText(syllables[sylIdx].text).width;
      }

      // Wrap: if the whole word group doesn't fit, move to next line
      // (only wrap if we've already placed something on this line)
      if (x + groupWidth > maxWidth && x > 0) {
        x = 0;
        y += lineHeight;
      }

      // Place each syllable in the group
      for (const sylIdx of group.syllableIndexes) {
        const syl = syllables[sylIdx];
        const w = font.measureText(syl.text).width;
        const durationMs = Math.max(1, syl.endTime - syl.startTime);
        result.push({
          text: syl.text,
          x,
          y,
          width: w,
          startTime: syl.startTime,
          endTime: syl.endTime,
          sustainMode: getSustainMode(syl.text, durationMs),
        });
        x += w;
      }

      // Add space after group if it needs a trailing gap
      if (group.needsTrailingGap) {
        x += spaceWidth;
      }
    }
    return result;
  }, [font, syllables, wordGroups, containerWidth, lineHeight]);

  // Compute canvas height from layout
  const canvasHeight = useMemo(() => {
    if (tokens.length === 0) return lineHeight;
    const lastToken = tokens[tokens.length - 1];
    return lastToken.y + lineHeight;
  }, [tokens, lineHeight]);

  // Per-syllable progress shared values (driven by withTiming)
  const progressValues = useMemo(
    () => syllables.map(() => ({} as SharedValue<number>)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [syllables.length],
  );

  // Actually create the shared values (can't do it in useMemo with hooks)
  // ponytail: use a stable array of shared values matching syllable count
  return (
    <View style={{ width: containerWidth, height: canvasHeight }}>
      <Canvas style={StyleSheet.absoluteFill}>
        {tokens.map((token, idx) => (
          <SkiaToken
            key={`${token.startTime}-${idx}`}
            token={token}
            font={font}
            fontSize={fontSize}
            lineHeight={lineHeight}
            playbackPosition={playbackPosition}
            isPlaying={isPlaying}
            anchorPositionMs={anchorPositionMs}
            anchorMonotonicMs={anchorMonotonicMs}
            isBackground={isBackground}
          />
        ))}
      </Canvas>
    </View>
  );
});

// ─── Per-token component with its own progress SharedValue ──────────────────

const SkiaToken = memo(function SkiaToken({
  token,
  font,
  fontSize,
  lineHeight,
  playbackPosition,
  isPlaying,
  anchorPositionMs,
  anchorMonotonicMs,
  isBackground,
}: {
  token: LayoutToken;
  font: SkFont;
  fontSize: number;
  lineHeight: number;
  playbackPosition: number;
  isPlaying: boolean;
  anchorPositionMs: number;
  anchorMonotonicMs: number;
  isBackground: boolean;
}) {
  const progress = useSharedValue(
    getSyllableProgress(playbackPosition, token.startTime, token.endTime),
  );

  // Drive progress with withTiming — same logic as syncRevealProgress in lyric-line.tsx
  useEffect(() => {
    const nextProgress = getSyllableProgress(
      playbackPosition,
      token.startTime,
      token.endTime,
    );

    if (!isPlaying || nextProgress >= 1) {
      cancelAnimation(progress);
      progress.value = nextProgress;
      return;
    }

    const easing =
      getGraphemeCount(token.text) <= 2
        ? ReanimatedEasing.linear
        : REVEAL_SWEEP_EASING;

    if (playbackPosition < token.startTime) {
      cancelAnimation(progress);
      progress.value = nextProgress;
      progress.value = withDelay(
        Math.max(0, token.startTime - playbackPosition),
        withTiming(1, {
          duration: Math.max(1, token.endTime - token.startTime),
          easing,
        }),
      );
      return;
    }

    cancelAnimation(progress);
    progress.value = withTiming(1, {
      duration: Math.max(1, token.endTime - playbackPosition),
      easing,
    });
  }, [
    token.endTime,
    token.startTime,
    token.text,
    isPlaying,
    playbackPosition,
    progress,
  ]);

  const pendingColor = isBackground ? COLOR_BG_PENDING : COLOR_ACTIVE_PENDING;
  const progressColor = isBackground ? COLOR_BG_PROGRESS : COLOR_ACTIVE_PROGRESS;
  const textY = token.y + fontSize; // Skia draws from baseline

  // Derived clip rect — updates on UI thread as progress animates
  const clipRect = useDerivedValue(() => {
    const w = getRevealClipWidth(token.width, progress.value);
    return rect(token.x, token.y, w, lineHeight);
  });

  // Soft leading edge clip (slightly wider)
  const softClipRect = useDerivedValue(() => {
    // Soft edge is progress + small lead
    const p = clamp01(progress.value);
    const leadPx = isBackground ? 6 : 4;
    const w = Math.min(token.width, token.width * p + leadPx);
    return rect(token.x, token.y, w, lineHeight);
  });

  // Subtle vertical rise during reveal
  const riseY = useDerivedValue(() => {
    const p = progress.value;
    const rise = isBackground
      ? 0.005 * fontSize * (1 - 2 * p)
      : 0.01 * fontSize * (1 - 5 * p);
    return textY + rise;
  });

  // Sustain glow blur
  const glowBlur = useDerivedValue(() => {
    if (token.sustainMode === "none") return 0;
    const p = progress.value;
    if (p <= 0 || p >= 1) return 0;
    return getSustainBlur(p);
  });

  return (
    <Group>
      {/* Base: pending text */}
      <SkiaText
        x={token.x}
        y={riseY}
        text={token.text}
        font={font}
        color={pendingColor}
      />
      {/* Progress: clipped revealed text */}
      <Group clip={clipRect}>
        <SkiaText
          x={token.x}
          y={riseY}
          text={token.text}
          font={font}
          color={progressColor}
        />
      </Group>
      {/* Soft leading edge */}
      {!isBackground && (
        <Group clip={softClipRect} opacity={0.35}>
          <SkiaText
            x={token.x}
            y={riseY}
            text={token.text}
            font={font}
            color={progressColor}
          />
        </Group>
      )}
      {/* Sustain glow */}
      {token.sustainMode !== "none" && (
        <Group clip={clipRect} layer>
          <Shadow
            dx={0}
            dy={0}
            blur={glowBlur}
            color="rgba(255,255,255,0.24)"
          />
          <SkiaText
            x={token.x}
            y={riseY}
            text={token.text}
            font={font}
            color={progressColor}
          />
        </Group>
      )}
    </Group>
  );
});
