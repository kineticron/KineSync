import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
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
  FadeOut,
  runOnUI,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useShallow } from "zustand/react/shallow";

import {
  LANDSCAPE_LINE_SCALE_BLEED,
  LANDSCAPE_LYRIC_TEXT_LANE_WIDTH,
} from "@/constants/player-layout";
import { usePlaybackStore } from "@/store/playback-store";
import { getGraphemeCount, getGraphemes } from "@/lib/graphemes";
import { LYRICS_LAYOUT } from "@/lib/lyrics-layout";
import type { LyricLine as LyricLineType, LyricSyllable } from "@/types/bridge";

const IDLE_PLAYBACK_SLICE = {
  bgStillActive: false,
  playbackPosition: 0,
  isPlaying: false,
  anchorPositionMs: 0,
  anchorMonotonicMs: 0,
} as const;

// Keep main's text metrics; AMLL effects only change how the glyphs are painted.
const SCALE_ACTIVE = LYRICS_LAYOUT.activeScale;
// AMLL's group wrapper resolves highlighted lyric groups to 0.85 opacity.
const OPACITY_ACTIVE = 0.85;
const OPACITY_NEAR = 1;
const OPACITY_MID = 1;
const OPACITY_FAR = 1;
// AMLL's mask resolves to ~0.2 alpha for solid/inactive rows and ~0.4 on the
// unrevealed side of an active gradient at the configured 100% active scale.
const COLOR_DONE = "rgba(255,255,255,0.20)";
const COLOR_INACTIVE = "rgba(255,255,255,0.20)";
const BASE_FONT_SIZE: number = LYRICS_LAYOUT.fontSize;
const BASE_LINE_HEIGHT: number = LYRICS_LAYOUT.lineHeight;
const LYRIC_TEXT_LANE_WIDTH = LYRICS_LAYOUT.textLane;
const LINE_INNER_PADDING_HORIZONTAL = LYRICS_LAYOUT.innerInset;
const LINE_INNER_PADDING_HORIZONTAL_LANDSCAPE = LYRICS_LAYOUT.landscapeInnerInset;
const BG_FONT_SIZE = BASE_FONT_SIZE * LYRICS_LAYOUT.backgroundScale;
const BG_LINE_HEIGHT = BASE_LINE_HEIGHT * LYRICS_LAYOUT.backgroundScale;
type AmlPosYSpringPolicy = {
  mass: number;
  damping: number;
  stiffness: number;
  overshootClamping: false;
};
const AMLL_DEFAULT_POS_Y_SPRING: AmlPosYSpringPolicy = {
  mass: 0.9,
  damping: 15,
  stiffness: 90,
  overshootClamping: false,
};

// AMLL deliberately keeps the mask sweep linear so word timestamps stay exact.
const REVEAL_SWEEP_EASING = ReanimatedEasing.linear;

function getSyllableProgress(
  positionMs: number,
  startTime: number,
  endTime: number,
) {
  const duration = Math.max(1, endTime - startTime);
  return Math.max(0, Math.min(1, (positionMs - startTime) / duration));
}

function getAmlWordFloatEndTime(startTime: number, endTime: number) {
  return startTime + Math.max(1000, endTime - startTime);
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
  const stop = () => cancelAnimation(progress);
  const nextProgress = getSyllableProgress(
    playbackPosition,
    startTime,
    endTime,
  );

  if (!isPlaying || nextProgress >= 1) {
    cancelAnimation(progress);
    progress.value = nextProgress;
    return stop;
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
    return stop;
  }

  // Small source corrections retarget from the current UI value without a
  // discontinuity. Large seeks and paused previews still land immediately.
  runOnUI((next: number, remaining: number, duration: number) => {
    "worklet";
    cancelAnimation(progress);
    if (Math.abs(progress.value - next) * duration > 250) progress.value = next;
    progress.value = withTiming(1, { duration: remaining, easing });
  })(nextProgress, Math.max(1, endTime - playbackPosition), Math.max(1, endTime - startTime));
  return stop;
}

function useAmlWordFloatProgress(
  playbackPosition: number,
  startTime: number,
  endTime: number,
  isPlaying: boolean,
) {
  const floatEndTime = getAmlWordFloatEndTime(startTime, endTime);
  const progress = useSharedValue(
    getSyllableProgress(playbackPosition, startTime, floatEndTime),
  );

  useEffect(() => {
    return syncRevealProgress(
      progress,
      playbackPosition,
      startTime,
      floatEndTime,
      isPlaying,
      ReanimatedEasing.linear,
    );
  }, [floatEndTime, isPlaying, playbackPosition, progress, startTime]);

  return progress;
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
  "worklet";
  return Math.max(0, Math.min(1, value));
}

// Worklets captures helper values eagerly when the module loads. Keep this
// dependency chain above its callers; JS function hoisting does not survive
// the native Worklets transform.
function cubicBezierCoordinate(t: number, p1: number, p2: number) {
  "worklet";
  const inv = 1 - t;
  return 3 * inv * inv * t * p1 + 3 * inv * t * t * p2 + t * t * t;
}

