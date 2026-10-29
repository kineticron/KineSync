import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { gzip } from 'pako';

// Bundle actual production parser, detector, packet and store together. Only native
// storage/AppState are stubbed; wall/monotonic clocks and network are injected.
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
export * from './lib/spotify-detector/timing-diagnostics';
export {sampleFrom,decodeDealer,decodeStateBody} from './lib/spotify-detector/protocol';
export {SpotifyDetector} from './lib/spotify-detector/client';
export {detectorPacket} from './lib/spotify-detector/packet';
export {usePlaybackStore} from './store/playback-store';` }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'native-stubs', setup(b) {
    b.onResolve({ filter: /^(@react-native-async-storage\/async-storage|expo-secure-store|expo-constants|react-native)$/ }, a => ({ path: a.path, namespace: 'native-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'native-stub' }, a => ({ contents: a.path === 'react-native'
      ? 'export const AppState={currentState:"background",addEventListener:()=>({remove(){}})};export const Platform={OS:"web"};'
      : 'export default {getItem:async()=>null,setItem:async()=>{}};export const getItemAsync=async()=>null;export const setItemAsync=async()=>{};export const deleteItemAsync=async()=>{};' }));
  } }],
});
const epoch = 1_800_000_000_000;
let wall = epoch, mono = 1000, timerId = 0;
const timers = new Map(), sockets = [];
let fetchResponse = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
class Socket {
  static OPEN = 1;
  readyState = 1;
  constructor() { sockets.push(this); }
  send() {}
  close() { this.readyState = 3; this.onclose?.(); }
  event(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const module = { exports: {} };
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url),
  process: { env: { NODE_ENV: 'test' } }, console, Buffer, TextDecoder, TextEncoder, URL, AbortController,
  Date: class extends Date { static now() { return wall; } }, performance: { now: () => mono },
  WebSocket: Socket, fetch: (...args) => fetchResponse(...args),
  setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, setInterval: fn => { timers.set(++timerId, fn); return timerId; },
  clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
});
const api = module.exports, store = api.usePlaybackStore;
const at = ms => { wall = epoch + ms; mono = 1000 + ms; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const raw = (position = 10000, timestamp = wall, playing = true, device = 'synthetic-device', session = 'synthetic-session') => ({
  changed_timestamp_ms: timestamp, server_timestamp_ms: timestamp + 7, transfer_data_timestamp: timestamp - 3,
  started_playing_at_timestamp: timestamp - 10, active_device_id: device,
  player_state: { timestamp, position_as_of_timestamp: position, duration: 300000,
    is_playing: true, is_paused: !playing, session_id: session,
    track: { uri: 'spotify:track:0000000000000000000001', metadata: { title: 'Synthetic', artist_name: 'Synthetic', album_title: 'Synthetic' } } },
});
function reset() {
  store.setState({ playbackMode: 'mobile', currentTrack: null, anchorPositionMs: 0, anchorMonotonicMs: mono,
    anchorTimestampMs: wall, playbackPosition: 0, isPlaying: false, clockSkewBaselineMs: NaN,
    lastSourceClockMs: 0, playbackCompensationMs: 0, bridgeTiming: {} });
}
function publish(sample) { const packet = api.detectorPacket(sample); store.getState().ingestPacket(packet, 'mobile'); return packet; }
function position() { const s = store.getState(); return s.anchorPositionMs + (s.isPlaying ? Math.max(0, mono - s.anchorMonotonicMs) : 0); }
async function connect(sample) {
  const detector = new api.SpotifyDetector({ sample, ready() {}, status() {}, sessionNeeded() {}, authenticated() {} });
  const capture = value => detector.capture(JSON.stringify(value), 'https://open.spotify.com');
  capture({ type: 'credentials', authenticated: true, token: 'synthetic-test-credential', expiresAt: wall + 3_600_000 });
  capture({ type: 'observerEndpoint', url: 'https://spclient.spotify.com/connect-state/v1/devices/synthetic-observer' });
  capture({ type: 'socket', url: 'wss://dealer.spotify.com/' }); detector.setEnabled(true);
  const socket = sockets.at(-1);
  socket.event({ headers: { 'Spotify-Connection-Id': 'synthetic-connection' } }); await flush();
  return { detector, socket };
}

// Diagnostics must not change projection, store corrections or wire packet shape.
at(0); reset(); api.clearTimingCapture();
let sample = api.sampleFrom(raw()); assert.equal(sample.timingProvenance, undefined);
at(250); const disabledPacket = publish(sample); assert.equal(position(), 10250);
assert.equal(store.getState().driftOffset, 0, 'delivery age compensated exactly once');
at(0); reset(); api.startTimingCapture(); sample = api.sampleFrom(raw());
at(250); const enabledPacket = publish(sample);
assert.equal(JSON.stringify(enabledPacket), JSON.stringify(disabledPacket));
assert.equal(position(), 10250);
const original = sample.timingProvenance;
assert.equal(api.timingSnapshot().records[0].values.normalizedTimestampMs, epoch + 250);
assert.equal(api.timingSnapshot().records[1].values.storeSourceClockMs, epoch + 250);
assert.equal(api.timingSnapshot().records[1].values.latencyMs, 0);
assert(Object.isFrozen(original) && Object.isFrozen(original.receipt) && Object.isFrozen(original.parsed));
assert.equal(original.rawPositionMs, 10000); assert.equal(original.rawTimestampMs, epoch);
assert.equal(original.clusterServerMs, epoch + 7); assert.equal(original.sourceMonotonicMs, null);
at(2000); publish({ ...sample, title: 'Enriched' });
assert.equal(sample.timingProvenance, original); assert.equal(original.receipt.wallMs, epoch);
assert.equal(position(), 12000, 'old valid anchor remains age-compensated on metadata publication');
assert.equal(api.timingSnapshot().records.at(-1).anchor, original);
const mutableReceipt = { wallMs: wall, monotonicMs: mono };
const independentReceipt = api.sampleFrom(raw(), 0, { receipt: mutableReceipt }).timingProvenance.receipt;
mutableReceipt.wallMs = 0; assert.equal(independentReceipt.wallMs, wall);

// Binary Cluster/PlayerState wire numbers and JSON+gzip preserve the SAME
// whitelisted evidence. Session bytes never enter the exported trace verbatim.
const varint = value => { let n = BigInt(value); const bytes = []; do { const b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while (n); return bytes; };
const numberField = (id, value) => [...varint(id * 8), ...varint(value)];
const bytesField = (id, value) => [...varint(id * 8 + 2), ...varint(value.length), ...value];
const textField = (id, value) => bytesField(id, Buffer.from(value));
const playerBytes = [...numberField(1, epoch), ...bytesField(7, textField(1, 'spotify:track:0000000000000000000001')),
  ...numberField(10, 10000), ...numberField(11, 300000), ...numberField(12, 1), ...textField(23, 'synthetic-session')];
const clusterBytes = [...numberField(1, epoch - 1), ...textField(2, 'synthetic-device'), ...bytesField(3, playerBytes),
  ...numberField(6, epoch - 2), ...numberField(9, epoch + 7), ...numberField(11, epoch - 10)];
const binary = api.sampleFrom(api.decodeStateBody(Uint8Array.from(clusterBytes)));
assert.equal(binary.positionMs, 10000); assert.equal(binary.positionTimestampMs, epoch);
assert.equal(binary.timingProvenance.clusterServerMs, epoch + 7);
assert.equal(binary.timingProvenance.clusterChangedMs, epoch - 1);
assert.equal(binary.timingProvenance.clusterTransferMs, epoch - 2);
assert.equal(binary.timingProvenance.clusterStartedPlayingMs, epoch - 10);
assert.match(binary.timingProvenance.session, /^session-/);
const wrapped = api.sampleFrom(api.decodeDealer({ uri: 'hm://connect-state/v1/cluster', payloads: [bytesField(1, clusterBytes)] }));
assert.equal(wrapped.timingProvenance.clusterServerMs, epoch + 7);
assert.equal(wrapped.timingProvenance.schemaPath, '$.payloads[*].cluster.player_state');
const compressed = api.sampleFrom(api.decodeDealer({ headers: { 'transfer-encoding': 'gzip' },
  payloads: [Buffer.from(gzip(JSON.stringify(raw()))).toString('base64')] }));
assert.equal(compressed.timingProvenance.clusterServerMs, wall + 7);

// Known clock skew transfers directly into old playing-anchor error. This is a
// fixture assumption, not a measured skew diagnosis for the captured session.
for (const skew of [-1520, -500, 0, 500, 1520]) {
  at(10000 + skew); reset(); const s = api.sampleFrom(raw(10000, epoch)); publish(s);
  assert.equal(position() - 20000, skew);
}
// Consistently stale position+timestamp is compensated; stale position paired
// with a fresh timestamp is not. Both can resemble skew without provenance.
at(5000); reset(); publish(api.sampleFrom(raw(10000, epoch))); assert.equal(position(), 15000);
reset(); publish(api.sampleFrom(raw(10000, wall))); assert.equal(position() - 15000, -5000);

// Nonfinite/future/unsafe epochs are characterized, not silently repaired.
for (const timestamp of [undefined, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'not-a-time']) {
  at(0); reset(); const state = raw(10000, timestamp); state.player_state.timestamp = timestamp;
  const s = api.sampleFrom(state); assert(s); publish(s); assert.equal(position(), 10000);
  at(2000); assert.equal(position(), 12000);
  if (timestamp === Infinity) assert.equal(s.timingProvenance.rawTimestampMs, 'nonfinite');
}
at(0); assert.equal(api.sampleFrom(raw(NaN)), null);
const invalidString = raw(); invalidString.player_state.timestamp = 'synthetic-private-value';
assert.equal(api.sampleFrom(invalidString).timingProvenance.rawTimestampMs, 'invalid');

// Scheduled-start ambiguity: existing packet-once/store advances immediately,
// while repeated raw projection waits. Neither behavior is "fixed" here.
at(0); reset(); sample = api.sampleFrom(raw(10000, wall + 1500)); publish(sample);
at(500); assert.equal(position(), 10500); assert.equal(api.detectorPacket(sample).positionMs, 10000);
at(2000); assert.equal(position(), 12000); assert.equal(api.detectorPacket(sample).positionMs, 10500);

// Actual detector acceptance, suppression and foreground replay with immutable
// receipt. The legacy receivedAt fallback is deliberately not changed.
at(0); reset(); api.startTimingCapture(); const accepted = [];
let live = await connect(s => { accepted.push(s); publish(s); });
at(50); live.socket.event({ payloads: [raw(10000, wall)] });
const first = accepted.at(-1), receipt = first.timingProvenance.receipt;
at(100); live.socket.event({ payloads: [raw(10000, epoch + 50)] });
assert.equal(accepted.length, 1, 'duplicate suppressed');
at(150); live.socket.event({ payloads: [raw(10000, epoch + 40, true, 'other-device', 'other-session')] });
assert.equal(accepted.length, 1, 'known failure: lower timestamp on new device/session is globally suppressed');
assert(api.timingSnapshot().records.some(r => r.stage === 'stale' && r.anchor.device !== first.timingProvenance.device && r.anchor.session !== first.timingProvenance.session));
at(200); live.socket.event({ payloads: [raw(12000, wall, false)] });
assert.equal(position(), 12000); at(900); assert.equal(position(), 12000);
live.socket.event({ payloads: [raw(12000, wall, true)] }); at(1100); assert.equal(position(), 12200);
live.socket.event({ payloads: [raw(2000, wall, true)] }); assert.equal(position(), 2000, 'backward seek authoritative');
at(1150); live.socket.event({ payloads: [raw(3000, wall, true, 'other-device', 'other-session')] });
assert.notEqual(accepted.at(-1).timingProvenance.device, first.timingProvenance.device);
assert.notEqual(accepted.at(-1).timingProvenance.session, first.timingProvenance.session);
at(1200); const buffering = raw(3500, wall, true); buffering.player_state.is_buffering = true;
live.socket.event({ payloads: [buffering] }); at(1300); assert.equal(position(), 3500, 'buffering never extrapolates');
live.detector.setEnabled(false); at(2000); live.detector.setEnabled(true);
assert.equal(accepted.at(-1).timingProvenance.receipt.wallMs, epoch + 1200);
assert.equal(receipt.wallMs, epoch + 50); live.detector.clear();
// Wall jump changes new wall-projected packets, not an already monotonic store.
const beforeJump = position(); wall += 60000; assert.equal(position(), beforeJump);

// Dealer received before observer registration completes keeps callback time,
// rather than registration completion, including connection identity.
at(0); reset(); api.startTimingCapture(); let release;
fetchResponse = () => new Promise(resolve => { release = resolve; });
const delayed = []; live = await connect(s => delayed.push(s));
at(100); live.socket.event({ payloads: [raw(10000, wall)] });
at(900); release({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }); await flush();
assert.equal(delayed[0].timingProvenance.receipt.wallMs, epoch + 100);
assert.equal(delayed[0].timingProvenance.receipt.monotonicMs, 1100);
assert.equal(delayed[0].timingProvenance.parsed.wallMs, epoch + 900);
assert.equal(delayed[0].timingProvenance.origin, 'dealer');
assert.match(delayed[0].timingProvenance.connection, /^connection-/); live.detector.clear();
fetchResponse = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });

// Whitelisted schema paths never copy dynamic keys or arbitrary numeric-field
// strings. Export contains no titles, raw IDs, credentials, URLs or payloads.
at(0); api.startTimingCapture();
const hostile = { 'synthetic-private-key': raw() }; hostile['synthetic-private-key'].player_state.timestamp = 'synthetic-private-value';
publish(api.sampleFrom(hostile));
const safe = JSON.stringify(api.timingSnapshot());
for (const forbidden of ['synthetic-private', 'synthetic-device', 'synthetic-session', 'Synthetic', 'spotify:track', 'synthetic-test-credential', 'https:', 'cookie', 'account_id']) assert(!safe.includes(forbidden), forbidden);
assert.equal(api.timingSnapshot().records[0].anchor.schemaPath, '$.*.player_state');
for (let i = 0; i < 400; i++) publish(api.sampleFrom(raw(i, wall, true, `device-${i}`, `session-${i}`)));
assert.equal(api.timingSnapshot().records.length, 256); assert(Object.isFrozen(api.timingSnapshot().records[0]));
at(60000); publish(api.sampleFrom(raw())); assert.equal(api.timingSnapshot().active, false);
assert.equal(api.timingSnapshot().records.length, 256);
api.clearTimingCapture(); assert.equal(api.timingSnapshot().records.length, 0);
api.startTimingCapture(); publish(sample);
assert.equal(api.timingSnapshot().records.length, 0, 'old capture anchors cannot enter a new capture');
at(0); reset(); sample = api.sampleFrom(raw());
const locallyDatedPacket = api.detectorPacket(sample);
store.setState({ playbackMode: 'desktop' }); store.getState().ingestPacket(locallyDatedPacket, 'mobile');
assert.equal(api.timingSnapshot().records.at(-1).values.rejection, 'mode');
store.setState({ playbackMode: 'mobile', lastSourceClockMs: wall + 1000 }); store.getState().ingestPacket(locallyDatedPacket, 'mobile');
assert.equal(api.timingSnapshot().records.at(-1).values.rejection, 'older-local-packet');

// All captured comparison rows, epochs shifted by a common synthetic origin.
// The original artifact stored extracted samples, not raw Dealer payloads. Input
// envelopes below are reconstructed; raw schema/flags/metadata timing are unknown.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/spotify-timing-live.json', import.meta.url), 'utf8'));
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const diagnostics of [false, true]) for (const metadataDelay of [null, 250, 1000, 1500, 2000, 5000]) {
  at(0); reset(); api.clearTimingCapture(); if (diagnostics) api.startTimingCapture(); let current;
  live = await connect(s => { current = s; publish(s); });
  const actions = fixture.events.flatMap((e, i) => [{ at: e.receiptMs, event: e, index: i },
    ...(metadataDelay !== null && (!fixture.events[i + 1] || e.receiptMs + metadataDelay < fixture.events[i + 1].receiptMs)
      ? [{ at: e.receiptMs + metadataDelay, metadata: true, index: i }] : [])]).sort((a, b) => a.at - b.at);
  const rows = []; let next = 0;
  for (const row of fixture.rows) {
    while (next < actions.length && actions[next].at <= row.atMs) {
      const action = actions[next++]; at(action.at);
      if (action.metadata) publish({ ...current, title: 'Enriched' });
      else {
        const e = action.event;
        live.socket.event({ payloads: [raw(e.positionMs, epoch + e.sourceTimestampMs, e.playing)] });
      }
    }
    at(row.atMs);
    const event = fixture.events.findLastIndex(e => e.receiptMs <= row.atMs);
    rows.push({ ...row, event, errorMs: position() - row.mprisPositionMs });
    assert.equal(api.detectorPacket(current).positionMs, row.repeatedProjectionMs, 'reconstructed inputs reproduce EVERY recorded repeated projection');
  }
  const perEvent = fixture.events.map((e, i) => {
    const matching = rows.filter(r => r.event === i);
    // Exclude command-to-state races from steady/error envelopes: MPRIS may
    // change before Dealer's corresponding authoritative callback arrives.
    const phases = ['initial', 'initial', 'paused', 'resumed', 'seek'];
    const settled = matching.filter(r => r.phase === phases[i] || (i === 4 && r.phase === 'relay-pairing'));
    const stable = settled.filter(r => r.phaseAgeMs > 3000 && r.atMs - e.receiptMs > 3000);
    const errors = settled.map(r => r.errorMs);
    return { event: i, futureMs: e.sourceTimestampMs - e.receiptMs,
      firstErrorMs: matching[0]?.errorMs, minErrorMs: Math.min(...errors), maxErrorMs: Math.max(...errors),
      stableMedianMs: stable.length ? median(stable.map(r => r.errorMs)) : null };
  });
  const expected = metadataDelay === null ? [-1498, null, 0, -133, -270]
    : metadataDelay === 250 ? [-1498, null, 0, -383, -520]
    : metadataDelay === 1000 ? [-1498, null, 0, -1133, -1270] : [-1498, null, 0, -1520, -1519];
  assert.deepEqual(perEvent.map(e => e.stableMedianMs), expected);
  if (diagnostics) assert.deepEqual(perEvent, results.find(r => r.metadataDelayMs === metadataDelay).perEvent, 'opt-in instrumentation preserves captured replay behavior');
  else results.push({ metadataDelayMs: metadataDelay, perEvent });
  live.detector.clear();
}
console.log(JSON.stringify({ reconstruction: fixture.provenance, results }, null, 2));
assert.equal(timers.size, 0, 'detector cleanup leaves no timers');
console.log('Spotify timing checks passed: actual event-once path, metadata replays, characterized failures, immutable bounded opt-in provenance and privacy.');
