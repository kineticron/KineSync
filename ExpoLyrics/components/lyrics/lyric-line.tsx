import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated as RNAnimated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
  type TextStyle,
} from "react-native";
import Reanimated, {
  cancelAnimation,
  Easing as ReanimatedEasing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useShallow } from "zustand/react/shallow";

import {
  LANDSCAPE_LINE_SCALE_BLEED,
  LANDSCAPE_LYRIC_TEXT_LANE_WIDTH,
} from "@/constants/player-layout";
import { LYRICS_FONT_FAMILY } from "@/constants/lyrics-typography";
import { usePlaybackStore } from "@/store/playback-store";
import { getGraphemeCount, getGraphemes } from "@/lib/graphemes";
import type { LyricLine as LyricLineType, LyricSyllable } from "@/types/bridge";
import { SkiaRevealLine } from "./skia-lyrics-canvas";

const IDLE_PLAYBACK_SLICE = {
  bgStillActive: false,
  playbackPosition: 0,
  isPlaying: false,
  anchorPositionMs: 0,
  anchorMonotonicMs: 0,
} as const;

const SCALE_ACTIVE = 1.05;
const OPACITY_ACTIVE = 1;
const OPACITY_NEAR = 0.5;
const OPACITY_MID = 0.5;
const OPACITY_FAR = 0.5;
const COLOR_DONE = "rgba(255,255,255,0.5)";
const COLOR_ACTIVE_PENDING = "rgba(255,255,255,0.5)";
const COLOR_INACTIVE = "rgba(255,255,255,0.5)";
const COLOR_ACTIVE_PROGRESS = "#FFFFFF";
const SUSTAIN_MS_THRESHOLD = 680;
const MIN_MS_PER_CHAR_FOR_LETTER_SWEEP = 220;
const MAX_LETTER_SWEEP_CHARS = 5;
const WORD_SUSTAIN_MIN_MS = 920;
const SUSTAIN_SHORT_SCALE_BOOST = 0.068;
const SUSTAIN_LONG_SCALE_BOOST = 0.04;
const SUSTAIN_LONG_MS = 1200;
const SUSTAIN_GLOW_RADIUS_MAX = 7;
const SUSTAIN_GLOW_RADIUS_MAX_BG = 4;
const SUSTAIN_WORD_GLOW_RADIUS_MAX = 8;
const SUSTAIN_WORD_GLOW_RADIUS_MAX_BG = 4.5;
const SUSTAIN_GLOW_COLOR = "rgba(255,255,255,0.24)";
const SUSTAIN_GLOW_COLOR_BG = "rgba(255,255,255,0.18)";
const WORD_SUSTAIN_SCALE_EXPANSION_MAX = 4.2;
const WORD_SUSTAIN_SCALE_EXPANSION_MAX_BG = 2.4;
const BASE_FONT_SIZE = 32;
const BASE_LINE_HEIGHT = 42;
const LYRIC_TEXT_LANE_WIDTH = "88%";
const LINE_INNER_PADDING_HORIZONTAL = 16;
const LINE_INNER_PADDING_HORIZONTAL_LANDSCAPE = 2;
const BG_FONT_SIZE = BASE_FONT_SIZE * 0.62;
const BG_LINE_HEIGHT = BASE_LINE_HEIGHT * 0.62;
const PRIMARY_REVEAL_VERTICAL_PAD = 10;
const BG_REVEAL_VERTICAL_PAD = 6;
const PRIMARY_REVEAL_HORIZONTAL_PAD = 18;
const BG_REVEAL_HORIZONTAL_PAD = 10;
const PRIMARY_GLYPH_PAINT_WIDTH =
  BASE_FONT_SIZE + PRIMARY_REVEAL_HORIZONTAL_PAD;
const BG_GLYPH_PAINT_WIDTH = BG_FONT_SIZE + BG_REVEAL_HORIZONTAL_PAD;
const SUSTAIN_LINE_HEIGHT_LIFT_FACTOR = 0.58;
// ponytail: render oversized, scale down — text rasterizes at full size, no upscale pixelation
const SCALE_TRANSFORM_INACTIVE = 1 / SCALE_ACTIVE; // ≈ 0.952
const SCALE_TRANSFORM_ACTIVE = 1.0;

// ponytail: worklet version — used inside useAnimatedStyle only
function getInwardScaleTransformWorklet(
  scale: number,
  laneWidthPx: number,
  alignRight: boolean,
) {
  "worklet";
  if (laneWidthPx <= 0) {
    return [{ scale }];
  }
  const pivot = laneWidthPx / 2;
  if (alignRight) {
    return [
      { translateX: -pivot },
      { scale },
      { translateX: pivot },
    ];
  }
  return [
    { translateX: pivot },
    { scale },
    { translateX: -pivot },
  ];
}

function getScaledPrimaryRevealHorizontalPad(fontSize = BASE_FONT_SIZE) {
  return PRIMARY_REVEAL_HORIZONTAL_PAD * (fontSize / BASE_FONT_SIZE);
}

const REVEAL_SWEEP_EASING = ReanimatedEasing.out(ReanimatedEasing.ease);

