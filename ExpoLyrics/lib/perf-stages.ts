/**
 * Perf stages instrumentation for KineSync native lyrics pipeline.
 *
 * Gated by __DEV__ only.
 * In production (!__DEV__): complete no-op, no timers, no allocations, no logging.
 *
 * Records a bounded ring buffer (max 200 entries) of stage marks:
 * - raw-body-available (source fetch body available)
 * - packet-ingestion (receipt of lyrics packet in JS handler; NOT native callback backlog)
 * - parser CPU (lyrics-ttml-import)
 * - model build (native-lyrics-model)
 * - voice-prepare (inclusive span: makeParagraph through words/rects)
 * - paragraph layout (narrow layout timer)
 * - glyph shaping
 * - first-active-picture (first active picture built for an arrival, with native monotonic time)
 * - picture build
 * - renderer-ready-layout-marker (layout readiness callback; may fire before active picture exists)
 * - React mount
 *
 * Bounded online aggregates per arrival id (max 8 retained arrivals) track count,
 * total, min, max, avg, first and last timestamps independent of ring wrapping.
 *
 * Also records rAF callback lateness and frame gaps using a single cheap
 * requestAnimationFrame (or timer drift sampler) active ONLY while a capture is armed.
 * setInterval-free.
 * Notice: This sampler measures callback lateness/frame gap, NOT continuous JS thread blocking.
 *
 * Exposes globalThis.__kinesyncPerf with no per-frame logging, no lyric text, and no secrets.
 */

export const RING_BUFFER_CAPACITY = 200;
export const MAX_RECENT_LATENESS = 20;
export const MAX_RECENT_BLOCKS = MAX_RECENT_LATENESS;
export const MAX_MILESTONES = 32;
export const MAX_RETAINED_ARRIVALS = 8;
export const MAX_STAGES_PER_ARRIVAL = 16;

export const CALLBACK_LATENESS_NOTICE =
  'rAF drift sampler measures callback lateness / frame gap, NOT continuous JS thread blocking execution time';
export const RENDERER_READY_LAYOUT_NOTICE =
  'renderer-ready-layout-marker indicates component layout readiness; may fire before active picture exists and does not represent a hardware presented frame';
export const FIRST_VISIBLE_PROXY_NOTICE = RENDERER_READY_LAYOUT_NOTICE;
export const PACKET_INGESTION_NOTICE =
  'packet-ingestion records receipt of lyrics packet in JS handler; true native callback backlog is not measured';

export type ArrivalKind = 'new-song' | 'translation' | 'rejected';

export const KNOWN_PIPELINE_STAGES = [
  'raw-body-available',
  'packet-ingestion',
  'parser CPU (lyrics-ttml-import)',
  'model build (native-lyrics-model)',
  'voice-prepare',
  'paragraph layout',
  'glyph shaping',
  'first-active-picture',
  'picture build',
  'renderer-ready-layout-marker',
  'React mount',
] as const;

export interface PerfStageMark {
  stage: string;
  timestamp: number;
  durationMs: number;
  arrivalId: string;
  superseded?: boolean;
  generation?: number;
  metadata?: Record<string, unknown>;
}

