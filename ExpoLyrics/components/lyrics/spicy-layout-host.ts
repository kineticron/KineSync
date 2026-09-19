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
let animation: { from: number; to: number; start: number; duration: number } | null = null;
let userScrollingUntil = 0;
let userTouching = false;
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
  return animation !== null || (!userTouching && performance.now() < userScrollingUntil);
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
  userTouching = false;
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

// Dynamic scroll pacing mirroring the native AMLL position spring: rapid
// lines snap, spaced lines glide. Range 240-440ms.
export const LYRIC_SCROLL_BASE_DURATION_MS = 440;
const LYRIC_SCROLL_MIN_DURATION_MS = 240;

export function lyricScrollDuration(
  intervalMs: number | undefined,
  seeking: boolean,
  interlude: boolean,
  distancePx: number,
): number {
  if (seeking || interlude || intervalMs === undefined) return LYRIC_SCROLL_BASE_DURATION_MS;
  const clamped = Math.min(800, Math.max(100, intervalMs));
  // Same curve as the native amlPositionSpring stiffness mapping: the ratio
  // approaches 1 for rapid lines and 0 for spaced lines.
  const ratio = (1 - (clamped - 100) / 700) ** 0.2;
  const intervalPart = LYRIC_SCROLL_BASE_DURATION_MS - ratio * 120;
  // Short hops settle quicker than full-screen glides.
  const distanceFactor = Math.max(0, Math.min(1, distancePx / 600));
  return Math.round(
    Math.max(
      LYRIC_SCROLL_MIN_DURATION_MS,
      Math.min(
        LYRIC_SCROLL_BASE_DURATION_MS,
        intervalPart * (0.7 + 0.3 * distanceFactor),
      ),
    ),
  );
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
  userScrollingUntil = performance.now() + 700;
}

export function setLyricsUserTouching(touching: boolean) {
  userTouching = touching;
  noteLyricsUserScroll();
}

/** Momentum keeps ownership until 700ms after the last native scroll event. */
export function noteLyricsViewportScroll() {
  if (!animation && (userTouching || performance.now() < userScrollingUntil)) {
    userScrollingUntil = performance.now() + 700;
  }
}

export function releaseLyricsUserScroll() {
  userTouching = false;
  userScrollingUntil = 0;
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
  const userScrolling = userTouching || now < userScrollingUntil;
  if (userScrolling) {
    if (autoFollow && now >= graceUntil && Math.abs(viewport.scrollTop - target) > 120) {
      onAutoFollowChange(false);
    } else if (!autoFollow && Math.abs(viewport.scrollTop - target) <= 64) {
      onAutoFollowChange(true);
    }
    // Remember that the current scroll position now belongs to the user so a
    // later follow resumes with easing rather than snapping to a stale target.
    lastTarget = null;
    wasFollowing = false;
    lastPosition = position;
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
    if (instant) {
      animation = null;
      viewport.scrollTop = target;
    } else {
      // Dynamic AMLL-style pacing: the interval between the focused line and
      // its predecessor picks the speed, interludes keep the slow default.
      const focusIndex = state.focusLineIndex;
      const interval =
        focusIndex > 0 && focusIndex < lyrics.length
          ? lyrics[focusIndex].lineStartTime - lyrics[focusIndex - 1].lineStartTime
          : undefined;
      animation = {
        from: viewport.scrollTop,
        to: target,
        start: now,
        duration: lyricScrollDuration(
          Number.isFinite(interval) ? interval : undefined,
          seek,
          state.isLongPause,
          Math.abs(target - viewport.scrollTop),
        ),
      };
    }
    lastTarget = target;
  }
  wasFollowing = true;
  if (animation) {
    const progress = Math.min(1, (now - animation.start) / animation.duration);
    viewport.scrollTop = animation.from + (animation.to - animation.from) * lyricScrollEasing(progress);
    if (progress >= 1) animation = null;
  }
}
