/** KineSync owns row layout and scrolling; Spicy owns the text animations. */
import {
  ACTIVE_RANGE_BOTTOM_PADDING,
  getAutoScrollTargetRange,
  getBackgroundActiveLines,
  getBottomListPadding,
  getCreditsAwareScrollOffset,
  getLyricTimingIndex,
  getPlaybackWindowState,
} from "../../lib/lyrics-layout";
import { LANDSCAPE_ACTIVE_LINE_TOP_OFFSET } from "../../constants/player-layout";
import type { LyricLine } from "../../types/bridge";
import type { SpicyRuntimeLine } from "./spicy-upstream-runtime";

let viewport: HTMLElement | null = null;
let container: HTMLElement | null = null;
let rows: HTMLElement[] = [];
let lyrics: LyricLine[] = [];
let backgrounds = getBackgroundActiveLines([]);
let timing = getLyricTimingIndex([]);
let observer: ResizeObserver | null = null;
let layoutDirty = true;
let rowTops: number[] = [];
let rowHeights: number[] = [];
let lastTarget: number | null = null;
let animation: { from: number; to: number; start: number } | null = null;
let userScrollingUntil = 0;
let graceUntil = 0;
let wasFollowing = true;
let lastPosition = 0;
let dots: SpicyRuntimeLine[] = [];
let visibleDot: HTMLElement | null = null;
let runtimeByRow: SpicyRuntimeLine[][] = [];
let visibleStart = -1;
let visibleEnd = -1;
let visibleLines: SpicyRuntimeLine[] = [];
let viewportHeight = 0;
let topOffset = 0;
let creditsLayout: { top: number; bottom: number } | null = null;
let statePosition = NaN;
let playbackState = getPlaybackWindowState(0, []);
let preactiveRow: HTMLElement | null = null;
let onLayoutChange = () => {};

export function getLyricsPlaybackState(position: number) {
  if (position !== statePosition) {
    playbackState = getPlaybackWindowState(position, lyrics, backgrounds, timing);
    statePosition = position;
  }
  return playbackState;
}

export function isLyricsScrollAnimating() {
  return animation !== null || performance.now() < userScrollingUntil;
}

// Keep measured rows in the flow, but only animate/paint the viewport and a
// 320px overscan. Binary search makes this independent of song length per frame.
export function getVisibleLyricsLines() {
  if (!viewport || !rowTops.length) return visibleLines;
  const min = viewport.scrollTop - 320;
  const max = viewport.scrollTop + viewportHeight + 320;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rowTops[mid] + rowHeights[mid] < min) low = mid + 1;
    else high = mid;
  }
  const start = low;
  while (low < rows.length && rowTops[low] <= max) low++;
  const end = low;
  if (start !== visibleStart || end !== visibleEnd) {
    for (let i = Math.max(0, visibleStart); i < visibleEnd; i++) {
      if (i < start || i >= end) rows[i].classList.add("ks-offscreen");
    }
    visibleLines = [];
    for (let i = start; i < end; i++) {
      rows[i].classList.remove("ks-offscreen");
      visibleLines.push(...runtimeByRow[i]);
    }
    visibleStart = start;
    visibleEnd = end;
  }
  return visibleLines;
}

export function destroyLyricsLayout() {
  observer?.disconnect();
  observer = null;
  viewport = null;
  container = null;
  rows = [];
  dots = [];
  visibleDot = null;
  preactiveRow = null;
  visibleStart = visibleEnd = -1;
  visibleLines = [];
  runtimeByRow = [];
  rowTops = rowHeights = [];
  statePosition = NaN;
  onLayoutChange = () => {};
  userScrollingUntil = 0;
  resetLyricsScroll();
}

export function resetLyricsScroll() {
  animation = null;
  lastTarget = null;
  lastPosition = 0;
  layoutDirty = true;
}

export function remeasureLyricsLayout() {
  layoutDirty = true;
  onLayoutChange();
}

export function initLyricsLayout(
  scrollElement: HTMLElement,
  content: HTMLElement,
  lines: SpicyRuntimeLine[],
  source: LyricLine[],
  onChange: () => void = () => {},
) {
  destroyLyricsLayout();
  viewport = scrollElement;
  container = content;
  lyrics = source;
  backgrounds = getBackgroundActiveLines(source);
  timing = getLyricTimingIndex(source);
  onLayoutChange = onChange;
  runtimeByRow = source.map(() => []);
  for (const line of lines) {
    if (!line.DotLine && line.sourceIndex !== undefined) runtimeByRow[line.sourceIndex]?.push(line);
  }
  graceUntil = performance.now() + 2000;
  wasFollowing = true;
  rows = source.map((line, index) => {
    const row = document.createElement("div");
    row.className = "ks-lyric-row";
    row.classList.add("ks-offscreen");
    row.dataset.sourceIndex = String(index);
    const inner = document.createElement("div");
    inner.className = "ks-lyric-inner";
    const opposite = Boolean(line.oppositeAligned);
    const right = scrollElement.closest(".landscape") ? !opposite : opposite;
    row.classList.toggle("ks-align-right", right);
    const group = runtimeByRow[index];
    // Background vocals always occupy their own space below the lead, as on main.
    for (const runtime of group) {
      runtime.HTMLElement.classList.toggle("OppositeAligned", right);
      inner.appendChild(runtime.HTMLElement);
    }
    row.appendChild(inner);
    content.appendChild(row);
    return row;
  });
  dots = lines.filter((line) => line.DotLine);
  for (const dot of dots) {
    const next = source.findIndex((line) => line.lineStartTime >= dot.EndTime);
    const rowIndex = Math.max(0, next - 1);
    const row = rows[rowIndex];
    if (!row) continue;
    runtimeByRow[rowIndex].push(dot);
    dot.HTMLElement.classList.add("ks-pause-dots");
    dot.HTMLElement.hidden = true;
    if (next === 0) row.prepend(dot.HTMLElement);
    else row.appendChild(dot.HTMLElement);
  }
  observer = new ResizeObserver(remeasureLyricsLayout);
  observer.observe(scrollElement);
  for (const row of rows) observer.observe(row);
  const credits = document.getElementById("spicyCredits");
  if (credits) observer.observe(credits);
}