function getSyllableProgress(
  positionMs: number,
  startTime: number,
  endTime: number,
) {
  const duration = Math.max(1, endTime - startTime);
  return Math.max(0, Math.min(1, (positionMs - startTime) / duration));
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

function getProjectedPlaybackPosition(
  anchorPositionMs: number,
  anchorMonotonicMs: number,
  isPlaying: boolean,
) {
  if (!isPlaying) {
    return Math.max(0, anchorPositionMs);
  }
  return Math.max(0, anchorPositionMs + getMonotonicNow() - anchorMonotonicMs);
}

function syncRevealProgress(
  progress: SharedValue<number>,
  playbackPosition: number,
  startTime: number,
  endTime: number,
  isPlaying: boolean,
  easing: typeof REVEAL_SWEEP_EASING,
) {
  const nextProgress = getSyllableProgress(
    playbackPosition,
    startTime,
    endTime,
  );

  if (!isPlaying || nextProgress >= 1) {
    cancelAnimation(progress);
    progress.value = nextProgress;
    return;
  }

  if (playbackPosition < startTime) {
    cancelAnimation(progress);
    progress.value = nextProgress;
    progress.value = withDelay(
      Math.max(0, startTime - playbackPosition),
      withTiming(1, {
        duration: Math.max(1, endTime - startTime),
        easing,
      }),
    );
    return;
  }

  // Cancel any in-flight animation, then animate from current value to 1.
  cancelAnimation(progress);
  progress.value = withTiming(1, {
    duration: Math.max(1, endTime - playbackPosition),
    easing,
  });
}

function estimateTokenWidth(text: string, fontSize: number) {
  const glyphCount = Math.max(1, getGraphemes(text || " ").length);
  return glyphCount * fontSize * 0.58;
}

function getSyllableGraphemes(syllable: LyricSyllable) {
  return syllable.graphemes ?? getGraphemes(syllable.text);
}

function getInactiveOpacity(distanceFromActive: number) {
  if (distanceFromActive <= 1) {
    return OPACITY_NEAR;
  }
  if (distanceFromActive <= 3) {
    return OPACITY_MID;
  }
  return OPACITY_FAR;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function interpolate(x: number, domain: number[], range: number[]) {
  "worklet";
  if (x <= domain[0]) return range[0];
  if (x >= domain[domain.length - 1]) return range[range.length - 1];
  for (let i = 0; i < domain.length - 1; i++) {
    if (x >= domain[i] && x <= domain[i + 1]) {
      const t = (x - domain[i]) / (domain[i + 1] - domain[i]);
      return range[i] + t * (range[i + 1] - range[i]);
    }
  }
  return range[range.length - 1];
}

function getPrimaryTokenRiseY(progress: number, fontSize = BASE_FONT_SIZE) {
  "worklet";
  const p = Math.max(0, Math.min(1, progress));
  return interpolate(p, [0, 1], [0.01 * fontSize, -0.04 * fontSize]);
}

function getBackgroundTokenRiseY(progress: number, fontSize = BG_FONT_SIZE) {
  "worklet";
  const p = Math.max(0, Math.min(1, progress));
  return interpolate(p, [0, 1], [0.005 * fontSize, -0.025 * fontSize]);
}

function smoothstep(value: number) {
  "worklet";
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function getCompletedLayerOpacity(progress: number, baseOpacity: number) {
  "worklet";
  const completionBlend = smoothstep((progress - 0.94) / 0.06);
  return baseOpacity + (1 - baseOpacity) * completionBlend;
}

function getRevealClipWidth(
  baseWidth: number,
  progress: number,
  leadWidth: number,
  edgePad: number,
) {
  "worklet";
  const safeBase = Math.max(0, baseWidth);
  const p = Math.max(0, Math.min(1, progress));
  const targetWidth = safeBase + edgePad;
  const swept = targetWidth * p + leadWidth * (1 - p);
  return Math.min(swept, targetWidth);
}



type SustainMode = "none" | "solo" | "letter-sweep" | "word";

function getSustainMode(text: string, durationMs: number): SustainMode {
  const trimmed = String(text || "").trim();
  const charCount = getGraphemeCount(trimmed);
  if (charCount === 0 || durationMs < SUSTAIN_MS_THRESHOLD) {
    return "none";
  }
  if (charCount === 1) {
    return "solo";
  }
  const msPerChar = durationMs / charCount;
  if (msPerChar >= MIN_MS_PER_CHAR_FOR_LETTER_SWEEP) {
    return "letter-sweep";
  }
  if (charCount > MAX_LETTER_SWEEP_CHARS && durationMs >= WORD_SUSTAIN_MIN_MS) {
    return "letter-sweep";
  }
  return "none";
}

function isSustainMode(
  mode: SustainMode,
): mode is Exclude<SustainMode, "none"> {
  return mode !== "none";
}

type SustainGlyphVisuals = {
  scale: number;
  fontSize: number;
  lineHeight: number;
  translateX: number;
  translateY: number;
  opacity: number;
  glowRadius: number;
};

function getSustainScaleBoost(durationMs: number, isBackground = false) {
  "worklet";
  const maxBoost =
    durationMs >= SUSTAIN_LONG_MS
      ? SUSTAIN_LONG_SCALE_BOOST
      : SUSTAIN_SHORT_SCALE_BOOST;
  return isBackground ? maxBoost * 0.55 : maxBoost;
}

function getSustainActiveIntensity(
  progress: number,
  charIdx: number,
  totalChars: number,
  isSoloMode: boolean,
) {
  "worklet";
  if (isSoloMode) {
    return interpolate(
      progress,
      [0, 0.12, 0.5, 0.88, 1],
      [0, 0.55, 1, 0.55, 0],
    );
  }

  const activeLetterFloat = progress * totalChars;
  const charCenter = charIdx + 0.5;
  const distance = Math.abs(charCenter - activeLetterFloat);
  // exp(-(3.1²)*0.48) ≈ 0.01 — skip math for distant glyphs
  if (distance > 3.1) return 0;
  const falloff = Math.exp(-(distance * distance) * 0.48);
  const fadeIn = smoothstep(progress / 0.12);
  const fadeOut = smoothstep((1 - progress) / 0.12);
  return falloff * fadeIn * fadeOut;
}

function getSustainGlowIntensity(
  progress: number,
  charIdx: number,
  totalChars: number,
) {
  "worklet";
  const activeLetterFloat = progress * totalChars;
  const charCenter = charIdx + 0.5;
  const distance = Math.abs(charCenter - activeLetterFloat);
  // exp(-(5.5²)*0.16) ≈ 0.01 — glow falloff is wider (0.16 vs 0.48)
  if (distance > 5.5) return 0;
  const falloff = Math.exp(-(distance * distance) * 0.16);
  const fadeIn = smoothstep(progress / 0.16);
  const fadeOut = smoothstep((1 - progress) / 0.16);
  return falloff * fadeIn * fadeOut;
}

function getSustainGlowRadius(glowIntensity: number, isBackground: boolean) {
  "worklet";
  const maxGlow = isBackground
    ? SUSTAIN_GLOW_RADIUS_MAX_BG
    : SUSTAIN_GLOW_RADIUS_MAX;
  return interpolate(glowIntensity, [0, 0.12, 1], [0, 0, maxGlow]);
}

function getWordSustainGlowRadius(
  activeIntensity: number,
  isBackground: boolean,
) {
  "worklet";
  const maxGlow = isBackground
    ? SUSTAIN_WORD_GLOW_RADIUS_MAX_BG
    : SUSTAIN_WORD_GLOW_RADIUS_MAX;
  return interpolate(activeIntensity, [0, 0.15, 1], [0, 0, maxGlow]);
}

function getWordSustainScaleBoost(
  durationMs: number,
  wordWidth: number,
  isBackground: boolean,
) {
  "worklet";
  const baseBoost = getSustainScaleBoost(durationMs, isBackground) * 0.92;
  const maxExpansion = isBackground
    ? WORD_SUSTAIN_SCALE_EXPANSION_MAX_BG
    : WORD_SUSTAIN_SCALE_EXPANSION_MAX;
  if (wordWidth <= 0) {
    return baseBoost;
  }
  return Math.min(baseBoost, maxExpansion / wordWidth);
}

function getSustainGlowStyle(
  glowRadius: number,
  isBackground: boolean,
): {
  textShadowColor?: string;
  textShadowOffset?: { width: number; height: number };
  textShadowRadius?: number;
} {
  if (glowRadius <= 0.01) {
    return {};
  }
  return {
    textShadowColor: isBackground ? SUSTAIN_GLOW_COLOR_BG : SUSTAIN_GLOW_COLOR,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: glowRadius,
  };
}
function computeSustainGlyphVisuals(
  progress: number,
  charIdx: number,
  totalChars: number,
  durationMs: number,
  isSoloMode: boolean,
  isBackground = false,
  primaryLiftBase = BASE_FONT_SIZE,
  primaryLineHeight = BASE_LINE_HEIGHT,
  forScaleTransform = false,
): SustainGlyphVisuals {
  "worklet";
  const activeIntensity = getSustainActiveIntensity(
    progress,
    charIdx,
    totalChars,
    isSoloMode,
  );
  const glowIntensity = isSoloMode
    ? activeIntensity
    : getSustainGlowIntensity(progress, charIdx, totalChars);
  const scaleBoost = getSustainScaleBoost(durationMs, isBackground);
  const easedActiveIntensity = smoothstep(activeIntensity);
  const easedGlowIntensity = smoothstep(glowIntensity);
  const scale = 1 + scaleBoost * easedActiveIntensity;
  const liftBase = primaryLiftBase;
  const baseLineHeight = primaryLineHeight;
  const fontSize = liftBase * scale;
  const lineHeight = baseLineHeight + (fontSize - liftBase) * 2;
  const lineHeightGrowth = lineHeight - baseLineHeight;
  const letterLevitation = -0.018 * liftBase * easedActiveIntensity;
  // ponytail: forScaleTransform uses center-pivot math; false path keeps fontSize-growth compensations for legacy callers
  const translateX = forScaleTransform ? 0 : -0.29 * liftBase * (scale - 1);
  const translateY = forScaleTransform
    ? letterLevitation - (scale - 1) * primaryLineHeight / 2
    : letterLevitation -
      lineHeightGrowth * SUSTAIN_LINE_HEIGHT_LIFT_FACTOR -
      (scale - 1) * liftBase * (isBackground ? 0.18 : 0.22);
  const opacity = interpolate(
    easedActiveIntensity,
    [0, 0.2, 1],
    [0.82, 0.92, 1],
  );
  const glowRadius = getSustainGlowRadius(easedGlowIntensity, isBackground);

  return {
    scale,
    fontSize,
    lineHeight,
    translateX,
    translateY,
    opacity,
    glowRadius,
  };
}

function computeWordSustainVisuals(
  progress: number,
  durationMs: number,
  isBackground = false,
  wordWidth = 0,
  primaryLiftBase = BASE_FONT_SIZE,
  primaryLineHeight = BASE_LINE_HEIGHT,
): SustainGlyphVisuals {
  "worklet";
  const activeIntensity = interpolate(
    progress,
    [0, 0.12, 0.5, 0.88, 1],
    [0, 0.65, 1, 0.65, 0],
  );
  const scaleBoost = getWordSustainScaleBoost(
    durationMs,
    wordWidth,
    isBackground,
  );
  const scale = 1 + scaleBoost * activeIntensity;
  const liftBase = primaryLiftBase;
  const baseLineHeight = primaryLineHeight;
  const fontSize = liftBase * scale;
  const lineHeight = baseLineHeight + (fontSize - liftBase) * 2;
  const lineHeightGrowth = lineHeight - baseLineHeight;
  const translateX = -0.29 * liftBase * (scale - 1);
  const translateY =
    -0.016 * liftBase * activeIntensity -
    lineHeightGrowth * SUSTAIN_LINE_HEIGHT_LIFT_FACTOR;
  const opacity = interpolate(activeIntensity, [0, 0.25, 1], [0.82, 0.94, 1]);
  const glowRadius = getWordSustainGlowRadius(activeIntensity, isBackground);

  return {
    scale,
    fontSize,
    lineHeight,
    translateX,
    translateY,
    opacity,
    glowRadius,
  };
}

function getSustainGlyphStyle(
  progress: number,
  charIdx: number,
  totalChars: number,
  durationMs: number,
  mode: "solo" | "letter-sweep" = "letter-sweep",
  primaryLiftBase = BASE_FONT_SIZE,
  primaryLineHeight = BASE_LINE_HEIGHT,
  revealHorizontalPad = getScaledPrimaryRevealHorizontalPad(primaryLiftBase),
) {
  const visuals = computeSustainGlyphVisuals(
    progress,
    charIdx,
    totalChars,
    durationMs,
    mode === "solo",
    false,
    primaryLiftBase,
    primaryLineHeight,
  );

  return {
    opacity: getCompletedLayerOpacity(progress, visuals.opacity),
    fontSize: visuals.fontSize,
    lineHeight: visuals.lineHeight,
    paddingRight: revealHorizontalPad,
    marginRight: -revealHorizontalPad,
    ...getSustainGlowStyle(visuals.glowRadius, false),
    transform: [
      { translateX: visuals.translateX },
      { translateY: visuals.translateY },
    ],
  };
}

function getBackgroundSustainGlyphStyle(
  progress: number,
  charIdx: number,
  totalChars: number,
  durationMs: number,
  mode: "solo" | "letter-sweep" = "letter-sweep",
  bgLiftBase = BG_FONT_SIZE,
  bgLineHeight = BG_LINE_HEIGHT,
) {
  const visuals = computeSustainGlyphVisuals(
    progress,
    charIdx,
    totalChars,
    durationMs,
    mode === "solo",
    true,
    bgLiftBase,
    bgLineHeight,
  );

  return {
    opacity: getCompletedLayerOpacity(progress, visuals.opacity),
    fontSize: bgLiftBase,
    lineHeight: bgLineHeight,
    paddingRight: BG_REVEAL_HORIZONTAL_PAD,
    marginRight: -BG_REVEAL_HORIZONTAL_PAD,
    ...getSustainGlowStyle(visuals.glowRadius, true),
    transform: [
      { translateX: visuals.translateX },
      { translateY: visuals.translateY },
      { scale: visuals.scale },
    ],
  };
}

function isCensorshipBoundary(currentText: string, nextText: string) {
  const current = String(currentText || "").trim();
  const next = String(nextText || "").trim();
  if (!current || !next) {
    return false;
  }
  const censorRun = /^[*＊•·]+$/;
  return (
    (censorRun.test(current) && /^[A-Za-z0-9]/.test(next)) ||
    (/[A-Za-z0-9]$/.test(current) && censorRun.test(next))
  );
}

const LEADING_ATTACH_MARKER_RE = /^[\p{Mark}\u200c\u200d\ufe00-\ufe0f]/u;
const ATTACH_TO_PREVIOUS_RE =
  /^[\p{Mark}\p{Modifier_Symbol}\p{Close_Punctuation}\p{Final_Punctuation}\p{Other_Punctuation}\u200c\u200d\ufe00-\ufe0f,.;:!?%…»–—'’”\-_~）】」』〉》]+$/u;
const ATTACH_TO_NEXT_RE =
  /^[\p{Open_Punctuation}\p{Initial_Punctuation}"'“‘({\[¿¡«–—\-_~（【「『〈《]+$/u;
const CENSOR_GLYPH_RE = /^[*＊•·]+$/u;
const SYMBOL_ONLY_SYLLABLE_RE =
  /^[\p{P}\p{S}*＊•·\-–—_~（）【】「」『』〈《〉》,.;:!?%…'"“”‘’]+$/u;

function isCensorOnlySyllable(text: string) {
  return CENSOR_GLYPH_RE.test(String(text || "").trim());
}

function isCensorSuffixContinuation(text: string) {
  const trimmed = String(text || "").trim();
  return /^(?:ing|in'|ed|er|es|s|n't)$/i.test(trimmed);
}

function shouldClusterCensorWithPrevious(previousText: string, text: string) {
  if (isCensorOnlySyllable(text)) {
    return false;
  }
  if (isCensorOnlySyllable(previousText)) {
    return isCensorSuffixContinuation(text);
  }
  return (
    shouldAttachToPrevious(text, previousText) ||
    shouldAttachToNext(previousText)
  );
}

function isSymbolOnlySyllable(text: string) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (!trimmed) {
    return /^\s+$/u.test(raw);
  }
  if (CENSOR_GLYPH_RE.test(trimmed)) {
    return true;
  }
  return (
    getGraphemeCount(trimmed) <= 3 && SYMBOL_ONLY_SYLLABLE_RE.test(trimmed)
  );
}

function usesTimedTokenSpacing(syllables: LyricSyllable[]) {
  return syllables.some((syl) => {
    const text = syl.text ?? "";
    return /\s$/.test(text) || /^\s/.test(text);
  });
}

function isStandaloneWordToken(text: string) {
  return /^(a|i|an|am|as|at|be|by|do|go|he|if|in|is|it|me|my|no|of|oh|ok|on|or|ow|so|to|up|us|we)$/i.test(
    String(text || "").trim(),
  );
}

function isSyllableWordContinuation(leftText: string, rightText: string) {
  const left = String(leftText || "").trim();
  const right = String(rightText || "").trim();
  if (!left || !right) {
    return false;
  }
  if (/\s$/.test(String(leftText || "")) || /^\s/.test(String(rightText || ""))) {
    return false;
  }
  if (isStandaloneWordToken(left) || isStandaloneWordToken(right)) {
    return false;
  }
  if (getGraphemeCount(left) !== 1 || !/^[a-z]$/.test(left)) {
    return false;
  }
  return /^[a-z]/.test(right);
}

function shouldInsertVisualGap(currentText: string, nextText: string) {
  const current = String(currentText || "");
  const next = String(nextText || "");
  if (!current || !next) {
    return false;
  }
  if (/\s$/.test(current) || /^\s/.test(next)) {
    return false;
  }
  if (isSyllableWordContinuation(current, next)) {
    return false;
  }
  // If a provider splits text into per-letter / per-syllable tokens (common for
  // QQ QRC in some Korean/English lines), inserting spaces between single glyphs
  // destroys the word shape. Only insert heuristic gaps when we see multi-glyph
  // chunks that look like word segments.
  const currentTrim = current.trim();
  const nextTrim = next.trim();
  if (getGraphemeCount(currentTrim) === 1 && getGraphemeCount(nextTrim) === 1) {
    return false;
  }
  // Netease (and some others) may provide censorship as separate syllables
  // e.g. "*", "*", "*", "*" — we should keep them adjacent without spaces.
  // Also support common full-width variants.
  const censorGlyph = /^[*＊•·]$/;
  if (censorGlyph.test(current.trim()) && censorGlyph.test(next.trim())) {
    return false;
  }
  if (isCensorshipBoundary(currentTrim, nextTrim)) {
    return false;
  }
  if (isSymbolOnlySyllable(current) || isSymbolOnlySyllable(next)) {
    if (isSymbolOnlySyllable(current) && isSymbolOnlySyllable(next)) {
      return false;
    }
    if (isSymbolOnlySyllable(next)) {
      if (shouldAttachToPrevious(next, current)) {
        return false;
      }
      if (/[A-Za-z0-9]$/.test(current.trim())) {
        return true;
      }
      return false;
    }
    return false;
  }
  // Quotes are commonly split into their own syllables by some sources.
  const quoteGlyph = /^["“”'‘’ʼ´]$/;
  if (quoteGlyph.test(current.trim()) || quoteGlyph.test(next.trim())) {
    return false;
  }
  // Some sources may isolate commas as their own syllable; keep them tight.
  if (current.trim() === "," || next.trim() === ",") {
    return false;
  }
  // Avoid adding gaps inside parentheticals, including full-width parens.
  if (/[（(\[{]$/.test(current)) {
    return false;
  }
  if (/^[,.;:!?)）\]\}%”’"*\-–—]/.test(next)) {
    return false;
  }
  return true;
}

type SyllableGroup = {
  syllableIndexes: number[];
  clusters: number[][];
  needsTrailingGap: boolean;
};

function shouldAttachToPrevious(text: string, previousText = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return false;
  }
  // Keep standalone handle/symbol tokens visually separate from the prior word.
  if (/^[@#]$/.test(trimmed)) {
    return false;
  }
  if (hasQrcAccentWordBoundary(previousText)) {
    return false;
  }
  const previousCore = String(previousText || "").replace(/\s+$/u, "");
  return (
    LEADING_ATTACH_MARKER_RE.test(trimmed) ||
    ATTACH_TO_PREVIOUS_RE.test(trimmed) ||
    isQrcAccentVowelFragment(trimmed) ||
    shouldMergeQrcPostAccentTail(previousCore, trimmed)
  );
}

function shouldAttachToNext(text: string) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return false;
  }
  return ATTACH_TO_NEXT_RE.test(trimmed);
}

function isQrcAccentVowelFragment(text: string) {
  const trimmed = String(text || "").trim();
  return (
    trimmed.length > 0 &&
    getGraphemeCount(trimmed) === 1 &&
    /^[áéíóúüñÁÉÍÓÚÜÑ]$/u.test(trimmed)
  );
}

function endsWithQrcAccentVowel(text: string) {
  const core = String(text || "").replace(/\s+$/u, "");
  if (!core) {
    return false;
  }
  const graphemes = getGraphemes(core);
  const last = graphemes[graphemes.length - 1] || "";
  return isQrcAccentVowelFragment(last);
}

function isQrcPostAccentLetterFragment(text: string) {
  const trimmed = String(text || "").trim();
  return (
    trimmed.length > 0 &&
    getGraphemeCount(trimmed) === 1 &&
    /^[a-zñ]$/i.test(trimmed)
  );
}

function hasSingleLetterBeforeAccentVowel(text: string) {
  const core = String(text || "").replace(/\s+$/u, "");
  return /(?:^|\s)([a-zñ])[áéíóúüñÁÉÍÓÚÜÑ]$/u.test(core);
}

function isQrcPostAccentSyllableTail(text: string, maxLength: number) {
  const trimmed = String(text || "").trim();
  if (
    !trimmed ||
    /^(?:y|o|a|e|de|el|la|los|las|en|un|una|que|por|con|se|es|al|del|yo|tu|no|si)$/i.test(
      trimmed,
    )
  ) {
    return false;
  }
  if (isQrcPostAccentLetterFragment(trimmed)) {
    return true;
  }
  return /^[a-zñ]+$/i.test(trimmed) && trimmed.length <= maxLength;
}

function hasQrcAccentWordBoundary(text: string) {
  return /[áéíóúüñÁÉÍÓÚÜÑ]\s+$/u.test(String(text || ""));
}

function shouldMergeQrcPostAccentTail(
  previousText: string,
  fragmentText: string,
) {
  if (hasQrcAccentWordBoundary(previousText)) {
    return false;
  }
  const previousCore = String(previousText || "").replace(/\s+$/u, "");
  if (!endsWithQrcAccentVowel(previousCore)) {
    return false;
  }
  const trimmed = String(fragmentText || "").trim();
  if (isQrcPostAccentLetterFragment(trimmed)) {
    return true;
  }
  if (hasSingleLetterBeforeAccentVowel(previousCore)) {
    return isQrcPostAccentSyllableTail(trimmed, 8);
  }
  return isQrcPostAccentSyllableTail(trimmed, 4);
}

function shouldBreakBetweenSyllables(
  current: LyricSyllable,
  next: LyricSyllable,
  shouldTrustWordInfo: boolean,
) {
  const currentText = current.text ?? "";
  const nextText = next.text ?? "";

  // Timed sources like QQ QRC already encode spaces inside syllable text.
  if (/\s$/.test(currentText) || /^\s/.test(nextText)) {
    return false;
  }

  const currentIsCensor = isCensorOnlySyllable(currentText);
  const nextIsCensor = isCensorOnlySyllable(nextText);
  if (currentIsCensor !== nextIsCensor) {
    if (currentIsCensor) {
      return !isCensorSuffixContinuation(nextText);
    }
    return true;
  }
  if (currentIsCensor && nextIsCensor) {
    return false;
  }

  if (isSymbolOnlySyllable(currentText) || isSymbolOnlySyllable(nextText)) {
    if (isSymbolOnlySyllable(currentText) && isSymbolOnlySyllable(nextText)) {
      return false;
    }
    if (isSymbolOnlySyllable(nextText)) {
      if (
        shouldAttachToNext(currentText) ||
        shouldAttachToPrevious(nextText, currentText)
      ) {
        return false;
      }
      if (shouldTrustWordInfo && current.isPartOfWord === false) {
        return true;
      }
      if (/[A-Za-z0-9]$/.test(String(currentText || "").trim())) {
        return true;
      }
      return shouldInsertVisualGap(currentText, nextText);
    }
    return false;
  }

  if (
    shouldAttachToNext(currentText) ||
    shouldAttachToPrevious(nextText, currentText)
  ) {
    return false;
  }

  if (current.isPartOfWord === true) {
    return false;
  }

  if (!shouldTrustWordInfo) {
    return shouldInsertVisualGap(currentText, nextText);
  }

  if (isCensorshipBoundary(currentText, nextText)) {
    return true;
  }

  if (current.isPartOfWord !== false) {
    return false;
  }

  // Providers often mark punctuation / combining marks as word boundaries even
  // though they must stay on the same flex row as neighboring syllables.
  if (shouldAttachToNext(currentText)) {
    return false;
  }
  if (shouldAttachToPrevious(currentText)) {
    return false;
  }
  if (shouldAttachToPrevious(nextText)) {
    return false;
  }
  if (isQrcAccentVowelFragment(nextText)) {
    return false;
  }
  if (shouldMergeQrcPostAccentTail(currentText, nextText)) {
    return false;
  }

  return true;
}

function clusterSyllableIndexes(
  syllables: LyricSyllable[],
  syllableIndexes: number[],
) {
  const clusters: number[][] = [];
  let current: number[] = [];

  // Keep punctuation and combining marks with their base token while preserving
  // safe syllable-level wrap points for long unspaced lyrics.
  for (const idx of syllableIndexes) {
    const text = syllables[idx]?.text ?? "";
    const previousIdx = current[current.length - 1];
    const previousText =
      previousIdx === undefined ? "" : (syllables[previousIdx]?.text ?? "");
    const mustStayWithPrevious =
      current.length > 0 && shouldClusterCensorWithPrevious(previousText, text);

    if (!mustStayWithPrevious && current.length > 0) {
      clusters.push(current);
      current = [];
    }

    current.push(idx);
  }

  if (current.length > 0) {
    clusters.push(current);
  }

  return clusters;
}

function shouldEndTimedPhraseBeforeNext(text: string, nextText: string) {
  if (!nextText) {
    return false;
  }
  if (isCensorOnlySyllable(nextText) && !isCensorOnlySyllable(text)) {
    return !isCensorSuffixContinuation(nextText);
  }
  if (isCensorOnlySyllable(text) && !isCensorOnlySyllable(nextText)) {
    return !isCensorSuffixContinuation(nextText);
  }
  return false;
}

function groupSyllablesByTimedTokenSpacing(
  syllables: LyricSyllable[],
): SyllableGroup[] {
  const groups: SyllableGroup[] = [];
  let current: SyllableGroup | null = null;

  for (let idx = 0; idx < syllables.length; idx += 1) {
    const text = syllables[idx]?.text ?? "";
    const nextText = syllables[idx + 1]?.text ?? "";
    if (!current) {
      current = { syllableIndexes: [], clusters: [], needsTrailingGap: false };
    }
    current.syllableIndexes.push(idx);
    const hasTrailingSpace = /\s$/.test(text);
    const breakBeforeNext = shouldEndTimedPhraseBeforeNext(text, nextText);
    const endsPhrase =
      idx < syllables.length - 1 && (hasTrailingSpace || breakBeforeNext);
    if (endsPhrase) {
      // Timed tokens usually embed spaces in syllable text ("word "). Only add a
      // separate gap when we break before a censor run without that space.
      if (breakBeforeNext && !hasTrailingSpace) {
        current.needsTrailingGap = true;
      }
      groups.push(current);
      current = null;
    }
  }

  if (current?.syllableIndexes.length) {
    groups.push(current);
  }

  return groups.map((group) => ({
    ...group,
    clusters: clusterSyllableIndexes(syllables, group.syllableIndexes),
  }));
}

function groupSyllablesIntoWords(syllables: LyricSyllable[]): SyllableGroup[] {
  if (usesTimedTokenSpacing(syllables)) {
    return groupSyllablesByTimedTokenSpacing(syllables);
  }

  const hasAnyWordInfo = syllables.some(
    (syl) => typeof syl.isPartOfWord === "boolean",
  );
  const hasAnyBoundaryFlag = syllables.some(
    (syl) => syl.isPartOfWord === false,
  );
  const allMarkedPartOfWord =
    hasAnyWordInfo &&
    !hasAnyBoundaryFlag &&
    syllables.every((syl) => syl.isPartOfWord === true);
  // Some sources always send `isPartOfWord: true` which is not useful for
  // detecting word boundaries. In that case, fall back to heuristic spacing.
  const shouldTrustWordInfo =
    hasAnyWordInfo && hasAnyBoundaryFlag && !allMarkedPartOfWord;

  const groups: SyllableGroup[] = [];
  let current: SyllableGroup | null = null;

  for (let idx = 0; idx < syllables.length; idx += 1) {
    const syl = syllables[idx];
    const nextSyl = syllables[idx + 1];
    const needsGap = nextSyl
      ? shouldBreakBetweenSyllables(syl, nextSyl, shouldTrustWordInfo)
      : false;

    if (!current) {
      current = { syllableIndexes: [], clusters: [], needsTrailingGap: false };
    }

    current.syllableIndexes.push(idx);
    current.needsTrailingGap = needsGap;

    if (needsGap) {
      groups.push(current);
      current = null;
    }
  }

  if (current) {
    groups.push(current);
  }

  return groups.map((group) => ({
    ...group,
    clusters: clusterSyllableIndexes(syllables, group.syllableIndexes),
  }));
}

function getSyllableDisplayText(text: string) {
  return String(text || "").replace(/\s+$/u, "");
}

function groupNeedsLeadingGap(
  groups: SyllableGroup[],
  syllables: LyricSyllable[],
  groupIdx: number,
) {
  if (groupIdx <= 0) {
    return false;
  }
  const previousGroup = groups[groupIdx - 1];
  if (previousGroup.needsTrailingGap) {
    return true;
  }
  const lastSyllableIdx =
    previousGroup.syllableIndexes[previousGroup.syllableIndexes.length - 1];
  const lastText = syllables[lastSyllableIdx]?.text ?? "";
  return /\s$/.test(lastText);
}

type LyricLineProps = {
  line: LyricLineType;
  isActive: boolean;
  isPast: boolean;
  inactiveOpacityDistance: number;
  showTranslatedText: boolean;
  pauseTone?: "none" | "past" | "future";
  showPauseDotsAfter?: boolean;
  showPauseDotsBefore?: boolean;
  pauseStartMs?: number;
  pauseVisualDurationMs?: number;
  playbackPositionOverrideMs?: number | null;
  onPress?: (line: LyricLineType) => void;
  onLongPress?: (line: LyricLineType) => void;
  tapEnabled: boolean;
  shouldDrivePlaybackUpdates: boolean;
  fontScale?: number;
  landscapeMode?: boolean;
};

function areSyllableArraysEqual(
  a: LyricLineType["syllables"] | undefined,
  b: LyricLineType["syllables"] | undefined,
) {
  if (a === b) return true;
  if (!a?.length && !b?.length) return true;
  if (a?.length !== b?.length) return false;
  for (let i = 0; i < (a?.length ?? 0); i += 1) {
    const prev = a![i];
    const next = b![i];
    if (
      prev.text !== next.text ||
      prev.startTime !== next.startTime ||
      prev.endTime !== next.endTime ||
      prev.isPartOfWord !== next.isPartOfWord
    ) {
      return false;
    }
  }
  return true;
}

function areLyricLinesEqual(a: LyricLineType, b: LyricLineType) {
  if (a === b) {
    return true;
  }
  if (
    a.lineStartTime !== b.lineStartTime ||
    a.lineEndTime !== b.lineEndTime ||
    Boolean(a.oppositeAligned) !== Boolean(b.oppositeAligned) ||
    (a.translatedText ?? "") !== (b.translatedText ?? "")
  ) {
    return false;
  }
  return (
    areSyllableArraysEqual(a.syllables, b.syllables) &&
    areSyllableArraysEqual(a.backgroundSyllables, b.backgroundSyllables)
  );
}

function areLyricLinePropsEqual(prev: LyricLineProps, next: LyricLineProps) {
  return (
    areLyricLinesEqual(prev.line, next.line) &&
    prev.isActive === next.isActive &&
    prev.isPast === next.isPast &&
    getInactiveOpacity(prev.inactiveOpacityDistance) ===
      getInactiveOpacity(next.inactiveOpacityDistance) &&
    prev.showTranslatedText === next.showTranslatedText &&
    prev.pauseTone === next.pauseTone &&
    prev.showPauseDotsAfter === next.showPauseDotsAfter &&
    prev.showPauseDotsBefore === next.showPauseDotsBefore &&
    (prev.pauseStartMs ?? 0) === (next.pauseStartMs ?? 0) &&
    (prev.pauseVisualDurationMs ?? 0) === (next.pauseVisualDurationMs ?? 0) &&
    prev.playbackPositionOverrideMs === next.playbackPositionOverrideMs &&
    prev.tapEnabled === next.tapEnabled &&
    prev.shouldDrivePlaybackUpdates === next.shouldDrivePlaybackUpdates &&
    (prev.fontScale ?? 1) === (next.fontScale ?? 1) &&
    Boolean(prev.landscapeMode) === Boolean(next.landscapeMode) &&
    prev.onPress === next.onPress &&
    prev.onLongPress === next.onLongPress
  );
}

export const LyricLine = memo(function LyricLine({
  line,
  isActive,
  isPast,
  inactiveOpacityDistance,
  showTranslatedText,
  pauseTone = "none",
  showPauseDotsAfter = false,
  showPauseDotsBefore = false,
  pauseStartMs = 0,
  pauseVisualDurationMs = 0,
  playbackPositionOverrideMs = null,
  onPress,
  onLongPress,
  tapEnabled,
  shouldDrivePlaybackUpdates,
  fontScale = 1,
  landscapeMode = false,
}: LyricLineProps) {
  // ponytail: oversized render — always at SCALE_ACTIVE size, scaled down when inactive
  const lineFontSize = BASE_FONT_SIZE * SCALE_ACTIVE * fontScale;
  const lineLineHeight = BASE_LINE_HEIGHT * SCALE_ACTIVE * fontScale;
  const scaledLineTextStyle = useMemo(
    () => ({
      fontSize: lineFontSize,
      lineHeight: lineLineHeight,
    }),
    [lineFontSize, lineLineHeight],
  );
  const bgEnd = line.backgroundSyllables?.length
    ? line.backgroundSyllables[line.backgroundSyllables.length - 1].endTime
    : 0;
  const hasBgExtension = bgEnd > line.lineEndTime;
  const shouldPrewarmNativeReveal =
    shouldDrivePlaybackUpdates &&
    playbackPositionOverrideMs == null &&
    !isPast &&
    !isActive &&
    inactiveOpacityDistance <= 1;
  const shouldUseNativeRevealTree =
    playbackPositionOverrideMs == null &&
    !isPast &&
    (isActive || shouldPrewarmNativeReveal);
  const needsPrimaryJsPlayback =
    isActive && playbackPositionOverrideMs != null;
  // Single shallow selector — far/inactive rows stay cold on the 64ms clock.
  const needsPlaybackSlice =
    shouldDrivePlaybackUpdates ||
    shouldUseNativeRevealTree ||
    needsPrimaryJsPlayback ||
    isActive ||
    shouldPrewarmNativeReveal;

  const {
    bgStillActive,
    playbackPosition,
    isPlaying,
    anchorPositionMs,
    anchorMonotonicMs,
  } = usePlaybackStore(
    useShallow(
      useCallback(
        (state) => {
          if (!needsPlaybackSlice) {
            return IDLE_PLAYBACK_SLICE;
          }
          const position = playbackPositionOverrideMs ?? state.playbackPosition;
          return {
            bgStillActive:
              hasBgExtension && shouldDrivePlaybackUpdates
                ? position >= line.lineEndTime && position < bgEnd
                : false,
            playbackPosition: needsPrimaryJsPlayback ? position : 0,
            isPlaying:
              isActive || shouldPrewarmNativeReveal ? state.isPlaying : false,
            anchorPositionMs: shouldUseNativeRevealTree
              ? state.anchorPositionMs
              : 0,
            anchorMonotonicMs: shouldUseNativeRevealTree
              ? state.anchorMonotonicMs
              : 0,
          };
        },
        [
          bgEnd,
          hasBgExtension,
          isActive,
          line.lineEndTime,
          needsPlaybackSlice,
          needsPrimaryJsPlayback,
          playbackPositionOverrideMs,
          shouldDrivePlaybackUpdates,
          shouldPrewarmNativeReveal,
          shouldUseNativeRevealTree,
        ],
      ),
    ),
  );

  const visuallyActive = isActive || bgStillActive;
  const inactiveOpacity = getInactiveOpacity(inactiveOpacityDistance);
  const shouldRevealPrimary =
    !isPast && (isActive || shouldPrewarmNativeReveal);
  const shouldAnimateRevealSweep = isPlaying && shouldUseNativeRevealTree;
  const nativeRevealPlaybackPosition = useMemo(
    () =>
      getProjectedPlaybackPosition(
        anchorPositionMs,
        anchorMonotonicMs,
        isPlaying,
      ),
    [anchorMonotonicMs, anchorPositionMs, isPlaying],
  );
  const skiaPlaybackPosition =
    playbackPositionOverrideMs !== null
      ? playbackPosition
      : nativeRevealPlaybackPosition;
  const [tokenWidths, setTokenWidths] = useState<Record<number, number>>({});
  const pendingTokenWidthsRef = useRef<Record<number, number>>({});
  const tokenWidthFlushFrameRef = useRef<number | null>(null);
  const scaleAnim = useSharedValue(visuallyActive ? SCALE_TRANSFORM_ACTIVE : SCALE_TRANSFORM_INACTIVE);
  const opacityAnim = useSharedValue(
    visuallyActive ? OPACITY_ACTIVE : getInactiveOpacity(inactiveOpacityDistance),
  );

  useEffect(() => {
    scaleAnim.value = withTiming(
      visuallyActive ? SCALE_TRANSFORM_ACTIVE : SCALE_TRANSFORM_INACTIVE,
      { easing: ReanimatedEasing.bezier(0.61, 1, 0.88, 1) },
    );
  }, [visuallyActive, scaleAnim]);

  useEffect(() => {
    opacityAnim.value = withTiming(
      visuallyActive ? OPACITY_ACTIVE : inactiveOpacity,
      { easing: ReanimatedEasing.bezier(0.61, 1, 0.88, 1) },
    );
  }, [inactiveOpacity, visuallyActive, opacityAnim]);

  useEffect(() => {
    if (
      tokenWidthFlushFrameRef.current !== null &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(tokenWidthFlushFrameRef.current);
    }
    tokenWidthFlushFrameRef.current = null;
    pendingTokenWidthsRef.current = {};
    setTokenWidths({});
    return () => {
      if (
        tokenWidthFlushFrameRef.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(tokenWidthFlushFrameRef.current);
      }
      tokenWidthFlushFrameRef.current = null;
      pendingTokenWidthsRef.current = {};
    };
  }, [line.lineStartTime, line.lineEndTime]);

  const textWeight = "700" as const;
  const translatedText = String(line.translatedText || "").trim();
  const isOppositeAligned = Boolean(line.oppositeAligned);
  const alignRight = landscapeMode ? !isOppositeAligned : isOppositeAligned;
  const textLaneWidth = landscapeMode
    ? LANDSCAPE_LYRIC_TEXT_LANE_WIDTH
    : LYRIC_TEXT_LANE_WIDTH;
  const lineInnerPaddingHorizontal = landscapeMode
    ? LINE_INNER_PADDING_HORIZONTAL_LANDSCAPE
    : LINE_INNER_PADDING_HORIZONTAL;
  const translatedColor = isPast
    ? "rgba(255,255,255,0.72)"
    : visuallyActive
      ? "rgba(255,255,255,0.66)"
      : "rgba(255,255,255,0.42)";
  const onPressLine = tapEnabled ? () => onPress?.(line) : undefined;
  const onLongPressLine = onLongPress ? () => onLongPress(line) : undefined;
  const flushPendingTokenWidths = useCallback(() => {
    tokenWidthFlushFrameRef.current = null;
    const pending = pendingTokenWidthsRef.current;
    pendingTokenWidthsRef.current = {};
    setTokenWidths((prev) => {
      let next: Record<number, number> | null = null;
      for (const [key, width] of Object.entries(pending)) {
        const idx = Number(key);
        const prevWidth = prev[idx] ?? 0;
        if (Math.abs(prevWidth - width) < 0.5) {
          continue;
        }
        if (!next) {
          next = { ...prev };
        }
        next[idx] = width;
      }
      return next ?? prev;
    });
  }, []);
  const setTokenWidth = useCallback(
    (idx: number, width: number) => {
      if (!Number.isFinite(width) || width <= 0) {
        return;
      }
      pendingTokenWidthsRef.current[idx] = width;
      if (tokenWidthFlushFrameRef.current !== null) {
        return;
      }
      if (typeof requestAnimationFrame === "function") {
        tokenWidthFlushFrameRef.current = requestAnimationFrame(
          flushPendingTokenWidths,
        );
        return;
      }
      flushPendingTokenWidths();
    },
    [flushPendingTokenWidths],
  );
  const syllableGroups = useMemo(
    () => groupSyllablesIntoWords(line.syllables),
    [line.syllables],
  );
  const usesTimedSpacingLayout = useMemo(
    () => usesTimedTokenSpacing(line.syllables),
    [line.syllables],
  );
  const [laneWidthPx, setLaneWidthPx] = useState(0);
  const handleLaneLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number } } }) => {
      const nextWidth = event.nativeEvent.layout.width;
      if (!Number.isFinite(nextWidth) || nextWidth <= 0) {
        return;
      }
      setLaneWidthPx((previous) =>
        Math.abs(previous - nextWidth) < 0.5 ? previous : nextWidth,
      );
    },
    [],
  );
  useEffect(() => {
    setLaneWidthPx(0);
  }, [textLaneWidth]);
  const translatedTextWidthStyle = useMemo(() => {
    if (laneWidthPx <= 0) {
      return { width: textLaneWidth as number | `${number}%` };
    }
    const laneFraction = landscapeMode ? 0.9 : 0.88;
    return { width: Math.round(laneWidthPx * laneFraction) };
  }, [laneWidthPx, landscapeMode, textLaneWidth]);
  const lineAnimStyle = useAnimatedStyle(() => ({
    opacity: opacityAnim.value,
    transform: getInwardScaleTransformWorklet(scaleAnim.value, laneWidthPx, alignRight),
  }), [laneWidthPx, alignRight]);
  const containerStyle = useMemo(
    () => [
      styles.lineOuter as ViewStyle,
      landscapeMode && (styles.lineOuterLandscape as ViewStyle),
      fontScale !== 1 && ({ minHeight: 84 * fontScale } as ViewStyle),
    ] as ViewStyle[],
    [fontScale, landscapeMode],
  );
  const toneOpacity =
    pauseTone === "future" ? 0.76 : pauseTone === "past" ? 0.94 : 1;

  return (
    <Reanimated.View style={[...containerStyle, lineAnimStyle]}>
      {showPauseDotsBefore && (
        <PauseDots
          alignRight={alignRight}
          pauseStartMs={pauseStartMs}
          pauseVisualDurationMs={pauseVisualDurationMs}
          fontSize={lineFontSize}
          edgeInset={lineInnerPaddingHorizontal}
        />
      )}
      <Pressable
        onLongPress={onLongPressLine}
        onPress={onPressLine}
        style={styles.linePressable as ViewStyle}
      >
        <View
          style={[
            styles.lineInner as ViewStyle,
            alignRight && (styles.lineInnerOpposite as ViewStyle),
            {
              opacity: toneOpacity,
              paddingHorizontal: lineInnerPaddingHorizontal,
            } as ViewStyle,
          ] as ViewStyle[]}
        >
          <View
            style={[
              styles.lineContentScaleWrap as ViewStyle,
              alignRight && (styles.lineContentScaleWrapRight as ViewStyle),
            ] as ViewStyle[]}
          >
          <View
            style={[
              styles.lineFlowScaleShell as ViewStyle,
              { width: textLaneWidth } as ViewStyle,
              alignRight && (styles.lineFlowScaleShellOpposite as ViewStyle),
            ] as ViewStyle[]}
          >
            <View
              onLayout={handleLaneLayout}
              style={[
                styles.lineFlow as ViewStyle,
                { width: textLaneWidth } as ViewStyle,
                alignRight && (styles.lineFlowOpposite as ViewStyle),
              ] as ViewStyle[]}
            >
              {/* Keep primary-line layout in Skia for every state so activation
                  never swaps between different text engines or font metrics. */}
              {laneWidthPx > 0 ? (
                <SkiaRevealLine
                  syllables={line.syllables}
                  wordGroups={syllableGroups}
                  playbackPosition={skiaPlaybackPosition}
                  isPlaying={shouldAnimateRevealSweep}
                  containerWidth={laneWidthPx}
                  fontScale={fontScale}
                  alignRight={alignRight}
                  revealEnabled={shouldRevealPrimary}
                />
              ) : syllableGroups.map((group, groupIdx) => (
                <View
                  // Group syllables into a flex item, then wrap only at safe clusters.
                  key={`${line.lineStartTime}-word-${groupIdx}`}
                  style={[
                    styles.wordWrap as ViewStyle,
                    usesTimedSpacingLayout && (styles.wordWrapPhrase as ViewStyle),
                  ] as ViewStyle[]}
                >
                  {alignRight &&
                    groupNeedsLeadingGap(
                      syllableGroups,
                      line.syllables,
                      groupIdx,
                    ) && <Text style={styles.gapText as TextStyle}> </Text>}
                  {group.clusters.map((cluster, clusterIdx) => (
                    <View
                      key={`${line.lineStartTime}-word-${groupIdx}-cluster-${clusterIdx}`}
                      style={styles.noBreakCluster as ViewStyle}
                    >
                      {cluster.map((idx) => {
                        const syl = line.syllables[idx];
                        const renderedText = alignRight
                          ? getSyllableDisplayText(syl.text ?? "")
                          : (syl.text ?? "");
                        const renderedChars =
                          alignRight && renderedText
                            ? getGraphemes(renderedText)
                            : getSyllableGraphemes(syl);

                        if (isPast) {
                          return (
                            <View
                              key={`${line.lineStartTime}-${idx}`}
                              style={styles.tokenWrap as ViewStyle}
                            >
                              <Text
                                style={[
                                  styles.lineText,
                                  scaledLineTextStyle,
                                  { color: COLOR_DONE, fontWeight: textWeight },
                                ]}
                              >
                                {renderedText}
                              </Text>
                            </View>
                          );
                        }

                        if (!isActive && !shouldPrewarmNativeReveal) {
                          return (
                            <View
                              key={`${line.lineStartTime}-${idx}`}
                              style={styles.tokenWrap as ViewStyle}
                            >
                              <Text
                                style={[
                                  styles.lineText,
                                  scaledLineTextStyle,
                                  {
                                    color: bgStillActive
                                      ? COLOR_DONE
                                      : COLOR_INACTIVE,
                                    fontWeight: textWeight,
                                  },
                                ]}
                              >
                                {renderedText}
                              </Text>
                            </View>
                          );
                        }

                        const progress = getSyllableProgress(
                          playbackPosition,
                          syl.startTime,
                          syl.endTime,
                        );
                        const tokenWidth = tokenWidths[idx] ?? 0;
                        const shouldMeasure = tokenWidth <= 0;
                        const tokenDurationMs = Math.max(
                          1,
                          syl.endTime - syl.startTime,
                        );
                        const sustainMode = getSustainMode(
                          renderedText,
                          tokenDurationMs,
                        );
                        const hasSustainEffect = isSustainMode(sustainMode);
                        const glyphSustainMode =
                          sustainMode === "solo" ||
                          sustainMode === "letter-sweep"
                            ? sustainMode
                            : "letter-sweep";
                        const regularRiseY = getPrimaryTokenRiseY(
                          progress,
                          lineFontSize,
                        );

                        if (!hasSustainEffect) {
                          return (
                            <PrimaryRevealSweepToken
                              key={`${line.lineStartTime}-${idx}`}
                              text={renderedText}
                              startTime={syl.startTime}
                              endTime={syl.endTime}
                              playbackPosition={nativeRevealPlaybackPosition}
                              isPlaying={shouldAnimateRevealSweep}
                              tokenWidth={tokenWidth}
                              shouldMeasure={shouldMeasure}
                              textWeight={textWeight}
                              lineFontSize={lineFontSize}
                              lineLineHeight={lineLineHeight}
                              onMeasure={(width) => setTokenWidth(idx, width)}
                            />
                          );
                        }

                        if (
                          shouldUseNativeRevealTree &&
                          sustainMode === "word"
                        ) {
                          return (
                            <PrimaryWordSustainRevealToken
                              key={`${line.lineStartTime}-${idx}`}
                              text={renderedText}
                              startTime={syl.startTime}
                              endTime={syl.endTime}
                              playbackPosition={nativeRevealPlaybackPosition}
                              isPlaying={shouldAnimateRevealSweep}
                              tokenWidth={tokenWidth}
                              shouldMeasure={shouldMeasure}
                              textWeight={textWeight}
                              lineFontSize={lineFontSize}
                              lineLineHeight={lineLineHeight}
                              onMeasure={(width) => setTokenWidth(idx, width)}
                            />
                          );
                        }

                        if (
                          shouldUseNativeRevealTree &&
                          (sustainMode === "solo" ||
                            sustainMode === "letter-sweep")
                        ) {
                          return (
                            <PrimarySustainRevealToken
                              key={`${line.lineStartTime}-${idx}`}
                              text={renderedText}
                              startTime={syl.startTime}
                              endTime={syl.endTime}
                              playbackPosition={nativeRevealPlaybackPosition}
                              isPlaying={shouldAnimateRevealSweep}
                              tokenWidth={tokenWidth}
                              shouldMeasure={shouldMeasure}
                              textWeight={textWeight}
                              sustainMode={glyphSustainMode}
                              lineFontSize={lineFontSize}
                              lineLineHeight={lineLineHeight}
                              onMeasure={(width) => setTokenWidth(idx, width)}
                            />
                          );
                        }

                        const renderSustainText = (color: string) => {
                          const textStyles = [
                            styles.lineText,
                            scaledLineTextStyle,
                            { color, fontWeight: textWeight },
                          ];
                          if (hasSustainEffect) {
                            if (sustainMode === "word") {
                              const wordStyle = computeWordSustainVisuals(
                                progress,
                                tokenDurationMs,
                                false,
                                tokenWidth > 0
                                  ? tokenWidth
                                  : estimateTokenWidth(
                                      renderedText,
                                      lineFontSize,
                                    ),
                                lineFontSize,
                                lineLineHeight,
                              );
                              return (
                                <RNAnimated.Text
                                  style={[
                                    ...textStyles,
                                    getSustainGlowStyle(
                                      wordStyle.glowRadius,
                                      false,
                                    ),
                                    {
                                      opacity: getCompletedLayerOpacity(
                                        progress,
                                        wordStyle.opacity,
                                      ),
                                      fontSize: wordStyle.fontSize,
                                      lineHeight: wordStyle.lineHeight,
                                      paddingRight: PRIMARY_REVEAL_HORIZONTAL_PAD,
                                      marginRight: -PRIMARY_REVEAL_HORIZONTAL_PAD,
                                      transform: [
                                        { translateX: wordStyle.translateX },
                                        { translateY: wordStyle.translateY },
                                      ],
                                    },
                                  ]}
                                >
                                  {renderedText}
                                </RNAnimated.Text>
                              );
                            }
                            return (
                              <View style={styles.sustainRow}>
                                {renderedChars.map((char, charIdx) => {
                                  const style = getSustainGlyphStyle(
                                    progress,
                                    charIdx,
                                    renderedChars.length,
                                    tokenDurationMs,
                                    glyphSustainMode,
                                    lineFontSize,
                                    lineLineHeight,
                                    getScaledPrimaryRevealHorizontalPad(lineFontSize),
                                  );
                                  return (
                                    <View
                                      key={`char-${charIdx}`}
                                      style={styles.sustainGlyphSlot}
                                    >
                                      <RNAnimated.Text
                                        style={[...textStyles, style]}
                                      >
                                        {char}
                                      </RNAnimated.Text>
                                    </View>
                                  );
                                })}
                              </View>
                            );
                          }
                          return (
                            <RNAnimated.Text style={textStyles}>
                              {renderedText}
                            </RNAnimated.Text>
                          );
                        };

                        const revealInnerStyle = {
                          width: tokenWidth + PRIMARY_REVEAL_HORIZONTAL_PAD,
                        };

                        if (progress <= 0) {
                          return (
                            <View
                              key={`${line.lineStartTime}-${idx}`}
                              style={[
                                styles.tokenWrap,
                                { transform: [{ translateY: regularRiseY }] },
                              ]}
                              onLayout={
                                shouldMeasure
                                  ? (event) =>
                                      setTokenWidth(
                                        idx,
                                        event.nativeEvent.layout.width,
                                      )
                                  : undefined
                              }
                            >
                              {renderSustainText(COLOR_ACTIVE_PENDING)}
                            </View>
                          );
                        }

                        return (
                          <View
                            key={`${line.lineStartTime}-${idx}`}
                            style={[
                              styles.tokenWrap,
                              { transform: [{ translateY: regularRiseY }] },
                            ]}
                            onLayout={
                              shouldMeasure
                                ? (event) =>
                                    setTokenWidth(
                                      idx,
                                      event.nativeEvent.layout.width,
                                    )
                                : undefined
                            }
                          >
                            {renderSustainText(COLOR_ACTIVE_PENDING)}
                            {tokenWidth > 0 && (
                              <>
                                {/* ponytail: merged soft+mid into one layer — matches native Reanimated path */}
                                {progress > 0 && progress < 1 && (
                                  <View
                                    pointerEvents="none"
                                    style={[
                                      styles.tokenRevealClip,
                                      styles.primaryTokenRevealClip,
                                      {
                                        width: getRevealClipWidth(
                                          tokenWidth,
                                          progress,
                                          4,
                                          PRIMARY_REVEAL_HORIZONTAL_PAD,
                                        ),
                                      },
                                    ]}
                                  >
                                    <View style={revealInnerStyle}>
                                      {renderSustainText(
                                        "rgba(255,255,255,0.25)",
                                      )}
                                    </View>
                                  </View>
                                )}
                                <View
                                  pointerEvents="none"
                                  style={[
                                    styles.tokenRevealClip,
                                    styles.primaryTokenRevealClip,
                                    {
                                      width: getRevealClipWidth(
                                        tokenWidth,
                                        progress,
                                        0,
                                        PRIMARY_REVEAL_HORIZONTAL_PAD,
                                      ),
                                    },
                                  ]}
                                >
                                  <View style={revealInnerStyle}>
                                    {renderSustainText(COLOR_ACTIVE_PROGRESS)}
                                  </View>
                                </View>
                              </>
                            )}
                          </View>
                        );
                      })}
                    </View>
                  ))}
                  {!alignRight && group.needsTrailingGap && (
                    <Text style={styles.gapText}> </Text>
                  )}
                </View>
              ))}
            </View>
          </View>
          {!!line.backgroundSyllables?.length && (
            <BackgroundVocals
              syllables={line.backgroundSyllables}
              parentIsActive={isActive}
              parentIsPast={isPast}
              parentBgStillActive={bgStillActive}
              parentShouldPrewarmNativeReveal={shouldPrewarmNativeReveal}
              playbackPositionOverrideMs={playbackPositionOverrideMs}
              alignRight={alignRight}
              textLaneWidth={textLaneWidth}
              fontScale={fontScale}
            />
          )}
          {!!translatedText && showTranslatedText && (
            <Text
              style={[
                styles.translatedText,
                {
                  color: translatedColor,
                  fontSize: 14 * fontScale,
                  lineHeight: 18 * fontScale,
                  ...translatedTextWidthStyle,
                },
                alignRight && styles.translatedTextOpposite,
              ]}
            >
              {translatedText}
            </Text>
          )}
          </View>
        </View>
      </Pressable>
      {showPauseDotsAfter && (
        <PauseDots
          alignRight={alignRight}
          pauseStartMs={pauseStartMs}
          pauseVisualDurationMs={pauseVisualDurationMs}
          fontSize={lineFontSize}
          edgeInset={lineInnerPaddingHorizontal}
        />
      )}
    </Reanimated.View>
  );
}, areLyricLinePropsEqual);

