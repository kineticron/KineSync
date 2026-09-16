// Native port of @applemusic-like-lyrics/core 0.5.2 (AGPL-3.0-only).
// Reference: amll-dev/applemusic-like-lyrics, lyric-player/{base,dom}.
// Keep these functions independent of React so the production worklets can be
// checked against the reference timeline, including seeks and paused frames.
import type { LyricSyllable } from "@/types/bridge";

export const AMLL_POSITION_SPRING = { mass: 0.9, damping: 15, stiffness: 90, overshootClamping: false } as const;
export const AMLL_SCALE_SPRING = { mass: 2, damping: 25, stiffness: 100, overshootClamping: false } as const;
export const AMLL_BG_SCALE_SPRING = { mass: 1, damping: 20, stiffness: 50, overshootClamping: false } as const;
// AMLL's default `wordFadeWidth` is 0.5. Keep the native feather tied to the
// same line-height ratio instead of widening it independently.
export const AMLL_WORD_FADE_WIDTH = 0.5;

export function amlPositionSpring(interval: number | undefined, seeking: boolean, interlude: boolean) {
  if (seeking || interlude || interval === undefined) return AMLL_POSITION_SPRING;
  const ratio = (1 - (Math.min(800, Math.max(100, interval)) - 100) / 700) ** 0.2;
  const stiffness = 170 + ratio * 50;
  return { mass: 0.9, stiffness, damping: Math.sqrt(stiffness) * 2.2, overshootClamping: false as const };
}

export function clampAml(value: number) {
  "worklet";
  return Math.max(0, Math.min(1, value));
}

function coordinate(t: number, p1: number, p2: number) {
  "worklet";
  return 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3;
}

export function amlBezier(x: number, x1: number, y1: number, x2: number, y2: number) {
  "worklet";
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    if (coordinate(mid, x1, x2) < x) low = mid;
    else high = mid;
  }
  return coordinate((low + high) / 2, y1, y2);
}

export function amlFloat(position: number, start: number, end: number, fontSize: number, background: boolean) {
  "worklet";
  const p = clampAml((position - start) / Math.max(1000, end - start));
  return -fontSize * (background ? 0.1 : 0.05) * amlBezier(p, 0, 0, 0.58, 1);
}

export function shouldEmphasizeAml(text: string, duration: number) {
  const cjk = /^[\p{Unified_Ideograph}\u0800-\u9FFC]+$/u.test(text);
  return duration >= 1000 && (cjk || (text.trim().length > 1 && text.trim().length <= 7));
}

export function amlEmphasisParameters(duration: number, lastWord: boolean) {
  let du = Math.max(1000, duration);
  const a = du / 2000;
  const b = du / 3000;
  const amount = Math.min(1.2, (a > 1 ? Math.sqrt(a) : a ** 3) * 0.6 * (lastWord ? 1.6 : 1));
  const blur = Math.min(0.8, (b > 1 ? Math.sqrt(b) : b ** 3) * 0.5 * (lastWord ? 1.5 : 1));
  if (lastWord) du *= 1.2;
  return { duration: du, amount, blur };
}

function emphasisEase(p: number) {
  "worklet";
  return p < 0.5 ? amlBezier(p * 2, 0.2, 0.4, 0.58, 1) : 1 - amlBezier((p - 0.5) * 2, 0.3, 0, 0.58, 1);
}

// AMLL emits 32 linear Web Animation keyframes, not a continuous sine/easing.
function sampledEnvelope(p: number, floating: boolean) {
  "worklet";
  const frame = clampAml(p) * 32;
  const left = Math.floor(frame);
  const right = Math.min(32, left + 1);
  const a = floating ? Math.sin(left / 32 * Math.PI) : emphasisEase(left / 32);
  const b = floating ? Math.sin(right / 32 * Math.PI) : emphasisEase(right / 32);
  return a + (b - a) * (frame - left);
}

export function amlEmphasis(position: number, start: number, index: number, count: number,
  params: ReturnType<typeof amlEmphasisParameters>, fontSize: number, background: boolean) {
  "worklet";
  const delay = start + params.duration / 2.5 / Math.max(1, count) * index;
  const glow = sampledEnvelope((position - delay) / params.duration, false);
  const floating = sampledEnvelope((position - delay + 400) / (params.duration * 1.4), true);
  const scale = 1 + glow * 0.1 * params.amount;
  return {
    scale,
    x: -glow * 0.03 * params.amount * (count / 2 - index) * fontSize * scale,
    y: -glow * 0.025 * params.amount * fontSize * scale - floating * (background ? 0.1 : 0.05) * fontSize,
    shadowOpacity: glow * params.blur,
    shadowRadius: Math.min(0.3, params.blur * 0.3) * fontSize,
  };
}

