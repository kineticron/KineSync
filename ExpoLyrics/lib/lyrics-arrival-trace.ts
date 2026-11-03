/** Development-only bounded observations. Never retains packets, text or native objects. */
export type ArrivalHandle = Readonly<{ capture: number; packet: number; source: string; parentPacket?: number }>;
type Observation = { pictureEpoch?: number; producers?: { model: number; cues: number }; parentPacket?: number; source: string; packet: number; generation: number; stage: string; start: number; end: number; count?: number; uiRecordDurationMs?: number };
let capture = 0, sequence = 0, enabled = false, dropped = 0;
let packets: WeakMap<object, ArrivalHandle>;
const records: Observation[] = (typeof __DEV__ !== 'undefined' && __DEV__ ? [] : undefined)!;
const LIMIT = 2048;
const emptyCounters = () => ({ modelCalls: 0, cueBuilds: 0, shapingCalls: 0, paragraphBuilds: 0,
  voiceRenders: 0, reactCommits: 0, firstPicturePublications: 0, instrumentedSpansOver50Ms: 0 });
let counters = (typeof __DEV__ !== 'undefined' && __DEV__ ? emptyCounters() : undefined)!;
export type ArrivalCounter = keyof ReturnType<typeof emptyCounters>;
export function arrivalCounter(handle: ArrivalHandle | undefined, metric: ArrivalCounter) {
  if (__DEV__ && enabled && handle?.capture === capture && Object.prototype.hasOwnProperty.call(counters, metric)) counters[metric]++;
}
export function startArrivalCapture() {
  if (!__DEV__) return;
  for (const pending of uiRequests.values()) { clearTimeout(pending.timer); pending.finish(); }
  uiRequests.clear(); uiReaders = undefined; uiSamples = undefined; uiVersion = 0; uiFlushedVersion = -1; uiDrops = 0; uiTimeouts = 0;
  capture++; counters = emptyCounters(); enabled = true; dropped = 0; records.length = 0; packets = new WeakMap();
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
export function arrivalEvent(handle: ArrivalHandle | undefined, generation: number, stage: string, start = performance.now(), end = start, count?: number, producers?: { model: number; cues: number }) {
  if (!__DEV__ || !enabled || handle?.capture !== capture) return;
  if (stage.startsWith('react-') && stage.endsWith('-render-to-commit')) counters.reactCommits++;
  if (records.length === LIMIT) { dropped++; return; }
  records.push({ parentPacket: handle.parentPacket, source: handle.source, packet: handle.packet, generation, stage, start, end, ...(producers ? { producers: { ...producers } } : {}), ...(count === undefined ? {} : { count }) });
}
export function arrivalPicture(handle: ArrivalHandle, generation: number, uiRecordDurationMs: number, pictureEpoch?: number) {
  if (!__DEV__ || !enabled || handle.capture !== capture) return;
  counters.firstPicturePublications++;
  if (records.length === LIMIT) { dropped++; return; }
  const now = performance.now();
  records.push({ parentPacket: handle.parentPacket, source: handle.source, packet: handle.packet, generation, pictureEpoch, stage: 'ui-picture-publication-rn-receipt-not-presentation', start: now, end: now, uiRecordDurationMs });
}
export function arrivalSpan<T>(handle: ArrivalHandle | undefined, generation: number, stage: string, work: () => T): T {
  if (!__DEV__ || !enabled || !handle || handle.capture !== capture) return work();
  if (stage === 'model') counters.modelCalls++;
  if (stage === 'cues') counters.cueBuilds++;
  if (stage === 'glyph-shaping') counters.shapingCalls++;
  const start = performance.now();
  try { return work(); } finally {
    const end = performance.now();
    if (enabled && handle.capture === capture && end - start >= 50) counters.instrumentedSpansOver50Ms++;
    arrivalEvent(handle, generation, stage, start, end);
  }
}
export function snapshotArrivalCapture() {
  if (!__DEV__) return undefined;
  return { uiCounts: snapshotArrivalUiCounts(), counterSchema: 1, counters: { ...counters }, counterScope: 'accepted capture owners; counters continue after span buffer saturation',
    counterUnavailable: ['empty/emoji-mask picture builds', 'native/GPU allocation bytes', 'all native allocation calls', 'actual JS long tasks'],
    capture, dropped, saturated: dropped > 0, clock: 'RN performance.now', accounting: 'independent inclusive spans; never sum',
    unavailable: ['native body-ready', 'callback backlog', 'actual first presented correct line', 'actual first presented correct window'], records: records.map(record => ({ ...record, ...(record.producers ? { producers: { ...record.producers } } : {}) })) };
}
export function stopArrivalCapture() { if (__DEV__) enabled = false; }

// Explicit opt-in for live-provider runs through the development JS console.
if (typeof __DEV__ !== 'undefined' && __DEV__) Object.assign(globalThis, { kineSyncArrivalTrace: {
  start: startArrivalCapture, snapshot: snapshotArrivalCapture, stop: stopArrivalCapture, flushUiCounts: flushArrivalUiCounts,
} });

export type ArrivalComparisonContext = Readonly<{
  runId: string; variant: 'baseline' | 'candidate'; sourceSha: string; fixtureSha: string;
  instrumentationSha: string; configuration: string; scenario: string;
}>;
/** Optional sidecar only. Does not emit or change the simulator harness protocol. */
export function exportArrivalCounters(context: ArrivalComparisonContext) {
  if (!__DEV__ || capture === 0) return undefined;
  return { uiCounts: snapshotArrivalUiCounts(), schema: 1, ...context, buildMode: 'development', counterSchema: 1, counters: { ...counters },
    scope: 'accepted capture owners; paragraph builds are constructor calls, not allocation bytes',
    unavailable: ['empty/emoji-mask picture builds', 'native/GPU allocation bytes', 'all native allocation calls', 'actual JS long tasks'],
    capture, spanRecordsDropped: dropped };
}
if (typeof __DEV__ !== 'undefined' && __DEV__) Object.assign(globalThis, { kineSyncArrivalCounters: exportArrivalCounters });

export type ArrivalUiTotals = { pictureBuilds: number; paintConstructors: number; blurFilterConstructors: number; shaderConstructors: number };
type UiSample = { sampledAtUiMs?: number; receivedAtRnMs: number; epoch: number; packet: number; generation: number; totals: ArrivalUiTotals };
let uiReaders: Map<number, () => Promise<void>> | undefined;
let uiSamples: Map<number, UiSample> | undefined;
let uiVersion = 0, uiFlushedVersion = -1, uiDrops = 0, uiTimeouts = 0;
let requestSequence = 0;
const uiRequests: Map<number, { finish: () => void; timer: ReturnType<typeof setTimeout> }> = (typeof __DEV__ !== 'undefined' && __DEV__ ? new Map() : undefined)!;
export function registerArrivalUiReader(handle: ArrivalHandle, epoch: number, read: () => Promise<void>) {
  if (!__DEV__ || !enabled || handle.capture !== capture) return () => {};
  uiReaders ??= new Map();
  if (uiReaders.size >= 512) { uiDrops++; return () => {}; }
  uiReaders.set(epoch, read); uiVersion++;
  return () => { if (handle.capture === capture && uiReaders?.get(epoch) === read) { uiReaders.delete(epoch); uiVersion++; } };
}
export function requestArrivalUiSample(send: (request: number) => void) {
  if (!__DEV__ || !enabled) return Promise.resolve();
  if (uiRequests.size >= 512) { uiDrops++; return Promise.resolve(); }
  const requestCapture = capture;
  return new Promise<void>(resolve => {
    const request = ++requestSequence;
    const timer = setTimeout(() => {
      uiRequests.delete(request);
      if (requestCapture === capture) uiTimeouts++;
      resolve();
    }, 1000);
    uiRequests.set(request, { finish: resolve, timer });
    try { send(request); } catch { clearTimeout(timer); uiRequests.delete(request); uiTimeouts++; resolve(); }
  });
}
export function receiveArrivalUiSample(handle: ArrivalHandle, epoch: number, generation: number, totals: ArrivalUiTotals, request: number, sampledAtUiMs?: number) {
  if (!__DEV__) return;
  const pending = uiRequests.get(request);
  if (!pending) return; // Late replies cannot enter a later flush.
  clearTimeout(pending.timer); uiRequests.delete(request);
  if (__DEV__ && enabled && handle.capture === capture) {
    uiSamples ??= new Map();
    if (uiSamples.has(epoch) || uiSamples.size < 2048) uiSamples.set(epoch, { sampledAtUiMs, receivedAtRnMs: performance.now(), epoch, packet: handle.packet, generation, totals: { ...totals } });
    else uiDrops++;
  }
  pending.finish();
}
export function snapshotArrivalUiCounts() {
  if (!__DEV__) return undefined;
  const totals: ArrivalUiTotals = { pictureBuilds: 0, paintConstructors: 0, blurFilterConstructors: 0, shaderConstructors: 0 };
  for (const sample of uiSamples?.values() ?? []) for (const key of Object.keys(totals) as (keyof ArrivalUiTotals)[]) totals[key] += sample.totals[key];
  return { scope: 'dynamic voice pictures and their reusable paints/filters/shaders; excludes empty and emoji-mask pictures; constructor calls, not bytes',
    complete: uiFlushedVersion === uiVersion && uiRequests.size === 0 && uiDrops === 0 && uiTimeouts === 0,
    totals, owners: [...(uiSamples?.values() ?? [])].map(sample => ({ ...sample, totals: { ...sample.totals } })),
    liveReaders: uiReaders?.size ?? 0, droppedOwners: uiDrops, timeouts: uiTimeouts };
}
export async function flushArrivalUiCounts() {
  if (!__DEV__ || !enabled) return undefined;
  const version = uiVersion, currentCapture = capture;
  await Promise.allSettled([...(uiReaders?.values() ?? [])].map(read => read()));
  if (currentCapture !== capture) return undefined;
  uiFlushedVersion = version;
  return snapshotArrivalCapture();
}
if (typeof __DEV__ !== 'undefined' && __DEV__) Object.assign(globalThis, { kineSyncArrivalUiCounts: flushArrivalUiCounts });