function cubicBezierYForX(
  x: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  "worklet";
  const target = Math.max(0, Math.min(1, x));
  if (target === 0 || target === 1) return target;
  let low = 0;
  let high = 1;
  let t = target;
  for (let i = 0; i < 10; i += 1) {
    t = (low + high) / 2;
    const bx = cubicBezierCoordinate(t, x1, x2);
    if (bx < target) low = t;
    else high = t;
  }
  return cubicBezierCoordinate(t, y1, y2);
}

function getPrimaryTokenRiseY(progress: number, fontSize = BASE_FONT_SIZE) {
  "worklet";
  const p = Math.max(0, Math.min(1, progress));
  // Web Animations `ease-out` = cubic-bezier(0, 0, .58, 1).
  const eased = cubicBezierYForX(p, 0, 0, 0.58, 1);
  return -0.05 * fontSize * eased;
}

function getBackgroundTokenRiseY(progress: number, fontSize = BG_FONT_SIZE) {
  "worklet";
  const p = Math.max(0, Math.min(1, progress));
  const eased = cubicBezierYForX(p, 0, 0, 0.58, 1);
  return -0.1 * fontSize * eased;
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
  rendererActive?: boolean;
  line: LyricLineType;
  isActive: boolean;
  isPast: boolean;
  isSelected?: boolean;
  blurAmount?: number;
  inactiveOpacityDistance: number;
  showTranslatedText: boolean;
  pauseTone?: "none" | "past" | "future";
  showPauseDotsAfter?: boolean;
  showPauseDotsBefore?: boolean;
  pauseStartMs?: number;
  pauseVisualDurationMs?: number;
  pauseHoldMs?: number;
  playbackPositionOverrideMs?: number | null;
  onPress?: (line: LyricLineType) => void;
  onLongPress?: (line: LyricLineType) => void;
  tapEnabled: boolean;
  shouldDrivePlaybackUpdates: boolean;
  fontScale?: number;
  landscapeMode?: boolean;
  hasDuetLines?: boolean;
  posYSpringPolicy?: AmlPosYSpringPolicy;
  groupMotionDelayMs?: number;
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
    (a.translatedText ?? "") !== (b.translatedText ?? "") ||
    (a.backgroundTranslatedText ?? "") !==
      (b.backgroundTranslatedText ?? "")
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
    (prev.rendererActive ?? true) === (next.rendererActive ?? true) &&
    areLyricLinesEqual(prev.line, next.line) &&
    prev.isActive === next.isActive &&
    prev.isPast === next.isPast &&
    Boolean(prev.isSelected) === Boolean(next.isSelected) &&
    (prev.blurAmount ?? 0) === (next.blurAmount ?? 0) &&
    getInactiveOpacity(prev.inactiveOpacityDistance) ===
      getInactiveOpacity(next.inactiveOpacityDistance) &&
    prev.showTranslatedText === next.showTranslatedText &&
    prev.pauseTone === next.pauseTone &&
    prev.showPauseDotsAfter === next.showPauseDotsAfter &&
    prev.showPauseDotsBefore === next.showPauseDotsBefore &&
    (prev.pauseStartMs ?? 0) === (next.pauseStartMs ?? 0) &&
    (prev.pauseVisualDurationMs ?? 0) === (next.pauseVisualDurationMs ?? 0) &&
    (prev.pauseHoldMs ?? 0) === (next.pauseHoldMs ?? 0) &&
    prev.playbackPositionOverrideMs === next.playbackPositionOverrideMs &&
    prev.tapEnabled === next.tapEnabled &&
    prev.shouldDrivePlaybackUpdates === next.shouldDrivePlaybackUpdates &&
    (prev.fontScale ?? 1) === (next.fontScale ?? 1) &&
    Boolean(prev.landscapeMode) === Boolean(next.landscapeMode) &&
    Boolean(prev.hasDuetLines) === Boolean(next.hasDuetLines) &&
    (prev.posYSpringPolicy?.mass ?? AMLL_DEFAULT_POS_Y_SPRING.mass) ===
      (next.posYSpringPolicy?.mass ?? AMLL_DEFAULT_POS_Y_SPRING.mass) &&
    (prev.posYSpringPolicy?.damping ?? AMLL_DEFAULT_POS_Y_SPRING.damping) ===
      (next.posYSpringPolicy?.damping ?? AMLL_DEFAULT_POS_Y_SPRING.damping) &&
    (prev.posYSpringPolicy?.stiffness ?? AMLL_DEFAULT_POS_Y_SPRING.stiffness) ===
      (next.posYSpringPolicy?.stiffness ?? AMLL_DEFAULT_POS_Y_SPRING.stiffness) &&
    (prev.groupMotionDelayMs ?? 0) === (next.groupMotionDelayMs ?? 0) &&
    prev.onPress === next.onPress &&
    prev.onLongPress === next.onLongPress
  );
}

