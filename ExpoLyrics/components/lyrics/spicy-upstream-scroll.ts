/*
 * Standalone port of Spicy Lyrics v6.3.15 ScrollToActiveLine normal-view
 * behavior. Source: Spikerko/spicy-lyrics @
 * 2a14863f8c29782f9ab3becff2b1360dfb74a4fb.
 *
 * KineSync owns the playback clock and the external auto-follow preference, so
 * those values are supplied by the caller instead of read from Spicetify.
 */
import type { SpicyRuntimeLine } from "./spicy-upstream-runtime";
import {
  getLyricsVirtualizer,
  scrollLyricsToIndex,
} from "./spicy-upstream-virtualizer";

const USER_SCROLL_COOLDOWN = 750;
const VIEWPORT_CHECK_INTERVAL = 350;
const PIN_LOOKAHEAD = 2;
const DRASTIC_POSITION_CHANGE_MS = 1000;
const DOT_LINE_SCROLL_DELAY_MS = 240;
const CENTER_PADDING = 30;

type EnhancedRuntimeLine = SpicyRuntimeLine & { _LineIndex: number };

let lastLine: HTMLElement | null = null;
let isUserScrolling = false;
let lastUserScrollTime = 0;
let lastPosition = 0;

let forceScrollQueued = false;
let smoothForceScrollQueued = false;

let scrolledToLastLine = false;
let scrolledToFirstLine = false;

let lastViewportCheckTime = 0;
let lastViewportLine: HTMLElement | null = null;
let lastViewportContainer: HTMLElement | null = null;
let lastIsLineInViewport = false;

let lastScrollElement: HTMLElement | null = null;

const wasDrasticPositionChange = (previousPosition: number, newPosition: number) =>
  Math.abs(newPosition - previousPosition) > DRASTIC_POSITION_CHANGE_MS;

const isBGLine = (line: SpicyRuntimeLine): boolean => line.BGLine === true;

const resolveToLeadIndex = (lines: SpicyRuntimeLine[], index: number): number => {
  let resolvedIndex = index;
  while (resolvedIndex > 0 && isBGLine(lines[resolvedIndex])) resolvedIndex -= 1;
  return resolvedIndex;
};

const getGroupEndTime = (lines: SpicyRuntimeLine[], leadIndex: number): number => {
  let end = lines[leadIndex].EndTime;
  for (
    let index = leadIndex + 1;
    index < lines.length && isBGLine(lines[index]);
    index += 1
  ) {
    if (lines[index].EndTime > end) end = lines[index].EndTime;
  }
  return end;
};

const getLookaheadLine = (lines: SpicyRuntimeLine[], leadIndex: number) => {
  let remaining = PIN_LOOKAHEAD;
  for (let index = leadIndex + 1; index < lines.length; index += 1) {
    if (isBGLine(lines[index])) continue;
    remaining -= 1;
    if (remaining === 0) return lines[index];
  }
  return null;
};

const getScrollLine = (
  lines: SpicyRuntimeLine[],
  processedPosition: number,
): EnhancedRuntimeLine | null => {
  const activeIndices: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      typeof line.StartTime === "number" &&
      typeof line.EndTime === "number" &&
      line.StartTime <= processedPosition &&
      line.EndTime >= processedPosition
    ) {
      activeIndices.push(index);
    }
  }

  if (activeIndices.length === 0) return null;

  const enhance = (index: number): EnhancedRuntimeLine => ({
    ...lines[index],
    _LineIndex: index,
  });

  let frontLead = -1;
  for (const index of activeIndices) {
    const lead = resolveToLeadIndex(lines, index);
    if (lead > frontLead) frontLead = lead;
  }

  const activeLeads: number[] = [];
  for (const index of activeIndices) {
    const lead = resolveToLeadIndex(lines, index);
    if (isBGLine(lines[index]) && lead < frontLead) continue;
    if (activeLeads[activeLeads.length - 1] !== lead) activeLeads.push(lead);
  }

  const anchorIndex = activeLeads[0];
  const lookahead = getLookaheadLine(lines, anchorIndex);
  if (lookahead === null || getGroupEndTime(lines, anchorIndex) <= lookahead.StartTime) {
    return enhance(anchorIndex);
  }

  const firstIndex = activeLeads[0];
  const lastIndex = activeLeads[activeLeads.length - 1];
  return enhance(lastIndex - firstIndex <= 1 ? firstIndex : lastIndex);
};

function getLyricsContent(scrollEl: HTMLElement | null): HTMLElement | null {
  if (!scrollEl) return null;
  if (scrollEl.classList.contains("LyricsContent")) return scrollEl;
  return scrollEl.closest<HTMLElement>(".LyricsContent");
}

function setHideLineBlur(scrollEl: HTMLElement | null, hidden: boolean): void {
  getLyricsContent(scrollEl)?.classList.toggle("HideLineBlur", hidden);
}

function scrollToLine(index: number, instantScroll: boolean): void {
  scrollLyricsToIndex(index, "center", instantScroll, CENTER_PADDING);
}

/**
 * Mirror Spicy's wheel/touchmove handling. The scroll element is optional so a
 * caller can register it through scrollToActiveLine() once and then simply call
 * noteUserScroll() from subsequent input events.
 */
export function noteUserScroll(scrollEl?: HTMLElement): void {
  if (scrollEl) lastScrollElement = scrollEl;
  if (!isUserScrolling) {
    isUserScrolling = true;
    setHideLineBlur(lastScrollElement, true);
  }
  lastUserScrollTime = performance.now();
}

