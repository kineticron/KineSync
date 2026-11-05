import { createContext, useMemo } from 'react';
import { useAnimatedReaction, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import type { PlaybackWindowState } from '@/lib/lyrics-layout';
import type { BlurGeometry } from './native-shared-blur';

export type MeasuredRow = BlurGeometry[number];
export type ProgressiveGeometry = MeasuredRow[];
export type Protection = { first: number; index: number; top: number; bottom: number };
type ProgressiveBlur = { rows: SharedValue<ProgressiveGeometry>; anchor: SharedValue<number>; upperAnchor: SharedValue<number>; protection: SharedValue<Protection> };
export const NativeProgressiveBlurContext = createContext<ProgressiveBlur | null>(null);

/** Dots live inside the upcoming lyric row, so protect that entire row.
 * Ordinary voices protect the row after the LAST active voice, including overlaps. */
export function measuredProtection(rows: ProgressiveGeometry, window: PlaybackWindowState, time: number): Protection {
  'worklet';
  let last = window.visualActiveLineEndIndex;
  let first = window.visualActiveLineStartIndex;
  let dots = -1;
  rows.forEach((row, index) => {
    if (row.voices ? row.voices.some((voice: { start: number; end: number }) => time >= voice.start && time < voice.end) : time >= row.start && time < row.end) { last = Math.max(last, index); first = first < 0 ? index : Math.min(first, index); }
    if (row.interlude && time >= row.interlude.start && time < row.interlude.end) dots = Math.max(dots, index);
  });
  const index = Math.min(rows.length - 1, Math.max(last + 1, dots, last < 0 ? window.focusLineIndex : -1, 0));
  first = first < 0 ? Math.max(0, dots, window.focusLineIndex) : first;
  const upper = rows[first];
  const top = upper && Number.isFinite(upper.y) && Number.isFinite(upper.height) && upper.height > 0 ? upper.y : -Infinity;
  const row = rows[index];
  const bottom = row && Number.isFinite(row.y) && Number.isFinite(row.height) && row.height > 0
    ? row.y + row.height : Infinity;
  return { first, index, top, bottom };
}

/** Per-voice Gaussian radius from measured content points. Never guess an edge
 * for a missing row. Whole protected rows stay sharp even during cue animation. */
export function measuredBlurRadius(index: number, rows: ProgressiveGeometry, protection: Protection, anchor: number, upperAnchor = protection.top) {
  'worklet';
  const row = rows[index];
  if (!row || !Number.isFinite(protection.bottom) || !Number.isFinite(anchor) ||
    !Number.isFinite(row.y) || !Number.isFinite(row.height) || row.height <= 0) return 0;
  if (index < protection.first) return Number.isFinite(upperAnchor)
    ? Math.min(6.83125, Math.max(0, upperAnchor - row.y - row.height) / 80) : 0;
  if (index <= protection.index || row.y <= protection.bottom) return 0;
  return Math.min(6.83125, Math.max(0, row.y - anchor) / 80);
}

export function useMeasuredProgressiveBlur(enabled: boolean, rows: SharedValue<ProgressiveGeometry>, window: SharedValue<PlaybackWindowState>,
  position: SharedValue<number>, seekVersion: SharedValue<number>, deadlines: number[]) {
  const protection = useSharedValue<Protection>({ first: 0, index: -1, top: -Infinity, bottom: Infinity });
  const anchor = useSharedValue(Infinity);
  const upperAnchor = useSharedValue(-Infinity);
  useAnimatedReaction(() => {
    let low = 0, high = deadlines.length;
    while (low < high) { const mid = (low + high) >>> 1; if (deadlines[mid] <= position.value) low = mid + 1; else high = mid; }
    return { enabled, rows: rows.value, window: window.value, seek: seekVersion.value, bucket: low };
  }, (next, previous) => {
    if (!next.enabled) return;
    if (previous && next.rows === previous.rows && next.window === previous.window && next.seek === previous.seek && next.bucket === previous.bucket) return;
    const target = measuredProtection(next.rows, next.window, position.value);
    const old = protection.value;
    const reset = !previous || !previous.enabled || next.seek !== previous.seek || !Number.isFinite(old.bottom) || !Number.isFinite(target.bottom);
    protection.value = target;
    if (reset || target.top !== old.top) upperAnchor.value = reset || !Number.isFinite(old.top) || !Number.isFinite(target.top) ? target.top : withTiming(target.top, { duration: 240 });
    if (reset || target.bottom !== old.bottom) anchor.value = reset ? target.bottom : withTiming(target.bottom, { duration: 240 });
  });
  return useMemo(() => enabled ? { rows, protection, anchor, upperAnchor } : null, [anchor, enabled, protection, rows, upperAnchor]);
}
