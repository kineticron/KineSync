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
} from "react";
import {
  AppState,
  type AppStateStatus,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  type LayoutChangeEvent,
  Pressable,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  cancelAnimation,
  Easing as ReanimatedEasing,
  runOnJS,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import {
  getLandscapeLyricsCenterUpwardOffset,
  getLyricsViewportCenterUpwardOffset,
  LANDSCAPE_ACTIVE_LINE_TOP_OFFSET,
  LANDSCAPE_LYRICS_EDGE_BLEED,
  LANDSCAPE_LYRICS_HORIZONTAL_INSET,
  LANDSCAPE_TOP_LIST_PADDING,
} from "@/constants/player-layout";
import { getPrimaryLineText } from "@/lib/active-lyric-line";
import { detectLyricsTimingMode } from "@/lib/lyrics-timing";
import { usePlaybackStore } from "@/store/playback-store";
import type { LyricLine as LyricLineType } from "@/types/bridge";

import { LyricLine } from "./lyric-line";

const LONG_PAUSE_THRESHOLD_MS = 3000;
const PAUSE_DOTS_EARLY_EXIT_MS = 500;
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
const ACTIVE_RANGE_BOTTOM_PADDING = 24;
const ACTIVE_LINE_ALIGNMENT_EPSILON = 3;
const LYRIC_SCROLL_ANIMATION_MS = 440;
const PROGRAMMATIC_SCROLL_GUARD_MS = LYRIC_SCROLL_ANIMATION_MS + 40;
const SCROLL_OFFSET_EPSILON = 2;
const SCROLL_SETTLE_VERIFY_MS = LYRIC_SCROLL_ANIMATION_MS + 100;
const PENDING_ANCHOR_RETRY_MS = 96;
const MAX_PENDING_ANCHOR_RETRIES = 18;
const STARTUP_DOTS_WARMUP_MS = 100;
// Fast start, long gentle deceleration — no overshoot (P1 0.22,0.88 → P2 0.34,1)
const LYRIC_SCROLL_EASING = ReanimatedEasing.bezier(0.22, 0.88, 0.34, 1);
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
  visualActiveLineStartIndex: number;
  visualActiveLineEndIndex: number;
  focusLineIndex: number;
  pauseAfterIndex: number;
  pauseBeforeIndex: number;
  isLongPause: boolean;
  pauseProgress: number;
  pauseStartMs: number;
  pauseVisualDurationMs: number;
};

type BackgroundActiveLine = {
  index: number;
  lineEndTime: number;
  backgroundEndTime: number;
};

type LyricTimingIndex = {
  maxEndTimeByIndex: number[];
};

type PlaybackWindowStateWithoutComputedRanges = Omit<
  PlaybackWindowState,
  "visualActiveLineStartIndex" | "visualActiveLineEndIndex"
>;

const EMPTY_WINDOW_STATE: PlaybackWindowState = {
  activeLineStartIndex: -1,
  activeLineEndIndex: -1,
  visualActiveLineStartIndex: -1,
  visualActiveLineEndIndex: -1,
  focusLineIndex: -1,
  pauseAfterIndex: -1,
  pauseBeforeIndex: -1,
  isLongPause: false,
  pauseProgress: 0,
  pauseStartMs: 0,
  pauseVisualDurationMs: 0,
};

