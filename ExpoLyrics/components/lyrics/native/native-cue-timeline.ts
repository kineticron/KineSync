import { getBackgroundActiveLines, getLyricTimingIndex, getPlaybackWindowState, type PlaybackWindowState } from '@/lib/lyrics-layout';
import type { LyricLine } from '@/types/bridge';

// Word clocks already run on UI. Notify RN only when line/focus/interlude state changes.
function samePresentation(a: PlaybackWindowState, b: PlaybackWindowState) {
  return a.activeLineStartIndex === b.activeLineStartIndex && a.activeLineEndIndex === b.activeLineEndIndex &&
    a.visualActiveLineStartIndex === b.visualActiveLineStartIndex && a.visualActiveLineEndIndex === b.visualActiveLineEndIndex &&
    a.focusLineIndex === b.focusLineIndex && a.isLongPause === b.isLongPause &&
    a.pauseStartMs === b.pauseStartMs && a.pauseVisualDurationMs === b.pauseVisualDurationMs &&
    a.pauseBeforeIndex === b.pauseBeforeIndex && a.pauseAfterIndex === b.pauseAfterIndex;
}

export function buildNativeCueTimeline(lyrics: LyricLine[], backgrounds = getBackgroundActiveLines(lyrics), timing = getLyricTimingIndex(lyrics)) {
  const candidates = [...new Set([0, ...lyrics.flatMap((line, index) => [line.lineStartTime, line.lineEndTime,
    timing.endTimeByIndex[index], Math.max(0, line.lineStartTime - 500)])])].sort((a, b) => a - b);
  const cues: number[] = [];
  const windows: PlaybackWindowState[] = [];
  for (const time of candidates) {
    const window = getPlaybackWindowState(time, lyrics, backgrounds, timing);
    if (windows.length && samePresentation(windows[windows.length - 1], window)) continue;
    cues.push(time); windows.push(window);
  }
  return { cues, windows };
}
