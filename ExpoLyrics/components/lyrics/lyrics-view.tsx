import { FlashList, type FlashListRef } from "@shopify/flash-list";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AppState,
  type AppStateStatus,
  Image,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  type LayoutChangeEvent,
  Pressable,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  cancelAnimation,
  Easing as ReanimatedEasing,
  runOnJS,
  scrollTo,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import {
  getLandscapeLyricsCenterUpwardOffset,
  getLyricsViewportCenterUpwardOffset,
} from "@/constants/player-layout";
import { getPrimaryLineText } from "@/lib/active-lyric-line";
import { detectLyricsTimingMode } from "@/lib/lyrics-timing";
import { usePlaybackStore } from "@/store/playback-store";
import type {
  LyricLine as LyricLineType,
  LyricsAttributionMetadata,
  LyricsAttributionProfile,
} from "@/types/bridge";

import { LyricLine } from "./lyric-line";

const AMLL_MIN_INTERLUDE_GAP_MS = 7000;
const AMLL_INTERLUDE_ENTER_HOLD_MS = 500;
const AMLL_INTERLUDE_EXIT_TOTAL_MS = 1000;
const AMLL_INTERLUDE_DOT_ENTER_TOTAL_MS = 910;
const AMLL_SEEK_JITTER_TOLERANCE_MS = 150;
const AMLL_SEEK_MAX_TRUSTED_GAP_MS = 800;
const AMLL_SEEK_DRIFT_SLACK = 0.5;
const SOURCE_CHANGE_AUTOSCROLL_DELAY_MS = 500;
const TOP_LIST_PADDING = 150;
const BOTTOM_LIST_PADDING = 280;
const STATIC_LYRIC_FONT_SIZE = 26;
const STATIC_LYRIC_LINE_HEIGHT = 38;
const STATIC_LYRIC_HORIZONTAL_INSET = 28;
const STATIC_LYRIC_MAX_WIDTH = 300;
const STATIC_TRANSLATED_FONT_SIZE = 18;
const STATIC_TRANSLATED_LINE_HEIGHT = 26;
const ACTIVE_LINE_TOP_OFFSET = 0;
const AMLL_ALIGN_POSITION = 0.35;
const ACTIVE_RANGE_BOTTOM_PADDING = 24;
const ACTIVE_LINE_ALIGNMENT_EPSILON = 3;
const LYRIC_SCROLL_ANIMATION_MS = 440;
const PROGRAMMATIC_SCROLL_GUARD_MS = LYRIC_SCROLL_ANIMATION_MS + 40;
const SCROLL_OFFSET_EPSILON = 2;
const SCROLL_SETTLE_VERIFY_MS = LYRIC_SCROLL_ANIMATION_MS + 100;
const PENDING_ANCHOR_RETRY_MS = 96;
const MAX_PENDING_ANCHOR_RETRIES = 18;
type AmlPosYSpringPolicyInput = {
  index: number;
  lyrics: LyricLineType[];
  isInterlude: boolean;
  isSeek: boolean;
  isSongEnd: boolean;
};

type AmlPosYSpringPolicy = {
  mass: number;
  stiffness: number;
  damping: number;
  overshootClamping: false;
};

const AMLL_DEFAULT_POS_Y_SPRING: AmlPosYSpringPolicy = {
  mass: 0.9,
  stiffness: 90,
  damping: 15,
  overshootClamping: false,
};
const AMLL_PLAYBACK_STAGGER_MS = 50;
const AMLL_PLAYBACK_STAGGER_DECAY = 1.05;

// Port of AMLL core's getPosYSpringPolicy. AMLL deliberately uses the softer
// 90/15 policy for seeks/interludes, but retunes ordinary lyric transitions
// from the interval between consecutive line starts.
function getAmlPosYSpringPolicy({
  index,
  lyrics,
  isInterlude,
  isSeek,
  isSongEnd,
}: AmlPosYSpringPolicyInput): AmlPosYSpringPolicy {
  if (isSeek || isInterlude) {
    return AMLL_DEFAULT_POS_Y_SPRING;
  }
  if (isSongEnd) {
    return { mass: 0.9, stiffness: 140, damping: 22, overshootClamping: false } as const;
  }
  const current = lyrics[index];
  const previous = index > 0 ? lyrics[index - 1] : undefined;
  if (!current || !previous) {
    return AMLL_DEFAULT_POS_Y_SPRING;
  }
  const interval = Math.max(
    100,
    Math.min(800, current.lineStartTime - previous.lineStartTime),
  );
  const ratio = Math.pow(1 - (interval - 100) / 700, 0.2);
  const stiffness = 170 + ratio * 50;
  return {
    mass: 0.9,
    stiffness,
    damping: 2.2 * Math.sqrt(stiffness),
    overshootClamping: false,
  } as const;
}

type LyricRowMotionTransition = {
  serial: number;
  kind: "idle" | "scroll" | "rebuild";
  startOffset: number;
  targetOffset: number;
  springPolicy: AmlPosYSpringPolicy;
  delayByIndex: ReadonlyMap<number, number>;
  rebuildStartCorrectionByIndex: ReadonlyMap<number, number>;
};

const EMPTY_ROW_DELAYS = new Map<number, number>();
const EMPTY_REBUILD_CORRECTIONS = new Map<number, number>();

const LyricRowMotion = memo(function LyricRowMotion({
  index,
  transition,
  globalOffset,
  enabled,
  children,
}: {
  index: number;
  transition: LyricRowMotionTransition;
  globalOffset: SharedValue<number>;
  enabled: SharedValue<boolean>;
  children: ReactNode;
}) {
  const progress = useSharedValue(1);
  const delayMs = transition.delayByIndex.get(index) ?? 0;
  const rebuildStartCorrection =
    transition.rebuildStartCorrectionByIndex.get(index);
  const shouldRun =
    transition.kind === "scroll" ||
    (transition.kind === "rebuild" && rebuildStartCorrection !== undefined);

  useEffect(() => {
    cancelAnimation(progress);
    if (!shouldRun) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    const animation = withSpring(1, transition.springPolicy);
    progress.value = delayMs > 0 ? withDelay(delayMs, animation) : animation;
  }, [
    delayMs,
    progress,
    shouldRun,
    transition.serial,
    transition.springPolicy.damping,
    transition.springPolicy.mass,
    transition.springPolicy.stiffness,
    transition.springPolicy,
  ]);

  const animatedStyle = useAnimatedStyle(() => {
    if (!enabled.value || !shouldRun) {
      return { transform: [{ translateY: 0 }] };
    }
    if (transition.kind === "rebuild") {
      return {
        transform: [
          {
            translateY:
              (rebuildStartCorrection ?? 0) * (1 - progress.value),
          },
        ],
      };
    }
    const globalDelta = globalOffset.value - transition.startOffset;
    const targetDelta = transition.targetOffset - transition.startOffset;
    return {
      transform: [
        {
          translateY: globalDelta - targetDelta * progress.value,
        },
      ],
    };
  }, [
    rebuildStartCorrection,
    shouldRun,
    transition.kind,
    transition.startOffset,
    transition.targetOffset,
  ]);

  return <Animated.View style={animatedStyle}>{children}</Animated.View>;
});
const AUTO_FOLLOW_DISABLE_GRACE_MS = 2000;
const AUTO_FOLLOW_DISABLE_DISTANCE_PX = 120;
const AUTO_FOLLOW_RESUME_DISTANCE_PX = 64;
const USER_SCROLL_IDLE_RESET_MS = 700;
// ponytail: always true on native (web support removed)
const SHOULD_USE_UI_THREAD_SCROLL = true;
// ponytail: only the active line ±1 needs JS-driven syllable updates;
// farther cells use static colors and don't need per-frame re-render
const LYRICS_JS_UPDATE_RADIUS = 1;
const ReanimatedFlashList = Animated.createAnimatedComponent(FlashList<LyricLineType>);

function getFlashListLeadingInset(
  list: FlashListRef<LyricLineType> | null | undefined,
) {
  const inset = list?.getFirstItemOffset?.();
  if (typeof inset === "number" && Number.isFinite(inset) && inset >= 0) {
    return inset;
  }
  return TOP_LIST_PADDING;
}

function flashListLayoutUsesContentCoordinates(
  list: FlashListRef<LyricLineType> | null | undefined,
  leadingInset: number,
) {
  const firstLayout = list?.getLayout(0);
  if (!firstLayout || !Number.isFinite(firstLayout.y)) {
    return false;
  }
  return firstLayout.y >= leadingInset * 0.25;
}

function normalizeFlashListItemTop(
  list: FlashListRef<LyricLineType> | null | undefined,
  layoutY: number,
  leadingInset: number,
) {
  if (flashListLayoutUsesContentCoordinates(list, leadingInset)) {
    return layoutY;
  }
  return layoutY + leadingInset;
}

type LyricLineRange = {
  startIndex: number;
  endIndex: number;
};

type PlaybackWindowState = {
  activeLineStartIndex: number;
  activeLineEndIndex: number;
  highlightedLineIndices: ReadonlySet<number>;
  visualActiveLineStartIndex: number;
  visualActiveLineEndIndex: number;
  focusLineIndex: number;
  pauseAfterIndex: number;
  pauseBeforeIndex: number;
  isLongPause: boolean;
  pauseProgress: number;
  pauseStartMs: number;
  pauseVisualDurationMs: number;
  pauseHoldMs: number;
};

type BackgroundActiveLine = {
  index: number;
  lineEndTime: number;
  backgroundEndTime: number;
};

type LyricTimingIndex = {
  maxEndTimeByIndex: number[];
};

type TimelinePlaybackState = {
  playingLineIndices: Set<number>;
  highlightedLineIndices: Set<number>;
  playbackCursor: number;
  scrollToIndex: number;
};

type InterludeCandidate = {
  startTime: number;
  endTime: number;
  anchorLineIndex: number;
  nextLineIndex: number;
};

type InterludePlaybackContext = {
  gapStartMs: number;
  gapEndMs: number;
  anchorMs: number;
  holdMs: number;
};

type PlaybackWindowStateWithoutComputedRanges = Omit<
  PlaybackWindowState,
  "visualActiveLineStartIndex" | "visualActiveLineEndIndex"
>;

const EMPTY_WINDOW_STATE: PlaybackWindowState = {
  activeLineStartIndex: -1,
  activeLineEndIndex: -1,
  highlightedLineIndices: new Set<number>(),
  visualActiveLineStartIndex: -1,
  visualActiveLineEndIndex: -1,
  focusLineIndex: -1,
  pauseAfterIndex: -1,
  pauseBeforeIndex: -1,
  isLongPause: false,
  pauseProgress: 0,
  pauseStartMs: 0,
  pauseVisualDurationMs: 0,
  pauseHoldMs: 0,
};

function areIndexSetsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>) {
  if (a === b) {
    return true;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const index of a) {
    if (!b.has(index)) {
      return false;
    }
  }
  return true;
}