function arePlaybackWindowStatesEqual(
  a: PlaybackWindowState,
  b: PlaybackWindowState,
) {
  return (
    a.activeLineStartIndex === b.activeLineStartIndex &&
    a.activeLineEndIndex === b.activeLineEndIndex &&
    a.visualActiveLineStartIndex === b.visualActiveLineStartIndex &&
    a.visualActiveLineEndIndex === b.visualActiveLineEndIndex &&
    a.focusLineIndex === b.focusLineIndex &&
    a.pauseAfterIndex === b.pauseAfterIndex &&
    a.pauseBeforeIndex === b.pauseBeforeIndex &&
    a.isLongPause === b.isLongPause &&
    Math.abs(a.pauseProgress - b.pauseProgress) < 0.004 &&
    a.pauseStartMs === b.pauseStartMs &&
    a.pauseVisualDurationMs === b.pauseVisualDurationMs
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

function findLastStartedLineIndex(positionMs: number, lyrics: LyricLineType[]) {
  let low = 0;
  let high = lyrics.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lyrics[mid].lineStartTime <= positionMs) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
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
): PlaybackWindowState {
  if (!lyrics.length) {
    return EMPTY_WINDOW_STATE;
  }

  const finalize = (state: PlaybackWindowStateWithoutComputedRanges) =>
    addVisualActiveRange(state, playbackPosition, backgroundActiveLines);

  // Support overlapping line windows by allowing multiple "active" lines.
  // Focus/scroll should anchor to the earliest active line so overlapping
  // lines stay visible together.
  const lastStartedIndex = findLastStartedLineIndex(playbackPosition, lyrics);
  if (lastStartedIndex >= 0) {
    let activeStart = -1;
    let activeEnd = -1;

    for (let idx = lastStartedIndex; idx >= 0; idx -= 1) {
      if (timingIndex.maxEndTimeByIndex[idx] <= playbackPosition) {
        break;
      }

      const line = lyrics[idx];
      if (isLineInPrimaryWindow(playbackPosition, line)) {
        activeStart = idx;
        if (activeEnd < 0) {
          activeEnd = idx;
        }
      }
    }

    for (let idx = lastStartedIndex + 1; idx < lyrics.length; idx += 1) {
      const line = lyrics[idx];
      if (playbackPosition < line.lineStartTime) {
        break;
      }
      if (playbackPosition < line.lineEndTime) {
        if (activeStart === -1) {
          activeStart = idx;
        }
        activeEnd = idx;
      }
    }
    if (activeStart >= 0) {
      return finalize({
        activeLineStartIndex: activeStart,
        activeLineEndIndex: activeEnd,
        focusLineIndex: activeStart,
        pauseAfterIndex: -1,
        pauseBeforeIndex: -1,
        isLongPause: false,
        pauseProgress: 0,
        pauseStartMs: 0,
        pauseVisualDurationMs: 0,
      });
    }
  }

  const previousLineIndex = findLastEndedLineIndex(playbackPosition, lyrics);
  const nextLineIndex = findFirstUpcomingLineIndex(playbackPosition, lyrics);

  // Keep previous line fully revealed for short inter-line gaps.
  if (previousLineIndex >= 0 && nextLineIndex >= 0) {
    const previous = lyrics[previousLineIndex];
    const next = lyrics[nextLineIndex];
    if (
      playbackPosition >= previous.lineEndTime &&
      playbackPosition < next.lineStartTime
    ) {
      const pauseDuration = Math.max(
        0,
        next.lineStartTime - previous.lineEndTime,
      );
      const isLongPause = pauseDuration >= LONG_PAUSE_THRESHOLD_MS;
      const pauseVisualDuration = Math.max(
        1,
        pauseDuration - PAUSE_DOTS_EARLY_EXIT_MS,
      );
      const pauseVisualEndTime = previous.lineEndTime + pauseVisualDuration;
      const showLongPauseVisuals =
        isLongPause && playbackPosition < pauseVisualEndTime;
      const pauseProgress =
        showLongPauseVisuals && pauseVisualDuration > 0
          ? clamp01(
              (playbackPosition - previous.lineEndTime) / pauseVisualDuration,
            )
          : 0;
      return finalize({
        activeLineStartIndex: showLongPauseVisuals ? -1 : nextLineIndex,
        activeLineEndIndex: showLongPauseVisuals ? -1 : nextLineIndex,
        focusLineIndex: showLongPauseVisuals ? previousLineIndex : nextLineIndex,
        pauseAfterIndex: showLongPauseVisuals ? previousLineIndex : -1,
        pauseBeforeIndex: -1,
        isLongPause: showLongPauseVisuals,
        pauseProgress,
        pauseStartMs: previous.lineEndTime,
        pauseVisualDurationMs: pauseVisualDuration,
      });
    }
  }

  if (previousLineIndex === -1 && nextLineIndex >= 0) {
    const next = lyrics[nextLineIndex];
    if (playbackPosition < next.lineStartTime) {
      const pauseDuration = Math.max(0, next.lineStartTime);
      const isLongPause = pauseDuration >= LONG_PAUSE_THRESHOLD_MS;
      const pauseVisualDuration = Math.max(
        1,
        pauseDuration - PAUSE_DOTS_EARLY_EXIT_MS,
      );
      const pauseVisualEndTime = pauseVisualDuration;
      const showLongPauseVisuals =
        isLongPause && playbackPosition < pauseVisualEndTime;
      const pauseProgress =
        showLongPauseVisuals && pauseVisualDuration > 0
          ? clamp01(playbackPosition / pauseVisualDuration)
          : 0;
      return finalize({
        activeLineStartIndex: -1,
        activeLineEndIndex: -1,
        focusLineIndex: nextLineIndex,
        pauseAfterIndex: -1,
        pauseBeforeIndex: showLongPauseVisuals ? nextLineIndex : -1,
        isLongPause: showLongPauseVisuals,
        pauseProgress,
        pauseStartMs: 0,
        pauseVisualDurationMs: pauseVisualDuration,
      });
    }
  }

  // At song end (no upcoming lines), never show pause dots.
  if (previousLineIndex >= 0 && nextLineIndex === -1) {
    return finalize({
      activeLineStartIndex: -1,
      activeLineEndIndex: -1,
      focusLineIndex: previousLineIndex,
      pauseAfterIndex: -1,
      pauseBeforeIndex: -1,
      isLongPause: false,
      pauseProgress: 0,
      pauseStartMs: 0,
      pauseVisualDurationMs: 0,
    });
  }

  return finalize({
    activeLineStartIndex: -1,
    activeLineEndIndex: -1,
    focusLineIndex: -1,
    pauseAfterIndex: -1,
    pauseBeforeIndex: -1,
    isLongPause: false,
    pauseProgress: 0,
    pauseStartMs: 0,
    pauseVisualDurationMs: 0,
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

const CreditsFooter = memo(function CreditsFooter({
  songwriters,
  lastLyricEndTime,
  onPress,
  style,
  alignRight = false,
}: {
  songwriters: string[];
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
  playbackPosition: number,
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

  // Single primary line: stay on it until it ends, then scroll to the next line.
  if (activeStart >= 0 && activeEnd === activeStart) {
    if (activeStart >= lyrics.length) {
      return null;
    }
    const line = lyrics[activeStart];
    if (!line) {
      return null;
    }
    if (playbackPosition < line.lineEndTime) {
      return { startIndex: activeStart, endIndex: activeStart };
    }
    const nextIndex = activeStart + 1;
    if (nextIndex < lyrics.length) {
      return { startIndex: nextIndex, endIndex: nextIndex };
    }
    return { startIndex: activeStart, endIndex: activeStart };
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

function isIndexWithinRange(index: number, startIndex: number, endIndex: number) {
  return startIndex >= 0 && index >= startIndex && index <= endIndex;
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
  const [windowState, setWindowState] = useState(() =>
    getPlaybackWindowState(
      usePlaybackStore.getState().playbackPosition,
      lyrics,
      backgroundActiveLines,
      timingIndex,
    ),
  );

  useEffect(() => {
    const computeWindowState = () =>
      getPlaybackWindowState(
        usePlaybackStore.getState().playbackPosition,
        lyrics,
        backgroundActiveLines,
        timingIndex,
      );

    setWindowState((prev) => {
      const next = computeWindowState();
      return arePlaybackWindowStatesEqual(prev, next) ? prev : next;
    });

    let previousPosition = usePlaybackStore.getState().playbackPosition;
    return usePlaybackStore.subscribe((state) => {
      const playbackPosition = state.playbackPosition;
      if (playbackPosition === previousPosition) {
        return;
      }
      previousPosition = playbackPosition;
      const next = getPlaybackWindowState(
        playbackPosition,
        lyrics,
        backgroundActiveLines,
        timingIndex,
      );
      setWindowState((prev) =>
        arePlaybackWindowStatesEqual(prev, next) ? prev : next,
      );
    });
  }, [backgroundActiveLines, lyrics, timingIndex]);

  if (lyrics.length === 0) {
    return EMPTY_WINDOW_STATE;
  }

  return windowState;
}

export function LyricsView({
  tapToSeekEnabled,
  showTranslatedText = true,
  previewPositionMs = null,
  autoFollowEnabled = true,
  resumeAutoFollowSignal = 0,
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
  const activeLineTopOffset = landscapeMode
    ? LANDSCAPE_ACTIVE_LINE_TOP_OFFSET
    : ACTIVE_LINE_TOP_OFFSET;
  const topListPadding = landscapeMode
    ? LANDSCAPE_TOP_LIST_PADDING
    : TOP_LIST_PADDING;
  const lyrics = usePlaybackStore((s) => s.lyrics);
  const lyricsSource = usePlaybackStore((s) => s.lyricsSource);
  const lyricsStatusMessage = usePlaybackStore((s) => s.lyricsStatusMessage);
  const lyricsMetadata = usePlaybackStore((s) => s.lyricsMetadata);
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
  const liveWindowState = usePlaybackWindowState(
    lyrics,
    backgroundActiveLines,
    lyricTimingIndex,
  );
  const [listReady, setListReady] = useState(false);
  const listRef = useAnimatedRef<FlashListRef<LyricLineType>>();
  const lyricScrollOffset = useSharedValue(0);
  const lyricScrollActive = useSharedValue(false);
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
  const pendingAnchorRangeRef = useRef<LyricLineRange | null>(null);
  const pendingAnchorAnimatedRef = useRef(true);
  const sourceAutoScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const startupDotsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasShownStartupDotsRef = useRef(false);
  const pendingAnchorRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingAnchorRetryCountRef = useRef(0);
  const hasMountedLyricsChangeEffectRef = useRef(false);
  const lastLyricsSourceRef = useRef<string | null>(null);
  const initialAutoScrollPendingRef = useRef(suppressInitialAutoScrollAnimation);
  const initialAutoScrollSettledRef = useRef(false);
  const lastLayoutSettleSignalRef = useRef(layoutSettleSignal);
  const [startupDotsWarmupActive, setStartupDotsWarmupActive] = useState(false);
  const [isSourceAutoScrollCooldown, setIsSourceAutoScrollCooldown] =
    useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
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
  const effectiveWindowState = useMemo(() => {
    if (!startupDotsWarmupActive) {
      return displayWindowState;
    }
    const focusIndex =
      displayWindowState.focusLineIndex >= 0 ? displayWindowState.focusLineIndex : 0;
    const pauseAfterIndex = focusIndex > 0 ? focusIndex - 1 : -1;
    return {
      ...displayWindowState,
      activeLineStartIndex: -1,
      activeLineEndIndex: -1,
      visualActiveLineStartIndex: -1,
      visualActiveLineEndIndex: -1,
      isLongPause: true,
      pauseProgress: 0,
      pauseAfterIndex,
      pauseBeforeIndex: focusIndex,
    };
  }, [displayWindowState, startupDotsWarmupActive]);
  // ponytail: coarse fingerprint for extraData — only changes when cell rendering
  // actually differs (index boundaries + pause on/off), NOT on every pauseProgress tick
  const extraDataFingerprint = useMemo(
    () =>
      `${effectiveWindowState.activeLineStartIndex}:${effectiveWindowState.activeLineEndIndex}:${effectiveWindowState.visualActiveLineStartIndex}:${effectiveWindowState.visualActiveLineEndIndex}:${effectiveWindowState.focusLineIndex}:${effectiveWindowState.pauseAfterIndex}:${effectiveWindowState.pauseBeforeIndex}:${effectiveWindowState.isLongPause ? 1 : 0}`,
    [
      effectiveWindowState.activeLineStartIndex,
      effectiveWindowState.activeLineEndIndex,
      effectiveWindowState.visualActiveLineStartIndex,
      effectiveWindowState.visualActiveLineEndIndex,
      effectiveWindowState.focusLineIndex,
      effectiveWindowState.pauseAfterIndex,
      effectiveWindowState.pauseBeforeIndex,
      effectiveWindowState.isLongPause,
    ],
  );
  const activeLineIndex = effectiveWindowState.activeLineStartIndex;
  const songwriters = lyricsMetadata.credits?.songwriters || [];
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

    return getAutoScrollTargetRange(
      effectiveWindowState,
      playbackPositionRef.current,
      lyrics,
    );
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
        previousPosition,
        lyrics,
      );
      const nextRange = getAutoScrollTargetRange(
        effectiveWindowStateRef.current,
        playbackPosition,
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
    if (hasShownStartupDotsRef.current || lyrics.length === 0) {
      return;
    }
    hasShownStartupDotsRef.current = true;
    setStartupDotsWarmupActive(true);
    if (startupDotsTimerRef.current) {
      clearTimeout(startupDotsTimerRef.current);
    }
    startupDotsTimerRef.current = setTimeout(() => {
      setStartupDotsWarmupActive(false);
      startupDotsTimerRef.current = null;
    }, STARTUP_DOTS_WARMUP_MS);
  }, [lyrics.length]);

  useEffect(() => {
    if (!autoFollowEnabled) {
      return;
    }
    userScrollInProgressRef.current = false;
    userScrollSessionRef.current = false;
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

  const getScrollOffsetForLineIndex = useCallback(
    (index: number) => {
      const absoluteTop = getAbsoluteLineTop(index);
      if (absoluteTop === null) {
        return null;
      }
      return Math.max(0, absoluteTop - activeLineTopOffset);
    },
    [activeLineTopOffset, getAbsoluteLineTop],
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
      userScrollIdleTimerRef.current = null;
    }, USER_SCROLL_IDLE_RESET_MS);
  }, [clearUserScrollIdleTimer]);

  const scrollToOffset = useCallback(
    (
      offset: number,
      animated: boolean,
      animationStyle: ScrollAnimationStyle,
      startOffset: number,
    ) => {
      if (
        animated &&
        animationStyle === "lyric" &&
        SHOULD_USE_UI_THREAD_SCROLL
      ) {
        cancelAnimation(lyricScrollOffset);
        lyricScrollActive.value = true;
        lyricScrollOffset.value = startOffset;
        lyricScrollOffset.value = withTiming(
          offset,
          {
            duration: LYRIC_SCROLL_ANIMATION_MS,
            easing: LYRIC_SCROLL_EASING,
          },
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
      const isLastLineRange =
        range.endIndex >= lyrics.length - 1 &&
        range.startIndex >= lyrics.length - 1;
      if (creditsActive && songwriters.length > 0 && isLastLineRange) {
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
      const activeRangeFits =
        activeRangeHeight <=
        listHeight - activeLineTopOffset - ACTIVE_RANGE_BOTTOM_PADDING;
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
      creditsActive,
      getAbsoluteLineTop,
      getRangeMetrics,
      getScrollOffsetForLineIndex,
      lyrics.length,
      songwriters.length,
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
      const isLastLineRange =
        range.endIndex >= lyrics.length - 1 &&
        range.startIndex >= lyrics.length - 1;
      if (creditsActive && songwriters.length > 0 && isLastLineRange) {
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
      const activeRangeFits =
        activeRangeHeight <=
        listHeight - activeLineTopOffset - ACTIVE_RANGE_BOTTOM_PADDING;
      const topIsAnchored =
        Math.abs(activeLineViewportTop - activeLineTopOffset) <=
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
      getRangeMetrics,
      getScrollOffsetForRange,
      lyrics.length,
      songwriters.length,
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
  const startupDotsWarmupActiveRef = useRef(startupDotsWarmupActive);
  startupDotsWarmupActiveRef.current = startupDotsWarmupActive;
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
      startupDotsWarmupActiveRef.current ||
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
      if (!force && isRangeAnchoredAndVisible(range)) {
        pendingAnchorRangeRef.current = null;
        return;
      }
      const requestKey = `${range.startIndex}:${range.endIndex}:${Math.round(
        resolvedOffset,
      )}:${Math.round(scrollOffsetRef.current)}:${shouldAnimate ? effectiveAnimationStyle : "i"}`;
      if (!force && lastScrollRequestRef.current === requestKey) {
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
        scrollToOffset(
          resolvedOffset,
          shouldAnimate,
          effectiveAnimationStyle,
          startOffset,
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
      getScrollOffsetForRange,
      isRangeAnchoredAndVisible,
      listReady,
      listRef,
      lyrics.length,
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
    activeLineRef.current = -1;
    scrollOffsetRef.current = 0;
    userScrollInProgressRef.current = false;
    userScrollSessionRef.current = false;
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
  }, [lyrics]);

  // Reset measurement state when layout-affecting props change
  useEffect(() => {
    setAllCellsMeasured(false);
    rowHeightsRef.current.clear();
  }, [fontScale, landscapeMode]);

  useEffect(
    () => () => {
      if (startupDotsTimerRef.current) {
        clearTimeout(startupDotsTimerRef.current);
        startupDotsTimerRef.current = null;
      }
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
    [clearUserScrollIdleTimer, lyricScrollActive, lyricScrollOffset],
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
      programmaticScrollInProgressRef.current = false;
      userScrollInProgressRef.current = false;
      userScrollSessionRef.current = false;
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
      startupDotsWarmupActive ||
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
    startupDotsWarmupActive,
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
      const hasActiveLines = ws.activeLineStartIndex >= 0;
      const isActive =
        hasActiveLines &&
        isIndexWithinRange(
          index,
          ws.activeLineStartIndex,
          ws.activeLineEndIndex,
        );
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
      const showPauseDotsAfter =
        ws.isLongPause && index === ws.pauseAfterIndex;
      const showPauseDotsBefore =
        ws.isLongPause && index === ws.pauseBeforeIndex;

      return (
        <LyricLine
          line={item}
          isActive={isActive}
          isPast={isPast}
          inactiveOpacityDistance={inactiveOpacityDistance}
          showPauseDotsAfter={showPauseDotsAfter}
          showPauseDotsBefore={showPauseDotsBefore}
          pauseStartMs={ws.pauseStartMs}
          pauseVisualDurationMs={ws.pauseVisualDurationMs}
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
        />
      );
    },
    [
      fontScale,
      landscapeMode,
      onLineLongPress,
      onLinePress,
      showTranslatedText,
      tapToSeekEnabled,
      previewPlaybackPosition,
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
        {renderItem({ item, index })}
      </View>
    ),
    [allCellsMeasured, handleCellLayout, landscapeMode, renderItem],
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
        hasCredits: songwriters.length > 0,
        activeLineTopOffset,
      }),
    };
  }, [
    activeLineTopOffset,
    contentLayoutVersion,
    getAbsoluteLineTop,
    getLineHeight,
    lyrics.length,
    songwriters.length,
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
    if (!songwriters.length) {
      return null;
    }
    return (
      <View onLayout={handleCreditsLayout}>
        <CreditsFooter
          songwriters={songwriters}
          lastLyricEndTime={lastLyricEndTime}
          onPress={onCreditsTimestampPress}
        />
      </View>
    );
  }, [
    handleCreditsLayout,
    lastLyricEndTime,
    onCreditsTimestampPress,
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
              { fontSize: STATIC_LYRIC_FONT_SIZE * fontScale },
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
        </View>
      );
    };
    const staticFooter = songwriters.length > 0 ? (
      <View
        style={[
          styles.staticCreditsFooter,
          landscapeMode && styles.staticCreditsFooterLandscape,
        ]}
      >
        <CreditsFooter
          songwriters={songwriters}
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
            landscapeMode && styles.staticLyricsContentLandscape,
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
        extraData={extraDataFingerprint}
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
          userScrollInProgressRef.current = true;
          userScrollSessionRef.current = true;
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
          userScrollInProgressRef.current = true;
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
    paddingHorizontal: 12,
  },
  listContentLandscape: {
    paddingLeft:
      LANDSCAPE_LYRICS_HORIZONTAL_INSET + LANDSCAPE_LYRICS_EDGE_BLEED,
    paddingRight:
      LANDSCAPE_LYRICS_HORIZONTAL_INSET + LANDSCAPE_LYRICS_EDGE_BLEED,
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
    alignItems: "flex-start",
  },
  staticLyricsContentLandscape: {
    alignItems: "flex-end",
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
  creditsTextActive: {
    color: "#FFFFFF",
  },
});