export const LyricLine = memo(function LyricLine({
  rendererActive = true,
  line,
  isActive,
  isPast,
  isSelected = false,
  blurAmount = 0,
  inactiveOpacityDistance,
  showTranslatedText,
  pauseTone = "none",
  showPauseDotsAfter = false,
  showPauseDotsBefore = false,
  pauseStartMs = 0,
  pauseVisualDurationMs = 0,
  pauseHoldMs = 0,
  playbackPositionOverrideMs = null,
  onPress,
  onLongPress,
  tapEnabled,
  shouldDrivePlaybackUpdates,
  fontScale = 1,
  landscapeMode = false,
  hasDuetLines = false,
  posYSpringPolicy = AMLL_DEFAULT_POS_Y_SPRING,
  groupMotionDelayMs = 0,
}: LyricLineProps) {
  const resolvedFontScale = fontScale;
  const lineFontSize = BASE_FONT_SIZE * SCALE_ACTIVE * resolvedFontScale;
  const lineLineHeight = BASE_LINE_HEIGHT * SCALE_ACTIVE * resolvedFontScale;
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
    rendererActive &&
    (shouldDrivePlaybackUpdates ||
      shouldUseNativeRevealTree ||
      needsPrimaryJsPlayback ||
      isActive ||
      shouldPrewarmNativeReveal);

  const {
    bgStillActive,
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
  const shouldAnimateRevealSweep =
    rendererActive && isPlaying && shouldUseNativeRevealTree;
  const nativeRevealPlaybackPosition = useMemo(
    () =>
      getProjectedPlaybackPosition(
        anchorPositionMs,
        anchorMonotonicMs,
        isPlaying,
      ),
    [anchorMonotonicMs, anchorPositionMs, isPlaying],
  );
  const opacityAnim = useSharedValue(
    visuallyActive ? OPACITY_ACTIVE : getInactiveOpacity(inactiveOpacityDistance),
  );
  const blurAnim = useSharedValue(Math.max(0, Math.min(5, blurAmount)));

  useEffect(() => {
    if (!rendererActive) {
      cancelAnimation(opacityAnim);
      return;
    }
    opacityAnim.value = withTiming(visuallyActive ? OPACITY_ACTIVE : inactiveOpacity, {
      duration: 400,
      easing: ReanimatedEasing.ease,
    });
    return () => cancelAnimation(opacityAnim);
  }, [inactiveOpacity, rendererActive, visuallyActive, opacityAnim]);

  useEffect(() => {
    if (!rendererActive) {
      cancelAnimation(blurAnim);
      return;
    }
    blurAnim.value = withTiming(Math.max(0, Math.min(5, blurAmount)), {
      duration: 400,
      easing: ReanimatedEasing.ease,
    });
    return () => cancelAnimation(blurAnim);
  }, [blurAmount, blurAnim, rendererActive]);

  const textWeight = "700" as const;
  const translatedText = String(line.translatedText || "").trim();
  const backgroundTranslatedText = String(
    line.backgroundTranslatedText || "",
  ).trim();
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
  }, [line.lineStartTime, line.lineEndTime, lineFontSize, textLaneWidth]);
  const translatedTextWidthStyle = useMemo(() => {
    if (laneWidthPx <= 0) {
      return { width: textLaneWidth as number | `${number}%` };
    }
    const laneFraction = landscapeMode ? 0.9 : 0.88;
    return { width: Math.round(laneWidthPx * laneFraction) };
  }, [laneWidthPx, landscapeMode, textLaneWidth]);
  const lineAnimStyle = useAnimatedStyle(
    () => ({
      opacity: opacityAnim.value,
      // Keep the filter present even at zero so the native view hierarchy stays
      // stable while focus moves between rows.
      filter: [{ blur: blurAnim.value }],
    }),
    [laneWidthPx, alignRight],
  );
  const containerStyle = useMemo(
    () => [
      styles.lineOuter as ViewStyle,
      landscapeMode && (styles.lineOuterLandscape as ViewStyle),
      fontScale !== 1 && ({ minHeight: 84 * fontScale } as ViewStyle),
    ] as ViewStyle[],
    [landscapeMode, fontScale],
  );
  const toneOpacity =
    pauseTone === "future" ? 0.76 : pauseTone === "past" ? 0.94 : 1;

  return (
    <View style={containerStyle}>
      {showPauseDotsBefore && (
        <PauseDots
          rendererActive={rendererActive}
          alignRight={alignRight}
          pauseStartMs={pauseStartMs}
          pauseVisualDurationMs={pauseVisualDurationMs}
          pauseHoldMs={pauseHoldMs}
          playbackPositionOverrideMs={playbackPositionOverrideMs}
          fontSize={lineFontSize}
          edgeInset={lineInnerPaddingHorizontal}
        />
      )}
      <Reanimated.View style={lineAnimStyle}>
        <Pressable
          onLongPress={onLongPressLine}
          onPress={onPressLine}
          style={({ pressed }) => [
            styles.linePressable as ViewStyle,
            isSelected && (styles.lineSelected as ViewStyle),
            pressed && (styles.linePressed as ViewStyle),
          ]}
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
            onLayout={handleLaneLayout}
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
              style={[
                styles.lineFlow as ViewStyle,
                { width: textLaneWidth } as ViewStyle,
                alignRight && (styles.lineFlowOpposite as ViewStyle),
              ] as ViewStyle[]}
            >
              {syllableGroups.map((group, groupIdx) => (
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
                        const text = alignRight ? getSyllableDisplayText(syl.text ?? "") : (syl.text ?? "");
                        if (isPast || (!isActive && !shouldPrewarmNativeReveal)) {
                          return <Text key={idx} style={[styles.lineText, scaledLineTextStyle,
                            { color: isPast || bgStillActive ? COLOR_DONE : COLOR_INACTIVE, fontWeight: textWeight }]}>{text}</Text>;
                        }
                        return <NativeRevealToken key={idx} text={text} startTime={syl.startTime} endTime={syl.endTime}
                          playbackPosition={playbackPositionOverrideMs ?? nativeRevealPlaybackPosition}
                          isPlaying={shouldAnimateRevealSweep} fontSize={lineFontSize} lineHeight={lineLineHeight} />;
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
          {!!line.backgroundSyllables?.length && (
            <BackgroundVocals
              rendererActive={rendererActive}
              syllables={line.backgroundSyllables}
              translatedText={
                showTranslatedText ? backgroundTranslatedText : ""
              }
              parentIsActive={isActive}
              parentIsPast={isPast}
              parentBgStillActive={bgStillActive}
              parentShouldPrewarmNativeReveal={shouldPrewarmNativeReveal}
              playbackPositionOverrideMs={playbackPositionOverrideMs}
              alignRight={alignRight}
              textLaneWidth={textLaneWidth}
              fontScale={resolvedFontScale}
              posYSpringPolicy={posYSpringPolicy}
              groupMotionDelayMs={groupMotionDelayMs}
            />
          )}
          </View>
        </View>
        </Pressable>
      </Reanimated.View>
      {showPauseDotsAfter && (
        <PauseDots
          rendererActive={rendererActive}
          alignRight={alignRight}
          pauseStartMs={pauseStartMs}
          pauseVisualDurationMs={pauseVisualDurationMs}
          pauseHoldMs={pauseHoldMs}
          playbackPositionOverrideMs={playbackPositionOverrideMs}
          fontSize={lineFontSize}
          edgeInset={lineInnerPaddingHorizontal}
        />
      )}
    </View>
  );
}, areLyricLinePropsEqual);

// One visible text tree. Color spans reveal glyphs without overlaid copies,
// animated clip widths, font-size changes, or magnifying a cached text bitmap.
const NativeRevealGlyph = memo(function NativeRevealGlyph({ text, index, count, progress, background }: {
  text: string; index: number; count: number; progress: SharedValue<number>; background: boolean;
}) {
  const colorStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const reveal = Math.max(0, Math.min(1, (p * (count + 0.8) - index) / 1.8));
    const alpha = background ? 0.16 + 0.24 * reveal : 0.4 + 0.6 * reveal;
    return { color: `rgba(255,255,255,${alpha})` };
  });
  return <Reanimated.Text style={colorStyle}>{text}</Reanimated.Text>;
});

