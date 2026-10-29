import { numericEvidence, timingNow, type ClockStamp, type NumericEvidence, type TimingOrigin } from './timing-diagnostics';

/** Automatic DEVELOPMENT-only bootstrap evidence. No timer, network, UI or
 * playback decisions. A manual JS reload starts a new bounded logging window. */
const MARKER = '[Spotify timing bootstrap]';
const WINDOW_MS = 120_000;
const MAX_LINES = 96;
let startedAt: number | undefined;
let lines = 0;
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
};
type SampleTiming = {
  developmentTiming?: DevelopmentTimingAnchor;
  positionMs: number;
  positionTimestampMs?: number;
  sourceServerTimestampMs?: number;
  positionObservedAt?: ClockStamp;
  receivedAt: number;
  playing: boolean;
};

export function developmentTimingActive() {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return false;
  const now = performance.now();
  const active = lines < MAX_LINES && (startedAt === undefined || (now >= startedAt && now - startedAt < WINDOW_MS));
  if (!active) aliases.clear();
  return active;
}
function rawNumber(value: unknown): RawNumber {
  const kind = value === undefined ? 'missing' : value === null ? 'null'
    : typeof value === 'number' ? 'number' : typeof value === 'string' ? 'string' : 'other';
  return Object.freeze({ kind, value: numericEvidence(value) });
}
function alias(kind: 'device' | 'session' | 'connection', value: unknown) {
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
    rawPositionMs: numericEvidence(input.position), player: rawNumber(input.player), server: rawNumber(input.server),
    receipt: Object.freeze({ ...input.receipt }), parsed: timingNow(), origin: input.origin,
    device: alias('device', input.device), session: alias('session', input.session), connection: alias('connection', input.connection),
    generation: input.generation ?? null });
}

type Stage = 'accepted' | 'duplicate' | 'stale' | 'registration-conflict' | 'foreground-replay' | 'normalize';
type Normalization = { wallMs: number; monotonicMs: number; elapsedMs: number; positionMs: number; clusterAgeMs?: number };
export function logDevelopmentTiming(stage: Stage, sample: SampleTiming, normalization?: Normalization) {
  if (!developmentTimingActive() || !sample.developmentTiming) return;
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
  const event = { version: 1, sequence: ++lines, limits: { windowMs: WINDOW_MS, maxLines: MAX_LINES }, stage, raw,
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
  try { console.log(`${MARKER} ${JSON.stringify(event)}`); } catch { /* Logging cannot interrupt playback. */ }
}