const PrimarySustainRevealToken = memo(function PrimarySustainRevealToken({
  text,
  startTime,
  endTime,
  playbackPosition,
  isPlaying,
  tokenWidth,
  shouldMeasure,
  textWeight,
  sustainMode,
  lineFontSize = BASE_FONT_SIZE,
  lineLineHeight = BASE_LINE_HEIGHT,
  revealClipStyle,
  revealHorizontalPad = getScaledPrimaryRevealHorizontalPad(lineFontSize),
  onMeasure,
}: {
  text: string;
  startTime: number;
  endTime: number;
  playbackPosition: number;
  isPlaying: boolean;
  tokenWidth: number;
  shouldMeasure: boolean;
  textWeight: "700";
  sustainMode: "solo" | "letter-sweep";
  lineFontSize?: number;
  lineLineHeight?: number;
  revealClipStyle?: { height: number };
  revealHorizontalPad?: number;
  onMeasure: (width: number) => void;
}) {
  const progress = useSharedValue(
    getSyllableProgress(playbackPosition, startTime, endTime),
  );
  const renderedChars = useMemo(() => getGraphemes(text), [text]);
  const tokenDurationMs = Math.max(1, endTime - startTime);

  useEffect(() => {
    const easing = getGraphemeCount(text) <= 2
      ? ReanimatedEasing.linear
      : REVEAL_SWEEP_EASING;
    syncRevealProgress(
      progress,
      playbackPosition,
      startTime,
      endTime,
      isPlaying,
      easing,
    );
  }, [endTime, isPlaying, playbackPosition, progress, startTime]);

  // Soft edge + solid progress only (mid layer dropped — same look, fewer UI nodes)
  const softRevealStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const visible = p > 0 && p < 1;
    return {
      opacity: visible ? 1 : 0,
      width: visible
        ? getRevealClipWidth(tokenWidth, p, 0, revealHorizontalPad)
        : 0,
    };
  });
  const progressRevealStyle = useAnimatedStyle(() => ({
    width: getRevealClipWidth(
      tokenWidth,
      progress.value,
      0,
      revealHorizontalPad,
    ),
  }));
  const tokenRiseStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: getPrimaryTokenRiseY(progress.value, lineFontSize) },
    ],
  }));

  const renderSustainText = (
    color: string,
    layer: "pending" | "soft" | "progress" = "pending",
  ) => (
    <View style={styles.sustainRow}>
      {renderedChars.map((char, charIdx) => (
        <View key={`${color}-${charIdx}`} style={styles.sustainGlyphSlot}>
          <PrimarySustainGlyph
            char={char}
            charIdx={charIdx}
            totalChars={renderedChars.length}
            durationMs={tokenDurationMs}
            color={color}
            textWeight={textWeight}
            sustainMode={sustainMode}
            progress={progress}
            layer={layer}
            canHidePending={tokenWidth > 0}
            lineFontSize={lineFontSize}
            lineLineHeight={lineLineHeight}
            revealHorizontalPad={revealHorizontalPad}
          />
        </View>
      ))}
    </View>
  );

  return (
    <Reanimated.View
      style={[styles.tokenWrap, tokenRiseStyle]}
      onLayout={
        shouldMeasure
          ? (event) => onMeasure(event.nativeEvent.layout.width)
          : undefined
      }
    >
      {renderSustainText(COLOR_ACTIVE_PENDING)}
      {tokenWidth > 0 && (
        <>
          <Reanimated.View
            pointerEvents="none"
            style={[
              styles.tokenRevealClip,
              styles.primaryTokenRevealClip,
              revealClipStyle,
              softRevealStyle,
            ]}
          >
            <View style={{ width: tokenWidth + revealHorizontalPad }}>
              {renderSustainText("rgba(255,255,255,0.25)", "soft")}
            </View>
          </Reanimated.View>
          <Reanimated.View
            pointerEvents="none"
            style={[
              styles.tokenRevealClip,
              styles.primaryTokenRevealClip,
              revealClipStyle,
              progressRevealStyle,
            ]}
          >
            <View style={{ width: tokenWidth + revealHorizontalPad }}>
              {renderSustainText(COLOR_ACTIVE_PROGRESS, "progress")}
            </View>
          </Reanimated.View>
        </>
      )}
    </Reanimated.View>
  );
});

