/** Opt-in, memory-only telemetry. Exports only whitelisted timing fields and temporary identity labels.
 * Source monotonic time is unavailable; local receipt is JS callback/body receipt,
 * not hardware arrival. This module does not estimate clocks or alter playback. */
export type ClockStamp = Readonly<{ wallMs: number; monotonicMs: number }>;
export type NumericEvidence = number | 'missing' | 'invalid' | 'nonfinite';
export type TimingOrigin = 'dealer' | 'registration' | 'parser';
export type TimingContext = {
  receipt?: ClockStamp;
  origin?: TimingOrigin;
  connectionId?: string;
  generation?: number;
};
export type TimingAnchor = Readonly<{
  capture: number;
  schemaPath: string;
  positionField: 'position_as_of_timestamp' | 'position' | 'progress_ms';
  rawPositionMs: NumericEvidence;
  rawTimestampMs: NumericEvidence;
  sourceMonotonicMs: null;
  receipt: ClockStamp;
  parsed: ClockStamp;
  origin: TimingOrigin;
  device: string | null;
  session: string | null;
  connection: string | null;
  generation: number | null;
  clusterChangedMs: NumericEvidence;
  clusterServerMs: NumericEvidence;
  clusterTransferMs: NumericEvidence;
  clusterStartedPlayingMs: NumericEvidence;
}>;
type TimingValues = Readonly<{
  positionMs?: NumericEvidence;
  basisMs?: NumericEvidence;
  normalizedTimestampMs?: NumericEvidence;
  storeSourceClockMs?: NumericEvidence;
  rejection?: 'mode' | 'older-local-packet';
  playing?: boolean;
  latencyMs?: NumericEvidence;
  projectedBeforeMs?: NumericEvidence;
  preserveAnchor?: boolean;
  seekDetected?: boolean;
}>;
type TimingStage = 'accepted' | 'duplicate' | 'stale' | 'foreground-replay' | 'packet' | 'store' | 'store-rejected';
type TimingRecord = Readonly<{ stage: TimingStage; anchor: TimingAnchor; processed: ClockStamp; values: TimingValues }>;
const MAX_RECORDS = 256;
const DURATION_MS = 60_000;
let capture = 0;
let deadline = 0;
let enabled = false;
let records: TimingRecord[] = [];
let aliases = new Map<string, string>();
let nextAlias = 0;
let packets = new WeakMap<object, TimingAnchor>();

export function timingNow(wallMs = Date.now()): ClockStamp {
  return Object.freeze({ wallMs, monotonicMs: performance.now() });
}
export function timingCaptureActive(): boolean {
  if (enabled && performance.now() >= deadline) { enabled = false; aliases.clear(); }
  return enabled;
}
export function startTimingCapture() {
  capture++; records = []; aliases.clear(); nextAlias = 0;
  packets = new WeakMap(); deadline = performance.now() + DURATION_MS; enabled = true;
}
export function clearTimingCapture() {
  enabled = false; records = []; aliases.clear(); packets = new WeakMap();
}
export function timingSnapshot() {
  return { version: 1, active: timingCaptureActive(), durationMs: DURATION_MS, maxRecords: MAX_RECORDS,
    clockCalibration: 'none', receiptSemantics: 'local JS callback or response body receipt', records: records.slice() };
}
export function numericEvidence(value: unknown): NumericEvidence {
  if (value === undefined || value === null) return 'missing';
  // Do not copy arbitrary strings (even in fields nominally containing numbers).
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && value.length <= 24)) return 'invalid';
  const number = Number(value);
  return Number.isFinite(number) ? number : 'nonfinite';
}
export function timingAlias(kind: 'device' | 'session' | 'connection', value: unknown): string | null {
  if (!timingCaptureActive() || typeof value !== 'string' || !value) return null;
  // Per-capture labels, not unsalted persistent hashes. Bound retained raw keys.
  const key = `${kind}:${value.slice(0, 256)}`;
  let alias = aliases.get(key);
  if (!alias) {
    if (aliases.size >= 64) aliases.delete(aliases.keys().next().value!);
    alias = `${kind}-${++nextAlias}`; aliases.set(key, alias);
  }
  return alias;
}
export function timingCaptureId() { return capture; }
export function recordTiming(stage: TimingStage, anchor: TimingAnchor | undefined, values: TimingValues = {}) {
  if (!timingCaptureActive() || !anchor || anchor.capture !== capture) return;
  if (records.length >= MAX_RECORDS) records.shift();
  records.push(Object.freeze({ stage, anchor, processed: timingNow(), values: Object.freeze(values) }));
}
export function tagTimingPacket(packet: object, anchor: TimingAnchor | undefined) {
  if (timingCaptureActive() && anchor?.capture === capture) packets.set(packet, anchor);
}
export function packetTimingAnchor(packet: object) { return packets.get(packet); }
