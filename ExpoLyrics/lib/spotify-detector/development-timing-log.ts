import { numericEvidence, timingNow, type ClockStamp, type NumericEvidence, type TimingOrigin } from './timing-diagnostics';

/** Automatic DEVELOPMENT-only bootstrap evidence. No timer, network, UI or
 * playback decisions. Lifecycle/track windows remain available after bootstrap. */
const MARKER = '[Spotify timing bootstrap]';
const WINDOW_MS = 120_000;
const MAX_LINES = 96;
let startedAt: number | undefined;
let lines = 0;
let windowLines = 0;
let hourStart: number | undefined;
let hourLines = 0;
let lifecycleLines = 0;
let suppressed = 0;
let windowSequence = 0;
let currentTrack: string | null = null;
const VERSION = 3;
const BUILD_BASE = '0453f4e';
const MAX_HOUR_LINES = 512;
const MAX_LIFECYCLE_LINES = 64;
let anchorSequence = 0;
let aliasSequence = 0;
const aliases = new Map<string, string>();

type RawNumber = Readonly<{ kind: 'missing' | 'null' | 'number' | 'string' | 'other'; value: NumericEvidence }>;
export type DevelopmentTimingAnchor = Readonly<{
  anchor: number;
  playerPath: string;
  serverPath: string | null;
  positionField: 'position_as_of_timestamp' | 'position' | 'progress_ms';
  playerField: 'timestamp';
  serverField: 'server_timestamp_ms';
  rawPositionMs: NumericEvidence;
  stateFlags: Readonly<Record<'is_playing' | 'is_paused' | 'paused' | 'loading' | 'is_buffering', Readonly<{
    present: boolean; kind: RawNumber['kind'] | 'boolean'; value: NumericEvidence | boolean;
  }>>>;
  flagPresenceScope: 'decoded-player-state';
  binaryFalseDefaultsPossible: true;
  clusterClocks: Readonly<Record<'changed_timestamp_ms' | 'transfer_data_timestamp' | 'started_playing_at_timestamp', RawNumber>>;
  player: RawNumber;
  server: RawNumber;
  receipt: ClockStamp;
  parsed: ClockStamp;
  origin: TimingOrigin;
  device: string | null;
  session: string | null;
  connection: string | null;
  generation: number | null;
}>;
type Input = {
  playerPath: string;
  serverPath: string | null;
  positionField: DevelopmentTimingAnchor['positionField'];
  position: unknown;
  player: unknown;
  server: unknown;
  receipt: ClockStamp;
  origin: TimingOrigin;
  device: unknown;
  session: unknown;
  connection: unknown;
  generation?: number;
  state?: Record<string, unknown>;
  cluster?: Record<string, unknown>;
};
type SampleTiming = {
  developmentTiming?: DevelopmentTimingAnchor;
  uri?: string;
  positionMs: number;
  positionTimestampMs?: number;
  sourceServerTimestampMs?: number;
  positionObservedAt?: ClockStamp;
  receivedAt: number;
  playing: boolean;
};

export function developmentTimingActive() {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return false;
  return true;
}
function budget(lifecycle = false) {
  if (!developmentTimingActive()) return false;
  const now = performance.now();
  if (hourStart === undefined || now < hourStart || now - hourStart >= 3_600_000) {
    hourStart = now; hourLines = 0; lifecycleLines = 0;
  }
  const allowed = lifecycle ? lifecycleLines < MAX_LIFECYCLE_LINES
    : hourLines < MAX_HOUR_LINES && windowLines < MAX_LINES && startedAt !== undefined && now >= startedAt && now - startedAt < WINDOW_MS;
  if (!allowed) { suppressed++; return false; }
  if (lifecycle) lifecycleLines++; else { hourLines++; windowLines++; }
  return true;
}
function write(event: object, lifecycle = false) {
  if (!budget(lifecycle)) return;
  const skipped = suppressed; suppressed = 0;
  try { console.log(`${MARKER} ${JSON.stringify({ version: VERSION, buildBase: BUILD_BASE, sequence: ++lines,
    window: windowSequence, suppressedSinceLastLine: skipped,
    limits: { windowMs: WINDOW_MS, maxLines: MAX_LINES, maxDetailLinesPerHour: MAX_HOUR_LINES, maxContextLinesPerHour: MAX_LIFECYCLE_LINES }, ...event })}`); } catch { /* Logging cannot interrupt playback. */ }
}
function openWindow() { startedAt = performance.now(); windowLines = 0; windowSequence++; }
export function logDevelopmentLifecycle(stage: 'cold-mount' | 'app-state' | 'observation-policy', context: {
  previous?: string | null; next?: string | null; enabled?: boolean; mobile?: boolean; loggedOut?: boolean;
} = {}) {
  if (!developmentTimingActive()) return;
  // AppState values come from native code, but serialize only known enum values.
  const state = (value: unknown) => ['active', 'background', 'inactive', 'unknown', 'extension'].includes(value as string) ? value : null;
  if (stage === 'cold-mount' || (stage === 'app-state' && context.next === 'active')) openWindow();
  write({ stage, processed: timingNow(), previous: state(context.previous), next: state(context.next),
    enabled: context.enabled, mobile: context.mobile, loggedOut: context.loggedOut }, true);
}
function rawNumber(value: unknown): RawNumber {
  const kind = value === undefined ? 'missing' : value === null ? 'null'
    : typeof value === 'number' ? 'number' : typeof value === 'string' ? 'string' : 'other';
  return Object.freeze({ kind, value: numericEvidence(value) });
}
function alias(kind: 'device' | 'session' | 'connection' | 'track', value: unknown) {
  if (typeof value !== 'string' || !value) return null;
  const key = `${kind}:${value.slice(0, 256)}`;
  let label = aliases.get(key);
  if (!label) {
    if (aliases.size >= 64) aliases.delete(aliases.keys().next().value!);
    label = `${kind}-${++aliasSequence}`; aliases.set(key, label);
  }
  return label;
}
export function developmentTimingAnchor(input: Input): DevelopmentTimingAnchor | undefined {
  if (!developmentTimingActive()) return undefined;
  startedAt ??= performance.now();
  return Object.freeze({ anchor: ++anchorSequence, playerPath: input.playerPath, serverPath: input.serverPath,
    positionField: input.positionField, playerField: 'timestamp', serverField: 'server_timestamp_ms',
    stateFlags: Object.freeze(Object.fromEntries(['is_playing', 'is_paused', 'paused', 'loading', 'is_buffering'].map(field => {
      const value = input.state?.[field];
      return [field, Object.freeze({ present: Object.prototype.hasOwnProperty.call(input.state ?? {}, field),
        kind: typeof value === 'boolean' ? 'boolean' : rawNumber(value).kind,
        value: typeof value === 'boolean' ? value : numericEvidence(value) })];
    })) as DevelopmentTimingAnchor['stateFlags']),
    flagPresenceScope: 'decoded-player-state', binaryFalseDefaultsPossible: true,
    clusterClocks: Object.freeze({ changed_timestamp_ms: rawNumber(input.cluster?.changed_timestamp_ms),
      transfer_data_timestamp: rawNumber(input.cluster?.transfer_data_timestamp),
      started_playing_at_timestamp: rawNumber(input.cluster?.started_playing_at_timestamp) }),
    rawPositionMs: numericEvidence(input.position), player: rawNumber(input.player), server: rawNumber(input.server),
    receipt: Object.freeze({ ...input.receipt }), parsed: timingNow(), origin: input.origin,
    device: alias('device', input.device), session: alias('session', input.session), connection: alias('connection', input.connection),
    generation: input.generation ?? null });
}

