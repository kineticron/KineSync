/** Development-only bounded observations. Never retains packets, text or native objects. */
export type ArrivalHandle = Readonly<{ capture: number; packet: number; source: string; parentPacket?: number }>;
type Observation = { parentPacket?: number; source: string; packet: number; generation: number; stage: string; start: number; end: number; count?: number; uiRecordDurationMs?: number };
let capture = 0, sequence = 0, enabled = false, dropped = 0;
let packets = new WeakMap<object, ArrivalHandle>();
const records: Observation[] = [];
const LIMIT = 2048;
export function startArrivalCapture() {
  if (!__DEV__) return;
  capture++; enabled = true; dropped = 0; records.length = 0; packets = new WeakMap();
}
export function arrivalHandle(packet: object): ArrivalHandle | undefined {
  if (!__DEV__ || !enabled) return;
  const handle = packets.get(packet);
  return handle?.capture === capture ? handle : undefined;
}
export function beginArrival(packet: object, source: string) {
  if (!__DEV__ || !enabled) return;
  const prior = arrivalHandle(packet);
  if (prior) return prior;
  const handle = Object.freeze({ capture, packet: ++sequence, source: source.slice(0, 64) });
  packets.set(packet, handle);
  return handle;
}
export function publishArrival(packet: object, source: string, parent: ArrivalHandle | undefined) {
  if (!__DEV__ || !enabled) return;
  const handle = Object.freeze({ capture, packet: ++sequence, source: source.slice(0, 64),
    ...(parent?.capture === capture ? { parentPacket: parent.packet } : {}) });
  packets.set(packet, handle);
  return handle;
}
export function linkArrival(packet: object, handle: ArrivalHandle | undefined) {
  if (__DEV__ && enabled && handle?.capture === capture) packets.set(packet, handle);
}
export function arrivalEvent(handle: ArrivalHandle | undefined, generation: number, stage: string, start = performance.now(), end = start, count?: number) {
  if (!__DEV__ || !enabled || handle?.capture !== capture) return;
  if (records.length === LIMIT) { dropped++; return; }
  records.push({ parentPacket: handle.parentPacket, source: handle.source, packet: handle.packet, generation, stage, start, end, ...(count === undefined ? {} : { count }) });
}
export function arrivalPicture(handle: ArrivalHandle, generation: number, uiRecordDurationMs: number) {
  if (!__DEV__ || !enabled || handle.capture !== capture) return;
  if (records.length === LIMIT) { dropped++; return; }
  const now = performance.now();
  records.push({ parentPacket: handle.parentPacket, source: handle.source, packet: handle.packet, generation, stage: 'ui-picture-publication-rn-receipt-not-presentation', start: now, end: now, uiRecordDurationMs });
}
export function arrivalSpan<T>(handle: ArrivalHandle | undefined, generation: number, stage: string, work: () => T): T {
  if (!__DEV__ || !enabled || !handle) return work();
  const start = performance.now();
  try { return work(); } finally { arrivalEvent(handle, generation, stage, start, performance.now()); }
}
export function snapshotArrivalCapture() {
  if (!__DEV__) return undefined;
  return { capture, dropped, saturated: dropped > 0, clock: 'RN performance.now', accounting: 'independent inclusive spans; never sum',
    unavailable: ['native body-ready', 'callback backlog', 'actual first presented correct line', 'actual first presented correct window'], records: records.map(record => ({ ...record })) };
}
export function stopArrivalCapture() { if (__DEV__) enabled = false; }

// Explicit opt-in for live-provider runs through the development JS console.
if (typeof __DEV__ !== 'undefined' && __DEV__) Object.assign(globalThis, { kineSyncArrivalTrace: {
  start: startArrivalCapture, snapshot: snapshotArrivalCapture, stop: stopArrivalCapture,
} });