/** Reset the same controller state that upstream ResetLastLine() resets. */
export function reset(): void {
  lastLine = null;
  lastViewportLine = null;
  lastViewportContainer = null;
  lastIsLineInViewport = false;
  lastViewportCheckTime = 0;
  isUserScrolling = false;
  lastUserScrollTime = 0;
  lastPosition = 0;
  forceScrollQueued = false;
  smoothForceScrollQueued = false;
  scrolledToLastLine = false;
  scrolledToFirstLine = false;
  lastScrollElement = null;
}

/**
 * Port of upstream ScrollToActiveLine() for the standard center-scrolling view.
 * Compact/PIP top-alignment and Spicetify policy/event dependencies are omitted.
 */
export function scrollToActiveLine(
  lines: SpicyRuntimeLine[],
  scrollEl: HTMLElement,
  positionMs: number,
  isPlaying: boolean,
  autoFollowEnabled: boolean,
  force = false,
): void {
  // KineSync's external gate is authoritative. Do not mutate upstream-style
  // controller state while auto-follow is disabled.
  if (!autoFollowEnabled) return;
  if (!lines.length) return;

  lastScrollElement = scrollEl;
  if (force) forceScrollQueued = true;

  const isForceScrollQueued = forceScrollQueued;
  const isSmoothForceScrollQueued = smoothForceScrollQueued;
  const currentLine = getScrollLine(lines, positionMs);

  const allLinesNotSung = lines.every((line) => line.Status === "NotSung");
  const activeLines = lines.filter((line) => line.Status === "Active");
  const sungLines = lines.filter((line) => line.Status === "Sung");
  const oneActiveNoSung = activeLines.length === 1 && sungLines.length === 0;
  const allLinesSung = lines.every((line) => line.Status === "Sung");
  const shouldForceScroll = isForceScrollQueued || lastLine == null;
  const drasticPositionChange =
    lastPosition !== 0 && wasDrasticPositionChange(lastPosition, positionMs);

  if (
    shouldForceScroll ||
    (!isPlaying && lastPosition !== positionMs) ||
    drasticPositionChange
  ) {
    isUserScrolling = false;
    const scrollToElement = allLinesSung
      ? lines[lines.length - 1]?.HTMLElement
      : currentLine?.HTMLElement;
    if (!scrollToElement) return;

    lastLine = scrollToElement;
    const lineIndex = allLinesSung ? lines.length - 1 : currentLine?._LineIndex;
    if (lineIndex === undefined) return;
    scrollToLine(lineIndex, shouldForceScroll || drasticPositionChange);
    if (forceScrollQueued) forceScrollQueued = false;
    lastPosition = positionMs;
    return;
  }

  lastPosition = positionMs;

  if (isSmoothForceScrollQueued) {
    isUserScrolling = false;
    const scrollToElement = allLinesSung
      ? lines[lines.length - 1]?.HTMLElement
      : currentLine?.HTMLElement;
    if (!scrollToElement) return;

    lastLine = scrollToElement;
    const lineIndex = allLinesSung ? lines.length - 1 : currentLine?._LineIndex;
    if (lineIndex === undefined) return;
    scrollToLine(lineIndex, false);
    if (smoothForceScrollQueued) smoothForceScrollQueued = false;
    return;
  }

  if (allLinesNotSung || oneActiveNoSung) {
    if (scrolledToFirstLine) return;
    smoothForceScrollQueued = true;
    scrolledToFirstLine = true;
  }

  if (allLinesSung) {
    if (scrolledToLastLine) return;
    smoothForceScrollQueued = true;
    scrolledToLastLine = true;
  }

  if (!currentLine) return;
  const lineElement = currentLine.HTMLElement;
  if (!lineElement) return;

  const now = performance.now();
  const timeSinceLastScroll = now - lastUserScrollTime;
  const shouldRecalculateViewport =
    now - lastViewportCheckTime > VIEWPORT_CHECK_INTERVAL ||
    lastViewportLine !== lineElement ||
    lastViewportContainer !== scrollEl;

  if (shouldRecalculateViewport) {
    const elementOffsetTop = lineElement.offsetTop;
    const elementBottom = elementOffsetTop + lineElement.clientHeight;
    const viewportTop = scrollEl.scrollTop;
    const viewportBottom = viewportTop + scrollEl.clientHeight;
    const visibleTop = Math.max(elementOffsetTop, viewportTop);
    const visibleBottom = Math.min(elementBottom, viewportBottom);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);

    lastIsLineInViewport = visibleHeight >= 5;
    lastViewportCheckTime = now;
    lastViewportLine = lineElement;
    lastViewportContainer = scrollEl;
  }

  const isLineInViewport =
    lastIsLineInViewport ||
    (getLyricsVirtualizer() !== null && lineElement.isConnected);
  const isSameLine = lastLine === lineElement;

  if (timeSinceLastScroll > USER_SCROLL_COOLDOWN && isLineInViewport) {
    isUserScrolling = false;
    setHideLineBlur(scrollEl, false);

    if (!isSameLine) {
      lastLine = lineElement;
      const scroll = () => {
        scrollToLine(currentLine._LineIndex, false);
        scrolledToLastLine = false;
        scrolledToFirstLine = false;
      };

      if (lines[currentLine._LineIndex - 1]?.DotLine === true) {
        setTimeout(scroll, DOT_LINE_SCROLL_DELAY_MS);
      } else {
        scroll();
      }
    }
  }
}