const PrimarySustainGlyph = memo(function PrimarySustainGlyph({
  char,
  charIdx,
  totalChars,
  durationMs,
  color,
  textWeight,
  sustainMode,
  progress,
  layer,
  canHidePending,
  lineFontSize = BASE_FONT_SIZE,
  lineLineHeight = BASE_LINE_HEIGHT,
  revealHorizontalPad = getScaledPrimaryRevealHorizontalPad(lineFontSize),
}: {
  char: string;
  charIdx: number;
  totalChars: number;
  durationMs: number;
  color: string;
  textWeight: "700";
  sustainMode: "solo" | "letter-sweep";
  progress: SharedValue<number>;
  layer: "pending" | "soft" | "progress";
  canHidePending: boolean;
  lineFontSize?: number;
  lineLineHeight?: number;
  revealHorizontalPad?: number;
}) {
  const isSoloMode = sustainMode === "solo";
  const glyphPaintWidth = lineFontSize + revealHorizontalPad;
  const lineTextStyle = useMemo(
    () => [
      styles.lineText,
      { fontSize: lineFontSize, lineHeight: lineLineHeight },
    ],
    [lineFontSize, lineLineHeight],
  );
  // Prefer transform scale over animated fontSize/lineHeight (layout thrash).
  const animatedStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const visuals = computeSustainGlyphVisuals(
      p,
      charIdx,
      totalChars,
      durationMs,
      isSoloMode,
      false,
      lineFontSize,
      lineLineHeight,
      true,
    );
    const resolvedOpacity =
      layer === "pending" && canHidePending
        ? visuals.opacity * Math.max(0, Math.min(1, (1 - p) / 0.035))
        : getCompletedLayerOpacity(p, visuals.opacity);
    const glow = visuals.glowRadius;

    return {
      opacity: resolvedOpacity,
      textShadowColor: glow > 0.35 ? SUSTAIN_GLOW_COLOR : "transparent",
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: glow > 0.35 ? glow : 0,
      transform: [
        { translateX: visuals.translateX },
        { translateY: visuals.translateY },
        { scale: visuals.scale },
      ],
    };
  });

  return (
    <View style={styles.sustainGlyphAnchor}>
      <Text
        style={[
          lineTextStyle,
          styles.sustainGlyphPlaceholder,
          { fontWeight: textWeight },
        ]}
      >
        {char}
      </Text>
      <Reanimated.Text
        style={[
          lineTextStyle,
          styles.sustainGlyphOverlay,
          styles.primarySustainGlyphOverlay as any,
          { color, fontWeight: textWeight, width: glyphPaintWidth },
          animatedStyle,
        ]}
      >
        {char}
      </Reanimated.Text>
    </View>
  );
});