export interface StageAggregate {
  status: 'recorded' | 'unavailable';
  count: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  avgDurationMs: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface ArrivalSummary {
  arrivalId: string;
  trackLabel: string;
  kind: ArrivalKind;
  createdAt: number;
  superseded: boolean;
  stages: Record<string, StageAggregate>;
}

export interface CallbackLatenessSummary {
  sampleCount: number;
  maxFrameGapMs: number;
  totalLatenessMs: number;
  gapsOver50ms: number;
  gapsOver100ms: number;
  gapsOver250ms: number;
  gapsOver1000ms: number;
  recentLateness: Array<{ timestamp: number; frameGapMs: number }>;
}

export type JsThreadBlockSummary = CallbackLatenessSummary;

export interface PerfSummary {
  armed: boolean;
  armedDurationMs: number;
  activeArrivalId: string | null;
  stageAggregates: Record<string, StageAggregate>;
  arrivals: ArrivalSummary[];
  perArrivalAggregates?: Record<string, ArrivalSummary>;
  callbackLateness: CallbackLatenessSummary;
  /** Compatibility alias */
  jsThreadBlocks?: CallbackLatenessSummary;
  buffer: {
    capacity: number;
    totalRecorded: number;
    currentBuffered: number;
    dropped: number;
  };
  marks: PerfStageMark[];
  milestones: PerfStageMark[];
  callbackLatenessNotice: string;
  firstVisibleProxyNotice: string;
  rendererReadyNotice: string;
  packetIngestionNotice: string;
}

declare const __DEV__: boolean;

const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

// Static NOOP function
const NOOP = () => {};

// Keys that could contain lyric text or secrets - strictly rejected
let FORBIDDEN_KEYS: Set<string> | null = null;

interface InternalArrival {
  arrivalId: string;
  trackLabel: string;
  kind: ArrivalKind;
  createdAt: number;
  superseded: boolean;
  stages: Map<string, StageAggregate>;
}

// Internal dev state - null in production to guarantee zero allocations at import
let ringBuffer: Array<PerfStageMark | null> | null = null;
let recentLateness: Array<{ timestamp: number; frameGapMs: number }> | null = null;
let milestones: PerfStageMark[] | null = null;
let seenMilestones: Set<string> | null = null;
let arrivals: Map<string, InternalArrival> | null = null;
let arrivalOrder: string[] | null = null;
let devObjectArrivalMap: WeakMap<object, string> | null = null;
let seenActivePictureArrivals: Set<string> | null = null;
let pendingParseArrivalId: string | null = null;

let bufferIndex = 0;
let totalRecorded = 0;
let generation = 0;
let arrivalSeq = 0;
let activeNewSongArrivalId: string | null = null;
let currentActiveArrivalId: string | null = null;

let isArmed = false;
let armedAt = 0;
let rafHandle: number | null = null;
let lastTickTime = 0;

let sampleCount = 0;
let maxFrameGapMs = 0;
let totalLatenessMs = 0;
let gapsOver50ms = 0;
let gapsOver100ms = 0;
let gapsOver250ms = 0;
let gapsOver1000ms = 0;

if (isDev) {
  FORBIDDEN_KEYS = new Set([
    'lyrics', 'lyric', 'text', 'words', 'word', 'letters', 'letter',
    'token', 'secret', 'key', 'password', 'auth', 'authorization',
    'cookie', 'header', 'headers', 'payload', 'body', 'ttml', 'content',
    'syllable', 'syllables', 'translation', 'translatedtext', 'lines', 'line'
  ]);
  ringBuffer = new Array(RING_BUFFER_CAPACITY).fill(null);
  recentLateness = [];
  milestones = [];
  seenMilestones = new Set();
  arrivals = new Map();
  arrivalOrder = [];
  devObjectArrivalMap = new WeakMap();
  seenActivePictureArrivals = new Set();
}

/** Test inspection helper to assert zero module-level allocations in production */
export function _getInternalDevState() {
  return {
    ringBuffer,
    recentLateness,
    milestones,
    seenMilestones,
    forbiddenKeys: FORBIDDEN_KEYS,
    arrivals,
    arrivalOrder,
    devObjectArrivalMap,
    seenActivePictureArrivals,
    pendingParseArrivalId,
  };
}

function sanitizeMetadata(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== 'object' || !FORBIDDEN_KEYS) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    const lowerKey = k.toLowerCase();
    if (FORBIDDEN_KEYS.has(lowerKey)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') {
      safe[k] = v;
    } else if (typeof v === 'string') {
      // Allow only short label/identifier strings, no text lines or multiline payloads
      if (v.length <= 64 && !/[\r\n]/.test(v)) {
        safe[k] = v;
      }
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function createArrival(
  trackLabel = 'unknown',
  kind: ArrivalKind = 'new-song'
): string {
  if (!isDev || !arrivals || !arrivalOrder) return '';
  arrivalSeq++;
  const id = `arr_${arrivalSeq}`;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const safeLabel = String(trackLabel || 'unknown')
    .slice(0, 48)
    .replace(/[\r\n]/g, '');

  if (kind === 'new-song') {
    generation++;
    // Supersede previously active new-song arrival
    if (activeNewSongArrivalId && arrivals.has(activeNewSongArrivalId)) {
      const prev = arrivals.get(activeNewSongArrivalId)!;
      prev.superseded = true;
    }
    activeNewSongArrivalId = id;
  }

  currentActiveArrivalId = id;

  const internal: InternalArrival = {
    arrivalId: id,
    trackLabel: safeLabel,
    kind,
    createdAt: now,
    superseded: false,
    stages: new Map(),
  };

  // Maintain bounded retained arrivals (LRU/FIFO eviction)
  if (arrivalOrder.length >= MAX_RETAINED_ARRIVALS) {
    const oldestId = arrivalOrder.shift()!;
    arrivals.delete(oldestId);
  }

  arrivals.set(id, internal);
  arrivalOrder.push(id);
  return id;
}

export function getActiveArrivalId(): string | null {
  if (!isDev) return null;
  return currentActiveArrivalId;
}

export function associateArrival(obj: unknown, arrivalId: string): void {
  if (!isDev || !devObjectArrivalMap || typeof obj !== 'object' || obj === null) return;
  devObjectArrivalMap.set(obj, arrivalId);
}

export function getArrivalForObject(obj: unknown): string | null {
  if (!isDev || !devObjectArrivalMap || typeof obj !== 'object' || obj === null) return null;
  return devObjectArrivalMap.get(obj) || null;
}

export function setPendingParseArrivalId(id: string | null): void {
  if (!isDev) return;
  pendingParseArrivalId = id || null;
}

export function getPendingParseArrivalId(): string | null {
  if (!isDev) return null;
  return pendingParseArrivalId;
}

export function clearPendingParseArrivalId(): void {
  if (!isDev) return;
  pendingParseArrivalId = null;
}

export function label(name: string): void {
  if (!isDev || !isArmed) return;
  const safeName = String(name || '').slice(0, 64).replace(/[\r\n]/g, '');
  recordPerfStage(`label: ${safeName}`, 0, { label: safeName });
}

function driftSampler(frameNow?: number) {
  if (!isArmed) return;
  const now = typeof frameNow === 'number' && frameNow > 0
    ? frameNow
    : (typeof performance !== 'undefined' ? performance.now() : Date.now());

  if (lastTickTime > 0) {
    const delta = now - lastTickTime;
    sampleCount++;
    if (delta > 50) {
      const frameGapMs = Math.round(delta);
      totalLatenessMs += frameGapMs;
      if (frameGapMs > maxFrameGapMs) {
        maxFrameGapMs = frameGapMs;
      }
      if (frameGapMs >= 1000) gapsOver1000ms++;
      else if (frameGapMs >= 250) gapsOver250ms++;
      else if (frameGapMs >= 100) gapsOver100ms++;
      else gapsOver50ms++;

      if (recentLateness) {
        if (recentLateness.length >= MAX_RECENT_LATENESS) {
          recentLateness.shift();
        }
        recentLateness.push({ timestamp: Math.round(now), frameGapMs });
      }
    }
  }
  lastTickTime = now;

  // Single cheap requestAnimationFrame callback, setInterval-free
  if (typeof requestAnimationFrame === 'function') {
    rafHandle = requestAnimationFrame(driftSampler);
  } else if (typeof setTimeout === 'function') {
    rafHandle = setTimeout(driftSampler, 16) as unknown as number;
  }
}

export function arm(): void {
  if (!isDev) return;
  if (isArmed) return;
  isArmed = true;
  // Re-arming resets active picture tracking so re-armed existing renderers still yield samples
  if (seenActivePictureArrivals) {
    seenActivePictureArrivals.clear();
  }
  pendingParseArrivalId = null;
  armedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  lastTickTime = armedAt;
  if (typeof requestAnimationFrame === 'function') {
    rafHandle = requestAnimationFrame(driftSampler);
  } else if (typeof setTimeout === 'function') {
    rafHandle = setTimeout(driftSampler, 16) as unknown as number;
  }
}

export function disarm(): void {
  if (!isDev) return;
  if (!isArmed) return;
  isArmed = false;
  if (rafHandle !== null) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafHandle);
    } else if (typeof clearTimeout === 'function') {
      clearTimeout(rafHandle);
    }
    rafHandle = null;
  }
  lastTickTime = 0;
}