// CSS ease-out used by the original native scroll: cubic-bezier(.22,.88,.34,1).
export function lyricScrollEasing(progress: number) {
  const x = Math.max(0, Math.min(1, progress));
  const bezier = (t: number, a: number, b: number) =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 16; i++) {
    const t = (low + high) / 2;
    if (bezier(t, 0.22, 0.34) < x) low = t;
    else high = t;
  }
  return bezier((low + high) / 2, 0.88, 1);
}

export function noteLyricsUserScroll() {
  animation = null;
  lastTarget = null;
  userScrollingUntil = performance.now() + 700;
}

export function scrollToActiveLine(
  position: number,
  autoFollow: boolean,
  force: boolean,
  onAutoFollowChange: (enabled: boolean) => void,
) {
  if (!viewport || !container || !lyrics.length) return;
  const now = performance.now();
  const state = getLyricsPlaybackState(position);
  const index = state.activeLineStartIndex;
  const nextPreactive = index >= 0 && position < lyrics[index].lineStartTime ? rows[index] : null;
  if (nextPreactive !== preactiveRow) {
    preactiveRow?.classList.remove("ks-preactive");
    nextPreactive?.classList.add("ks-preactive");
    preactiveRow = nextPreactive;
  }
  const range = getAutoScrollTargetRange(state, position, lyrics);
  const nextDot = state.isLongPause
    ? dots.find((dot) => position >= dot.StartTime && position < dot.EndTime)?.HTMLElement ?? null
    : null;
  if (nextDot !== visibleDot) {
    if (visibleDot) visibleDot.hidden = true;
    if (nextDot) nextDot.hidden = false;
    visibleDot = nextDot;
    layoutDirty = true;
  }
  if (!range) return;
  if (layoutDirty) {
    topOffset = viewport.closest(".landscape") ? LANDSCAPE_ACTIVE_LINE_TOP_OFFSET : 0;
    viewportHeight = viewport.clientHeight;
    if (viewportHeight <= 0) return;
    // Read untransformed layout boxes: animated word lifts/scales never move the anchor.
    rowTops = rows.map((row) => container!.offsetTop + row.offsetTop);
    rowHeights = rows.map((row) => row.offsetHeight);
    const credits = document.getElementById("spicyCredits");
    const hasCredits = Boolean(credits && !credits.hidden);
    creditsLayout = hasCredits && credits
      ? { top: credits.offsetTop, bottom: credits.offsetTop + credits.offsetHeight }
      : null;
    const padding = getBottomListPadding({
      viewportHeight,
      lyricsLength: lyrics.length,
      lastLineTop: rowTops[rowTops.length - 1] ?? null,
      lastLineHeight: rowHeights[rowHeights.length - 1] ?? 0,
      creditsLayout,
      hasCredits,
      activeLineTopOffset: topOffset,
    });
    container.parentElement?.style.setProperty("padding-bottom", `${padding}px`);
    layoutDirty = false;
  }
  const height = viewportHeight;
  const top = rowTops[range.startIndex];
  const bottom = rowTops[range.endIndex] + rowHeights[range.endIndex];
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return;
  let target = bottom - top <= height - topOffset - ACTIVE_RANGE_BOTTOM_PADDING
    ? Math.max(0, top - topOffset)
    : Math.max(0, bottom - height + ACTIVE_RANGE_BOTTOM_PADDING);
  if (creditsLayout && position >= lyrics[lyrics.length - 1].lineEndTime) {
    target = getCreditsAwareScrollOffset({
      range, lyricsLength: lyrics.length, listHeight: height,
      creditsLayout,
      getAbsoluteLineTop: (index) => rowTops[index] ?? null,
      creditsActive: true, hasCredits: true, activeLineTopOffset: topOffset,
    }) ?? target;
  }
  const userScrolling = now < userScrollingUntil;
  if (userScrolling) {
    if (autoFollow && now >= graceUntil && Math.abs(viewport.scrollTop - target) > 120) {
      onAutoFollowChange(false);
    } else if (!autoFollow && Math.abs(viewport.scrollTop - target) <= 64) {
      onAutoFollowChange(true);
    }
    return;
  }
  if (!autoFollow) {
    wasFollowing = false;
    animation = null;
    lastTarget = null;
    return;
  }
  const seek = Math.abs(position - lastPosition) > 1000;
  lastPosition = position;
  if (lastTarget === null || Math.abs(lastTarget - target) > 2 || force || !wasFollowing) {
    const instant = (lastTarget === null && wasFollowing) || seek;
    animation = instant ? null : { from: viewport.scrollTop, to: target, start: now };
    if (instant) viewport.scrollTop = target;
    lastTarget = target;
  }
  wasFollowing = true;
  if (animation) {
    const progress = Math.min(1, (now - animation.start) / 440);
    viewport.scrollTop = animation.from + (animation.to - animation.from) * lyricScrollEasing(progress);
    if (progress >= 1) animation = null;
  }
}