const NativeRevealToken = memo(function NativeRevealToken({ text, startTime, endTime, playbackPosition, isPlaying,
  fontSize, lineHeight, background = false }: {
  text: string; startTime: number; endTime: number; playbackPosition: number; isPlaying: boolean;
  fontSize: number; lineHeight: number; background?: boolean;
}) {
  const progress = useSharedValue(getSyllableProgress(playbackPosition, startTime, endTime));
  const floatProgress = useAmlWordFloatProgress(playbackPosition, startTime, endTime, isPlaying);
  useEffect(() => syncRevealProgress(progress, playbackPosition, startTime, endTime, isPlaying, REVEAL_SWEEP_EASING),
    [endTime, isPlaying, playbackPosition, progress, startTime]);
  // Keep joining scripts in a single attributed run so shaping remains intact.
  const glyphs = useMemo(() => /[\u0590-\u08ff\u0900-\u0dff]/u.test(text) ? [text] : getGraphemes(text), [text]);
  const motion = useAnimatedStyle(() => ({ transform: [{ translateY: background
    ? getBackgroundTokenRiseY(floatProgress.value, fontSize) : getPrimaryTokenRiseY(floatProgress.value, fontSize) }] }));
  return <Reanimated.View style={[styles.tokenWrap, motion]}>
    <Text style={[background ? styles.bgVocalsText : styles.lineText,
      { fontSize, lineHeight, fontWeight: background ? "500" : "700" }]}>
      {glyphs.map((glyph, index) => <NativeRevealGlyph key={index} text={glyph} index={index} count={glyphs.length}
        progress={progress} background={background} />)}
    </Text>
  </Reanimated.View>;
});

const COLOR_BG_INACTIVE = "rgba(255,255,255,0.08)";