export function reset(): void {
  if (!isDev) return;
  if (ringBuffer) {
    for (let i = 0; i < RING_BUFFER_CAPACITY; i++) {
      ringBuffer[i] = null;
    }
  }
  bufferIndex = 0;
  totalRecorded = 0;
  generation = 0;
  arrivalSeq = 0;
  activeNewSongArrivalId = null;
  currentActiveArrivalId = null;
  sampleCount = 0;
  maxFrameGapMs = 0;
  totalLatenessMs = 0;
  gapsOver50ms = 0;
  gapsOver100ms = 0;
  gapsOver250ms = 0;
  gapsOver1000ms = 0;
  if (recentLateness) {
    recentLateness.length = 0;
  }
  if (milestones) {
    milestones.length = 0;
  }
  if (seenMilestones) {
    seenMilestones.clear();
  }
  if (arrivals) {
    arrivals.clear();
  }
  if (arrivalOrder) {
    arrivalOrder.length = 0;
  }
  if (seenActivePictureArrivals) {
    seenActivePictureArrivals.clear();
  }
  pendingParseArrivalId = null;
  if (isArmed) {
    armedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    lastTickTime = armedAt;
  } else {
    armedAt = 0;
    lastTickTime = 0;
  }
}

export function recordPerfStage(
  stage: string,
  durationMs = 0,
  metadata?: Record<string, unknown>,
  explicitArrivalId?: string
): void {
  if (!isDev || !isArmed || !ringBuffer) return;

  const timestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const safeDuration = Math.max(0, durationMs || 0);

  // Backward compatibility: alias 'body-ready/callback-backlog' -> 'packet-ingestion'
  let normalizedStage = stage;
  if (stage === 'body-ready/callback-backlog') {
    normalizedStage = 'packet-ingestion';
  } else if (stage.includes('first-visible proxy')) {
    normalizedStage = 'renderer-ready-layout-marker';
  }

  // Resolve arrival id: explicit > metadata > uncorrelated
  let effectiveArrivalId = explicitArrivalId ||
    (typeof metadata?._arrivalId === 'string' ? (metadata._arrivalId as string) : undefined) ||
    'uncorrelated';

  // Retrieve arrival record
  let arrival = arrivals?.get(effectiveArrivalId);
  if (!arrival && effectiveArrivalId !== 'uncorrelated' && arrivals) {
    // If an unknown arrivalId was passed, register it as a dynamic arrival
    arrival = {
      arrivalId: effectiveArrivalId,
      trackLabel: 'unknown',
      kind: 'new-song',
      createdAt: timestamp,
      superseded: false,
      stages: new Map(),
    };
    if (arrivalOrder && arrivalOrder.length >= MAX_RETAINED_ARRIVALS) {
      const oldestId = arrivalOrder.shift()!;
      arrivals.delete(oldestId);
    }
    arrivals.set(effectiveArrivalId, arrival);
    arrivalOrder?.push(effectiveArrivalId);
  }

  const isSuperseded = arrival ? arrival.superseded : false;

  // Filter single active picture per arrival
  if (normalizedStage === 'first-active-picture' && seenActivePictureArrivals) {
    if (seenActivePictureArrivals.has(effectiveArrivalId)) {
      return; // Already recorded first active picture for this arrival
    }
    seenActivePictureArrivals.add(effectiveArrivalId);
  }

  // Online bounded aggregate update (per arrival id)
  if (arrival) {
    let agg = arrival.stages.get(normalizedStage);
    if (!agg && arrival.stages.size < MAX_STAGES_PER_ARRIVAL) {
      agg = {
        status: 'recorded',
        count: 0,
        totalDurationMs: 0,
        minDurationMs: safeDuration,
        maxDurationMs: safeDuration,
        avgDurationMs: 0,
        firstTimestamp: timestamp,
        lastTimestamp: timestamp,
      };
      arrival.stages.set(normalizedStage, agg);
    }
    if (agg) {
      agg.count++;
      agg.totalDurationMs = Number((agg.totalDurationMs + safeDuration).toFixed(2));
      if (safeDuration < agg.minDurationMs) agg.minDurationMs = Number(safeDuration.toFixed(2));
      if (safeDuration > agg.maxDurationMs) agg.maxDurationMs = Number(safeDuration.toFixed(2));
      agg.avgDurationMs = Number((agg.totalDurationMs / agg.count).toFixed(2));
      agg.lastTimestamp = timestamp;
    }
  }

  const safeMeta = sanitizeMetadata(metadata);
  const mark: PerfStageMark = {
    stage: normalizedStage,
    timestamp,
    durationMs: safeDuration,
    arrivalId: effectiveArrivalId,
    superseded: isSuperseded,
    generation,
    ...(safeMeta ? { metadata: safeMeta } : {}),
  };

  // Ring buffer keeps only raw recent marks
  ringBuffer[bufferIndex] = mark;
  bufferIndex = (bufferIndex + 1) % RING_BUFFER_CAPACITY;
  totalRecorded++;

  // Milestone tracking: first mark per stage per arrival
  if (milestones && seenMilestones && milestones.length < MAX_MILESTONES) {
    const correlationKey = `${effectiveArrivalId}:${normalizedStage}`;
    if (!seenMilestones.has(correlationKey)) {
      seenMilestones.add(correlationKey);
      milestones.push(mark);
    }
  }
}