function arePlaybackWindowStatesEqual(
  a: PlaybackWindowState,
  b: PlaybackWindowState,
) {
  return (
    a.activeLineStartIndex === b.activeLineStartIndex &&
    a.activeLineEndIndex === b.activeLineEndIndex &&
    areIndexSetsEqual(a.highlightedLineIndices, b.highlightedLineIndices) &&
    a.visualActiveLineStartIndex === b.visualActiveLineStartIndex &&
    a.visualActiveLineEndIndex === b.visualActiveLineEndIndex &&
    a.focusLineIndex === b.focusLineIndex &&
    a.pauseAfterIndex === b.pauseAfterIndex &&
    a.pauseBeforeIndex === b.pauseBeforeIndex &&
    a.isLongPause === b.isLongPause &&
    Math.abs(a.pauseProgress - b.pauseProgress) < 0.004 &&
    a.pauseStartMs === b.pauseStartMs &&
    a.pauseVisualDurationMs === b.pauseVisualDurationMs &&
    a.pauseHoldMs === b.pauseHoldMs
  );
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function findActiveLineIndex(positionMs: number, lyrics: LyricLineType[]) {
  let low = 0;
  let high = lyrics.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const line = lyrics[mid];
    if (positionMs < line.lineStartTime) {
      high = mid - 1;
    } else if (positionMs >= line.lineEndTime) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

function findLastEndedLineIndex(positionMs: number, lyrics: LyricLineType[]) {
  let low = 0;
  let high = lyrics.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lyrics[mid].lineEndTime <= positionMs) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

function findFirstUpcomingLineIndex(
  positionMs: number,
  lyrics: LyricLineType[],
) {
  let low = 0;
  let high = lyrics.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lyrics[mid].lineStartTime > positionMs) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return result;
}

function getBackgroundEndTime(line: LyricLineType) {
  const backgroundSyllables = line.backgroundSyllables;
  if (!backgroundSyllables?.length) {
    return line.lineEndTime;
  }
  return Math.max(
    line.lineEndTime,
    backgroundSyllables[backgroundSyllables.length - 1].endTime,
  );
}

function getBackgroundActiveLines(lyrics: LyricLineType[]) {
  const activeLines: BackgroundActiveLine[] = [];
  for (let index = 0; index < lyrics.length; index += 1) {
    const line = lyrics[index];
    const backgroundEndTime = getBackgroundEndTime(line);
    if (backgroundEndTime > line.lineEndTime) {
      activeLines.push({
        index,
        lineEndTime: line.lineEndTime,
        backgroundEndTime,
      });
    }
  }
  return activeLines;
}

function getLyricTimingIndex(lyrics: LyricLineType[]): LyricTimingIndex {
  const maxEndTimeByIndex: number[] = [];
  let maxEndTime = 0;

  for (let index = 0; index < lyrics.length; index += 1) {
    maxEndTime = Math.max(maxEndTime, lyrics[index].lineEndTime);
    maxEndTimeByIndex.push(maxEndTime);
  }

  return { maxEndTimeByIndex };
}

function getInterludeCandidate(
  playbackPosition: number,
  lyrics: LyricLineType[],
  timingIndex: LyricTimingIndex,
): InterludeCandidate | null {
  const nextLineIndex = findFirstUpcomingLineIndex(playbackPosition, lyrics);
  if (nextLineIndex < 0) {
    return null;
  }

  const startTime =
    nextLineIndex === 0
      ? 0
      : (timingIndex.maxEndTimeByIndex[nextLineIndex - 1] ?? 0);
  const endTime = Math.max(startTime, lyrics[nextLineIndex].lineStartTime);
  if (
    endTime - startTime < AMLL_MIN_INTERLUDE_GAP_MS ||
    playbackPosition < startTime ||
    playbackPosition >= endTime
  ) {
    return null;
  }

  return {
    startTime,
    endTime,
    anchorLineIndex: nextLineIndex - 1,
    nextLineIndex,
  };
}

function createInterludePlaybackContext(
  candidate: InterludeCandidate,
  playbackPosition: number,
  resetAtCurrentPosition: boolean,
): InterludePlaybackContext {
  const anchorMs = resetAtCurrentPosition
    ? Math.max(candidate.startTime, Math.min(candidate.endTime, playbackPosition))
    : candidate.startTime;
  const isNaturalIntro =
    candidate.anchorLineIndex === -1 && anchorMs <= candidate.startTime;
  return {
    gapStartMs: candidate.startTime,
    gapEndMs: candidate.endTime,
    anchorMs,
    holdMs: isNaturalIntro ? 0 : AMLL_INTERLUDE_ENTER_HOLD_MS,
  };
}

function interludeContextMatches(
  context: InterludePlaybackContext | null,
  candidate: InterludeCandidate,
) {
  return (
    context !== null &&
    context.gapStartMs === candidate.startTime &&
    context.gapEndMs === candidate.endTime
  );
}

function getMaxLyricEndTime(timingIndex: LyricTimingIndex) {
  return timingIndex.maxEndTimeByIndex.length > 0
    ? timingIndex.maxEndTimeByIndex[timingIndex.maxEndTimeByIndex.length - 1]
    : 0;
}

function rebuildTimelinePlaybackState(
  playbackPosition: number,
  lyrics: LyricLineType[],
  timingIndex: LyricTimingIndex,
): TimelinePlaybackState {
  const playingLineIndices = new Set<number>();
  const highlightedLineIndices = new Set<number>();
  const upcomingIndex = findFirstUpcomingLineIndex(playbackPosition, lyrics);
  const firstGreater = upcomingIndex >= 0 ? upcomingIndex : lyrics.length;

  let anchorIndex = -1;
  for (let index = firstGreater - 1; index >= 0; index -= 1) {
    const line = lyrics[index];
    if (line.lineEndTime > line.lineStartTime) {
      anchorIndex = index;
      break;
    }
  }

  if (anchorIndex < 0) {
    return {
      playingLineIndices,
      highlightedLineIndices,
      playbackCursor: firstGreater,
      scrollToIndex: 0,
    };
  }

  const anchorStartTime = lyrics[anchorIndex].lineStartTime;
  let minPlaying = -1;
  let minHighlighted = -1;

  for (let index = anchorIndex; index >= 0; index -= 1) {
    const line = lyrics[index];
    if (line.lineEndTime <= anchorStartTime) {
      continue;
    }

    if (isLineInPrimaryWindow(playbackPosition, line)) {
      playingLineIndices.add(index);
      minPlaying = index;
    }

    highlightedLineIndices.add(index);
    minHighlighted = index;
  }

  const activeInterlude = getInterludeCandidate(
    playbackPosition,
    lyrics,
    timingIndex,
  );
  const isPastMaxEnd =
    lyrics.length > 0 && playbackPosition >= getMaxLyricEndTime(timingIndex);
  if (
    (activeInterlude !== null || isPastMaxEnd) &&
    playingLineIndices.size === 0
  ) {
    highlightedLineIndices.clear();
  }

  return {
    playingLineIndices,
    highlightedLineIndices,
    playbackCursor: minPlaying === -1 ? firstGreater : minPlaying,
    scrollToIndex: minHighlighted,
  };
}

function advanceTimelinePlaybackState(
  timelineState: TimelinePlaybackState,
  playbackPosition: number,
  lyrics: LyricLineType[],
  timingIndex: LyricTimingIndex,
) {
  for (const index of timelineState.playingLineIndices) {
    const line = lyrics[index];
    if (
      !line ||
      playbackPosition < line.lineStartTime ||
      line.lineEndTime <= playbackPosition
    ) {
      timelineState.playingLineIndices.delete(index);
    }
  }

  const addedPlayingIndices: number[] = [];
  let cursor = Math.max(0, timelineState.playbackCursor);
  while (cursor < lyrics.length) {
    const line = lyrics[cursor];
    if (line.lineStartTime > playbackPosition) {
      break;
    }

    if (
      isLineInPrimaryWindow(playbackPosition, line) &&
      !timelineState.playingLineIndices.has(cursor)
    ) {
      timelineState.playingLineIndices.add(cursor);
      addedPlayingIndices.push(cursor);
    }
    cursor += 1;
  }
  timelineState.playbackCursor = cursor;

  const expiredHighlightedIndices: number[] = [];
  for (const index of timelineState.highlightedLineIndices) {
    if (!timelineState.playingLineIndices.has(index)) {
      expiredHighlightedIndices.push(index);
    }
  }

  if (addedPlayingIndices.length > 0) {
    for (const index of addedPlayingIndices) {
      timelineState.highlightedLineIndices.add(index);
    }
    for (const index of expiredHighlightedIndices) {
      timelineState.highlightedLineIndices.delete(index);
    }

    let minHighlighted = Number.POSITIVE_INFINITY;
    for (const index of timelineState.highlightedLineIndices) {
      if (index < minHighlighted) {
        minHighlighted = index;
      }
    }
    if (Number.isFinite(minHighlighted)) {
      timelineState.scrollToIndex = minHighlighted;
    }
  }

  const activeInterlude = getInterludeCandidate(
    playbackPosition,
    lyrics,
    timingIndex,
  );
  const isPastMaxEnd =
    lyrics.length > 0 && playbackPosition >= getMaxLyricEndTime(timingIndex);
  if (
    (activeInterlude !== null || isPastMaxEnd) &&
    timelineState.playingLineIndices.size === 0
  ) {
    timelineState.highlightedLineIndices.clear();
  }
}

function getHighlightedLineRange(indices: ReadonlySet<number>) {
  let startIndex = Number.POSITIVE_INFINITY;
  let endIndex = -1;
  for (const index of indices) {
    startIndex = Math.min(startIndex, index);
    endIndex = Math.max(endIndex, index);
  }
  return {
    startIndex: Number.isFinite(startIndex) ? startIndex : -1,
    endIndex,
  };
}

function getLatestHighlightedLineIndex(
  indices: ReadonlySet<number>,
  fallbackIndex: number,
) {
  let latestIndex = fallbackIndex;
  for (const index of indices) {
    latestIndex = Math.max(latestIndex, index);
  }
  return latestIndex;
}

function getMonotonicNow() {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function extendLineIndexRange(
  startIndex: number,
  endIndex: number,
  index: number,
) {
  if (index < 0) {
    return { startIndex, endIndex };
  }
  return {
    startIndex: startIndex < 0 ? index : Math.min(startIndex, index),
    endIndex: endIndex < 0 ? index : Math.max(endIndex, index),
  };
}

function isLineInPrimaryWindow(
  playbackPosition: number,
  line: LyricLineType,
) {
  return (
    playbackPosition >= line.lineStartTime &&
    playbackPosition < line.lineEndTime
  );
}

function addVisualActiveRange(
  state: PlaybackWindowStateWithoutComputedRanges,
  playbackPosition: number,
  backgroundActiveLines: BackgroundActiveLine[],
): PlaybackWindowState {
  let visualStart = state.activeLineStartIndex;
  let visualEnd = state.activeLineEndIndex;

  for (const line of backgroundActiveLines) {
    const backgroundStillActive =
      playbackPosition >= line.lineEndTime &&
      playbackPosition < line.backgroundEndTime;
    if (!backgroundStillActive) {
      continue;
    }
    ({ startIndex: visualStart, endIndex: visualEnd } = extendLineIndexRange(
      visualStart,
      visualEnd,
      line.index,
    ));
  }

  return {
    ...state,
    visualActiveLineStartIndex: visualStart,
    visualActiveLineEndIndex: visualEnd,
  };
}

function getPlaybackWindowState(
  playbackPosition: number,
  lyrics: LyricLineType[],
  backgroundActiveLines: BackgroundActiveLine[] = getBackgroundActiveLines(lyrics),
  timingIndex: LyricTimingIndex = getLyricTimingIndex(lyrics),
  interludeContext: InterludePlaybackContext | null = null,
  timelinePlaybackState: TimelinePlaybackState | null = null,
): PlaybackWindowState {
  if (!lyrics.length) {
    return EMPTY_WINDOW_STATE;
  }

  const finalize = (state: PlaybackWindowStateWithoutComputedRanges) =>
    addVisualActiveRange(state, playbackPosition, backgroundActiveLines);
  const resolvedTimelineState =
    timelinePlaybackState ??
    rebuildTimelinePlaybackState(playbackPosition, lyrics, timingIndex);
  const highlightedLineIndices =
    resolvedTimelineState.highlightedLineIndices.size > 0
      ? new Set(resolvedTimelineState.highlightedLineIndices)
      : EMPTY_WINDOW_STATE.highlightedLineIndices;
  const highlightedRange = getHighlightedLineRange(highlightedLineIndices);
  const interlude = getInterludeCandidate(
    playbackPosition,
    lyrics,
    timingIndex,
  );

  if (interlude) {
    const resolvedContext = interludeContextMatches(interludeContext, interlude)
      ? interludeContext!
      : createInterludePlaybackContext(interlude, playbackPosition, true);
    const remainingMs = Math.max(0, interlude.endTime - resolvedContext.anchorMs);
    const bodyMs =
      remainingMs - resolvedContext.holdMs - AMLL_INTERLUDE_EXIT_TOTAL_MS;
    const canDisplayInterlude = bodyMs >= AMLL_INTERLUDE_DOT_ENTER_TOTAL_MS;
    const elapsedMs = Math.max(0, playbackPosition - resolvedContext.anchorMs);
    const pauseProgress =
      canDisplayInterlude && remainingMs > 0
        ? clamp01(elapsedMs / remainingMs)
        : 0;

    return finalize({
      activeLineStartIndex: -1,
      activeLineEndIndex: -1,
      highlightedLineIndices: EMPTY_WINDOW_STATE.highlightedLineIndices,
      focusLineIndex: canDisplayInterlude
        ? interlude.anchorLineIndex >= 0
          ? interlude.anchorLineIndex
          : interlude.nextLineIndex
        : interlude.nextLineIndex,
      pauseAfterIndex:
        canDisplayInterlude && interlude.anchorLineIndex >= 0
          ? interlude.anchorLineIndex
          : -1,
      pauseBeforeIndex:
        canDisplayInterlude && interlude.anchorLineIndex < 0
          ? interlude.nextLineIndex
          : -1,
      isLongPause: canDisplayInterlude,
      pauseProgress,
      pauseStartMs: resolvedContext.anchorMs,
      pauseVisualDurationMs: remainingMs,
      pauseHoldMs: resolvedContext.holdMs,
    });
  }

  if (highlightedRange.startIndex >= 0) {
    return finalize({
      activeLineStartIndex: highlightedRange.startIndex,
      activeLineEndIndex: highlightedRange.endIndex,
      highlightedLineIndices,
      focusLineIndex: highlightedRange.startIndex,
      pauseAfterIndex: -1,
      pauseBeforeIndex: -1,
      isLongPause: false,
      pauseProgress: 0,
      pauseStartMs: 0,
      pauseVisualDurationMs: 0,
      pauseHoldMs: 0,
    });
  }

  return finalize({
    activeLineStartIndex: -1,
    activeLineEndIndex: -1,
    highlightedLineIndices: EMPTY_WINDOW_STATE.highlightedLineIndices,
    focusLineIndex: Math.max(
      0,
      Math.min(resolvedTimelineState.scrollToIndex, lyrics.length - 1),
    ),
    pauseAfterIndex: -1,
    pauseBeforeIndex: -1,
    isLongPause: false,
    pauseProgress: 0,
    pauseStartMs: 0,
    pauseVisualDurationMs: 0,
    pauseHoldMs: 0,
  });
}

type LyricsViewProps = {
  tapToSeekEnabled: boolean;
  showTranslatedText?: boolean;
  previewPositionMs?: number | null;
  autoFollowEnabled?: boolean;
  resumeAutoFollowSignal?: number;
  selectedLineKeys?: Set<string>;
  onLinePress?: (line: LyricLineType) => void;
  onLineLongPress?: (line: LyricLineType) => void;
  onCreditsTimestampPress?: (positionMs: number) => void;
  onActiveLineChange?: (lineIndex: number) => void;
  onAutoFollowChange?: (enabled: boolean) => void;
  onUserInteraction?: () => void;
  suppressInitialAutoScrollAnimation?: boolean;
  layoutSettleSignal?: number;
  suspendViewportScrollAdjustments?: boolean;
  onInitialAutoScrollSettled?: () => void;
  fontScale?: number;
  landscapeMode?: boolean;
};

type ScrollAnimationStyle = "native" | "lyric";

const CreditsProfileLine = memo(function CreditsProfileLine({
  label,
  profile,
  active,
  alignRight,
}: {
  label: string;
  profile: LyricsAttributionProfile;
  active: boolean;
  alignRight: boolean;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  return (
    <View
      style={[
        styles.creditsProfileRow,
        alignRight && styles.creditsProfileRowOpposite,
      ]}
    >
      <Text
        style={[
          styles.creditsText,
          alignRight && styles.creditsTextOpposite,
          active && styles.creditsTextActive,
        ]}
      >
        <Text style={styles.creditsTextStrong}>{label}</Text>@
        {profile.username}
      </Text>
      {profile.avatar && !avatarFailed ? (
        <Image
          source={{ uri: profile.avatar }}
          style={styles.creditsProfileAvatar}
          accessibilityLabel={`${profile.username || "Community member"}'s avatar`}
          onError={() => setAvatarFailed(true)}
        />
      ) : null}
    </View>
  );
});

const CreditsFooter = memo(function CreditsFooter({
  songwriters,
  attribution,
  lastLyricEndTime,
  onPress,
  style,
  alignRight = false,
}: {
  songwriters: string[];
  attribution?: LyricsAttributionMetadata;
  lastLyricEndTime: number;
  onPress?: (positionMs: number) => void;
  style?: StyleProp<ViewStyle>;
  alignRight?: boolean;
}) {
  const isActive = usePlaybackStore(
    useCallback(
      (state) =>
        lastLyricEndTime > 0 && state.playbackPosition >= lastLyricEndTime,
      [lastLyricEndTime],
    ),
  );
  const activeProgress = useSharedValue(isActive ? 1 : 0);

  useEffect(() => {
    activeProgress.value = withTiming(isActive ? 1 : 0, {
      duration: 260,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [activeProgress, isActive]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.52 + activeProgress.value * 0.48,
    transform: [{ scale: 0.98 + activeProgress.value * 0.04 }],
  }));

  return (
    <Animated.View style={[styles.creditsFooterMotion, animatedStyle]}>
      <Pressable
        style={[styles.creditsFooter, style]}
        onPress={() => onPress?.(lastLyricEndTime)}
      >
        {songwriters.length ? (
          <Text
            style={[
              styles.creditsText,
              alignRight && styles.creditsTextOpposite,
              isActive && styles.creditsTextActive,
            ]}
          >
            <Text style={styles.creditsTextStrong}>Written By: </Text>
            {songwriters.join(", ")}
          </Text>
        ) : null}
        {attribution ? (
          <Text
            style={[
              styles.creditsText,
              alignRight && styles.creditsTextOpposite,
              isActive && styles.creditsTextActive,
            ]}
          >
            <Text style={styles.creditsTextStrong}>Provided By: </Text>
            {attribution.provider}
          </Text>
        ) : null}
        {attribution?.community ? (
          <Text
            style={[
              styles.creditsText,
              alignRight && styles.creditsTextOpposite,
              isActive && styles.creditsTextActive,
            ]}
          >
            These lyrics have been provided by the Spicy Lyrics community
          </Text>
        ) : null}
        {attribution?.maker?.username ? (
          <CreditsProfileLine
            label="Made By: "
            profile={attribution.maker}
            active={isActive}
            alignRight={alignRight}
          />
        ) : null}
        {attribution?.uploader?.username ? (
          <CreditsProfileLine
            label={attribution.maker?.username ? "Uploaded By: " : "Made By: "}
            profile={attribution.uploader}
            active={isActive}
            alignRight={alignRight}
          />
        ) : null}
      </Pressable>
    </Animated.View>
  );
});

type CreditsLayout = {
  top: number;
  bottom: number;
};

function getCreditsAwareScrollOffset({
  range,
  lyricsLength,
  listHeight,
  creditsLayout,
  getAbsoluteLineTop,
  creditsActive,
  hasCredits,
  activeLineTopOffset = ACTIVE_LINE_TOP_OFFSET,
}: {
  range: LyricLineRange;
  lyricsLength: number;
  listHeight: number;
  creditsLayout: CreditsLayout | null;
  getAbsoluteLineTop: (index: number) => number | null;
  creditsActive: boolean;
  hasCredits: boolean;
  activeLineTopOffset?: number;
}) {
  const startIndex = Math.max(0, Math.min(range.startIndex, lyricsLength - 1));
  const top = getAbsoluteLineTop(startIndex);
  if (top === null) {
    return null;
  }
  const safeTopOffset = Math.min(activeLineTopOffset, Math.max(0, listHeight));
  const normalOffset = Math.max(0, top - safeTopOffset);
  const isLastLineRange =
    range.endIndex >= lyricsLength - 1 && range.startIndex >= lyricsLength - 1;
  if (
    !creditsActive ||
    !hasCredits ||
    !isLastLineRange ||
    !creditsLayout ||
    listHeight <= 0
  ) {
    return normalOffset;
  }

  const lastLineIndex = lyricsLength - 1;
  const lastLineTop = getAbsoluteLineTop(lastLineIndex);
  if (lastLineTop === null) {
    return normalOffset;
  }

  const blockHeight = creditsLayout.bottom - lastLineTop;
  const availableHeight =
    listHeight - activeLineTopOffset - ACTIVE_RANGE_BOTTOM_PADDING;
  if (blockHeight <= availableHeight) {
    return normalOffset;
  }

  return Math.max(
    0,
    creditsLayout.bottom - listHeight + ACTIVE_RANGE_BOTTOM_PADDING,
  );
}

function getMaxScrollTarget({
  lyricsLength,
  listHeight,
  lastLineTop,
  creditsLayout,
  hasCredits,
  activeLineTopOffset = ACTIVE_LINE_TOP_OFFSET,
}: {
  lyricsLength: number;
  listHeight: number;
  lastLineTop: number;
  creditsLayout: CreditsLayout | null;
  hasCredits: boolean;
  activeLineTopOffset?: number;
}) {
  let maxScrollTarget = Math.max(0, lastLineTop - activeLineTopOffset);
  if (!hasCredits || !creditsLayout || listHeight <= 0 || lyricsLength <= 0) {
    return maxScrollTarget;
  }

  const blockHeight = creditsLayout.bottom - lastLineTop;
  const availableHeight =
    listHeight - activeLineTopOffset - ACTIVE_RANGE_BOTTOM_PADDING;
  if (blockHeight > availableHeight) {
    maxScrollTarget = Math.max(
      maxScrollTarget,
      creditsLayout.bottom - listHeight + ACTIVE_RANGE_BOTTOM_PADDING,
    );
  }

  return maxScrollTarget;
}

function getBottomListPadding({
  viewportHeight,
  lyricsLength,
  lastLineTop,
  lastLineHeight,
  creditsLayout,
  hasCredits,
  activeLineTopOffset = ACTIVE_LINE_TOP_OFFSET,
}: {
  viewportHeight: number;
  lyricsLength: number;
  lastLineTop: number | null;
  lastLineHeight: number;
  creditsLayout: CreditsLayout | null;
  hasCredits: boolean;
  activeLineTopOffset?: number;
}) {
  if (viewportHeight <= 0 || lyricsLength <= 0 || lastLineTop === null) {
    return Math.max(BOTTOM_LIST_PADDING, viewportHeight);
  }

  const contentBottom =
    creditsLayout?.bottom ?? lastLineTop + lastLineHeight;
  const maxScrollTarget = getMaxScrollTarget({
    lyricsLength,
    listHeight: viewportHeight,
    lastLineTop,
    creditsLayout,
    hasCredits,
    activeLineTopOffset,
  });

  return Math.max(0, maxScrollTarget + viewportHeight - contentBottom);
}

function getFocusIndexAtPosition(positionMs: number, lyrics: LyricLineType[]) {
  const active = findActiveLineIndex(positionMs, lyrics);
  if (active >= 0) {
    return active;
  }
  const previous = findLastEndedLineIndex(positionMs, lyrics);
  if (previous >= 0) {
    return previous;
  }
  return findFirstUpcomingLineIndex(positionMs, lyrics);
}

function getAutoScrollTargetRange(
  windowState: PlaybackWindowState,
  lyrics: LyricLineType[],
): LyricLineRange | null {
  if (!lyrics.length) {
    return null;
  }

  const clampIndex = (index: number) =>
    Math.max(0, Math.min(index, lyrics.length - 1));

  if (windowState.isLongPause) {
    const startIndex = clampIndex(
      windowState.pauseAfterIndex >= 0
        ? windowState.pauseAfterIndex
        : windowState.pauseBeforeIndex >= 1
          ? windowState.pauseBeforeIndex - 1
          : 0,
    );
    const endIndex =
      windowState.pauseBeforeIndex >= 0
        ? clampIndex(windowState.pauseBeforeIndex + 1)
        : startIndex;
    return { startIndex, endIndex };
  }

  const visualStart = windowState.visualActiveLineStartIndex;
  const visualEnd = windowState.visualActiveLineEndIndex;
  const activeStart = windowState.activeLineStartIndex;
  const activeEnd = windowState.activeLineEndIndex;

  // Overlap / multi-line: anchor on the earliest active line and keep the full range visible.
  if (visualStart >= 0 && visualEnd > visualStart) {
    return {
      startIndex: clampIndex(visualStart),
      endIndex: clampIndex(visualEnd),
    };
  }
  if (activeStart >= 0 && activeEnd > activeStart) {
    return {
      startIndex: clampIndex(activeStart),
      endIndex: clampIndex(activeEnd),
    };
  }

  // A highlighted line remains the scroll anchor through a short gap. AMLL only
  // advances scrollToIndex when a new lyric actually enters playback.
  if (activeStart >= 0 && activeEnd === activeStart) {
    const safeIndex = clampIndex(activeStart);
    return { startIndex: safeIndex, endIndex: safeIndex };
  }

  const focusIndex = windowState.focusLineIndex;
  if (focusIndex >= 0 && focusIndex < lyrics.length) {
    return { startIndex: focusIndex, endIndex: focusIndex };
  }

  if (visualStart >= 0 && visualStart < lyrics.length) {
    const safeVisualEnd =
      visualEnd >= visualStart
        ? Math.min(visualEnd, lyrics.length - 1)
        : visualStart;
    return { startIndex: visualStart, endIndex: safeVisualEnd };
  }

  return null;
}

function areLyricLineRangesEqual(
  a: LyricLineRange | null,
  b: LyricLineRange | null,
) {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

function isIndexWithinUpdateWindow(
  index: number,
  windowState: PlaybackWindowState,
) {
  const visualStart =
    windowState.visualActiveLineStartIndex >= 0
      ? windowState.visualActiveLineStartIndex
      : windowState.focusLineIndex;
  const visualEnd =
    windowState.visualActiveLineEndIndex >= 0
      ? windowState.visualActiveLineEndIndex
      : visualStart;

  if (visualStart >= 0) {
    return (
      index >= visualStart - LYRICS_JS_UPDATE_RADIUS &&
      index <= visualEnd + LYRICS_JS_UPDATE_RADIUS
    );
  }

  if (windowState.pauseAfterIndex >= 0 || windowState.pauseBeforeIndex >= 0) {
    const pauseStart =
      windowState.pauseAfterIndex >= 0
        ? windowState.pauseAfterIndex
        : windowState.pauseBeforeIndex;
    const pauseEnd =
      windowState.pauseBeforeIndex >= 0
        ? windowState.pauseBeforeIndex
        : pauseStart;
    return (
      index >= pauseStart - LYRICS_JS_UPDATE_RADIUS &&
      index <= pauseEnd + LYRICS_JS_UPDATE_RADIUS
    );
  }

  return false;
}

function usePlaybackWindowState(
  lyrics: LyricLineType[],
  backgroundActiveLines: BackgroundActiveLine[],
  timingIndex: LyricTimingIndex,
) {
  const interludeContextRef = useRef<InterludePlaybackContext | null>(null);
  const timelinePlaybackStateRef = useRef<TimelinePlaybackState | null>(null);
  const seekContinuityRef = useRef({
    mediaTime: 0,
    wallTime: 0,
    hasBaseline: false,
  });
  const [committedSeekSerial, setCommittedSeekSerial] = useState(0);
  const [windowState, setWindowState] = useState(() => {
    const initialPosition = usePlaybackStore.getState().playbackPosition;
    const initialTimelineState = rebuildTimelinePlaybackState(
      initialPosition,
      lyrics,
      timingIndex,
    );
    timelinePlaybackStateRef.current = initialTimelineState;
    return getPlaybackWindowState(
      initialPosition,
      lyrics,
      backgroundActiveLines,
      timingIndex,
      null,
      initialTimelineState,
    );
  });

  useEffect(() => {
    const currentPlayback = usePlaybackStore.getState();
    const currentPosition = currentPlayback.playbackPosition;
    timelinePlaybackStateRef.current = rebuildTimelinePlaybackState(
      currentPosition,
      lyrics,
      timingIndex,
    );
    const initialInterlude = getInterludeCandidate(
      currentPosition,
      lyrics,
      timingIndex,
    );
    interludeContextRef.current = initialInterlude
      ? createInterludePlaybackContext(
          initialInterlude,
          currentPosition,
          currentPosition > initialInterlude.startTime,
        )
      : null;
    seekContinuityRef.current = {
      mediaTime: currentPosition,
      wallTime: getMonotonicNow(),
      hasBaseline: true,
    };

    const computeWindowState = () =>
      getPlaybackWindowState(
        usePlaybackStore.getState().playbackPosition,
        lyrics,
        backgroundActiveLines,
        timingIndex,
        interludeContextRef.current,
        timelinePlaybackStateRef.current,
      );

    setWindowState((prev) => {
      const next = computeWindowState();
      return arePlaybackWindowStatesEqual(prev, next) ? prev : next;
    });

    return usePlaybackStore.subscribe((state) => {
      const playbackPosition = state.playbackPosition;
      const continuity = seekContinuityRef.current;
      const now = getMonotonicNow();
      if (playbackPosition === continuity.mediaTime) {
        continuity.wallTime = now;
        return;
      }

      let isSeek = false;
      if (continuity.hasBaseline) {
        if (playbackPosition < continuity.mediaTime) {
          isSeek = true;
        } else {
          const mediaDelta = playbackPosition - continuity.mediaTime;
          const elapsed = Math.max(0, now - continuity.wallTime);
          const wallDelta = Math.min(elapsed, AMLL_SEEK_MAX_TRUSTED_GAP_MS);
          const expected = state.isPlaying ? wallDelta : 0;
          const tolerance = state.isPlaying
            ? Math.max(
                AMLL_SEEK_JITTER_TOLERANCE_MS,
                wallDelta * AMLL_SEEK_DRIFT_SLACK,
              )
            : AMLL_SEEK_JITTER_TOLERANCE_MS;
          isSeek = mediaDelta - expected > tolerance;
        }
      }
      continuity.mediaTime = playbackPosition;
      continuity.wallTime = now;
      continuity.hasBaseline = true;

      if (isSeek) {
        setCommittedSeekSerial((serial) => serial + 1);
      }

      if (isSeek || timelinePlaybackStateRef.current === null) {
        timelinePlaybackStateRef.current = rebuildTimelinePlaybackState(
          playbackPosition,
          lyrics,
          timingIndex,
        );
      } else {
        advanceTimelinePlaybackState(
          timelinePlaybackStateRef.current,
          playbackPosition,
          lyrics,
          timingIndex,
        );
      }

      const interlude = getInterludeCandidate(
        playbackPosition,
        lyrics,
        timingIndex,
      );
      if (!interlude) {
        interludeContextRef.current = null;
      } else if (
        isSeek ||
        !interludeContextMatches(interludeContextRef.current, interlude)
      ) {
        interludeContextRef.current = createInterludePlaybackContext(
          interlude,
          playbackPosition,
          isSeek,
        );
      }

      const next = getPlaybackWindowState(
        playbackPosition,
        lyrics,
        backgroundActiveLines,
        timingIndex,
        interludeContextRef.current,
        timelinePlaybackStateRef.current,
      );
      setWindowState((prev) =>
        arePlaybackWindowStatesEqual(prev, next) ? prev : next,
      );
    });
  }, [backgroundActiveLines, lyrics, timingIndex]);

  if (lyrics.length === 0) {
    return { windowState: EMPTY_WINDOW_STATE, committedSeekSerial };
  }

  return { windowState, committedSeekSerial };
}

export function LyricsView({
  tapToSeekEnabled,
  showTranslatedText = true,
  previewPositionMs = null,
  autoFollowEnabled = true,
  resumeAutoFollowSignal = 0,
  selectedLineKeys,
  onLinePress,
  onLineLongPress,
  onCreditsTimestampPress,
  onActiveLineChange,
  onAutoFollowChange,
  onUserInteraction,
  suppressInitialAutoScrollAnimation = false,
  layoutSettleSignal = 0,
  suspendViewportScrollAdjustments = false,
  onInitialAutoScrollSettled,
  fontScale = 1,
  landscapeMode = false,
}: LyricsViewProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isNarrowViewport = windowWidth <= 1024;
  const [viewportHeight, setViewportHeight] = useState(0);
  const amllResponsiveBaseFontSize =
    windowWidth <= 768
      ? Math.max(windowWidth * 0.08, 12)
      : Math.max(windowHeight * 0.05, windowWidth * 0.025, 12);
  const activeLineTopOffset = Math.max(
    0,
    viewportHeight * AMLL_ALIGN_POSITION -
      (amllResponsiveBaseFontSize * 1.2 * fontScale) / 2,
  );
  const topListPadding = activeLineTopOffset;
  const lyrics = usePlaybackStore((s) => s.lyrics);
  const lyricsSource = usePlaybackStore((s) => s.lyricsSource);
  const lyricsStatusMessage = usePlaybackStore((s) => s.lyricsStatusMessage);
  const lyricsMetadata = usePlaybackStore((s) => s.lyricsMetadata);
  const hasDuetLines = useMemo(
    () => lyrics.some((line) => Boolean(line.oppositeAligned)),
    [lyrics],
  );
  const lyricsTimingMode = useMemo(
    () => detectLyricsTimingMode(lyrics, lyricsSource),
    [lyrics, lyricsSource],
  );
  const insets = useSafeAreaInsets();
  const centeredNoticeUpwardOffset = useMemo(
    () =>
      landscapeMode
        ? getLandscapeLyricsCenterUpwardOffset(insets.top)
        : getLyricsViewportCenterUpwardOffset(insets.top),
    [insets.top, landscapeMode],
  );
  const [showEmptyDebug, setShowEmptyDebug] = useState(false);
  const backgroundActiveLines = useMemo(
    () => getBackgroundActiveLines(lyrics),
    [lyrics],
  );
  const lyricTimingIndex = useMemo(() => getLyricTimingIndex(lyrics), [lyrics]);
  const {
    windowState: liveWindowState,
    committedSeekSerial,
  } = usePlaybackWindowState(
    lyrics,
    backgroundActiveLines,
    lyricTimingIndex,
  );
  const [listReady, setListReady] = useState(false);
  const listRef = useAnimatedRef<FlashListRef<LyricLineType>>();
  const lyricScrollOffset = useSharedValue(0);
  const lyricScrollActive = useSharedValue(false);
  const lyricRowMotionEnabled = useSharedValue(false);
  const rowMotionSerialRef = useRef(0);
  const lastRowMotionFocusKeyRef = useRef("");
  const pendingRebuildFlyInRef = useRef(true);
  const [rowMotionTransition, setRowMotionTransition] =
    useState<LyricRowMotionTransition>(() => ({
      serial: 0,
      kind: "idle",
      startOffset: 0,
      targetOffset: 0,
      springPolicy: AMLL_DEFAULT_POS_Y_SPRING,
      delayByIndex: EMPTY_ROW_DELAYS,
      rebuildStartCorrectionByIndex: EMPTY_REBUILD_CORRECTIONS,
    }));
  useEffect(() => {
    lyricRowMotionEnabled.value = rowMotionTransition.kind !== "idle";
  }, [
    lyricRowMotionEnabled,
    rowMotionTransition.kind,
    rowMotionTransition.serial,
  ]);
  const activeLineRef = useRef(-1);
  const onAutoFollowChangeRef = useRef(onAutoFollowChange);
  const listHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  const rowHeightsRef = useRef(new Map<number, number>());
  const rowOffsetsRef = useRef(new Map<number, number>());
  const pendingScrollFrameRef = useRef<number | null>(null);
  const programmaticScrollTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const userScrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const scrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const programmaticScrollInProgressRef = useRef(false);
  const userScrollInProgressRef = useRef(false);
  const userScrollSessionRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const autoFollowDisableGraceUntilRef = useRef(
    Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS,
  );
  const lastScrollRequestRef = useRef("");
  const lastResumeAutoFollowSignalRef = useRef(0);
  const consumedCommittedSeekSerialRef = useRef(0);
  const pendingAnchorRangeRef = useRef<LyricLineRange | null>(null);
  const pendingAnchorAnimatedRef = useRef(true);
  const sourceAutoScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingAnchorRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingAnchorRetryCountRef = useRef(0);
  const hasMountedLyricsChangeEffectRef = useRef(false);
  const lastLyricsSourceRef = useRef<string | null>(null);
  const initialAutoScrollPendingRef = useRef(suppressInitialAutoScrollAnimation);
  const initialAutoScrollSettledRef = useRef(false);
  const lastLayoutSettleSignalRef = useRef(layoutSettleSignal);
  const [isUserTouchScrolling, setIsUserTouchScrolling] = useState(false);
  const [isSourceAutoScrollCooldown, setIsSourceAutoScrollCooldown] =
    useState(false);
  const [contentLayoutVersion, setContentLayoutVersion] = useState(0);
  // ponytail: batch cell layout bumps — fast scroll fires onLayout per cell,
  // debounce so we only re-render once per frame instead of per-cell
  const layoutBumpPendingRef = useRef(false);
  const layoutBumpFrameRef = useRef<number | null>(null);
  const bumpContentLayoutVersion = useCallback(() => {
    if (layoutBumpPendingRef.current) return;
    layoutBumpPendingRef.current = true;
    if (layoutBumpFrameRef.current !== null) return;
    layoutBumpFrameRef.current = requestAnimationFrame(() => {
      layoutBumpFrameRef.current = null;
      layoutBumpPendingRef.current = false;
      setContentLayoutVersion((v) => v + 1);
    });
  }, []);
  const creditsLayoutRef = useRef<CreditsLayout | null>(null);

  const autoFollowActive = autoFollowEnabled && !isSourceAutoScrollCooldown;

  const markInitialAutoScrollSettled = useCallback(() => {
    if (initialAutoScrollSettledRef.current) {
      return;
    }
    initialAutoScrollSettledRef.current = true;
    initialAutoScrollPendingRef.current = false;
    onInitialAutoScrollSettled?.();
  }, [onInitialAutoScrollSettled]);

  useDerivedValue(() => {
    if (lyricScrollActive.value) {
      scrollTo(listRef, 0, Math.max(0, lyricScrollOffset.value), false);
    }
  });

  const syncScrollOffsetFromAnimation = useCallback((offset: number) => {
    scrollOffsetRef.current = Math.max(0, offset);
  }, []);

  useAnimatedReaction(
    () => ({
      offset: lyricScrollOffset.value,
      active: lyricScrollActive.value,
    }),
    (current, previous) => {
      if (!current.active) {
        return;
      }
      if (
        previous === null ||
        Math.abs(current.offset - previous.offset) >= 0.5
      ) {
        runOnJS(syncScrollOffsetFromAnimation)(current.offset);
      }
    },
    [syncScrollOffsetFromAnimation],
  );

  const previewPlaybackPosition =
    Number.isFinite(previewPositionMs) && previewPositionMs !== null
      ? previewPositionMs
      : null;
  const previewFocusIndex = useMemo(
    () =>
      previewPlaybackPosition !== null
        ? getFocusIndexAtPosition(previewPlaybackPosition, lyrics)
        : -1,
    [lyrics, previewPlaybackPosition],
  );
  const displayPlaybackPosition =
    previewPlaybackPosition !== null ? previewPlaybackPosition : null;
  const displayWindowState = useMemo(
    () =>
      displayPlaybackPosition !== null
        ? getPlaybackWindowState(
            displayPlaybackPosition,
            lyrics,
            backgroundActiveLines,
            lyricTimingIndex,
          )
        : liveWindowState,
    [
      backgroundActiveLines,
      displayPlaybackPosition,
      liveWindowState,
      lyrics,
      lyricTimingIndex,
    ],
  );
  const effectiveWindowState = displayWindowState;
  // ponytail: coarse fingerprint for extraData — only changes when cell rendering
  // actually differs (index boundaries + pause on/off), NOT on every pauseProgress tick
  const extraDataFingerprint = useMemo(
    () => {
      const highlightedFingerprint = Array.from(
        effectiveWindowState.highlightedLineIndices,
      )
        .sort((a, b) => a - b)
        .join(",");
      return `${effectiveWindowState.activeLineStartIndex}:${effectiveWindowState.activeLineEndIndex}:${highlightedFingerprint}:${effectiveWindowState.visualActiveLineStartIndex}:${effectiveWindowState.visualActiveLineEndIndex}:${effectiveWindowState.focusLineIndex}:${effectiveWindowState.pauseAfterIndex}:${effectiveWindowState.pauseBeforeIndex}:${effectiveWindowState.isLongPause ? 1 : 0}:${effectiveWindowState.pauseStartMs}:${effectiveWindowState.pauseVisualDurationMs}:${effectiveWindowState.pauseHoldMs}:${isUserTouchScrolling ? 1 : 0}:${isNarrowViewport ? 1 : 0}`;
    },
    [
      effectiveWindowState.activeLineStartIndex,
      effectiveWindowState.activeLineEndIndex,
      effectiveWindowState.highlightedLineIndices,
      effectiveWindowState.visualActiveLineStartIndex,
      effectiveWindowState.visualActiveLineEndIndex,
      effectiveWindowState.focusLineIndex,
      effectiveWindowState.pauseAfterIndex,
      effectiveWindowState.pauseBeforeIndex,
      effectiveWindowState.isLongPause,
      effectiveWindowState.pauseStartMs,
      effectiveWindowState.pauseVisualDurationMs,
      effectiveWindowState.pauseHoldMs,
      isNarrowViewport,
      isUserTouchScrolling,
    ],
  );
  const activeLineIndex = effectiveWindowState.activeLineStartIndex;
  const songwriters = useMemo(
    () => lyricsMetadata.credits?.songwriters || [],
    [lyricsMetadata.credits?.songwriters],
  );
  const attribution = lyricsMetadata.attribution;
  const hasCredits = songwriters.length > 0 || Boolean(attribution);
  const instrumental = Boolean(lyricsMetadata.instrumental);
  const lastLyricEndTime = lyrics.length
    ? Number(lyrics[lyrics.length - 1]?.lineEndTime || 0)
    : 0;
  const playbackPositionRef = useRef(
    usePlaybackStore.getState().playbackPosition,
  );
  const [scrollPlannerTick, bumpScrollPlanner] = useReducer(
    (tick: number) => tick + 1,
    0,
  );
  const effectiveWindowStateRef = useRef(effectiveWindowState);
  effectiveWindowStateRef.current = effectiveWindowState;
  const scrollTargetRangeRef = useRef<LyricLineRange | null>(null);
  const scheduleScrollToRangeRef = useRef<typeof scheduleScrollToRange>(null as any);
  // ponytail: subscribe instead of reactive selector — avoids LyricsView re-render on every 64ms tick
  const [liveCreditsActive, setLiveCreditsActive] = useState(
    () => lastLyricEndTime > 0 && usePlaybackStore.getState().playbackPosition >= lastLyricEndTime,
  );
  useEffect(() => {
    const check = (pos: number) => lastLyricEndTime > 0 && pos >= lastLyricEndTime;
    setLiveCreditsActive(check(usePlaybackStore.getState().playbackPosition));
    let prev = liveCreditsActive;
    return usePlaybackStore.subscribe((state) => {
      const next = check(state.playbackPosition);
      if (next !== prev) {
        prev = next;
        setLiveCreditsActive(next);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLyricEndTime]);
  const creditsActive =
    previewPlaybackPosition !== null
      ? lastLyricEndTime > 0 && previewPlaybackPosition >= lastLyricEndTime
      : liveCreditsActive;
  const scrollTargetRange = useMemo(() => {
    void scrollPlannerTick;
    if (!lyrics.length) {
      return null;
    }

    // Preview scrubbing: follow a single focused line for precision.
    if (previewPlaybackPosition !== null) {
      const focusIndex =
        previewFocusIndex >= 0 ? previewFocusIndex : effectiveWindowState.focusLineIndex;
      if (focusIndex >= 0) {
        return { startIndex: focusIndex, endIndex: focusIndex };
      }
      return null;
    }

    return getAutoScrollTargetRange(effectiveWindowState, lyrics);
  }, [
    effectiveWindowState,
    lyrics,
    previewFocusIndex,
    previewPlaybackPosition,
    scrollPlannerTick,
  ]);
  scrollTargetRangeRef.current = scrollTargetRange;
  useEffect(() => {
    let previousPosition = usePlaybackStore.getState().playbackPosition;
    playbackPositionRef.current = previousPosition;
    return usePlaybackStore.subscribe((state) => {
      const playbackPosition = state.playbackPosition;
      if (playbackPosition === previousPosition) {
        return;
      }
      playbackPositionRef.current = playbackPosition;
      if (previewPlaybackPosition !== null) {
        previousPosition = playbackPosition;
        return;
      }
      const prevRange = getAutoScrollTargetRange(
        effectiveWindowStateRef.current,
        lyrics,
      );
      const nextRange = getAutoScrollTargetRange(
        effectiveWindowStateRef.current,
        lyrics,
      );
      previousPosition = playbackPosition;
      if (!areLyricLineRangesEqual(prevRange, nextRange)) {
        bumpScrollPlanner();
      }
    });
  }, [lyrics, previewPlaybackPosition]);
  useEffect(() => {
    onAutoFollowChangeRef.current = onAutoFollowChange;
  }, [onAutoFollowChange]);

  useEffect(() => {
    if (
      layoutSettleSignal <= 0 ||
      layoutSettleSignal === lastLayoutSettleSignalRef.current
    ) {
      return;
    }
    lastLayoutSettleSignalRef.current = layoutSettleSignal;
    initialAutoScrollPendingRef.current = true;
    initialAutoScrollSettledRef.current = false;
    lastScrollRequestRef.current = "";
    pendingAnchorRangeRef.current = null;
  }, [layoutSettleSignal]);

  useEffect(() => {
    if (!autoFollowEnabled) {
      return;
    }
    userScrollInProgressRef.current = false;
    userScrollSessionRef.current = false;
    setIsUserTouchScrolling(false);
    lastScrollRequestRef.current = "";
  }, [autoFollowEnabled]);

  const getAbsoluteLineTop = useCallback(
    (index: number) => {
      const safeIndex = Math.max(0, Math.min(index, lyrics.length - 1));
      if (listReady && listRef.current) {
        const layout = listRef.current.getLayout(safeIndex);
        if (layout && Number.isFinite(layout.y)) {
          const leadingInset = getFlashListLeadingInset(listRef.current);
          const absoluteTop = normalizeFlashListItemTop(
            listRef.current,
            layout.y,
            leadingInset,
          );
          rowOffsetsRef.current.set(safeIndex, absoluteTop);
          return absoluteTop;
        }
      }
      const measuredTop = rowOffsetsRef.current.get(safeIndex);
      return measuredTop ?? null;
    },
    [listReady, lyrics.length],
  );

  const getLineHeight = useCallback(
    (index: number) => {
      const safeIndex = Math.max(0, Math.min(index, lyrics.length - 1));
      if (listReady) {
        const layout = listRef.current?.getLayout(safeIndex);
        if (layout && Number.isFinite(layout.height) && layout.height > 0) {
          rowHeightsRef.current.set(safeIndex, layout.height);
          return layout.height;
        }
      }
      return rowHeightsRef.current.get(safeIndex);
    },
    [listReady, lyrics.length],
  );

  const buildRowMotionTransition = useCallback(
    ({
      kind,
      startOffset,
      targetOffset,
      scrollToIndex,
      springPolicy,
      disableStagger,
    }: {
      kind: "scroll" | "rebuild";
      startOffset: number;
      targetOffset: number;
      scrollToIndex: number;
      springPolicy: AmlPosYSpringPolicy;
      disableStagger: boolean;
    }): LyricRowMotionTransition => {
      const delayByIndex = new Map<number, number>();
      const rebuildStartCorrectionByIndex = new Map<number, number>();
      let delayMs = 0;
      let baseDelayMs = disableStagger ? 0 : AMLL_PLAYBACK_STAGGER_MS;
      const targetViewportHeight = listHeightRef.current;

      for (let index = 0; index < lyrics.length; index += 1) {
        delayByIndex.set(index, disableStagger ? 0 : delayMs);

        const absoluteTop = getAbsoluteLineTop(index);
        const height = getLineHeight(index);
        if (
          kind === "rebuild" &&
          targetViewportHeight > 0 &&
          absoluteTop !== null &&
          height !== undefined
        ) {
          const viewportTop = absoluteTop - targetOffset;
          const viewportBottom = viewportTop + height;
          if (viewportBottom >= 0 && viewportTop <= targetViewportHeight) {
            // AMLL's DOM LyricGroup constructor starts every group at
            // window.innerHeight * 2. Only arm rows that are already in the
            // target viewport so a later FlashList mount cannot replay it.
            rebuildStartCorrectionByIndex.set(
              index,
              targetViewportHeight * 2 - viewportTop,
            );
          }
        }

        if (
          !disableStagger &&
          absoluteTop !== null &&
          height !== undefined &&
          absoluteTop - targetOffset + height >= 0
        ) {
          // AMLL increments the delay only after laying out rows that reach or
          // sit below the viewport's top edge. Once at/after scrollToIndex the
          // 50ms base delay decays by 1.05 for each following row.
          delayMs += baseDelayMs;
          if (index >= scrollToIndex) {
            baseDelayMs /= AMLL_PLAYBACK_STAGGER_DECAY;
          }
        }
      }

      rowMotionSerialRef.current += 1;
      return {
        serial: rowMotionSerialRef.current,
        kind,
        startOffset,
        targetOffset,
        springPolicy,
        delayByIndex,
        rebuildStartCorrectionByIndex,
      };
    },
    [getAbsoluteLineTop, getLineHeight, lyrics.length],
  );

  const getLineViewportAnchorTop = useCallback(
    (index: number) => {
      const measuredHeight = getLineHeight(index);
      const fallbackHeight = amllResponsiveBaseFontSize * 1.2 * fontScale;
      const targetHeight = measuredHeight ?? fallbackHeight;
      return Math.max(
        0,
        listHeightRef.current * AMLL_ALIGN_POSITION - targetHeight / 2,
      );
    },
    [amllResponsiveBaseFontSize, fontScale, getLineHeight],
  );

  const getScrollOffsetForLineIndex = useCallback(
    (index: number) => {
      const absoluteTop = getAbsoluteLineTop(index);
      if (absoluteTop === null) {
        return null;
      }
      return Math.max(0, absoluteTop - getLineViewportAnchorTop(index));
    },
    [getAbsoluteLineTop, getLineViewportAnchorTop],
  );

  const markProgrammaticScroll = useCallback((animated: boolean) => {
    programmaticScrollInProgressRef.current = true;
    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = setTimeout(
      () => {
        programmaticScrollInProgressRef.current = false;
        programmaticScrollTimerRef.current = null;
      },
      animated ? PROGRAMMATIC_SCROLL_GUARD_MS : 120,
    );
  }, []);

  const clearUserScrollIdleTimer = useCallback(() => {
    if (userScrollIdleTimerRef.current) {
      clearTimeout(userScrollIdleTimerRef.current);
      userScrollIdleTimerRef.current = null;
    }
  }, []);

  const scheduleUserScrollIdleReset = useCallback(() => {
    clearUserScrollIdleTimer();
    userScrollIdleTimerRef.current = setTimeout(() => {
      userScrollInProgressRef.current = false;
      userScrollSessionRef.current = false;
      setIsUserTouchScrolling(false);
      userScrollIdleTimerRef.current = null;
    }, USER_SCROLL_IDLE_RESET_MS);
  }, [clearUserScrollIdleTimer]);

  const scrollToOffset = useCallback(
    (
      offset: number,
      animated: boolean,
      animationStyle: ScrollAnimationStyle,
      startOffset: number,
      springPolicy = {
        mass: 0.9,
        stiffness: 90,
        damping: 15,
        overshootClamping: false,
      },
    ) => {
      if (
        animated &&
        animationStyle === "lyric" &&
        SHOULD_USE_UI_THREAD_SCROLL
      ) {
        cancelAnimation(lyricScrollOffset);
        lyricScrollActive.value = true;
        lyricScrollOffset.value = startOffset;
        lyricScrollOffset.value = withSpring(
          offset,
          springPolicy,
          (finished) => {
            if (finished) {
              lyricScrollActive.value = false;
            }
          },
        );
        return;
      }

      cancelAnimation(lyricScrollOffset);
      lyricScrollActive.value = false;
      listRef.current?.scrollToOffset({
        offset,
        animated,
        skipFirstItemOffset: false,
      });
    },
    [listRef, lyricScrollActive, lyricScrollOffset],
  );

  const syncMeasuredRowLayoutsFromIndex = useCallback(
    (fromIndex: number) => {
      const rowHeights = rowHeightsRef.current;
      const rowOffsets = rowOffsetsRef.current;
      let offset = topListPadding;
      if (fromIndex > 0) {
        const previousTop = rowOffsets.get(fromIndex - 1);
        const previousHeight = rowHeights.get(fromIndex - 1);
        if (previousTop === undefined || previousHeight === undefined) {
          return;
        }
        offset = previousTop + previousHeight;
      }
      for (let index = fromIndex; index < lyrics.length; index += 1) {
        const height = rowHeights.get(index);
        if (height === undefined) {
          break;
        }
        rowOffsets.set(index, offset);
        offset += height;
      }
    },
    [lyrics.length],
  );

  const getRangeMetrics = useCallback(
    (range: LyricLineRange) => {
      const startIndex = Math.max(0, Math.min(range.startIndex, lyrics.length - 1));
      const endIndex = Math.max(startIndex, Math.min(range.endIndex, lyrics.length - 1));
      const top = getAbsoluteLineTop(startIndex);
      const endTop = getAbsoluteLineTop(endIndex);
      const endHeight = getLineHeight(endIndex);
      if (top === null || endTop === null || endHeight === undefined) {
        return null;
      }
      return {
        top,
        bottom: endTop + endHeight,
      };
    },
    [getAbsoluteLineTop, getLineHeight, lyrics.length],
  );

  const getScrollOffsetForRange = useCallback(
    (range: LyricLineRange) => {
      const listHeight = listHeightRef.current;
      if (!listHeight || lyrics.length === 0) {
        return null;
      }

      const currentWindowState = effectiveWindowStateRef.current;
      if (currentWindowState.isLongPause) {
        const interludeRowIndex =
          currentWindowState.pauseAfterIndex >= 0
            ? currentWindowState.pauseAfterIndex
            : currentWindowState.pauseBeforeIndex;
        const rowTop = getAbsoluteLineTop(interludeRowIndex);
        const rowHeight = getLineHeight(interludeRowIndex);
        if (rowTop !== null && rowHeight !== undefined) {
          const interludeHeight = amllResponsiveBaseFontSize * fontScale * 2.1;
          const interludeCenter =
            currentWindowState.pauseAfterIndex >= 0
              ? rowTop + rowHeight - interludeHeight / 2
              : rowTop + interludeHeight / 2;
          const lastLineTop = getAbsoluteLineTop(lyrics.length - 1);
          const maxScrollTarget =
            lastLineTop === null
              ? Number.POSITIVE_INFINITY
              : getMaxScrollTarget({
                  lyricsLength: lyrics.length,
                  listHeight,
                  lastLineTop,
                  creditsLayout: creditsLayoutRef.current,
                  hasCredits,
                  activeLineTopOffset,
                });
          const clampScrollTarget = (offset: number) =>
            Math.min(maxScrollTarget, Math.max(0, offset));
          let interludeOffset = clampScrollTarget(
            interludeCenter - listHeight * AMLL_ALIGN_POSITION,
          );
          const metrics = getRangeMetrics(range);
          if (metrics) {
            interludeOffset = clampScrollTarget(
              Math.max(
                interludeOffset,
                metrics.bottom - listHeight + ACTIVE_RANGE_BOTTOM_PADDING,
              ),
            );
          }
          return interludeOffset;
        }
      }

      const isLastLineRange =
        range.endIndex >= lyrics.length - 1 &&
        range.startIndex >= lyrics.length - 1;
      if (creditsActive && hasCredits && isLastLineRange) {
        return getCreditsAwareScrollOffset({
          range,
          lyricsLength: lyrics.length,
          listHeight,
          creditsLayout: creditsLayoutRef.current,
          getAbsoluteLineTop,
          creditsActive,
          hasCredits: true,
          activeLineTopOffset,
        });
      }

      const anchorOffset = getScrollOffsetForLineIndex(range.startIndex);
      if (anchorOffset === null) {
        return null;
      }

      const metrics = getRangeMetrics(range);
      if (!metrics) {
        return anchorOffset;
      }
      const { top, bottom } = metrics;
      const activeRangeHeight = bottom - top;
      const rangeAnchorTop = getLineViewportAnchorTop(range.startIndex);
      const activeRangeFits =
        activeRangeHeight <=
        listHeight - rangeAnchorTop - ACTIVE_RANGE_BOTTOM_PADDING;
      if (activeRangeFits) {
        return anchorOffset;
      }
      return Math.max(
        0,
        bottom - listHeight + ACTIVE_RANGE_BOTTOM_PADDING,
      );
    },
    [
      activeLineTopOffset,
      amllResponsiveBaseFontSize,
      creditsActive,
      fontScale,
      getAbsoluteLineTop,
      getLineHeight,
      getLineViewportAnchorTop,
      getRangeMetrics,
      getScrollOffsetForLineIndex,
      lyrics.length,
      hasCredits,
    ],
  );

  const isRangeAnchoredAndVisible = useCallback(
    (range: LyricLineRange) => {
      const listHeight = listHeightRef.current;
      if (!listHeight || lyrics.length === 0) {
        return true;
      }
      const targetOffset = getScrollOffsetForRange(range);
      if (targetOffset === null) {
        return false;
      }
      if (effectiveWindowStateRef.current.isLongPause) {
        const metrics = getRangeMetrics(range);
        if (!metrics) {
          return false;
        }
        const scrollOffset = scrollOffsetRef.current;
        return (
          Math.abs(scrollOffset - targetOffset) <= ACTIVE_LINE_ALIGNMENT_EPSILON &&
          metrics.bottom <=
            scrollOffset +
              listHeight -
              ACTIVE_RANGE_BOTTOM_PADDING +
              ACTIVE_LINE_ALIGNMENT_EPSILON
        );
      }
      const isLastLineRange =
        range.endIndex >= lyrics.length - 1 &&
        range.startIndex >= lyrics.length - 1;
      if (creditsActive && hasCredits && isLastLineRange) {
        const creditsLayout = creditsLayoutRef.current;
        const scrollOffset = scrollOffsetRef.current;
        if (
          Math.abs(scrollOffset - targetOffset) > ACTIVE_LINE_ALIGNMENT_EPSILON
        ) {
          return false;
        }
        if (!creditsLayout) {
          return true;
        }
        return (
          creditsLayout.bottom <=
          scrollOffset + listHeight - ACTIVE_RANGE_BOTTOM_PADDING + ACTIVE_LINE_ALIGNMENT_EPSILON
        );
      }
      const metrics = getRangeMetrics(range);
      if (!metrics) {
        return false;
      }
      const { top, bottom } = metrics;
      const activeLineViewportTop = top - scrollOffsetRef.current;
      const activeRangeHeight = bottom - top;
      const rangeAnchorTop = getLineViewportAnchorTop(range.startIndex);
      const activeRangeFits =
        activeRangeHeight <=
        listHeight - rangeAnchorTop - ACTIVE_RANGE_BOTTOM_PADDING;
      const topIsAnchored =
        Math.abs(activeLineViewportTop - rangeAnchorTop) <=
        ACTIVE_LINE_ALIGNMENT_EPSILON;
      const bottomIsVisible =
        bottom <=
        scrollOffsetRef.current +
          listHeight -
          ACTIVE_RANGE_BOTTOM_PADDING +
          ACTIVE_LINE_ALIGNMENT_EPSILON;
      if (activeRangeFits) {
        return topIsAnchored && bottomIsVisible;
      }
      return bottomIsVisible;
    },
    [
      activeLineTopOffset,
      creditsActive,
      getLineViewportAnchorTop,
      getRangeMetrics,
      getScrollOffsetForRange,
      lyrics.length,
      hasCredits,
    ],
  );

  const getDistanceFromRangeAnchor = useCallback(
    (range: LyricLineRange) => {
      const targetOffset = getScrollOffsetForRange(range);
      if (targetOffset === null) {
        return null;
      }
      return Math.abs(targetOffset - scrollOffsetRef.current);
    },
    [getScrollOffsetForRange],
  );

  const autoFollowEnabledRef = useRef(autoFollowEnabled);
  autoFollowEnabledRef.current = autoFollowEnabled;
  const previewPlaybackPositionRef = useRef(previewPlaybackPosition);
  previewPlaybackPositionRef.current = previewPlaybackPosition;
  const isSourceAutoScrollCooldownRef = useRef(isSourceAutoScrollCooldown);
  isSourceAutoScrollCooldownRef.current = isSourceAutoScrollCooldown;
  const getDistanceFromRangeAnchorRef = useRef(getDistanceFromRangeAnchor);
  getDistanceFromRangeAnchorRef.current = getDistanceFromRangeAnchor;

  // ponytail: stable identity — reads volatile deps from refs to avoid cascading
  // callback invalidation that re-renders the entire FlashList on every line change
  const updateAutoFollowForUserScroll = useCallback(() => {
    const currentScrollTarget = scrollTargetRangeRef.current;
    if (
      !currentScrollTarget ||
      previewPlaybackPositionRef.current !== null ||
      isSourceAutoScrollCooldownRef.current ||
      programmaticScrollInProgressRef.current ||
      (!userScrollSessionRef.current && !userScrollInProgressRef.current)
    ) {
      return;
    }

    const distanceFromAnchor = getDistanceFromRangeAnchorRef.current(currentScrollTarget);
    if (distanceFromAnchor === null) {
      return;
    }

    if (autoFollowEnabledRef.current) {
      if (Date.now() < autoFollowDisableGraceUntilRef.current) {
        return;
      }
      if (distanceFromAnchor > AUTO_FOLLOW_DISABLE_DISTANCE_PX) {
        lastScrollRequestRef.current = "";
        onAutoFollowChangeRef.current?.(false);
      }
      return;
    }

    if (distanceFromAnchor <= AUTO_FOLLOW_RESUME_DISTANCE_PX) {
      lastScrollRequestRef.current = "";
      onAutoFollowChangeRef.current?.(true);
    }
  }, []);

  const scheduleScrollToRange = useCallback(
    (
      range: LyricLineRange,
      {
        animated = true,
        animationStyle = "lyric",
        force = false,
      }: {
        animated?: boolean;
        animationStyle?: ScrollAnimationStyle;
        force?: boolean;
      } = {},
    ) => {
      if (!listReady || lyrics.length === 0) {
        return;
      }
      const shouldSettleInitialAutoScroll =
        initialAutoScrollPendingRef.current && autoFollowEnabled;
      const shouldAnimate =
        animated && !shouldSettleInitialAutoScroll;
      const effectiveAnimationStyle: ScrollAnimationStyle = animated
        ? animationStyle
        : "native";
      const resolvedOffset = getScrollOffsetForRange(range);
      if (resolvedOffset === null) {
        pendingAnchorRangeRef.current = range;
        pendingAnchorAnimatedRef.current = animated;
        const layoutIndex = Math.max(
          0,
          Math.min(range.startIndex, lyrics.length - 1),
        );
        void listRef.current
          ?.scrollToIndex({
            index: layoutIndex,
            animated: false,
            viewOffset: activeLineTopOffset,
          })
          .then(() => {
            if (getScrollOffsetForRange(range) === null) {
              if (
                pendingAnchorRetryCountRef.current < MAX_PENDING_ANCHOR_RETRIES &&
                !pendingAnchorRetryTimerRef.current
              ) {
                pendingAnchorRetryTimerRef.current = setTimeout(() => {
                  pendingAnchorRetryTimerRef.current = null;
                  const pendingRange = pendingAnchorRangeRef.current;
                  if (!pendingRange) {
                    pendingAnchorRetryCountRef.current = 0;
                    return;
                  }
                  pendingAnchorRetryCountRef.current += 1;
                  scheduleScrollToRange(pendingRange, {
                    animated: pendingAnchorAnimatedRef.current,
                    animationStyle: "lyric",
                    force: true,
                  });
                }, PENDING_ANCHOR_RETRY_MS);
              }
              return;
            }
            pendingAnchorRetryCountRef.current = 0;
            scheduleScrollToRange(range, {
              animated,
              animationStyle,
              force: true,
            });
          });
        return;
      }
      pendingAnchorRetryCountRef.current = 0;
      if (pendingAnchorRetryTimerRef.current) {
        clearTimeout(pendingAnchorRetryTimerRef.current);
        pendingAnchorRetryTimerRef.current = null;
      }
      const hasCommittedSeek =
        previewPlaybackPositionRef.current === null &&
        committedSeekSerial > consumedCommittedSeekSerialRef.current;
      if (
        !force &&
        !pendingRebuildFlyInRef.current &&
        isRangeAnchoredAndVisible(range)
      ) {
        if (hasCommittedSeek) {
          consumedCommittedSeekSerialRef.current = committedSeekSerial;
        }
        pendingAnchorRangeRef.current = null;
        return;
      }
      const requestKey = `${range.startIndex}:${range.endIndex}:${Math.round(
        resolvedOffset,
      )}:${Math.round(scrollOffsetRef.current)}:${shouldAnimate ? effectiveAnimationStyle : "i"}`;
      if (
        !force &&
        !pendingRebuildFlyInRef.current &&
        lastScrollRequestRef.current === requestKey
      ) {
        if (hasCommittedSeek) {
          consumedCommittedSeekSerialRef.current = committedSeekSerial;
        }
        return;
      }
      lastScrollRequestRef.current = requestKey;
      if (
        pendingScrollFrameRef.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(pendingScrollFrameRef.current);
      }
      const performScroll = () => {
        pendingScrollFrameRef.current = null;
        pendingAnchorRangeRef.current = range;
        markProgrammaticScroll(shouldAnimate);
        const startOffset = scrollOffsetRef.current;
        const currentPosition =
          previewPlaybackPositionRef.current ??
          usePlaybackStore.getState().playbackPosition;
        const isCommittedSeek =
          previewPlaybackPositionRef.current === null &&
          committedSeekSerial > consumedCommittedSeekSerialRef.current;
        if (isCommittedSeek) {
          consumedCommittedSeekSerialRef.current = committedSeekSerial;
        }
        const isInterludeCandidate = Boolean(
          getInterludeCandidate(currentPosition, lyrics, lyricTimingIndex),
        );
        const isRebuildTransition = pendingRebuildFlyInRef.current;
        if (isRebuildTransition) {
          pendingRebuildFlyInRef.current = false;
        }
        const lastLine = lyrics[lyrics.length - 1];
        const isSeekTransition =
          previewPlaybackPositionRef.current !== null || isCommittedSeek;
        const isSongEndTransition =
          range.startIndex >= lyrics.length - 1 &&
          Boolean(lastLine) &&
          currentPosition >= lastLine.lineEndTime;
        const springPolicy = isRebuildTransition
          ? AMLL_DEFAULT_POS_Y_SPRING
          : getAmlPosYSpringPolicy({
              index: range.startIndex,
              lyrics,
              isInterlude: isInterludeCandidate,
              isSeek: isSeekTransition,
              isSongEnd: isSongEndTransition,
            });
        const shouldUseRowMotionCorrection =
          shouldAnimate && effectiveAnimationStyle === "lyric";
        const rowMotionFocusKey = isRebuildTransition
          ? `rebuild:${range.startIndex}:${range.endIndex}`
          : `${range.startIndex}:${range.endIndex}:${isInterludeCandidate ? "interlude" : "line"}:${
              isCommittedSeek
                ? `seek-${committedSeekSerial}`
                : previewPlaybackPositionRef.current !== null
                  ? "preview"
                  : isSongEndTransition
                    ? "end"
                    : "playback"
            }`;
        if (
          isRebuildTransition ||
          (shouldUseRowMotionCorrection &&
            lastRowMotionFocusKeyRef.current !== rowMotionFocusKey)
        ) {
          lastRowMotionFocusKeyRef.current = rowMotionFocusKey;
          lyricRowMotionEnabled.value = false;
          setRowMotionTransition(
            buildRowMotionTransition({
              kind: isRebuildTransition ? "rebuild" : "scroll",
              startOffset,
              targetOffset: resolvedOffset,
              scrollToIndex: range.startIndex,
              springPolicy,
              disableStagger:
                isRebuildTransition || isSeekTransition || isInterludeCandidate,
            }),
          );
        }
        scrollToOffset(
          resolvedOffset,
          shouldAnimate,
          effectiveAnimationStyle,
          startOffset,
          springPolicy,
        );
        if (!shouldAnimate) {
          scrollOffsetRef.current = resolvedOffset;
        }
        if (scrollSettleTimerRef.current) {
          clearTimeout(scrollSettleTimerRef.current);
        }
        scrollSettleTimerRef.current = setTimeout(
          () => {
            scrollSettleTimerRef.current = null;
            if (!listReady || lyrics.length === 0) {
              return;
            }
            const settledOffset = getScrollOffsetForRange(range);
            if (settledOffset === null) {
              pendingAnchorRangeRef.current = range;
              return;
            }
            if (
              Math.abs(settledOffset - scrollOffsetRef.current) <=
              SCROLL_OFFSET_EPSILON
            ) {
              return;
            }
            markProgrammaticScroll(false);
            const startOffset = scrollOffsetRef.current;
            scrollToOffset(settledOffset, false, "native", startOffset);
            scrollOffsetRef.current = settledOffset;
          },
          shouldAnimate ? SCROLL_SETTLE_VERIFY_MS : 80,
        );
        if (shouldSettleInitialAutoScroll) {
          markInitialAutoScrollSettled();
        }
      };
      if (typeof requestAnimationFrame === "function") {
        pendingScrollFrameRef.current = requestAnimationFrame(performScroll);
        return;
      }
      performScroll();
    },
    [
      autoFollowEnabled,
      activeLineTopOffset,
      buildRowMotionTransition,
      committedSeekSerial,
      getScrollOffsetForRange,
      isRangeAnchoredAndVisible,
      listReady,
      listRef,
      lyricRowMotionEnabled,
      lyrics,
      lyricTimingIndex,
      markInitialAutoScrollSettled,
      markProgrammaticScroll,
      scrollToOffset,
    ],
  );
  scheduleScrollToRangeRef.current = scheduleScrollToRange;

  // ponytail: track whether all cells are measured so we can skip onLayout entirely
  const [allCellsMeasured, setAllCellsMeasured] = useState(false);
  const handleCellLayout = useCallback(
    (index: number, event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (!Number.isFinite(height) || height <= 0) {
        return;
      }
      const rowHeights = rowHeightsRef.current;
      const previousHeight = rowHeights.get(index);
      if (previousHeight !== undefined && Math.abs(previousHeight - height) < 0.5) {
        return;
      }
      rowHeights.set(index, height);
      if (getAbsoluteLineTop(index) === null) {
        syncMeasuredRowLayoutsFromIndex(index);
      }
      // ponytail: only bump when the last line height changes — that's the only thing that
      // affects listInsets.paddingBottom. Mid-song cell layouts during scroll don't change padding.
      if (index === lyrics.length - 1) {
        bumpContentLayoutVersion();
      }
      // Once every line has been measured, disable onLayout to stop bridge chatter
      if (rowHeights.size >= lyrics.length && !allCellsMeasured) {
        setAllCellsMeasured(true);
      }
      const pendingRange = pendingAnchorRangeRef.current;
      const currentScrollTarget = scrollTargetRangeRef.current;
      const rangeToRescroll =
        pendingRange ??
        (currentScrollTarget &&
        index >= currentScrollTarget.startIndex &&
        index <= currentScrollTarget.endIndex
          ? currentScrollTarget
          : null);
      if (
        rangeToRescroll &&
        rowOffsetsRef.current.has(rangeToRescroll.startIndex)
      ) {
        scheduleScrollToRangeRef.current(rangeToRescroll, {
          animated: pendingRange
            ? pendingAnchorAnimatedRef.current
            : true,
          animationStyle: "lyric",
          force: true,
        });
      }
    },
    [
      allCellsMeasured,
      bumpContentLayoutVersion,
      getAbsoluteLineTop,
      lyrics.length,
      syncMeasuredRowLayoutsFromIndex,
    ],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollOffsetRef.current = Math.max(0, event.nativeEvent.contentOffset.y);
      if (
        programmaticScrollInProgressRef.current ||
        (!userScrollSessionRef.current && !userScrollInProgressRef.current)
      ) {
        return;
      }
      scheduleUserScrollIdleReset();
      updateAutoFollowForUserScroll();
    },
    [scheduleUserScrollIdleReset, updateAutoFollowForUserScroll],
  );

  useLayoutEffect(() => {
    lyricRowMotionEnabled.value = false;
    lastRowMotionFocusKeyRef.current = "";
    pendingRebuildFlyInRef.current = lyrics.length > 0;
    rowMotionSerialRef.current += 1;
    setRowMotionTransition({
      serial: rowMotionSerialRef.current,
      kind: "idle",
      startOffset: 0,
      targetOffset: 0,
      springPolicy: AMLL_DEFAULT_POS_Y_SPRING,
      delayByIndex: EMPTY_ROW_DELAYS,
      rebuildStartCorrectionByIndex: EMPTY_REBUILD_CORRECTIONS,
    });
    activeLineRef.current = -1;
    scrollOffsetRef.current = 0;
    userScrollInProgressRef.current = false;
    userScrollSessionRef.current = false;
    setIsUserTouchScrolling(false);
    autoFollowDisableGraceUntilRef.current =
      Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS;
    lastScrollRequestRef.current = "";
    pendingAnchorRangeRef.current = null;
    pendingAnchorAnimatedRef.current = true;
    pendingAnchorRetryCountRef.current = 0;
    if (pendingAnchorRetryTimerRef.current) {
      clearTimeout(pendingAnchorRetryTimerRef.current);
      pendingAnchorRetryTimerRef.current = null;
    }
    onAutoFollowChangeRef.current?.(true);
    setAllCellsMeasured(false);
    rowHeightsRef.current.clear();
    rowOffsetsRef.current.clear();
    creditsLayoutRef.current = null;
    setContentLayoutVersion(0);
  }, [lyricRowMotionEnabled, lyrics]);

  // Reset measurement state when layout-affecting props change
  useEffect(() => {
    setAllCellsMeasured(false);
    rowHeightsRef.current.clear();
  }, [fontScale, landscapeMode]);

  useEffect(
    () => () => {
      if (
        pendingScrollFrameRef.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(pendingScrollFrameRef.current);
      }
      pendingScrollFrameRef.current = null;
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
        programmaticScrollTimerRef.current = null;
      }
      clearUserScrollIdleTimer();
      if (scrollSettleTimerRef.current) {
        clearTimeout(scrollSettleTimerRef.current);
        scrollSettleTimerRef.current = null;
      }
      cancelAnimation(lyricScrollOffset);
      lyricScrollActive.value = false;
      lyricRowMotionEnabled.value = false;
      lastRowMotionFocusKeyRef.current = "";
      pendingAnchorRangeRef.current = null;
      pendingAnchorAnimatedRef.current = true;
      pendingAnchorRetryCountRef.current = 0;
      if (pendingAnchorRetryTimerRef.current) {
        clearTimeout(pendingAnchorRetryTimerRef.current);
        pendingAnchorRetryTimerRef.current = null;
      }
      if (layoutBumpFrameRef.current !== null) {
        cancelAnimationFrame(layoutBumpFrameRef.current);
        layoutBumpFrameRef.current = null;
      }
      programmaticScrollInProgressRef.current = false;
    },
    [
      clearUserScrollIdleTimer,
      lyricRowMotionEnabled,
      lyricScrollActive,
      lyricScrollOffset,
    ],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;
      if (nextState !== "active" || previousState === "active") {
        return;
      }

      cancelAnimation(lyricScrollOffset);
      lyricScrollActive.value = false;
      lyricRowMotionEnabled.value = false;
      lastRowMotionFocusKeyRef.current = "";
      programmaticScrollInProgressRef.current = false;
      userScrollInProgressRef.current = false;
      userScrollSessionRef.current = false;
      setIsUserTouchScrolling(false);
      autoFollowDisableGraceUntilRef.current =
        Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS;
      lastScrollRequestRef.current = "";
      onAutoFollowChangeRef.current?.(true);

      if (autoFollowEnabled && scrollTargetRange) {
        scheduleScrollToRange(scrollTargetRange, {
          animated: true,
          animationStyle: "lyric",
          force: true,
        });
      }
    });

    return () => subscription.remove();
  }, [
    autoFollowEnabled,
    lyricScrollActive,
    lyricScrollOffset,
    lyricRowMotionEnabled,
    scheduleScrollToRange,
    scrollTargetRange,
  ]);

  useEffect(() => {
    if (!hasMountedLyricsChangeEffectRef.current) {
      hasMountedLyricsChangeEffectRef.current = true;
      lastLyricsSourceRef.current = lyricsSource || null;
      return;
    }
    const currentSource = lyricsSource || null;
    if (lastLyricsSourceRef.current === currentSource) {
      return;
    }
    lastLyricsSourceRef.current = currentSource;

    setIsSourceAutoScrollCooldown(true);
    if (sourceAutoScrollTimerRef.current) {
      clearTimeout(sourceAutoScrollTimerRef.current);
    }
    sourceAutoScrollTimerRef.current = setTimeout(() => {
      setIsSourceAutoScrollCooldown(false);
      sourceAutoScrollTimerRef.current = null;
    }, SOURCE_CHANGE_AUTOSCROLL_DELAY_MS);
  }, [lyricsSource]);

  useEffect(
    () => () => {
      if (sourceAutoScrollTimerRef.current) {
        clearTimeout(sourceAutoScrollTimerRef.current);
        sourceAutoScrollTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (
      !listReady ||
      resumeAutoFollowSignal <= 0 ||
      resumeAutoFollowSignal === lastResumeAutoFollowSignalRef.current
    ) {
      return;
    }
    lastResumeAutoFollowSignalRef.current = resumeAutoFollowSignal;
    userScrollInProgressRef.current = false;
    userScrollSessionRef.current = false;
    setIsUserTouchScrolling(false);
    lastScrollRequestRef.current = "";
    onAutoFollowChange?.(true);
    if (isSourceAutoScrollCooldown || !scrollTargetRange) {
      return;
    }
    scheduleScrollToRange(scrollTargetRange, {
      animated: true,
      animationStyle: "lyric",
      force: true,
    });
  }, [
    isSourceAutoScrollCooldown,
    listReady,
    onAutoFollowChange,
    resumeAutoFollowSignal,
    scheduleScrollToRange,
    scrollTargetRange,
  ]);

  useEffect(() => {
    if (initialAutoScrollPendingRef.current && lyrics.length === 0) {
      markInitialAutoScrollSettled();
      return;
    }
    if (
      initialAutoScrollPendingRef.current &&
      listReady &&
      !scrollTargetRange
    ) {
      markInitialAutoScrollSettled();
    }
  }, [lyrics.length, listReady, markInitialAutoScrollSettled, scrollTargetRange]);

  useEffect(() => {
    if (
      !listReady ||
      !scrollTargetRange ||
      isSourceAutoScrollCooldown ||
      suspendViewportScrollAdjustments ||
      userScrollInProgressRef.current
    ) {
      return;
    }
    if (previewPlaybackPosition !== null) {
      if (!isRangeAnchoredAndVisible(scrollTargetRange)) {
        scheduleScrollToRange(scrollTargetRange, {
          animated: true,
          animationStyle: "lyric",
        });
      } else if (initialAutoScrollPendingRef.current) {
        markInitialAutoScrollSettled();
      }
      return;
    }
    if (autoFollowActive && !isRangeAnchoredAndVisible(scrollTargetRange)) {
      scheduleScrollToRange(scrollTargetRange, {
        animated: true,
        animationStyle: "lyric",
      });
    } else if (autoFollowActive && initialAutoScrollPendingRef.current) {
      markInitialAutoScrollSettled();
    }
  }, [
    autoFollowActive,
    creditsActive,
    isRangeAnchoredAndVisible,
    isSourceAutoScrollCooldown,
    markInitialAutoScrollSettled,
    listReady,
    previewPlaybackPosition,
    scheduleScrollToRange,
    scrollTargetRange,
    suspendViewportScrollAdjustments,
    viewportHeight,
    layoutSettleSignal,
  ]);

  useEffect(() => {
    if (activeLineIndex < 0) {
      activeLineRef.current = -1;
      return;
    }
    if (activeLineIndex === activeLineRef.current) {
      return;
    }
    activeLineRef.current = activeLineIndex;
    onActiveLineChange?.(activeLineIndex);
  }, [activeLineIndex, onActiveLineChange]);

  // ponytail: read window state from ref so renderItem is stable across line transitions.
  // FlashList still diffs via extraData, but the callback identity doesn't change,
  // avoiding full invalidation of the internal render tree.
  const renderItem = useCallback(
    ({ item, index }: { item: LyricLineType; index: number }) => {
      const ws = effectiveWindowStateRef.current;
      const hasActiveLines = ws.highlightedLineIndices.size > 0;
      const isActive = ws.highlightedLineIndices.has(index);
      const shouldDrivePlaybackUpdates = isIndexWithinUpdateWindow(
        index,
        ws,
      );
      const isPast =
        ws.focusLineIndex >= 0
          ? hasActiveLines
            ? index < ws.focusLineIndex
            : index <= ws.focusLineIndex
          : false;
      const inactiveOpacityDistance = Math.abs(
        ws.focusLineIndex - index,
      );
      const scrollFocusIndex = Math.max(0, ws.focusLineIndex);
      const latestHighlightedIndex = getLatestHighlightedLineIndex(
        ws.highlightedLineIndices,
        scrollFocusIndex,
      );
      const blurDistance =
        index < scrollFocusIndex
          ? Math.abs(scrollFocusIndex - index) + 1
          : Math.abs(index - latestHighlightedIndex);
      const blurAmount =
        isUserTouchScrolling || isActive
          ? 0
          : (1 + blurDistance) * (isNarrowViewport ? 0.8 : 1);
      const isSelected = Boolean(
        selectedLineKeys?.has(`${item.lineStartTime}-${item.lineEndTime}`),
      );
      const showPauseDotsAfter =
        ws.isLongPause && ws.pauseAfterIndex >= 0 && index === ws.pauseAfterIndex;
      const showPauseDotsBefore =
        ws.isLongPause && ws.pauseAfterIndex < 0 && index === ws.pauseBeforeIndex;

      return (
        <LyricLine
          line={item}
          isActive={isActive}
          isPast={isPast}
          isSelected={isSelected}
          blurAmount={blurAmount}
          inactiveOpacityDistance={inactiveOpacityDistance}
          showPauseDotsAfter={showPauseDotsAfter}
          showPauseDotsBefore={showPauseDotsBefore}
          pauseStartMs={ws.pauseStartMs}
          pauseVisualDurationMs={ws.pauseVisualDurationMs}
          pauseHoldMs={ws.pauseHoldMs}
          playbackPositionOverrideMs={previewPlaybackPosition}
          pauseTone={
            ws.isLongPause
              ? index <= ws.pauseAfterIndex
                ? "past"
                : "future"
              : "none"
          }
          onPress={onLinePress}
          onLongPress={onLineLongPress}
          tapEnabled={tapToSeekEnabled}
          showTranslatedText={showTranslatedText}
          shouldDrivePlaybackUpdates={shouldDrivePlaybackUpdates}
          fontScale={fontScale}
          landscapeMode={landscapeMode}
          hasDuetLines={hasDuetLines}
          posYSpringPolicy={rowMotionTransition.springPolicy}
          groupMotionDelayMs={rowMotionTransition.delayByIndex.get(index) ?? 0}
        />
      );
    },
    [
      fontScale,
      hasDuetLines,
      isNarrowViewport,
      isUserTouchScrolling,
      landscapeMode,
      onLineLongPress,
      onLinePress,
      selectedLineKeys,
      showTranslatedText,
      tapToSeekEnabled,
      previewPlaybackPosition,
      rowMotionTransition,
    ],
  );

  // ponytail: skip onLayout once all cells measured — eliminates JS bridge chatter during scroll
  const flashListRenderItem = useCallback(
    ({ item, index }: { item: LyricLineType; index: number }) => (
      <View
        style={landscapeMode ? styles.flashListCellLandscape : undefined}
        onLayout={
          allCellsMeasured
            ? undefined
            : (event) => handleCellLayout(index, event)
          }
      >
        <LyricRowMotion
          index={index}
          transition={rowMotionTransition}
          globalOffset={lyricScrollOffset}
          enabled={lyricRowMotionEnabled}
        >
          {renderItem({ item, index })}
        </LyricRowMotion>
      </View>
    ),
    [
      allCellsMeasured,
      handleCellLayout,
      landscapeMode,
      lyricRowMotionEnabled,
      lyricScrollOffset,
      renderItem,
      rowMotionTransition,
    ],
  );

  const keyExtractor = useCallback(
    (item: LyricLineType, index: number) =>
      `${index}-${item.lineStartTime}-${item.lineEndTime}`,
    [],
  );

  const listInsets = useMemo(() => {
    void contentLayoutVersion;
    const lastLineIndex = Math.max(0, lyrics.length - 1);
    const lastLineTop = getAbsoluteLineTop(lastLineIndex);
    const lastLineHeight = getLineHeight(lastLineIndex) ?? 0;
    return {
      // Extra top inset supports Apple-like upper-focus active line anchoring.
      paddingTop: topListPadding,
      // Bottom inset is sized so max scroll stops once the last line (and credits)
      // reach their anchor positions, without extra empty scroll room.
      paddingBottom: getBottomListPadding({
        viewportHeight,
        lyricsLength: lyrics.length,
        lastLineTop,
        lastLineHeight,
        creditsLayout: creditsLayoutRef.current,
        hasCredits,
        activeLineTopOffset,
      }),
    };
  }, [
    activeLineTopOffset,
    contentLayoutVersion,
    getAbsoluteLineTop,
    getLineHeight,
    lyrics.length,
    hasCredits,
    topListPadding,
    viewportHeight,
  ]);

  const handleCreditsLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      if (!Number.isFinite(height) || height <= 0 || lyrics.length === 0) {
        return;
      }
      const lastLineIndex = lyrics.length - 1;
      const lastLineTop = getAbsoluteLineTop(lastLineIndex);
      const lastLineHeight = getLineHeight(lastLineIndex);
      if (lastLineTop === null || lastLineHeight === undefined) {
        return;
      }
      const absoluteTop = lastLineTop + lastLineHeight;
      const nextLayout: CreditsLayout = {
        top: absoluteTop,
        bottom: absoluteTop + height,
      };
      const previousLayout = creditsLayoutRef.current;
      if (
        previousLayout &&
        Math.abs(previousLayout.top - nextLayout.top) < 0.5 &&
        Math.abs(previousLayout.bottom - nextLayout.bottom) < 0.5
      ) {
        return;
      }
      creditsLayoutRef.current = nextLayout;
      bumpContentLayoutVersion();
      const pendingRange = pendingAnchorRangeRef.current;
      if (pendingRange) {
        scheduleScrollToRange(pendingRange, {
          animated: pendingAnchorAnimatedRef.current,
          animationStyle: "lyric",
          force: true,
        });
        return;
      }
      if (!listReady || !scrollTargetRange) {
        return;
      }
      if (!isRangeAnchoredAndVisible(scrollTargetRange)) {
        scheduleScrollToRange(scrollTargetRange, {
          animated: true,
          animationStyle: "lyric",
          force: true,
        });
      }
    },
    [
      getAbsoluteLineTop,
      getLineHeight,
      isRangeAnchoredAndVisible,
      listReady,
      lyrics.length,
      scheduleScrollToRange,
      scrollTargetRange,
    ],
  );

  const listFooter = useMemo(() => {
    if (!hasCredits) {
      return null;
    }
    return (
      <View onLayout={handleCreditsLayout}>
        <CreditsFooter
          songwriters={songwriters}
          attribution={attribution}
          lastLyricEndTime={lastLyricEndTime}
          onPress={onCreditsTimestampPress}
        />
      </View>
    );
  }, [
    handleCreditsLayout,
    lastLyricEndTime,
    onCreditsTimestampPress,
    attribution,
    hasCredits,
    songwriters,
  ]);

  if (!lyrics.length) {
    const title = instrumental ? "This song is an instrumental" : "No synced lyrics yet";
    const iconName = instrumental ? "musical-notes" : "document-text";
    return (
      <View style={styles.container}>
        <View
          style={[
            styles.emptyWrap,
            {
              transform: [{ translateY: -centeredNoticeUpwardOffset }],
            },
          ]}
        >
          <View style={styles.emptyIconWrap}>
            <Ionicons name={iconName} size={34} color="#FFFFFF" />
          </View>
          <Text style={styles.emptyTitle}>{title}</Text>
          <Pressable
            style={styles.emptyDebugButton}
            onPress={() => setShowEmptyDebug((value) => !value)}
          >
            <Ionicons
              name={showEmptyDebug ? "chevron-up" : "information-circle"}
              size={15}
              color="rgba(255,255,255,0.76)"
            />
            <Text style={styles.emptyDebugText}>
              {showEmptyDebug ? "Hide details" : "Details"}
            </Text>
          </Pressable>
          {showEmptyDebug && (
            <Text style={styles.emptySub}>
              {lyricsStatusMessage || `Source: ${lyricsSource || "unavailable"}`}
            </Text>
          )}
        </View>
      </View>
    );
  }

  if (lyricsTimingMode === "static") {
    // ponytail: FlashList instead of ScrollView+.map() — virtualizes long static lyrics
    const staticRenderItem = ({ item: line }: { item: LyricLineType }) => {
      const text = getPrimaryLineText(line);
      if (!text) return null;
      const translatedText = String(line.translatedText || "").trim();
      const backgroundText = line.backgroundSyllables?.length
        ? getPrimaryLineText({ ...line, syllables: line.backgroundSyllables })
        : "";
      const backgroundTranslatedText = String(
        line.backgroundTranslatedText || "",
      ).trim();
      const alignRight = landscapeMode ? !line.oppositeAligned : false;
      return (
        <View
          style={[
            styles.staticLyricLineWrap,
            alignRight && styles.staticLyricLineWrapOpposite,
          ]}
        >
          <Text
            style={[
              styles.staticLyricLineText,
              alignRight && styles.staticLyricLineTextOpposite,
              {
                fontSize: STATIC_LYRIC_FONT_SIZE * fontScale,
                lineHeight: STATIC_LYRIC_LINE_HEIGHT * fontScale,
              },
            ]}
          >
            {text}
          </Text>
          {showTranslatedText && translatedText ? (
            <Text
              style={[
                styles.staticTranslatedText,
                alignRight && styles.staticLyricLineTextOpposite,
                {
                  fontSize: STATIC_TRANSLATED_FONT_SIZE * fontScale,
                  lineHeight: STATIC_TRANSLATED_LINE_HEIGHT * fontScale,
                },
              ]}
            >
              {translatedText}
            </Text>
          ) : null}
          {backgroundText ? (
            <View
              style={[
                styles.staticBackgroundGroup,
                alignRight && styles.staticLyricLineWrapOpposite,
              ]}
            >
              <Text
                style={[
                  styles.staticBackgroundText,
                  alignRight && styles.staticLyricLineTextOpposite,
                  {
                    fontSize: STATIC_TRANSLATED_FONT_SIZE * fontScale,
                    lineHeight: STATIC_TRANSLATED_LINE_HEIGHT * fontScale,
                  },
                ]}
              >
                {backgroundText}
              </Text>
              {showTranslatedText && backgroundTranslatedText ? (
                <Text
                  style={[
                    styles.staticBackgroundTranslatedText,
                    alignRight && styles.staticLyricLineTextOpposite,
                    {
                      fontSize: 15 * fontScale,
                      lineHeight: 21 * fontScale,
                    },
                  ]}
                >
                  {backgroundTranslatedText}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      );
    };
    const staticFooter = hasCredits ? (
      <View
        style={[
          styles.staticCreditsFooter,
          landscapeMode && styles.staticCreditsFooterLandscape,
        ]}
      >
        <CreditsFooter
          songwriters={songwriters}
          attribution={attribution}
          lastLyricEndTime={0}
          onPress={onCreditsTimestampPress}
          alignRight={landscapeMode}
          style={[
            styles.staticCreditsFooterPressable,
            landscapeMode && styles.staticCreditsFooterPressableLandscape,
          ]}
        />
      </View>
    ) : null;
    return (
      <View style={[styles.container, landscapeMode && styles.containerLandscape]}>
        <FlashList
          data={lyrics}
          renderItem={staticRenderItem}
          keyExtractor={keyExtractor}
          drawDistance={400}
          ListFooterComponent={staticFooter}
          contentContainerStyle={[
            styles.staticLyricsContent,
            landscapeMode && styles.listContentLandscape,
            {
              paddingTop: topListPadding,
              paddingBottom: BOTTOM_LIST_PADDING,
            },
          ]}
          showsVerticalScrollIndicator={false}
          onScrollBeginDrag={() => onUserInteraction?.()}
          onMomentumScrollBegin={() => onUserInteraction?.()}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, landscapeMode && styles.containerLandscape]}>
      <ReanimatedFlashList
        ref={listRef}
        data={lyrics}
        renderItem={flashListRenderItem}
        keyExtractor={keyExtractor}
        extraData={`${extraDataFingerprint}:${rowMotionTransition.serial}`}
        drawDistance={320}
        ListFooterComponent={listFooter}
        onLoad={() => {
          const pendingRange = pendingAnchorRangeRef.current ?? scrollTargetRangeRef.current;
          if (pendingRange) {
            scheduleScrollToRangeRef.current(pendingRange, {
              animated: true,
              animationStyle: "lyric",
              force: true,
            });
          }
        }}
        onLayout={(event) => {
          const height = event.nativeEvent.layout.height;
          listHeightRef.current = height;
          setViewportHeight((previous) =>
            Math.abs(previous - height) < 0.5 ? previous : height,
          );
          setListReady(true);
        }}
        contentContainerStyle={[
          styles.listContent,
          landscapeMode && styles.listContentLandscape,
          listInsets,
        ]}
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={10}
        onScrollBeginDrag={() => {
          if (programmaticScrollInProgressRef.current) {
            return;
          }
          onUserInteraction?.();
          cancelAnimation(lyricScrollOffset);
          lyricScrollActive.value = false;
          lyricRowMotionEnabled.value = false;
          lastRowMotionFocusKeyRef.current = "";
          userScrollInProgressRef.current = true;
          userScrollSessionRef.current = true;
          setIsUserTouchScrolling(true);
          scheduleUserScrollIdleReset();
          lastScrollRequestRef.current = "";
          pendingAnchorRangeRef.current = null;
          if (
            pendingScrollFrameRef.current !== null &&
            typeof cancelAnimationFrame === "function"
          ) {
            cancelAnimationFrame(pendingScrollFrameRef.current);
            pendingScrollFrameRef.current = null;
          }
        }}
        onScrollEndDrag={() => {
          userScrollInProgressRef.current = false;
          setIsUserTouchScrolling(false);
          scheduleUserScrollIdleReset();
        }}
        onMomentumScrollBegin={() => {
          if (
            programmaticScrollInProgressRef.current ||
            !userScrollSessionRef.current
          ) {
            return;
          }
          onUserInteraction?.();
          cancelAnimation(lyricScrollOffset);
          lyricScrollActive.value = false;
          lyricRowMotionEnabled.value = false;
          lastRowMotionFocusKeyRef.current = "";
          userScrollInProgressRef.current = true;
          setIsUserTouchScrolling(true);
          scheduleUserScrollIdleReset();
          lastScrollRequestRef.current = "";
          pendingAnchorRangeRef.current = null;
          if (
            pendingScrollFrameRef.current !== null &&
            typeof cancelAnimationFrame === "function"
          ) {
            cancelAnimationFrame(pendingScrollFrameRef.current);
            pendingScrollFrameRef.current = null;
          }
        }}
        onMomentumScrollEnd={() => {
          clearUserScrollIdleTimer();
          programmaticScrollInProgressRef.current = false;
          if (programmaticScrollTimerRef.current) {
            clearTimeout(programmaticScrollTimerRef.current);
            programmaticScrollTimerRef.current = null;
          }
          userScrollInProgressRef.current = false;
          userScrollSessionRef.current = false;
          setIsUserTouchScrolling(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  containerLandscape: {
    overflow: "visible",
  },
  listContent: {
    paddingHorizontal: 0,
  },
  listContentLandscape: {
    paddingHorizontal: 0,
  },
  flashListCellLandscape: {
    overflow: "visible",
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 28,
  },
  emptyIconWrap: {
    width: 70,
    height: 70,
    borderRadius: 35,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  emptyTitle: {
    color: "#F8F8FB",
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "800",
    textAlign: "center",
  },
  emptyDebugButton: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.09)",
  },
  emptyDebugText: {
    color: "rgba(255,255,255,0.76)",
    fontSize: 12,
    fontWeight: "600",
  },
  emptySub: {
    color: "rgba(248,248,251,0.72)",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    maxWidth: 320,
  },
  staticLyricsContent: {
    paddingHorizontal: STATIC_LYRIC_HORIZONTAL_INSET,
  },
  staticLyricsColumn: {
    width: "100%",
    maxWidth: STATIC_LYRIC_MAX_WIDTH,
    alignSelf: "flex-start",
  },
  staticLyricsColumnLandscape: {
    alignSelf: "flex-end",
  },
  staticLyricLineWrap: {
    marginBottom: 14,
    alignSelf: "flex-start",
    width: "100%",
    maxWidth: STATIC_LYRIC_MAX_WIDTH,
    paddingVertical: 1,
  },
  staticLyricLineWrapOpposite: {
    alignSelf: "flex-end",
    alignItems: "flex-end",
  },
  staticLyricLineText: {
    color: "#FFFFFF",
    fontSize: STATIC_LYRIC_FONT_SIZE,
    lineHeight: STATIC_LYRIC_LINE_HEIGHT,
    fontWeight: "600",
    letterSpacing: 0.15,
    textAlign: "left",
    alignSelf: "flex-start",
  },
  staticLyricLineTextOpposite: {
    textAlign: "right",
    alignSelf: "flex-end",
  },
  staticTranslatedText: {
    marginTop: 6,
    color: "rgba(255,255,255,0.68)",
    fontSize: STATIC_TRANSLATED_FONT_SIZE,
    lineHeight: STATIC_TRANSLATED_LINE_HEIGHT,
    fontWeight: "500",
    letterSpacing: 0.1,
    textAlign: "left",
    alignSelf: "flex-start",
  },
  staticBackgroundGroup: {
    marginTop: 5,
    alignSelf: "flex-start",
  },
  staticBackgroundText: {
    color: "rgba(255,255,255,0.78)",
    fontWeight: "500",
    letterSpacing: 0.1,
    textAlign: "left",
    alignSelf: "flex-start",
  },
  staticBackgroundTranslatedText: {
    marginTop: 2,
    color: "rgba(255,255,255,0.58)",
    fontWeight: "500",
    letterSpacing: 0.08,
    textAlign: "left",
    alignSelf: "flex-start",
  },
  staticCreditsFooter: {
    marginTop: 18,
    paddingTop: 4,
    alignSelf: "stretch",
  },
  staticCreditsFooterLandscape: {
    alignItems: "flex-end",
  },
  staticCreditsFooterPressable: {
    paddingHorizontal: 0,
    paddingTop: 12,
  },
  staticCreditsFooterPressableLandscape: {
    alignItems: "flex-end",
  },
  creditsFooter: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 6,
  },
  creditsFooterMotion: {
    alignSelf: "stretch",
  },
  creditsText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 13,
    lineHeight: 18,
  },
  creditsTextOpposite: {
    textAlign: "right",
  },
  creditsTextStrong: {
    fontWeight: "800",
  },
  creditsProfileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  creditsProfileRowOpposite: {
    justifyContent: "flex-end",
  },
  creditsProfileAvatar: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  creditsTextActive: {
    color: "#FFFFFF",
  },
});
