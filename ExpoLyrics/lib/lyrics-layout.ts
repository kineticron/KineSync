import type { LyricLine as LyricLineType } from "@/types/bridge";

// KineSync native layout/timeline policy, shared by both renderer hosts.
export const LYRICS_LAYOUT = {
  fontSize: 32,
  lineHeight: 42,
  activeScale: 1.05,
  backgroundScale: 0.62,
  rowMinHeight: 84,
  rowPadding: 10,
  pressPadding: 2,
  listInset: 12,
  innerInset: 16,
  landscapeInnerInset: 2,
  textLane: "88%",
} as const;
export const LONG_PAUSE_THRESHOLD_MS = 3000;

export const PAUSE_DOTS_EARLY_EXIT_MS = 500;

export const TOP_LIST_PADDING = 150;

export const BOTTOM_LIST_PADDING = 280;

export const ACTIVE_LINE_TOP_OFFSET = 0;

export const ACTIVE_RANGE_BOTTOM_PADDING = 24;

export const STARTUP_DOTS_WARMUP_MS = 100;

export const LYRICS_JS_UPDATE_RADIUS = 1;

export type LyricLineRange = {
  startIndex: number;
  endIndex: number;
};

export type PlaybackWindowState = {
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

export type BackgroundActiveLine = {
  index: number;
  lineEndTime: number;
  backgroundEndTime: number;
};

export type LyricTimingIndex = {
  maxEndTimeByIndex: number[];
};

export type PlaybackWindowStateWithoutComputedRanges = Omit<
  PlaybackWindowState,
  "visualActiveLineStartIndex" | "visualActiveLineEndIndex"
>;

export const EMPTY_WINDOW_STATE: PlaybackWindowState = {
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

export function arePlaybackWindowStatesEqual(
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

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function findActiveLineIndex(positionMs: number, lyrics: LyricLineType[]) {
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

export function findLastStartedLineIndex(positionMs: number, lyrics: LyricLineType[]) {
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

export function findLastEndedLineIndex(positionMs: number, lyrics: LyricLineType[]) {
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

export function findFirstUpcomingLineIndex(
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

export function getBackgroundEndTime(line: LyricLineType) {
  const backgroundSyllables = line.backgroundSyllables;
  if (!backgroundSyllables?.length) {
    return line.lineEndTime;
  }
  return Math.max(
    line.lineEndTime,
    backgroundSyllables[backgroundSyllables.length - 1].endTime,
  );
}

export function getBackgroundActiveLines(lyrics: LyricLineType[]) {
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

export function getLyricTimingIndex(lyrics: LyricLineType[]): LyricTimingIndex {
  const maxEndTimeByIndex: number[] = [];
  let maxEndTime = 0;

  for (let index = 0; index < lyrics.length; index += 1) {
    maxEndTime = Math.max(maxEndTime, lyrics[index].lineEndTime);
    maxEndTimeByIndex.push(maxEndTime);
  }

  return { maxEndTimeByIndex };
}

export function extendLineIndexRange(
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

export function isLineInPrimaryWindow(
  playbackPosition: number,
  line: LyricLineType,
) {
  return (
    playbackPosition >= line.lineStartTime &&
    playbackPosition < line.lineEndTime
  );
}

export function addVisualActiveRange(
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

export function getPlaybackWindowState(
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

export type CreditsLayout = {
  top: number;
  bottom: number;
};

export function getCreditsAwareScrollOffset({
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

export function getMaxScrollTarget({
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

export function getBottomListPadding({
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

export function getFocusIndexAtPosition(positionMs: number, lyrics: LyricLineType[]) {
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

export function getAutoScrollTargetRange(
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

export function areLyricLineRangesEqual(
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

export function isIndexWithinRange(index: number, startIndex: number, endIndex: number) {
  return startIndex >= 0 && index >= startIndex && index <= endIndex;
}

export function isIndexWithinUpdateWindow(
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