export function startPerfStage(
  stage: string,
  metadata?: Record<string, unknown>,
  explicitArrivalId?: string
): () => void {
  if (!isDev || !isArmed) return NOOP;
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return () => {
    const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
    recordPerfStage(stage, end - start, metadata, explicitArrivalId);
  };
}

export function summary(): PerfSummary {
  if (!isDev || !ringBuffer) {
    const emptyLateness: CallbackLatenessSummary = {
      sampleCount: 0,
      maxFrameGapMs: 0,
      totalLatenessMs: 0,
      gapsOver50ms: 0,
      gapsOver100ms: 0,
      gapsOver250ms: 0,
      gapsOver1000ms: 0,
      recentLateness: [],
    };
    return {
      armed: false,
      armedDurationMs: 0,
      activeArrivalId: null,
      stageAggregates: {},
      arrivals: [],
      callbackLateness: emptyLateness,
      jsThreadBlocks: emptyLateness,
      buffer: {
        capacity: RING_BUFFER_CAPACITY,
        totalRecorded: 0,
        currentBuffered: 0,
        dropped: 0,
      },
      marks: [],
      milestones: [],
      callbackLatenessNotice: CALLBACK_LATENESS_NOTICE,
      firstVisibleProxyNotice: RENDERER_READY_LAYOUT_NOTICE,
      rendererReadyNotice: RENDERER_READY_LAYOUT_NOTICE,
      packetIngestionNotice: PACKET_INGESTION_NOTICE,
    };
  }

  const marks: PerfStageMark[] = [];
  const currentCount = Math.min(totalRecorded, RING_BUFFER_CAPACITY);
  const startIdx = totalRecorded > RING_BUFFER_CAPACITY ? bufferIndex : 0;
  for (let i = 0; i < currentCount; i++) {
    const entry = ringBuffer[(startIdx + i) % RING_BUFFER_CAPACITY];
    if (entry) marks.push(entry);
  }

  // Build per-arrival aggregate summaries exposing 'unavailable' for unseen pipeline stages
  const arrivalSummaries: ArrivalSummary[] = [];
  const perArrivalAggregates: Record<string, ArrivalSummary> = {};

  if (arrivals && arrivalOrder) {
    for (const arrId of arrivalOrder) {
      const arr = arrivals.get(arrId);
      if (!arr) continue;
      const stagesRecord: Record<string, StageAggregate> = {};
      for (const knownStage of KNOWN_PIPELINE_STAGES) {
        const recorded = arr.stages.get(knownStage);
        if (recorded) {
          stagesRecord[knownStage] = { ...recorded };
        } else {
          stagesRecord[knownStage] = {
            status: 'unavailable',
            count: 0,
            totalDurationMs: 0,
            minDurationMs: 0,
            maxDurationMs: 0,
            avgDurationMs: 0,
            firstTimestamp: 0,
            lastTimestamp: 0,
          };
        }
      }
      // Include any other stages recorded for this arrival
      for (const [stg, data] of arr.stages.entries()) {
        if (!stagesRecord[stg]) {
          stagesRecord[stg] = { ...data };
        }
      }

      const sum: ArrivalSummary = {
        arrivalId: arr.arrivalId,
        trackLabel: arr.trackLabel,
        kind: arr.kind,
        createdAt: arr.createdAt,
        superseded: arr.superseded,
        stages: stagesRecord,
      };
      arrivalSummaries.push(sum);
      perArrivalAggregates[arr.arrivalId] = sum;
    }
  }

  // Top-level stageAggregates: online aggregates across all recorded arrivals / active arrival
  const topStageAggregates: Record<string, StageAggregate> = {};
  if (totalRecorded > 0) {
    for (const knownStage of KNOWN_PIPELINE_STAGES) {
      let count = 0;
      let totalDuration = 0;
      let minDuration = Infinity;
      let maxDuration = 0;
      let firstTime = Infinity;
      let lastTime = 0;
      let seen = false;

      if (arrivals) {
        for (const arr of arrivals.values()) {
          const stg = arr.stages.get(knownStage);
          if (stg) {
            seen = true;
            count += stg.count;
            totalDuration += stg.totalDurationMs;
            if (stg.minDurationMs < minDuration) minDuration = stg.minDurationMs;
            if (stg.maxDurationMs > maxDuration) maxDuration = stg.maxDurationMs;
            if (stg.firstTimestamp < firstTime) firstTime = stg.firstTimestamp;
            if (stg.lastTimestamp > lastTime) lastTime = stg.lastTimestamp;
          }
        }
      }

      if (seen) {
        topStageAggregates[knownStage] = {
          status: 'recorded',
          count,
          totalDurationMs: Number(totalDuration.toFixed(2)),
          minDurationMs: Number(minDuration.toFixed(2)),
          maxDurationMs: Number(maxDuration.toFixed(2)),
          avgDurationMs: count > 0 ? Number((totalDuration / count).toFixed(2)) : 0,
          firstTimestamp: firstTime,
          lastTimestamp: lastTime,
        };
      } else {
        topStageAggregates[knownStage] = {
          status: 'unavailable',
          count: 0,
          totalDurationMs: 0,
          minDurationMs: 0,
          maxDurationMs: 0,
          avgDurationMs: 0,
          firstTimestamp: 0,
          lastTimestamp: 0,
        };
      }
    }

    // Also include any extra custom stages recorded in marks
    if (arrivals) {
      for (const arr of arrivals.values()) {
        for (const [stg, data] of arr.stages.entries()) {
          if (!topStageAggregates[stg]) {
            topStageAggregates[stg] = { ...data };
          }
        }
      }
    }
  }

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const armedDurationMs = isArmed ? Number((now - armedAt).toFixed(2)) : 0;

  const lateness: CallbackLatenessSummary = {
    sampleCount,
    maxFrameGapMs,
    totalLatenessMs,
    gapsOver50ms,
    gapsOver100ms,
    gapsOver250ms,
    gapsOver1000ms,
    recentLateness: recentLateness ? [...recentLateness] : [],
  };

  return {
    armed: isArmed,
    armedDurationMs,
    activeArrivalId: currentActiveArrivalId,
    stageAggregates: topStageAggregates,
    arrivals: arrivalSummaries,
    perArrivalAggregates,
    callbackLateness: lateness,
    jsThreadBlocks: lateness,
    buffer: {
      capacity: RING_BUFFER_CAPACITY,
      totalRecorded,
      currentBuffered: marks.length,
      dropped: Math.max(0, totalRecorded - RING_BUFFER_CAPACITY),
    },
    marks,
    milestones: milestones ? [...milestones] : [],
    callbackLatenessNotice: CALLBACK_LATENESS_NOTICE,
    firstVisibleProxyNotice: RENDERER_READY_LAYOUT_NOTICE,
    rendererReadyNotice: RENDERER_READY_LAYOUT_NOTICE,
    packetIngestionNotice: PACKET_INGESTION_NOTICE,
  };
}

// Expose on globalThis.__kinesyncPerf ONLY in development
if (isDev && typeof globalThis !== 'undefined') {
  (globalThis as unknown as { __kinesyncPerf: unknown }).__kinesyncPerf = {
    arm,
    disarm,
    summary,
    reset,
    mark: recordPerfStage,
    start: startPerfStage,
    label,
    createArrival,
    getActiveArrivalId,
    associateArrival,
    getArrivalForObject,
    setPendingParseArrivalId,
    getPendingParseArrivalId,
    clearPendingParseArrivalId,
  };
}