const PrimaryWordSustainRevealToken = memo(
  function PrimaryWordSustainRevealToken({
    text,
    startTime,
    endTime,
    playbackPosition,
    isPlaying,
    tokenWidth,
    shouldMeasure,
    textWeight,
    lineFontSize = BASE_FONT_SIZE,
    lineLineHeight = BASE_LINE_HEIGHT,
    revealClipStyle,
    revealHorizontalPad = getScaledPrimaryRevealHorizontalPad(lineFontSize),
    onMeasure,
  }: {
    text: string;
    startTime: number;
    endTime: number;
    playbackPosition: number;
    isPlaying: boolean;
    tokenWidth: number;
    shouldMeasure: boolean;
    textWeight: "700";
    lineFontSize?: number;
    lineLineHeight?: number;
    revealClipStyle?: { height: number };
    revealHorizontalPad?: number;
    onMeasure: (width: number) => void;
  }) {
    const lineTextStyle = useMemo(
      () => [
        styles.lineText,
        { fontSize: lineFontSize, lineHeight: lineLineHeight },
      ],
      [lineFontSize, lineLineHeight],
    );
    const progress = useSharedValue(
      getSyllableProgress(playbackPosition, startTime, endTime),
    );
    const tokenDurationMs = Math.max(1, endTime - startTime);

    useEffect(() => {
      const easing = getGraphemeCount(text) <= 2
        ? ReanimatedEasing.linear
        : REVEAL_SWEEP_EASING;
      syncRevealProgress(
        progress,
        playbackPosition,
        startTime,
        endTime,
        isPlaying,
        easing,
      );
    }, [endTime, isPlaying, playbackPosition, progress, startTime]);

    const wordMotionStyle = useAnimatedStyle(() => {
      const p = Math.max(0, Math.min(1, progress.value));
      const visuals = computeWordSustainVisuals(
        p,
        tokenDurationMs,
        false,
        tokenWidth,
        lineFontSize,
        lineLineHeight,
      );
      return {
        opacity: getCompletedLayerOpacity(p, visuals.opacity),
        fontSize: visuals.fontSize,
        lineHeight: visuals.lineHeight,
        paddingRight: revealHorizontalPad,
        marginRight: -revealHorizontalPad,
        transform: [
          { translateX: visuals.translateX },
          { translateY: visuals.translateY },
        ],
      };
    });

    const pendingGlowStyle = useAnimatedStyle(() => {
      const p = Math.max(0, Math.min(1, progress.value));
      const visuals = computeWordSustainVisuals(
        p,
        tokenDurationMs,
        false,
        tokenWidth,
        lineFontSize,
        lineLineHeight,
      );
      return {
        opacity:
          tokenWidth > 0
            ? Math.max(0, Math.min(1, (1 - p) / 0.035))
            : undefined,
        textShadowColor: SUSTAIN_GLOW_COLOR,
        textShadowOffset: { width: 0, height: 0 },
        textShadowRadius: visuals.glowRadius,
      };
    });

    const softRevealStyle = useAnimatedStyle(() => {
      const p = Math.max(0, Math.min(1, progress.value));
      const visible = p > 0 && p < 1;
      return {
        opacity: visible ? 1 : 0,
        width: visible
          ? getRevealClipWidth(tokenWidth, p, 0, revealHorizontalPad)
          : 0,
      };
    });
    const progressRevealStyle = useAnimatedStyle(() => ({
      width: getRevealClipWidth(
        tokenWidth,
        progress.value,
        0,
        revealHorizontalPad,
      ),
    }));
    const tokenRiseStyle = useAnimatedStyle(() => ({
      transform: [
        { translateY: getPrimaryTokenRiseY(progress.value, lineFontSize) },
      ],
    }));

    const renderWordText = (color: string) => (
      <Reanimated.Text
        style={[
          lineTextStyle,
          { color, fontWeight: textWeight },
          wordMotionStyle,
          color === COLOR_ACTIVE_PENDING ? pendingGlowStyle : undefined,
        ]}
      >
        {text}
      </Reanimated.Text>
    );

    return (
      <Reanimated.View
        style={[styles.tokenWrap, tokenRiseStyle]}
        onLayout={
          shouldMeasure
            ? (event) => onMeasure(event.nativeEvent.layout.width)
            : undefined
        }
      >
        {renderWordText(COLOR_ACTIVE_PENDING)}
        {tokenWidth > 0 && (
          <>
            <Reanimated.View
              pointerEvents="none"
              style={[
                styles.tokenRevealClip,
                styles.primaryTokenRevealClip,
                revealClipStyle,
                softRevealStyle,
              ]}
            >
              <View style={{ width: tokenWidth + revealHorizontalPad }}>
                {renderWordText("rgba(255,255,255,0.25)")}
              </View>
            </Reanimated.View>
            <Reanimated.View
              pointerEvents="none"
              style={[
                styles.tokenRevealClip,
                styles.primaryTokenRevealClip,
                revealClipStyle,
                progressRevealStyle,
              ]}
            >
              <View style={{ width: tokenWidth + revealHorizontalPad }}>
                {renderWordText(COLOR_ACTIVE_PROGRESS)}
              </View>
            </Reanimated.View>
          </>
        )}
      </Reanimated.View>
    );
  },
);