const BackgroundVocals = memo(function BackgroundVocals({
  rendererActive = true,
  syllables,
  translatedText = "",
  alignRight = false,
  textLaneWidth = LYRIC_TEXT_LANE_WIDTH,
  parentIsActive,
  parentIsPast,
  parentBgStillActive,
  parentShouldPrewarmNativeReveal,
  playbackPositionOverrideMs = null,
  fontScale = 1,
  precedesMain = false,
  posYSpringPolicy = AMLL_DEFAULT_POS_Y_SPRING,
  groupMotionDelayMs = 0,
}: {
  rendererActive?: boolean;
  syllables: LyricSyllable[];
  translatedText?: string;
  alignRight?: boolean;
  textLaneWidth?: number | string;
  parentIsActive: boolean;
  parentIsPast: boolean;
  parentBgStillActive: boolean;
  parentShouldPrewarmNativeReveal: boolean;
  playbackPositionOverrideMs?: number | null;
  fontScale?: number;
  precedesMain?: boolean;
  posYSpringPolicy?: AmlPosYSpringPolicy;
  groupMotionDelayMs?: number;
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
  const syllableGroups = useMemo(
    () => groupSyllablesIntoWords(syllables),
    [syllables],
  );
  const shouldUseNativeBackgroundReveal =
    rendererActive &&
    playbackPositionOverrideMs == null &&
    (parentIsActive || parentBgStillActive || parentShouldPrewarmNativeReveal);
  const needsBackgroundJsPlayback =
    rendererActive &&
    playbackPositionOverrideMs != null &&
    (parentIsActive || parentBgStillActive || parentShouldPrewarmNativeReveal);

  const { playbackPosition, isPlaying, anchorPositionMs, anchorMonotonicMs, globallyPlaying } = usePlaybackStore(
    useShallow(useCallback((state) => {
      const pos = playbackPositionOverrideMs ?? state.playbackPosition;
      return {
        playbackPosition: needsBackgroundJsPlayback
          ? (pos >= bgEnd ? bgEnd : pos >= bgStart ? pos : 0) : 0,
        isPlaying:
          rendererActive && shouldUseNativeBackgroundReveal && state.isPlaying,
        anchorPositionMs: shouldUseNativeBackgroundReveal ? state.anchorPositionMs : 0,
        anchorMonotonicMs: shouldUseNativeBackgroundReveal ? state.anchorMonotonicMs : 0,
        globallyPlaying: state.isPlaying,
      };
    }, [bgEnd, bgStart, needsBackgroundJsPlayback, playbackPositionOverrideMs, rendererActive, shouldUseNativeBackgroundReveal])),
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
  const isBgPast = parentIsPast || effectivePlaybackPosition >= bgEnd;
  const bgPresented = parentIsActive || parentBgStillActive || !globallyPlaying;
  const hiddenSlideY = precedesMain ? 80 : -80;
  const bgSlideY = useSharedValue(bgPresented ? 0 : hiddenSlideY);
  const bgOpacity = useSharedValue(bgPresented ? 1 : 0);
  const [bgMeasuredHeight, setBgMeasuredHeight] = useState(0);
  useEffect(() => {
    if (!rendererActive) {
      cancelAnimation(bgSlideY);
      cancelAnimation(bgOpacity);
      return;
    }
    const slideAnimation = withSpring(
      bgPresented ? 0 : hiddenSlideY,
      posYSpringPolicy,
    );
    bgSlideY.value =
      groupMotionDelayMs > 0
        ? withDelay(groupMotionDelayMs, slideAnimation)
        : slideAnimation;
    bgOpacity.value = withTiming(bgPresented ? 1 : 0, {
      duration: 300,
      easing: ReanimatedEasing.ease,
    });
    return () => {
      cancelAnimation(bgSlideY);
      cancelAnimation(bgOpacity);
    };
  }, [
    bgOpacity,
    bgPresented,
    bgSlideY,
    groupMotionDelayMs,
    hiddenSlideY,
    posYSpringPolicy.damping,
    posYSpringPolicy.mass,
    posYSpringPolicy.stiffness,
    posYSpringPolicy,
    rendererActive,
  ]);

  // Paint-only background effects: reserve the same space before, during and
  // after playback so the primary line and following rows never jump.
  const bgPresentationStyle = useAnimatedStyle(() => ({
    opacity: 0.5 + bgOpacity.value * 0.5,
    transform: [
      { translateY: (bgSlideY.value / 100) * Math.min(bgMeasuredHeight, bgLineHeight) },
    ],
  }));

  const translationColor = "rgba(255,255,255,0.12)";

  return (
    <Reanimated.View
      onLayout={(event) => {
        const { height: nextHeight } = event.nativeEvent.layout;
        if (Number.isFinite(nextHeight) && nextHeight > 0) {
          setBgMeasuredHeight((previous) =>
            Math.abs(previous - nextHeight) < 0.5 ? previous : nextHeight,
          );
        }
      }}
      style={[
        styles.bgVocalsGroup,
        precedesMain && styles.bgVocalsGroupPrecedes,
        { width: textLaneWidth as number },
        alignRight && styles.bgVocalsGroupOpposite,
        bgPresentationStyle,
      ]}
    >
      <View
        style={[
          styles.bgVocalsFlow,
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
                const text = alignRight ? getSyllableDisplayText(syl.text ?? "") : (syl.text ?? "");
                if (isBgPast || (!parentIsActive && !parentBgStillActive && !parentShouldPrewarmNativeReveal)) {
                  return <Text key={idx} style={[styles.bgVocalsText, bgTextStyle, { color: COLOR_BG_INACTIVE }]}>{text}</Text>;
                }
                return <NativeRevealToken key={idx} text={text} startTime={syl.startTime} endTime={syl.endTime}
                  playbackPosition={playbackPositionOverrideMs ?? nativeRevealPlaybackPosition}
                  isPlaying={shouldAnimateRevealSweep} fontSize={bgFontSize} lineHeight={bgLineHeight} background />;
              })}
            </View>
          ))}
          {!alignRight && group.needsTrailingGap && (
            <Text style={styles.bgVocalsGapText}> </Text>
          )}
        </View>
      ))}
      </View>
      {!!translatedText && (
        <Text
          style={[
            styles.backgroundTranslatedText,
            {
              color: translationColor,
              fontSize: 12 * fontScale,
              lineHeight: 16 * fontScale,
            },
            alignRight && styles.translatedTextOpposite,
          ]}
        >
          {translatedText}
        </Text>
      )}
    </Reanimated.View>
  );
});