type Stage = 'accepted' | 'duplicate' | 'stale' | 'registration-conflict' | 'foreground-replay' | 'normalize' | 'sample-publish' | 'metadata-publish' | 'store-track-change';
type Normalization = { wallMs: number; monotonicMs: number; elapsedMs: number; positionMs: number; clusterAgeMs?: number };
export function logDevelopmentTiming(stage: Stage, sample: SampleTiming, normalization?: Normalization) {
  if (!developmentTimingActive() || !sample.developmentTiming) return;
  const track = alias('track', sample.uri);
  if (track && track !== currentTrack) {
    const previousTrack = currentTrack; currentTrack = track; openWindow();
    write({ stage: 'track-observed', track, previousTrack, processed: timingNow(),
      anchor: sample.developmentTiming.anchor, origin: sample.developmentTiming.origin }, true);
  }
  const raw = sample.developmentTiming;
  const player = sample.positionTimestampMs, server = sample.sourceServerTimestampMs;
  const validPlayer = typeof player === 'number' && Number.isSafeInteger(player) && player > 1_000_000_000_000;
  const validServer = typeof server === 'number' && Number.isSafeInteger(server) && server > 1_000_000_000_000;
  const reasons: string[] = [];
  if (!validPlayer) reasons.push(raw.player.kind === 'missing' || raw.player.kind === 'null' ? 'missing-player' : 'invalid-player');
  if (!validServer) reasons.push(raw.server.kind === 'missing' || raw.server.kind === 'null' ? 'missing-server' : 'invalid-server');
  if (validPlayer && validServer && server! < player!) reasons.push('future-player-relative-to-server');
  // Observational explanation only. The caller supplies the actual chosen age;
  // this function must never replace clusterPositionAge or change its guards.
  const processed = normalization ? { wallMs: normalization.wallMs, monotonicMs: normalization.monotonicMs } : timingNow();
  const event = { stage, track, raw,
    processed, playerTimestampMs: numericEvidence(player), serverTimestampMs: numericEvidence(server),
    playing: sample.playing, sourcePositionMs: numericEvidence(sample.positionMs), legacyReceivedAtMs: numericEvidence(sample.receivedAt),
    sinceOriginalReceiptMs: numericEvidence(Math.max(0, processed.monotonicMs - raw.receipt.monotonicMs)),
    reasons: reasons.length ? reasons : ['paired'],
    ...(normalization ? {
      projection: normalization.clusterAgeMs === undefined ? 'legacy' : 'paired',
      clusterAgeMs: numericEvidence(normalization.clusterAgeMs), elapsedMs: numericEvidence(normalization.elapsedMs),
      projectedPositionMs: numericEvidence(normalization.positionMs),
      elapsedClock: normalization.clusterAgeMs === undefined ? 'wall' : sample.positionObservedAt ? 'monotonic' : 'wall-receipt-fallback',
      positionObservedAt: sample.positionObservedAt ?? null,
    } : {}) };
  write(event);
}

// Module evaluation proves this JS version executed, independently of detector state.
if (developmentTimingActive()) write({ stage: 'js-startup', processed: timingNow() }, true);