const PrimaryRevealSweepToken = memo(function PrimaryRevealSweepToken({
  text,
  startTime,
  endTime,
  playbackPosition,
  isPlaying,
  tokenWidth,
  shouldMeasure,
  textWeight,
  lineFontSize = BASE_FONT_SIZE,
  lineLineHeight = BASE_LINE_HEIGHT,
  revealClipStyle,
  onMeasure,
}: {
  text: string;
  startTime: number;
  endTime: number;
  playbackPosition: number;
  isPlaying: boolean;
  tokenWidth: number;
  shouldMeasure: boolean;
  textWeight: "700";
  lineFontSize?: number;
  lineLineHeight?: number;
  revealClipStyle?: { height: number };
  onMeasure: (width: number) => void;
}) {
  const lineTextStyle = useMemo(
    () => [
      styles.lineText,
      { fontSize: lineFontSize, lineHeight: lineLineHeight },
    ],
    [lineFontSize, lineLineHeight],
  );
  const progress = useSharedValue(
    getSyllableProgress(playbackPosition, startTime, endTime),
  );

  useEffect(() => {
    const easing = getGraphemeCount(text) <= 2
      ? ReanimatedEasing.linear
      : REVEAL_SWEEP_EASING;
    syncRevealProgress(
      progress,
      playbackPosition,
      startTime,
      endTime,
      isPlaying,
      easing,
    );
  }, [endTime, isPlaying, playbackPosition, progress, startTime]);

  const displayWidth =
    tokenWidth > 0 ? tokenWidth : estimateTokenWidth(text, lineFontSize);
  const tokenRiseStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: getPrimaryTokenRiseY(progress.value, lineFontSize) },
    ],
  }));
  const softRevealStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const visible = p > 0 && p < 1;
    return {
          opacity: visible ? 1 : 0,
          width: visible
            ? getRevealClipWidth(displayWidth, p, 0, 0)
            : 0,
    };
  });
  const progressRevealStyle = useAnimatedStyle(() => ({
    width: getRevealClipWidth(displayWidth, progress.value, 0, 0),
  }));

  return (
    <Reanimated.View
      style={[styles.tokenWrap, tokenRiseStyle]}
      onLayout={
        shouldMeasure
          ? (event) => onMeasure(event.nativeEvent.layout.width)
          : undefined
      }
    >
      <Text
        style={[
          lineTextStyle,
          { color: COLOR_ACTIVE_PENDING, fontWeight: textWeight },
        ]}
      >
        {text}
      </Text>
      {displayWidth > 0 && (
        <>
          <Reanimated.View
            pointerEvents="none"
            style={[
              styles.tokenRevealClip,
              styles.primaryTokenRevealClip,
              revealClipStyle,
              softRevealStyle,
            ]}
          >
            <View style={{ width: displayWidth }}>
              <Text
                style={[
                  lineTextStyle,
                  { color: "rgba(255,255,255,0.35)", fontWeight: textWeight },
                ]}
              >
                {text}
              </Text>
            </View>
          </Reanimated.View>
          <Reanimated.View
            pointerEvents="none"
            style={[
              styles.tokenRevealClip,
              styles.primaryTokenRevealClip,
              revealClipStyle,
              progressRevealStyle,
            ]}
          >
            <View style={{ width: displayWidth }}>
              <Text
                style={[
                  lineTextStyle,
                  { color: COLOR_ACTIVE_PROGRESS, fontWeight: textWeight },
                ]}
              >
                {text}
              </Text>
            </View>
          </Reanimated.View>
        </>
      )}
    </Reanimated.View>
  );
});

const COLOR_BG_DONE = "rgba(255,255,255,0.70)";
const COLOR_BG_PENDING = "rgba(255,255,255,0.32)";
const COLOR_BG_REVEAL_SOFT = "rgba(255,255,255,0.05)";
const COLOR_BG_REVEAL_MID = "rgba(255,255,255,0.10)";
const COLOR_BG_PROGRESS = "rgba(255,255,255,0.47)";
const COLOR_BG_INACTIVE = "rgba(255,255,255,0.28)";

const BackgroundRevealSweepToken = memo(function BackgroundRevealSweepToken({
  text,
  startTime,
  endTime,
  playbackPosition,
  isPlaying,
  tokenWidth,
  shouldMeasure,
  lineFontSize = BG_FONT_SIZE,
  lineLineHeight = BG_LINE_HEIGHT,
  onMeasure,
}: {
  text: string;
  startTime: number;
  endTime: number;
  playbackPosition: number;
  isPlaying: boolean;
  tokenWidth: number;
  shouldMeasure: boolean;
  lineFontSize?: number;
  lineLineHeight?: number;
  onMeasure: (width: number) => void;
}) {
  const bgTextStyle = useMemo(
    () => ({
      fontSize: lineFontSize,
      lineHeight: lineLineHeight,
    }),
    [lineFontSize, lineLineHeight],
  );
  const progress = useSharedValue(
    getSyllableProgress(playbackPosition, startTime, endTime),
  );

  useEffect(() => {
    const easing = getGraphemeCount(text) <= 2
      ? ReanimatedEasing.linear
      : REVEAL_SWEEP_EASING;
    syncRevealProgress(
      progress,
      playbackPosition,
      startTime,
      endTime,
      isPlaying,
      easing,
    );
  }, [endTime, isPlaying, playbackPosition, progress, startTime]);

  const displayWidth =
    tokenWidth > 0 ? tokenWidth : estimateTokenWidth(text, lineFontSize);
  const tokenRiseStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: getBackgroundTokenRiseY(progress.value, lineFontSize) }],
  }));
  const softRevealStyle = useAnimatedStyle(() => ({
    width: getRevealClipWidth(displayWidth, progress.value, 6, 0),
  }));
  const midRevealStyle = useAnimatedStyle(() => ({
    width: getRevealClipWidth(displayWidth, progress.value, 3, 0),
  }));
  const progressRevealStyle = useAnimatedStyle(() => ({
    width: getRevealClipWidth(displayWidth, progress.value, 0, 0),
  }));

  return (
    <Reanimated.View
      style={[styles.tokenWrap, tokenRiseStyle]}
      onLayout={
        shouldMeasure
          ? (event) => onMeasure(event.nativeEvent.layout.width)
          : undefined
      }
    >
      <Text style={[styles.bgVocalsText, bgTextStyle, { color: COLOR_BG_PENDING }]}>
        {text}
      </Text>
      {displayWidth > 0 && (
        <>
          <Reanimated.View
            pointerEvents="none"
            style={[
              styles.tokenRevealClip,
              styles.bgTokenRevealClip,
              softRevealStyle,
            ]}
          >
            <View style={{ width: displayWidth }}>
              <Text
                style={[
                  styles.bgVocalsText,
                  bgTextStyle,
                  { color: COLOR_BG_REVEAL_SOFT },
                ]}
              >
                {text}
              </Text>
            </View>
          </Reanimated.View>
          <Reanimated.View
            pointerEvents="none"
            style={[
              styles.tokenRevealClip,
              styles.bgTokenRevealClip,
              midRevealStyle,
            ]}
          >
            <View style={{ width: displayWidth }}>
              <Text
                style={[
                  styles.bgVocalsText,
                  bgTextStyle,
                  { color: COLOR_BG_REVEAL_MID },
                ]}
              >
                {text}
              </Text>
            </View>
          </Reanimated.View>
          <Reanimated.View
            pointerEvents="none"
            style={[
              styles.tokenRevealClip,
              styles.bgTokenRevealClip,
              progressRevealStyle,
            ]}
          >
            <View style={{ width: displayWidth }}>
              <Text
                style={[
                  styles.bgVocalsText,
                  bgTextStyle,
                  { color: COLOR_BG_PROGRESS },
                ]}
              >
                {text}
              </Text>
            </View>
          </Reanimated.View>
        </>
      )}
    </Reanimated.View>
  );
});

const BackgroundSustainRevealToken = memo(
  function BackgroundSustainRevealToken({
    text,
    startTime,
    endTime,
    playbackPosition,
    isPlaying,
    tokenWidth,
    shouldMeasure,
    sustainMode,
    lineFontSize = BG_FONT_SIZE,
    lineLineHeight = BG_LINE_HEIGHT,
    onMeasure,
  }: {
    text: string;
    startTime: number;
    endTime: number;
    playbackPosition: number;
    isPlaying: boolean;
    tokenWidth: number;
    shouldMeasure: boolean;
    sustainMode: "solo" | "letter-sweep";
    lineFontSize?: number;
    lineLineHeight?: number;
    onMeasure: (width: number) => void;
  }) {
    const progress = useSharedValue(
      getSyllableProgress(playbackPosition, startTime, endTime),
    );
    const renderedChars = useMemo(() => getGraphemes(text), [text]);
    const tokenDurationMs = Math.max(1, endTime - startTime);

    useEffect(() => {
      const easing = getGraphemeCount(text) <= 2
        ? ReanimatedEasing.linear
        : REVEAL_SWEEP_EASING;
      syncRevealProgress(
        progress,
        playbackPosition,
        startTime,
        endTime,
        isPlaying,
        easing,
      );
    }, [endTime, isPlaying, playbackPosition, progress, startTime]);

    const displayWidth =
      tokenWidth > 0 ? tokenWidth : estimateTokenWidth(text, lineFontSize);
    const softRevealStyle = useAnimatedStyle(() => ({
      width: getRevealClipWidth(
        displayWidth,
        progress.value,
        6,
        BG_REVEAL_HORIZONTAL_PAD,
      ),
    }));
    const midRevealStyle = useAnimatedStyle(() => ({
      width: getRevealClipWidth(
        displayWidth,
        progress.value,
        3,
        BG_REVEAL_HORIZONTAL_PAD,
      ),
    }));
    const progressRevealStyle = useAnimatedStyle(() => ({
      width: getRevealClipWidth(
        displayWidth,
        progress.value,
        0,
        BG_REVEAL_HORIZONTAL_PAD,
      ),
    }));
    const tokenRiseStyle = useAnimatedStyle(() => ({
      transform: [
        { translateY: getBackgroundTokenRiseY(progress.value, lineFontSize) },
      ],
    }));

    const renderSustainText = (color: string) => (
      <View style={styles.sustainRow}>
        {renderedChars.map((char, charIdx) => (
          <View key={`${color}-${charIdx}`} style={styles.sustainGlyphSlot}>
            <BackgroundSustainGlyph
              char={char}
              charIdx={charIdx}
              totalChars={renderedChars.length}
              durationMs={tokenDurationMs}
              color={color}
              sustainMode={sustainMode}
              progress={progress}
              lineFontSize={lineFontSize}
              lineLineHeight={lineLineHeight}
            />
          </View>
        ))}
      </View>
    );

    return (
      <Reanimated.View
        style={[styles.tokenWrap, tokenRiseStyle]}
        onLayout={
          shouldMeasure
            ? (event) => onMeasure(event.nativeEvent.layout.width)
            : undefined
        }
      >
        {renderSustainText(COLOR_BG_PENDING)}
        {displayWidth > 0 && (
          <>
            <Reanimated.View
              pointerEvents="none"
              style={[
                styles.tokenRevealClip,
                styles.bgTokenRevealClip,
                softRevealStyle,
              ]}
            >
              <View style={{ width: displayWidth + BG_REVEAL_HORIZONTAL_PAD }}>
                {renderSustainText(COLOR_BG_REVEAL_SOFT)}
              </View>
            </Reanimated.View>
            <Reanimated.View
              pointerEvents="none"
              style={[
                styles.tokenRevealClip,
                styles.bgTokenRevealClip,
                midRevealStyle,
              ]}
            >
              <View style={{ width: displayWidth + BG_REVEAL_HORIZONTAL_PAD }}>
                {renderSustainText(COLOR_BG_REVEAL_MID)}
              </View>
            </Reanimated.View>
            <Reanimated.View
              pointerEvents="none"
              style={[
                styles.tokenRevealClip,
                styles.bgTokenRevealClip,
                progressRevealStyle,
              ]}
            >
              <View style={{ width: displayWidth + BG_REVEAL_HORIZONTAL_PAD }}>
                {renderSustainText(COLOR_BG_PROGRESS)}
              </View>
            </Reanimated.View>
          </>
        )}
      </Reanimated.View>
    );
  },
);