const AMLL_DOT3_TRAILING_MS = 750;
const AMLL_DOTS_EXIT_PHASE1_MS = 750;
const AMLL_DOTS_EXIT_PHASE2_MS = 250;
const AMLL_DOTS_EXIT_TOTAL_MS =
  AMLL_DOTS_EXIT_PHASE1_MS + AMLL_DOTS_EXIT_PHASE2_MS;
const AMLL_DOTS_EXIT_FADE_MS = 250;
const AMLL_DOTS_DISMISS_FADE_MS = 150;
const AMLL_DOTS_ENTER_FADE_MS = 180;
const AMLL_DOT_ENTER_FADE_MS = 750;
const AMLL_DOT_ENTER_STAGGER_MS = 80;
const AMLL_DOT_ENTER_TOTAL_MS =
  AMLL_DOT_ENTER_STAGGER_MS * 2 + AMLL_DOT_ENTER_FADE_MS;
const AMLL_DOTS_BREATHE_PERIOD_MS = 4000;
const AMLL_DOTS_FALLBACK_THRESHOLD_MS = 3000;
const AMLL_DOTS_MAX_SCALE = 1.25;
const AMLL_DOTS_MIN_SCALE = 0.4;
const AMLL_DOT_INACTIVE_OPACITY = 0.2;
const AMLL_DOT_ACTIVE_OPACITY = 0.9;

function amlDotsBezier(
  progress: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  "worklet";
  return cubicBezierYForX(clamp01(progress), x1, y1, x2, y2);
}

function amlDotOpacity(fraction: number) {
  "worklet";
  return (
    AMLL_DOT_INACTIVE_OPACITY +
    (AMLL_DOT_ACTIVE_OPACITY - AMLL_DOT_INACTIVE_OPACITY) * clamp01(fraction)
  );
}

function amlDotsBreathingProgress(t: number) {
  "worklet";
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const angle = 4 * Math.PI * t;
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return t - 0.084 * s + 0.008 * (1 - c) + 0.0046 * s * (c - s);
}

function amlDotEnterAlpha(index: number, internalMs: number) {
  "worklet";
  const t = clamp01(
    (internalMs - index * AMLL_DOT_ENTER_STAGGER_MS) / AMLL_DOT_ENTER_FADE_MS,
  );
  return t * t;
}

function amlDotFraction(
  startDelay: number,
  duration: number,
  internalMs: number,
  target: number,
) {
  "worklet";
  if (internalMs <= startDelay || duration <= 0) return 0;
  const eased = amlDotsBezier(
    (internalMs - startDelay) / duration,
    0.56,
    0.01,
    0.45,
    1,
  );
  return eased * target;
}