// A single measured cursor crosses the whole line. AMLL's WebMaskAnimator
// serializes each timed word/syllable on one mask timeline: positive gaps are
// held, while overlapping source windows do NOT advance two segments at once.
// That distinction matters for providers whose syllable ranges overlap; using
// each absolute range independently makes whole groups brighten together.
export function amlMaskCursor(
  position: number,
  words: readonly LyricSyllable[],
  widths: readonly number[],
  fade: number,
  lineStartTime = words[0]?.startTime ?? 0,
  lineEndTime = Math.max(lineStartTime, ...words.map((word) => word.endTime)),
) {
  "worklet";
  let cursor = -2 * fade;
  if (words.length === 0) return cursor;

  // Mirror WebMaskAnimator's generated keyframe timeline. Movement segments
  // are serialized, positive source gaps become holds, and duplicate keyframes
  // beyond the line duration resolve to the fully-revealed endpoint at the
  // line boundary.
  const totalDuration = Math.max(0, lineEndTime - lineStartTime);
  const relativePosition = Math.max(0, Math.min(totalDuration, position - lineStartTime));
  const atLineEnd = position >= lineEndTime;
  let timelinePosition = 0;
  let sourceTimestamp = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const duration = Math.max(0, word.endTime - word.startTime);
    const relativeStart = word.startTime - lineStartTime;
    const staticDuration = relativeStart - sourceTimestamp;
    if (staticDuration > 0) {
      if (!atLineEnd && relativePosition < timelinePosition + staticDuration) {
        return cursor;
      }
      timelinePosition += staticDuration;
    }
    sourceTimestamp = relativeStart;

    const move =
      (widths[i] || 0) +
      (i === 0 ? fade * 1.5 : 0) +
      (i === words.length - 1 ? fade * 0.5 : 0);
    if (!atLineEnd) {
      if (duration > 0 && relativePosition < timelinePosition + duration) {
        cursor += move * clampAml((relativePosition - timelinePosition) / duration);
        return cursor;
      }
      if (duration === 0 && relativePosition < timelinePosition) {
        return cursor;
      }
    }
    cursor += move;
    timelinePosition += duration;
    sourceTimestamp += duration;
  }
  return cursor;
}

// AMLL's calculation-based mask fallback advances a word from its own timing
// and geometry. The native renderer uses this path so a syllable never depends
// on preceding siblings having completed their asynchronous RN onLayout pass.
// `textWidth` is the measured glyph run only; `padding` is the extra mask room
// on each side used for floating/emphasis without clipping.
export function amlTokenMaskOffset(
  position: number,
  startTime: number,
  endTime: number,
  textWidth: number,
  padding: number,
  fade: number,
) {
  "worklet";
  const safeTextWidth = Math.max(0, textWidth);
  const safePadding = Math.max(0, padding);
  const safeFade = Math.max(0, fade);
  const totalWordWidth = safeTextWidth + safePadding * 2;
  const duration = Math.max(Math.abs(endTime - startTime), 1);
  const speed = safeTextWidth / duration;
  const startPos = safePadding - totalWordWidth - safeFade / 2;
  const minOffset = -totalWordWidth - safeFade;
  const maskPos = startPos + (position - startTime) * speed;
  return Math.max(minOffset, Math.min(0, maskPos));
}

export function amlBlur(index: number, focus: number, latest: number, active: boolean, scrolling: boolean) {
  if (active || scrolling) return 0;
  const distance = index < focus ? Math.abs(focus - index) + 1 : Math.abs(index - Math.max(focus, latest));
  return Math.min(5, (1 + distance) * 0.8);
}

export function amlStagger(index: number, firstVisible: number, focus: number) {
  let delay = 0;
  let step = 50;
  for (let i = firstVisible; i < index; i++) {
    delay += step;
    if (i >= focus) step /= 1.05;
  }
  return delay;
}

function easeInOutBack(x: number) {
  "worklet";
  const c = 1.70158 * 1.525;
  return x < 0.5 ? (2 * x) ** 2 * ((c + 1) * 2 * x - c) / 2
    : ((2 * x - 2) ** 2 * ((c + 1) * (x * 2 - 2) + c) + 2) / 2;
}

export function amlInterlude(elapsed: number, duration: number) {
  "worklet";
  if (elapsed < 0 || elapsed >= duration || duration <= 0) return { opacity: 0, scale: 0, dots: [0, 0, 0] };
  const period = duration / Math.ceil(duration / 1500);
  let scale = 1 + Math.sin(1.5 * Math.PI - elapsed / period * 2) / 20;
  if (elapsed < 2000) scale *= 1 - 2 ** (-10 * elapsed / 2000);
  const remaining = duration - elapsed;
  if (remaining < 750) scale *= 1 - easeInOutBack((750 - remaining) / 1500);
  const opacity = clampAml((elapsed - 500) / 500) * clampAml(remaining / 375);
  const fillDuration = Math.max(1, duration - 750);
  return { opacity, scale: Math.max(0, scale) * 0.7,
    dots: [0, 1, 2].map(i => Math.max(0.25, Math.min(1, (elapsed - fillDuration / 3 * i) * 3 / fillDuration * 0.75))) };
}