const BackgroundWordSustainRevealToken = memo(
  function BackgroundWordSustainRevealToken({
    text,
    startTime,
    endTime,
    playbackPosition,
    isPlaying,
    tokenWidth,
    shouldMeasure,
    lineFontSize = BG_FONT_SIZE,
    lineLineHeight = BG_LINE_HEIGHT,
    onMeasure,
  }: {
    text: string;
    startTime: number;
    endTime: number;
    playbackPosition: number;
    isPlaying: boolean;
    tokenWidth: number;
    shouldMeasure: boolean;
    lineFontSize?: number;
    lineLineHeight?: number;
    onMeasure: (width: number) => void;
  }) {
    const progress = useSharedValue(
      getSyllableProgress(playbackPosition, startTime, endTime),
    );
    const tokenDurationMs = Math.max(1, endTime - startTime);

    useEffect(() => {
      const easing = getGraphemeCount(text) <= 2
        ? ReanimatedEasing.linear
        : REVEAL_SWEEP_EASING;
      syncRevealProgress(
        progress,
        playbackPosition,
        startTime,
        endTime,
        isPlaying,
        easing,
      );
    }, [endTime, isPlaying, playbackPosition, progress, startTime]);

    const displayWidth =
      tokenWidth > 0 ? tokenWidth : estimateTokenWidth(text, lineFontSize);
    const wordMotionStyle = useAnimatedStyle(() => {
      const p = Math.max(0, Math.min(1, progress.value));
      const visuals = computeWordSustainVisuals(
        p,
        tokenDurationMs,
        true,
        displayWidth,
        lineFontSize,
        lineLineHeight,
      );
      return {
        opacity: getCompletedLayerOpacity(p, visuals.opacity),
        fontSize: lineFontSize,
        lineHeight: lineLineHeight,
        paddingRight: BG_REVEAL_HORIZONTAL_PAD,
        marginRight: -BG_REVEAL_HORIZONTAL_PAD,
        transform: [
          { translateX: visuals.translateX },
          { translateY: visuals.translateY },
          { scale: visuals.scale },
        ],
      };
    });
    const pendingGlowStyle = useAnimatedStyle(() => {
      const p = Math.max(0, Math.min(1, progress.value));
      const visuals = computeWordSustainVisuals(
        p,
        tokenDurationMs,
        true,
        displayWidth,
      );
      return {
        textShadowColor: SUSTAIN_GLOW_COLOR_BG,
        textShadowOffset: { width: 0, height: 0 },
        textShadowRadius: visuals.glowRadius,
      };
    });
    const softRevealStyle = useAnimatedStyle(() => ({
      width: getRevealClipWidth(
        displayWidth,
        progress.value,
        6,
        BG_REVEAL_HORIZONTAL_PAD,
      ),
    }));
    const midRevealStyle = useAnimatedStyle(() => ({
      width: getRevealClipWidth(
        displayWidth,
        progress.value,
        3,
        BG_REVEAL_HORIZONTAL_PAD,
      ),
    }));
    const progressRevealStyle = useAnimatedStyle(() => ({
      width: getRevealClipWidth(
        displayWidth,
        progress.value,
        0,
        BG_REVEAL_HORIZONTAL_PAD,
      ),
    }));
    const tokenRiseStyle = useAnimatedStyle(() => ({
      transform: [
        { translateY: getBackgroundTokenRiseY(progress.value, lineFontSize) },
      ],
    }));

    const renderWordText = (color: string) => (
      <Reanimated.Text
        style={[
          styles.bgVocalsText,
          { color, fontSize: lineFontSize, lineHeight: lineLineHeight },
          wordMotionStyle,
          color === COLOR_BG_PENDING ? pendingGlowStyle : undefined,
        ]}
      >
        {text}
      </Reanimated.Text>
    );

    return (
      <Reanimated.View
        style={[styles.tokenWrap, tokenRiseStyle]}
        onLayout={
          shouldMeasure
            ? (event) => onMeasure(event.nativeEvent.layout.width)
            : undefined
        }
      >
        {renderWordText(COLOR_BG_PENDING)}
        {displayWidth > 0 && (
          <>
            <Reanimated.View
              pointerEvents="none"
              style={[
                styles.tokenRevealClip,
                styles.bgTokenRevealClip,
                softRevealStyle,
              ]}
            >
              <View style={{ width: displayWidth + BG_REVEAL_HORIZONTAL_PAD }}>
                {renderWordText(COLOR_BG_REVEAL_SOFT)}
              </View>
            </Reanimated.View>
            <Reanimated.View
              pointerEvents="none"
              style={[
                styles.tokenRevealClip,
                styles.bgTokenRevealClip,
                midRevealStyle,
              ]}
            >
              <View style={{ width: displayWidth + BG_REVEAL_HORIZONTAL_PAD }}>
                {renderWordText(COLOR_BG_REVEAL_MID)}
              </View>
            </Reanimated.View>
            <Reanimated.View
              pointerEvents="none"
              style={[
                styles.tokenRevealClip,
                styles.bgTokenRevealClip,
                progressRevealStyle,
              ]}
            >
              <View style={{ width: displayWidth + BG_REVEAL_HORIZONTAL_PAD }}>
                {renderWordText(COLOR_BG_PROGRESS)}
              </View>
            </Reanimated.View>
          </>
        )}
      </Reanimated.View>
    );
  },
);

const BackgroundSustainGlyph = memo(function BackgroundSustainGlyph({
  char,
  charIdx,
  totalChars,
  durationMs,
  color,
  sustainMode,
  progress,
  lineFontSize = BG_FONT_SIZE,
  lineLineHeight = BG_LINE_HEIGHT,
}: {
  char: string;
  charIdx: number;
  totalChars: number;
  durationMs: number;
  color: string;
  sustainMode: "solo" | "letter-sweep";
  progress: SharedValue<number>;
  lineFontSize?: number;
  lineLineHeight?: number;
}) {
  const isSoloMode = sustainMode === "solo";
  const animatedStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const visuals = computeSustainGlyphVisuals(
      p,
      charIdx,
      totalChars,
      durationMs,
      isSoloMode,
      true,
      lineFontSize,
      lineLineHeight,
      true,
    );

    return {
      opacity: getCompletedLayerOpacity(p, visuals.opacity),
      fontSize: lineFontSize,
      lineHeight: lineLineHeight,
      textShadowColor: SUSTAIN_GLOW_COLOR_BG,
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: visuals.glowRadius,
      transform: [
        { translateX: visuals.translateX },
        { translateY: visuals.translateY },
        { scale: visuals.scale },
      ],
    };
  });

  return (
    <View style={styles.sustainGlyphAnchor}>
      <Text
        style={[
          styles.bgVocalsText,
          styles.sustainGlyphPlaceholder,
          { fontSize: lineFontSize, lineHeight: lineLineHeight },
        ]}
      >
        {char}
      </Text>
      <Reanimated.Text
        style={[
          styles.bgVocalsText,
          styles.sustainGlyphOverlay,
          styles.bgSustainGlyphOverlay,
          { color },
          animatedStyle,
        ]}
      >
        {char}
      </Reanimated.Text>
    </View>
  );
});

const BackgroundVocals = memo(function BackgroundVocals({
  syllables,
  alignRight = false,
  textLaneWidth = LYRIC_TEXT_LANE_WIDTH,
  parentIsActive,
  parentIsPast,
  parentBgStillActive,
  parentShouldPrewarmNativeReveal,
  playbackPositionOverrideMs = null,
  fontScale = 1,
}: {
  syllables: LyricSyllable[];
  alignRight?: boolean;
  textLaneWidth?: number | string;
  parentIsActive: boolean;
  parentIsPast: boolean;
  parentBgStillActive: boolean;
  parentShouldPrewarmNativeReveal: boolean;
  playbackPositionOverrideMs?: number | null;
  fontScale?: number;
}) {
  const bgFontSize = BG_FONT_SIZE * SCALE_ACTIVE * fontScale;
  const bgLineHeight = BG_LINE_HEIGHT * SCALE_ACTIVE * fontScale;
  const bgTextStyle = useMemo(
    () => ({
      fontSize: bgFontSize,
      lineHeight: bgLineHeight,
    }),
    [bgFontSize, bgLineHeight],
  );
  const bgStart = syllables[0]?.startTime ?? 0;
  const bgEnd = syllables[syllables.length - 1]?.endTime ?? 0;
  const [widths, setWidths] = useState<Record<number, number>>({});
  const pendingWidthsRef = useRef<Record<number, number>>({});
  const widthFlushFrameRef = useRef<number | null>(null);
  const syllableGroups = useMemo(
    () => groupSyllablesIntoWords(syllables),
    [syllables],
  );
  const shouldUseNativeBackgroundReveal =
    playbackPositionOverrideMs == null &&
    (parentIsActive || parentBgStillActive || parentShouldPrewarmNativeReveal);
  const needsBackgroundJsPlayback =
    playbackPositionOverrideMs != null &&
    (parentIsActive || parentBgStillActive || parentShouldPrewarmNativeReveal);

  const playbackPosition = usePlaybackStore(
    useCallback(
      (state) => {
        if (!needsBackgroundJsPlayback) {
          return 0;
        }
        const pos = playbackPositionOverrideMs ?? state.playbackPosition;
        if (pos >= bgStart && pos < bgEnd) return pos;
        return pos >= bgEnd ? bgEnd : 0;
      },
      [bgStart, bgEnd, needsBackgroundJsPlayback, playbackPositionOverrideMs],
    ),
  );
  const isPlaying = usePlaybackStore(
    useCallback(
      (state) => (shouldUseNativeBackgroundReveal ? state.isPlaying : false),
      [shouldUseNativeBackgroundReveal],
    ),
  );
  const anchorPositionMs = usePlaybackStore(
    useCallback(
      (state) => (shouldUseNativeBackgroundReveal ? state.anchorPositionMs : 0),
      [shouldUseNativeBackgroundReveal],
    ),
  );
  const anchorMonotonicMs = usePlaybackStore(
    useCallback(
      (state) =>
        shouldUseNativeBackgroundReveal ? state.anchorMonotonicMs : 0,
      [shouldUseNativeBackgroundReveal],
    ),
  );
  const shouldAnimateRevealSweep = isPlaying && shouldUseNativeBackgroundReveal;
  const nativeRevealPlaybackPosition = useMemo(
    () =>
      getProjectedPlaybackPosition(
        anchorPositionMs,
        anchorMonotonicMs,
        isPlaying,
      ),
    [anchorMonotonicMs, anchorPositionMs, isPlaying],
  );
  const effectivePlaybackPosition = needsBackgroundJsPlayback
    ? playbackPosition
    : nativeRevealPlaybackPosition >= bgEnd
      ? bgEnd
      : nativeRevealPlaybackPosition >= bgStart
        ? nativeRevealPlaybackPosition
        : 0;

  const isBgActive =
    effectivePlaybackPosition > 0 && effectivePlaybackPosition < bgEnd;
  const isBgPast = parentIsPast || effectivePlaybackPosition >= bgEnd;

  useEffect(() => {
    if (
      widthFlushFrameRef.current !== null &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(widthFlushFrameRef.current);
    }
    widthFlushFrameRef.current = null;
    pendingWidthsRef.current = {};
    setWidths({});
    return () => {
      if (
        widthFlushFrameRef.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(widthFlushFrameRef.current);
      }
      widthFlushFrameRef.current = null;
      pendingWidthsRef.current = {};
    };
  }, [syllables]);

  const flushPendingWidths = useCallback(() => {
    widthFlushFrameRef.current = null;
    const pending = pendingWidthsRef.current;
    pendingWidthsRef.current = {};
    setWidths((prev) => {
      let next: Record<number, number> | null = null;
      for (const [key, width] of Object.entries(pending)) {
        const idx = Number(key);
        if (Math.abs((prev[idx] ?? 0) - width) < 0.5) {
          continue;
        }
        if (!next) {
          next = { ...prev };
        }
        next[idx] = width;
      }
      return next ?? prev;
    });
  }, []);
  const measureToken = useCallback(
    (idx: number, w: number) => {
      if (!Number.isFinite(w) || w <= 0) return;
      pendingWidthsRef.current[idx] = w;
      if (widthFlushFrameRef.current !== null) {
        return;
      }
      if (typeof requestAnimationFrame === "function") {
        widthFlushFrameRef.current = requestAnimationFrame(flushPendingWidths);
        return;
      }
      flushPendingWidths();
    },
    [flushPendingWidths],
  );

  return (
    <View
      style={[
        styles.bgVocalsFlow,
        { width: textLaneWidth as number },
        alignRight && styles.bgVocalsFlowOpposite,
      ]}
    >
      {syllableGroups.map((group, groupIdx) => (
        <View key={`bg-word-${groupIdx}`} style={styles.wordWrap}>
          {alignRight &&
            groupNeedsLeadingGap(syllableGroups, syllables, groupIdx) && (
              <Text style={styles.bgVocalsGapText}> </Text>
            )}
          {group.clusters.map((cluster, clusterIdx) => (
            <View
              key={`bg-word-${groupIdx}-cluster-${clusterIdx}`}
              style={styles.noBreakCluster}
            >
              {cluster.map((idx) => {
                const syl = syllables[idx];
                const text = alignRight
                  ? getSyllableDisplayText(syl.text ?? "")
                  : (syl.text ?? "");
                const tokenDurationMs = Math.max(
                  1,
                  syl.endTime - syl.startTime,
                );
                const renderedChars =
                  alignRight && text
                    ? getGraphemes(text)
                    : getSyllableGraphemes(syl);
                const sustainMode = getSustainMode(text, tokenDurationMs);
                const hasSustainEffect = isSustainMode(sustainMode);
                const glyphSustainMode =
                  sustainMode === "solo" || sustainMode === "letter-sweep"
                    ? sustainMode
                    : "letter-sweep";
                const renderBgText = (color: string, progress = 0) => {
                  if (hasSustainEffect) {
                    if (sustainMode === "word") {
                      const wordStyle = computeWordSustainVisuals(
                        progress,
                        tokenDurationMs,
                        true,
                        estimateTokenWidth(text, bgFontSize),
                        bgFontSize,
                        bgLineHeight,
                      );
                      return (
                        <Text
                          style={[
                            styles.bgVocalsText,
                            bgTextStyle,
                            { color },
                            getSustainGlowStyle(wordStyle.glowRadius, true),
                            {
                              opacity: getCompletedLayerOpacity(
                                progress,
                                wordStyle.opacity,
                              ),
                              paddingRight: BG_REVEAL_HORIZONTAL_PAD,
                              marginRight: -BG_REVEAL_HORIZONTAL_PAD,
                              transform: [
                                { translateX: wordStyle.translateX },
                                { translateY: wordStyle.translateY },
                                { scale: wordStyle.scale },
                              ],
                            },
                          ]}
                        >
                          {text}
                        </Text>
                      );
                    }
                    return (
                      <View style={styles.sustainRow}>
                        {renderedChars.map((char, charIdx) => (
                          <View
                            key={`bg-char-${charIdx}`}
                            style={styles.sustainGlyphSlot}
                          >
                            <Text
                              style={[
                                styles.bgVocalsText,
                                bgTextStyle,
                                { color },
                                getBackgroundSustainGlyphStyle(
                                  progress,
                                  charIdx,
                                  renderedChars.length,
                                  tokenDurationMs,
                                  glyphSustainMode,
                                  bgFontSize,
                                  bgLineHeight,
                                ),
                              ]}
                            >
                              {char}
                            </Text>
                          </View>
                        ))}
                      </View>
                    );
                  }

                  return (
                    <Text style={[styles.bgVocalsText, bgTextStyle, { color }]}>
                      {text}
                    </Text>
                  );
                };

                if (
                  !isBgActive &&
                  (!shouldUseNativeBackgroundReveal ||
                    playbackPositionOverrideMs != null ||
                    isBgPast)
                ) {
                  return (
                    <View
                      key={`bg-${syl.startTime}-${idx}`}
                      style={styles.tokenWrap}
                    >
                      {renderBgText(
                        isBgPast ? COLOR_BG_DONE : COLOR_BG_INACTIVE,
                      )}
                    </View>
                  );
                }

                const progress = getSyllableProgress(
                  effectivePlaybackPosition,
                  syl.startTime,
                  syl.endTime,
                );
                const w = widths[idx] ?? 0;
                const needsMeasure = w <= 0;

                if (sustainMode === "word" && shouldUseNativeBackgroundReveal) {
                  return (
                    <BackgroundWordSustainRevealToken
                      key={`bg-${syl.startTime}-${idx}`}
                      text={text}
                      startTime={syl.startTime}
                      endTime={syl.endTime}
                      playbackPosition={nativeRevealPlaybackPosition}
                      isPlaying={shouldAnimateRevealSweep}
                      tokenWidth={w}
                      shouldMeasure={needsMeasure}
                      lineFontSize={bgFontSize}
                      lineLineHeight={bgLineHeight}
                      onMeasure={(width) => measureToken(idx, width)}
                    />
                  );
                }

                if (
                  (sustainMode === "solo" || sustainMode === "letter-sweep") &&
                  shouldUseNativeBackgroundReveal
                ) {
                  return (
                    <BackgroundSustainRevealToken
                      key={`bg-${syl.startTime}-${idx}`}
                      text={text}
                      startTime={syl.startTime}
                      endTime={syl.endTime}
                      playbackPosition={nativeRevealPlaybackPosition}
                      isPlaying={shouldAnimateRevealSweep}
                      tokenWidth={w}
                      shouldMeasure={needsMeasure}
                      sustainMode={glyphSustainMode}
                      lineFontSize={bgFontSize}
                      lineLineHeight={bgLineHeight}
                      onMeasure={(width) => measureToken(idx, width)}
                    />
                  );
                }

                if (
                  !hasSustainEffect &&
                  shouldUseNativeBackgroundReveal &&
                  progress < 1
                ) {
                  return (
                    <BackgroundRevealSweepToken
                      key={`bg-${syl.startTime}-${idx}`}
                      text={text}
                      startTime={syl.startTime}
                      endTime={syl.endTime}
                      playbackPosition={nativeRevealPlaybackPosition}
                      isPlaying={shouldAnimateRevealSweep}
                      tokenWidth={w}
                      shouldMeasure={needsMeasure}
                      lineFontSize={bgFontSize}
                      lineLineHeight={bgLineHeight}
                      onMeasure={(width) => measureToken(idx, width)}
                    />
                  );
                }

                if (progress <= 0) {
                  return (
                    <View
                      key={`bg-${syl.startTime}-${idx}`}
                      style={styles.tokenWrap}
                      onLayout={
                        needsMeasure
                          ? (e) => measureToken(idx, e.nativeEvent.layout.width)
                          : undefined
                      }
                    >
                      {renderBgText(COLOR_BG_PENDING)}
                    </View>
                  );
                }

                if (progress >= 1) {
                  return (
                    <View
                      key={`bg-${syl.startTime}-${idx}`}
                      style={[
                        styles.tokenWrap,
                        {
                          transform: [{ translateY: -0.025 * bgFontSize }],
                        },
                      ]}
                    >
                      {renderBgText(COLOR_BG_DONE, 1)}
                    </View>
                  );
                }

                const clampedProgress = clamp01(progress);
                const regularRiseY = getBackgroundTokenRiseY(clampedProgress);
                const bgRevealPad = hasSustainEffect
                  ? BG_REVEAL_HORIZONTAL_PAD
                  : 0;

                return (
                  <View
                    key={`bg-${syl.startTime}-${idx}`}
                    style={[
                      styles.tokenWrap,
                      { transform: [{ translateY: regularRiseY }] },
                    ]}
                    onLayout={
                      needsMeasure
                        ? (e) => measureToken(idx, e.nativeEvent.layout.width)
                        : undefined
                    }
                  >
                    {renderBgText(COLOR_BG_PENDING, clampedProgress)}
                    {w > 0 && (
                      <>
                        <View
                          pointerEvents="none"
                          style={[
                            styles.tokenRevealClip,
                            styles.bgTokenRevealClip,
                            {
                              width: getRevealClipWidth(
                                w,
                                clampedProgress,
                                6,
                                bgRevealPad,
                              ),
                            },
                          ]}
                        >
                          <View style={{ width: w + bgRevealPad }}>
                            {renderBgText(
                              COLOR_BG_REVEAL_SOFT,
                              clampedProgress,
                            )}
                          </View>
                        </View>
                        <View
                          pointerEvents="none"
                          style={[
                            styles.tokenRevealClip,
                            styles.bgTokenRevealClip,
                            {
                              width: getRevealClipWidth(
                                w,
                                clampedProgress,
                                3,
                                bgRevealPad,
                              ),
                            },
                          ]}
                        >
                          <View style={{ width: w + bgRevealPad }}>
                            {renderBgText(COLOR_BG_REVEAL_MID, clampedProgress)}
                          </View>
                        </View>
                        <View
                          pointerEvents="none"
                          style={[
                            styles.tokenRevealClip,
                            styles.bgTokenRevealClip,
                            {
                              width: getRevealClipWidth(
                                w,
                                clampedProgress,
                                0,
                                bgRevealPad,
                              ),
                            },
                          ]}
                        >
                          <View style={{ width: w + bgRevealPad }}>
                            {renderBgText(COLOR_BG_PROGRESS, clampedProgress)}
                          </View>
                        </View>
                      </>
                    )}
                  </View>
                );
              })}
            </View>
          ))}
          {!alignRight && group.needsTrailingGap && (
            <Text style={styles.bgVocalsGapText}> </Text>
          )}
        </View>
      ))}
    </View>
  );
});