function resolveAmlPauseDotsSnapshot(
  elapsedMs: number,
  totalDurationMs: number,
  holdMs: number,
) {
  "worklet";
  const delayEndMs = Math.max(0, holdMs);
  const bodyMs = totalDurationMs - delayEndMs - AMLL_DOTS_EXIT_TOTAL_MS;
  if (bodyMs < AMLL_DOT_ENTER_TOTAL_MS || elapsedMs < 0) {
    return { opacity: 0, scale: 1, dots: [0, 0, 0] as const };
  }
  const bodyEndMs = delayEndMs + bodyMs;
  const totalEndMs = bodyEndMs + AMLL_DOTS_EXIT_TOTAL_MS;
  if (elapsedMs >= totalEndMs) {
    return { opacity: 0, scale: 1, dots: [0, 0, 0] as const };
  }
  if (elapsedMs < delayEndMs) {
    return { opacity: 0, scale: 1, dots: [0, 0, 0] as const };
  }

  const internalMs = elapsedMs - delayEndMs;
  const enterOpacity = amlDotsBezier(
    internalMs / AMLL_DOTS_ENTER_FADE_MS,
    0.59,
    0.02,
    0.07,
    1,
  );
  const fallback = bodyMs < AMLL_DOTS_FALLBACK_THRESHOLD_MS;
  const breatheCycles = Math.max(1, Math.floor(bodyMs / AMLL_DOTS_BREATHE_PERIOD_MS));
  const breathePeriodMs = bodyMs / breatheCycles;
  const segmentMs = Math.round((bodyMs + AMLL_DOT3_TRAILING_MS) / 3);
  const dot3DurationMs = bodyMs - segmentMs * 2;
  const dot3Target = fallback ? 1 : dot3DurationMs / segmentMs;
  const writeDots = (fractions: readonly [number, number, number]) =>
    fractions.map(
      (fraction, index) =>
        amlDotOpacity(fraction) * amlDotEnterAlpha(index, internalMs),
    ) as [number, number, number];

  if (elapsedMs >= bodyEndMs) {
    const exitElapsedMs = elapsedMs - bodyEndMs;
    const fadeT = clamp01(
      (exitElapsedMs - (AMLL_DOTS_EXIT_TOTAL_MS - AMLL_DOTS_EXIT_FADE_MS)) /
        AMLL_DOTS_EXIT_FADE_MS,
    );
    const opacity =
      enterOpacity *
      (1 - amlDotsBezier(fadeT, 0.43, 0.08, 0.83, 0.31));
    let scale: number;
    if (exitElapsedMs < AMLL_DOTS_EXIT_PHASE1_MS) {
      scale =
        1 +
        amlDotsBezier(
          exitElapsedMs / AMLL_DOTS_EXIT_PHASE1_MS,
          0.14,
          0.06,
          0.25,
          1,
        ) *
          (AMLL_DOTS_MAX_SCALE - 1);
    } else {
      const phase2 =
        (exitElapsedMs - AMLL_DOTS_EXIT_PHASE1_MS) / AMLL_DOTS_EXIT_PHASE2_MS;
      scale =
        AMLL_DOTS_MAX_SCALE -
        amlDotsBezier(phase2, 0.29, 0.03, 1, 0.38) *
          (AMLL_DOTS_MAX_SCALE - AMLL_DOTS_MIN_SCALE);
    }
    const trailing = clamp01(exitElapsedMs / AMLL_DOT3_TRAILING_MS);
    return {
      opacity,
      scale,
      dots: writeDots([
        1,
        1,
        dot3Target + (1 - dot3Target) * trailing,
      ]),
    };
  }

  if (fallback) {
    return { opacity: enterOpacity, scale: 1, dots: writeDots([1, 1, 1]) };
  }

  const cycleT = (internalMs % breathePeriodMs) / breathePeriodMs;
  const breathe = amlDotsBreathingProgress(cycleT);
  const scale =
    breathe <= 0.5
      ? 1 + (breathe / 0.5) * (AMLL_DOTS_MAX_SCALE - 1)
      : AMLL_DOTS_MAX_SCALE -
        ((breathe - 0.5) / 0.5) * (AMLL_DOTS_MAX_SCALE - 1);
  return {
    opacity: enterOpacity,
    scale,
    dots: writeDots([
      amlDotFraction(0, segmentMs, internalMs, 1),
      amlDotFraction(segmentMs, segmentMs, internalMs, 1),
      amlDotFraction(segmentMs * 2, dot3DurationMs, internalMs, dot3Target),
    ]),
  };
}

const PauseDot = memo(function PauseDot({ index, snapshot }: {
  index: number;
  snapshot: Pick<SharedValue<ReturnType<typeof resolveAmlPauseDotsSnapshot>>, "value">;
}) {
  const animatedStyle = useAnimatedStyle(() => ({ opacity: snapshot.value.dots[index] }));
  return <Reanimated.View style={[styles.pauseDot, { width: 12, height: 12, borderRadius: 6 }, animatedStyle]} />;
});

const PauseDots = memo(function PauseDots({
  rendererActive = true,
  alignRight = false,
  pauseStartMs,
  pauseVisualDurationMs,
  pauseHoldMs,
  playbackPositionOverrideMs = null,
  fontSize = BASE_FONT_SIZE,
  edgeInset = LINE_INNER_PADDING_HORIZONTAL,
}: {
  rendererActive?: boolean;
  alignRight?: boolean;
  pauseStartMs: number;
  pauseVisualDurationMs: number;
  pauseHoldMs: number;
  playbackPositionOverrideMs?: number | null;
  fontSize?: number;
  edgeInset?: number;
}) {
  const { anchorPositionMs, anchorMonotonicMs, isPlaying } = usePlaybackStore(
    useShallow((state) => ({
      anchorPositionMs: rendererActive ? state.anchorPositionMs : 0,
      anchorMonotonicMs: rendererActive ? state.anchorMonotonicMs : 0,
      isPlaying: rendererActive && state.isPlaying,
    })),
  );
  const position = playbackPositionOverrideMs ?? getProjectedPlaybackPosition(
    anchorPositionMs, anchorMonotonicMs, isPlaying,
  );
  const elapsed = useSharedValue(position - pauseStartMs);
  useEffect(() => {
    cancelAnimation(elapsed);
    if (!rendererActive && playbackPositionOverrideMs === null) {
      return;
    }
    const current = playbackPositionOverrideMs ?? getProjectedPlaybackPosition(
      anchorPositionMs, anchorMonotonicMs, isPlaying,
    );
    elapsed.value = current - pauseStartMs;
    if (isPlaying && playbackPositionOverrideMs === null && elapsed.value < pauseVisualDurationMs) {
      elapsed.value = withTiming(pauseVisualDurationMs, {
        duration: Math.max(1, pauseVisualDurationMs - elapsed.value),
        easing: ReanimatedEasing.linear,
      });
    }
    return () => cancelAnimation(elapsed);
  }, [anchorPositionMs, anchorMonotonicMs, isPlaying, playbackPositionOverrideMs, pauseStartMs, pauseVisualDurationMs, rendererActive, elapsed]);
  const snapshot = useDerivedValue(() => resolveAmlPauseDotsSnapshot(
    elapsed.value, pauseVisualDurationMs, pauseHoldMs,
  ));
  const presentation = useAnimatedStyle(() => ({
    opacity: snapshot.value.opacity,
    transform: [{ scale: snapshot.value.scale }],
  }));
  const dotGap = 8;
  const innerVerticalPad = 0;
  const outerVerticalMargin = 0;
  const contentHeight = 16;

  return (
    <Reanimated.View
      exiting={FadeOut.duration(AMLL_DOTS_DISMISS_FADE_MS).easing(
        ReanimatedEasing.bezier(0.43, 0.08, 0.83, 0.31),
      )}
      style={[
        styles.pauseDotsRow,
        alignRight
          ? { alignSelf: "flex-end", marginLeft: 0, marginRight: edgeInset }
          : { marginLeft: edgeInset },
        {
          gap: dotGap,
          height: contentHeight + innerVerticalPad * 2,
          // Upstream's horizontal padding is the lyric-line inset itself. This
          // component already applies that inset via marginLeft/marginRight,
          // so adding another .4em here would shift the dots too far inward.
          paddingHorizontal: 0,
          paddingVertical: innerVerticalPad,
          marginTop: 15,
          marginBottom: outerVerticalMargin,
        },
        presentation,
      ]}
    >
      {[0, 1, 2].map((index) => (
        <PauseDot key={index} index={index} snapshot={snapshot} />
      ))}
    </Reanimated.View>
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
    borderRadius: 9,
    overflow: "visible",
  } as ViewStyle,
  lineSelected: {
    backgroundColor: "rgba(255,255,255,0.13)",
  } as ViewStyle,
  linePressed: {
    backgroundColor: "rgba(255,255,255,0.16)",
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
  pauseDotsRow: {
    flexDirection: "row",
    alignItems: "center",
  } as ViewStyle,
  pauseDot: {
    backgroundColor: "#FFFFFF",
  } as ViewStyle,
  lineText: {
    fontSize: BASE_FONT_SIZE,
    lineHeight: BASE_LINE_HEIGHT,
    textAlign: "left",
    letterSpacing: 0.1,
  } as TextStyle,
  gapText: {
    fontSize: BASE_FONT_SIZE,
    lineHeight: BASE_LINE_HEIGHT,
  } as TextStyle,
  bgVocalsFlow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-end",
    alignSelf: "flex-start",
    width: "100%",
    marginTop: 3,
  } as ViewStyle,
  bgVocalsGroup: {
    alignSelf: "flex-start",
  } as ViewStyle,
  bgVocalsGroupPrecedes: {
    marginBottom: 0,
  } as ViewStyle,
  bgVocalsGroupOpposite: {
    alignSelf: "flex-end",
  } as ViewStyle,
  bgVocalsFlowOpposite: {
    justifyContent: "flex-end",
    alignSelf: "flex-end",
  } as ViewStyle,
  bgVocalsText: {
    fontSize: BG_FONT_SIZE,
    lineHeight: BG_LINE_HEIGHT,
    fontWeight: "500",
    textAlign: "left",
    letterSpacing: 0.1,
  } as TextStyle,
  bgVocalsGapText: {
    fontSize: BG_FONT_SIZE,
    lineHeight: BG_LINE_HEIGHT,
  } as TextStyle,
  backgroundTranslatedText: {
    alignSelf: "flex-start",
    marginTop: 2,
    marginLeft: 2,
    textAlign: "left",
    letterSpacing: 0.05,
    textShadowColor: "rgba(0,0,0,0.3)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
    fontWeight: "700",
  } as TextStyle,
  translatedText: {
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
    fontWeight: "700",
  } as TextStyle,
  translatedTextOpposite: {
    alignSelf: "flex-end",
    marginLeft: 0,
    marginRight: 2,
    textAlign: "right",
  } as TextStyle,
});