function getPauseDotStrength(progress: number, dotIndex: number) {
  const dotStart = dotIndex / 3;
  const dotEnd = (dotIndex + 1) / 3;
  if (progress <= dotStart) {
    return 0;
  }
  if (progress >= dotEnd) {
    return 1;
  }
  return (progress - dotStart) / Math.max(0.001, dotEnd - dotStart);
}

const PauseDots = memo(function PauseDots({
  alignRight = false,
  pauseStartMs,
  pauseVisualDurationMs,
  fontSize = BASE_FONT_SIZE,
  edgeInset = LINE_INNER_PADDING_HORIZONTAL,
}: {
  alignRight?: boolean;
  pauseStartMs: number;
  pauseVisualDurationMs: number;
  fontSize?: number;
  edgeInset?: number;
}) {
  // ponytail: visible always true when mounted (caller uses conditional render); fade-in only
  const fadeAnim = useRef(new RNAnimated.Value(0)).current;
  const exitScale = useRef(new RNAnimated.Value(0)).current;

  useEffect(() => {
    RNAnimated.timing(fadeAnim, {
      toValue: 1,
      duration: 240,
      useNativeDriver: true,
    }).start();
    RNAnimated.spring(exitScale, {
      toValue: 1,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim, exitScale]);

  // Self-subscribe to playback store for live progress — avoids needing
  // FlashList re-renders on every tick
  const progress = usePlaybackStore(
    useCallback(
      (state) => {
        if (pauseVisualDurationMs <= 0) return 0;
        return clamp01((state.playbackPosition - pauseStartMs) / pauseVisualDurationMs);
      },
      [pauseStartMs, pauseVisualDurationMs],
    ),
  );

  return (
    <RNAnimated.View
      style={[
        styles.pauseDotsRow,
        alignRight
          ? { alignSelf: "flex-end", marginLeft: 0, marginRight: edgeInset }
          : { marginLeft: edgeInset },
        {
          opacity: fadeAnim,
          transform: [{ scale: exitScale }],
        },
      ]}
    >
      {[0, 1, 2].map((idx) => {
        const dotProgress = getPauseDotStrength(progress, idx);

        const dp = dotProgress;
        const targetScale = interpolate(dp, [0, 0.7, 1], [0.75, 1.05, 1]);
        const targetYOffsetFloat = interpolate(dp, [0, 0.9, 1], [0, -0.12, 0]);
        const targetYOffset = targetYOffsetFloat * fontSize;
        const targetOpacity = interpolate(dp, [0, 0.6, 1], [0.35, 1, 1]);
        const targetGlow = interpolate(dp, [0, 0.6, 1], [0, 1, 1]);

        return (
          <View
            key={idx}
            style={[
              styles.pauseDot,
              {
                opacity: targetOpacity,
                transform: [
                  { translateY: targetYOffset },
                  { scale: targetScale },
                ],
                shadowColor: `rgba(255,255,255,0.9)`,
                shadowRadius: 4 + 6 * targetGlow,
                shadowOpacity: targetGlow,
                shadowOffset: { width: 0, height: 0 },
                elevation: 4 + 6 * targetGlow,
              },
            ]}
          />
        );
      })}
    </RNAnimated.View>
  );
});

const styles = StyleSheet.create({
  lineOuter: {
    minHeight: 84,
    justifyContent: "center",
    paddingVertical: 10,
  } as ViewStyle,
  lineOuterLandscape: {
    overflow: "visible",
    marginHorizontal: -LANDSCAPE_LINE_SCALE_BLEED,
    paddingHorizontal: LANDSCAPE_LINE_SCALE_BLEED,
  } as ViewStyle,
  linePressable: {
    paddingVertical: 2,
  } as ViewStyle,
  lineInner: {
    alignItems: "flex-start",
    justifyContent: "center",
    alignSelf: "stretch",
  } as ViewStyle,
  lineInnerOpposite: {
    alignItems: "flex-end",
  } as ViewStyle,
  lineContentScaleWrap: {
    alignSelf: "flex-start",
    maxWidth: "100%",
  } as ViewStyle,
  lineContentScaleWrapRight: {
    alignSelf: "flex-end",
  } as ViewStyle,
  lineFlowScaleShell: {
    alignSelf: "flex-start",
    width: LYRIC_TEXT_LANE_WIDTH,
  } as ViewStyle,
  lineFlowScaleShellOpposite: {
    alignSelf: "flex-end",
  } as ViewStyle,
  lineFlow: {
    flexDirection: "row",
    flexWrap: "wrap",
    // Use top alignment so multi-line wraps expand downward naturally.
    alignItems: "flex-start",
    alignSelf: "flex-start",
    width: LYRIC_TEXT_LANE_WIDTH,
  } as ViewStyle,
  lineFlowOpposite: {
    justifyContent: "flex-end",
    alignSelf: "flex-end",
  } as ViewStyle,
  wordWrap: {
    flexDirection: "row",
    alignItems: "flex-start",
    // Allow "word" groups to shrink so the parent can wrap them.
    // Without this, a long word can exceed screen width and overflow horizontally.
    flexShrink: 1,
    maxWidth: "100%",
    // If a single word is wider than the screen, allow it to wrap at syllable boundaries.
    flexWrap: "wrap",
  } as ViewStyle,
  wordWrapPhrase: {
    flexWrap: "nowrap",
  } as ViewStyle,
  noBreakCluster: {
    flexDirection: "row",
    alignItems: "flex-start",
    flexShrink: 0,
  } as ViewStyle,
  tokenWrap: {
    position: "relative",
    flexShrink: 0,
  } as ViewStyle,
  tokenRevealClip: {
    position: "absolute",
    left: 0,
    top: 0,
    overflow: "hidden",
  } as ViewStyle,
  primaryTokenRevealClip: {
    top: -PRIMARY_REVEAL_VERTICAL_PAD,
    height: BASE_LINE_HEIGHT * SCALE_ACTIVE + PRIMARY_REVEAL_VERTICAL_PAD * 2,
    paddingTop: PRIMARY_REVEAL_VERTICAL_PAD,
  } as ViewStyle,
  bgTokenRevealClip: {
    top: -BG_REVEAL_VERTICAL_PAD,
    height: BG_LINE_HEIGHT * SCALE_ACTIVE + BG_REVEAL_VERTICAL_PAD * 2,
    paddingTop: BG_REVEAL_VERTICAL_PAD,
  } as ViewStyle,
  sustainRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    overflow: "visible",
  } as ViewStyle,
  sustainGlyphSlot: {
    overflow: "visible",
  } as ViewStyle,
  sustainGlyphAnchor: {
    position: "relative",
    overflow: "visible",
  } as ViewStyle,
  sustainGlyphPlaceholder: {
    opacity: 0,
  } as TextStyle,
  sustainGlyphOverlay: {
    position: "absolute",
    left: 0,
    top: 0,
    paddingRight: PRIMARY_REVEAL_HORIZONTAL_PAD,
  } as TextStyle,
  primarySustainGlyphOverlay: {
    width: PRIMARY_GLYPH_PAINT_WIDTH,
  } as ViewStyle,
  bgSustainGlyphOverlay: {
    width: BG_GLYPH_PAINT_WIDTH,
  } as TextStyle,
  pauseDotsRow: {
    marginTop: 15,
    marginBottom: 0,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    height: 16,
  } as ViewStyle,
  pauseDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#FFFFFF",
  } as ViewStyle,
  lineText: {
    fontFamily: LYRICS_FONT_FAMILY,
    fontSize: BASE_FONT_SIZE,
    lineHeight: BASE_LINE_HEIGHT,
    textAlign: "left",
    letterSpacing: 0,
  } as TextStyle,
  gapText: {
    fontFamily: LYRICS_FONT_FAMILY,
    fontSize: BASE_FONT_SIZE,
    lineHeight: BASE_LINE_HEIGHT,
  } as TextStyle,
  bgVocalsFlow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-end",
    alignSelf: "flex-start",
    width: LYRIC_TEXT_LANE_WIDTH,
    marginTop: 3,
  } as ViewStyle,
  bgVocalsFlowOpposite: {
    justifyContent: "flex-end",
    alignSelf: "flex-end",
  } as ViewStyle,
  bgVocalsText: {
    fontFamily: LYRICS_FONT_FAMILY,
    fontSize: BG_FONT_SIZE,
    lineHeight: BG_LINE_HEIGHT,
    fontWeight: "500",
    textAlign: "left",
    letterSpacing: 0.1,
  } as TextStyle,
  bgVocalsGapText: {
    fontFamily: LYRICS_FONT_FAMILY,
    fontSize: BG_FONT_SIZE,
    lineHeight: BG_LINE_HEIGHT,
  } as TextStyle,
  translatedText: {
    fontFamily: LYRICS_FONT_FAMILY,
    alignSelf: "flex-start",
    marginTop: 4,
    marginLeft: 2,
    fontSize: 14,
    lineHeight: 18,
    textAlign: "left",
    letterSpacing: 0.05,
    textShadowColor: "rgba(0,0,0,0.34)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  } as TextStyle,
  translatedTextOpposite: {
    alignSelf: "flex-end",
    marginLeft: 0,
    marginRight: 2,
    textAlign: "right",
  } as TextStyle,
});
