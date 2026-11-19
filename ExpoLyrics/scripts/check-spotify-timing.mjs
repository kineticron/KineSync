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
export {sampleFrom,decodeDealer,decodeStateBody,clusterPositionAge} from './lib/spotify-detector/protocol';
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
  changed_timestamp_ms: timestamp, transfer_data_timestamp: timestamp - 3,
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
// Use identical source inputs: the packet now preserves the source timestamp
// pair even when diagnostics are disabled. Captured legacy fixtures below stay intact.
const neutralityInput = { ...raw(), server_timestamp_ms: epoch };
at(0); reset(); api.clearTimingCapture();
let sample = api.sampleFrom(neutralityInput); assert.equal(sample.timingProvenance, undefined);
at(250); const disabledPacket = publish(sample); assert.equal(position(), 10250);
assert.equal(store.getState().driftOffset, 0, 'delivery age compensated exactly once');
at(0); reset(); api.startTimingCapture(); sample = api.sampleFrom(neutralityInput);
at(250); const enabledPacket = publish(sample);
assert.equal(JSON.stringify(enabledPacket), JSON.stringify(disabledPacket));
assert.equal(position(), 10250);
const original = sample.timingProvenance;
assert.equal(api.timingSnapshot().records[0].values.normalizedTimestampMs, epoch + 250);
assert.equal(api.timingSnapshot().records[1].values.storeSourceClockMs, epoch + 250);
assert.equal(api.timingSnapshot().records[1].values.latencyMs, 0);
assert(Object.isFrozen(original) && Object.isFrozen(original.receipt) && Object.isFrozen(original.parsed));
assert.equal(original.rawPositionMs, 10000); assert.equal(original.rawTimestampMs, epoch);
assert.equal(original.clusterServerMs, epoch); assert.equal(original.sourceMonotonicMs, null);
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
  payloads: [Buffer.from(gzip(JSON.stringify({ ...raw(), server_timestamp_ms: wall + 7 }))).toString('base64')] }));
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
assert.equal(accepted.length, 2, 'older-clock new device/session must be accepted');
assert.notEqual(accepted.at(-1).timingProvenance.device, first.timingProvenance.device);
assert.notEqual(accepted.at(-1).timingProvenance.session, first.timingProvenance.session);
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

// Ordering must work with diagnostics OFF as well as ON.
for (const diagnostics of [false, true]) {
  at(0); reset(); api.clearTimingCapture(); if (diagnostics) api.startTimingCapture();
  const seen = []; live = await connect(s => { seen.push(s); publish(s); });
  const send = (timestamp, device = 'device-A', session = 'session-A', value = 10000) => {
    const frame = raw(value, timestamp == null ? undefined : epoch + timestamp, true, device, session);
    if (timestamp == null) delete frame.player_state.timestamp;
    if (device == null) delete frame.active_device_id;
    if (session == null) delete frame.player_state.session_id;
    live.socket.event({ payloads: [frame] });
  };
  send(5000); assert.equal(seen.length, 1);
  send(4999); assert.equal(seen.length, 1, 'same-source stale suppressed');
  send(4000, 'device-B'); assert.equal(seen.length, 2, 'device-only older-clock switch accepted');
  send(3999, 'device-B'); assert.equal(seen.length, 2, 'new device has its own watermark');
  send(3000, 'device-B', 'session-B'); assert.equal(seen.length, 3, 'session-only older-clock switch accepted');
  send(2999, 'device-B', 'session-B'); assert.equal(seen.length, 3);
  send(3000, 'device-B', 'session-C'); assert.equal(seen.length, 4, 'session transition with equal state fingerprint accepted');
  send(3000, 'device-B', 'session-C'); assert.equal(seen.length, 4, 'same-source duplicate suppressed');
  send(2999, null, null); send(2999, null, 'session-C'); send(2999, 'device-B', null);
  assert.equal(seen.length, 4, 'missing identities never reset known ordering');
  send(3000, null, null); assert.equal(seen.length, 4, 'identity-less duplicate inherits known scope');
  send(null, 'device-C', null, 12000); assert.equal(seen.length, 5, 'known switch without epoch resets previous watermark');
  send(1000, 'device-C', 'session-D', 12000); assert.equal(seen.length, 6);
  send(999, 'device-C', 'session-D', 12000); assert.equal(seen.length, 6);
  const oldSocket = live.socket;
  live.detector.setEnabled(false); live.detector.setEnabled(true);
  live.socket = sockets.at(-1); live.socket.event({ headers: { 'Spotify-Connection-Id': 'reconnected' } }); await flush();
  const count = seen.length;
  oldSocket.event({ payloads: [raw(10000, epoch + 100000)] }); assert.equal(seen.length, count, 'old generation callback ignored');
  send(999, 'device-C', 'session-D', 12000); assert.equal(seen.length, count, 'reconnect retains same-source watermark');
  send(1000, 'device-C', 'session-D', 12000); assert.equal(seen.length, count + 1, 'new connection confirms equal state once');
  send(1000, 'device-C', 'session-D', 12000); assert.equal(seen.length, count + 1);
  live.detector.refresh(); live.socket = sockets.at(-1);
  live.socket.event({ headers: { 'Spotify-Connection-Id': 'refreshed' } }); await flush();
  send(500, 'device-C', 'session-D'); assert.equal(seen.length, count + 2, 'explicit refresh clears source fence');
  live.detector.clear();
  const unknown = []; live = await connect(s => unknown.push(s));
  send(5000, null, null); send(4000); assert.equal(unknown.length, 1, 'identity discovery alone does not prove a switch');
  send(5000); assert.equal(unknown.length, 2); live.detector.clear();
  assert.equal(api.sampleFrom(api.decodeStateBody(Uint8Array.from(clusterBytes))).playbackSessionId, 'synthetic-session', 'binary session exists even with diagnostics OFF');
  const binarySeen = []; live = await connect(s => { binarySeen.push(s); publish(s); });
  const wire = (timestamp, session) => {
    const player = [...numberField(1, epoch + timestamp), ...bytesField(7, textField(1, 'spotify:track:0000000000000000000001')),
      ...numberField(10, 9000), ...numberField(11, 300000), ...numberField(12, 1), ...textField(23, session)];
    const cluster = [...textField(2, 'binary-device'), ...bytesField(3, player)];
    return { uri: 'hm://connect-state/v1/cluster', payloads: [bytesField(1, cluster)] };
  };
  live.socket.event(wire(5000, 'binary-session-A'));
  live.socket.event(wire(4000, 'binary-session-B'));
  live.socket.event(wire(3999, 'binary-session-B'));
  assert.equal(binarySeen.length, 2, 'real binary decoder/detector session switch and same-session stale ordering');
  assert.equal(position(), 9000, 'binary handoff reaches packet and store with diagnostics off/on');
  live.detector.clear();
  // Old-device HTTP snapshot must not switch back after pending Dealer handoff.
  for (const [oldDevice, oldSession] of [['device-A', 'session-A'], ['device-B', 'session-A']]) {
    let resolveRegistration;
    fetchResponse = () => new Promise(resolve => { resolveRegistration = resolve; });
    const raced = []; live = await connect(s => raced.push(s));
    live.socket.event({ payloads: [raw(2000, epoch + 1000, true, 'device-B', 'session-B')] });
    resolveRegistration({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(raw(10000, epoch + 5000, true, oldDevice, oldSession))).buffer });
    await flush(); assert.equal(raced.length, 1); assert.equal(raced[0].activeDeviceId, 'device-B');
    assert.equal(raced[0].playbackSessionId, 'session-B'); live.detector.clear();
  }
  // Abort alone is insufficient when an obsolete registration resolves anyway.
  const registrations = [];
  fetchResponse = () => new Promise(resolve => registrations.push(resolve));
  const replacement = []; live = await connect(s => replacement.push(s));
  live.socket.event({ headers: { 'Spotify-Connection-Id': 'replacement-connection' } });
  registrations[1]({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }); await flush();
  live.socket.event({ payloads: [raw(2000, epoch + 1000)] });
  registrations[0]({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(raw(10000, epoch + 5000))).buffer });
  await flush(); assert.equal(replacement.length, 1, 'obsolete connection registration ignored'); live.detector.clear();
  fetchResponse = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
}

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
// Primary eligibility is evidence-based, never inferred from a phase name.
function primaryEligible(event, actions) {
  if (!event.playing || event.measurementCase !== 'fresh-start' || event.startProvenance !== 'explicit-command') return false;
  const action = actions.findLast(a => a.completedMs <= event.receiptMs);
  return !!action && action.id === event.actionId && action.kind === 'explicit-start' &&
    ['Next', 'OpenUri', 'PlayFromBeginning'].includes(action.command) && action.status === 'ok' && action.observedTrackChange === true;
}
assert.equal(fixture.measurementProtocol.startProvenance, 'unknown');
assert.equal(fixture.measurementProtocol.primaryBaseline, 'not-established');
assert(fixture.events.every(e => !primaryEligible(e, [])), 'old unknown-start run is secondary exploratory only');
const fresh = JSON.parse(readFileSync(new URL('./fixtures/spotify-timing-explicit-start.json', import.meta.url), 'utf8'));
assert.equal(fresh.measurementProtocol.sourceClockCalibration, 'not-established');
const proven = fresh.events.find(e => primaryEligible(e, fresh.actions)); assert(proven);
assert(!primaryEligible({ ...proven, startProvenance: 'unknown' }, fresh.actions));
assert(!primaryEligible({ ...proven, measurementCase: 'transition' }, fresh.actions));
assert(!primaryEligible(proven, fresh.actions.map(a => ({ ...a, status: 'failed' }))));
assert(!primaryEligible(proven, fresh.actions.map(a => ({ ...a, observedTrackChange: false }))));
assert(fresh.events.filter(e => ['seek', 'pause-resume', 'transition', 'exploratory'].includes(e.measurementCase)).every(e => !primaryEligible(e, fresh.actions)));
assert(!primaryEligible({ ...proven, phase: 'fresh-start-1' }, []), 'phase label supplies no start evidence');
at(0); reset(); api.clearTimingCapture(); let freshSample;
live = await connect(s => { freshSample = s; publish(s); });
let eventIndex = -1, maxReplayDifferenceMs = 0;
const primaryRows = [];
for (const row of fresh.rows) {
  while (eventIndex + 1 < fresh.events.length && fresh.events[eventIndex + 1].receiptMs <= row.atMs) {
    const e = fresh.events[++eventIndex]; at(e.receiptMs);
    const frame = raw(e.positionMs, epoch + e.sourceTimestampMs, e.playing);
    frame.player_state.track.uri = `spotify:track:${String(e.track).padStart(22, '0')}`;
    live.socket.event({ payloads: [frame] });
  }
  at(row.atMs);
  assert.equal(api.detectorPacket(freshSample).positionMs, row.repeatedProjectionMs, 'fresh reconstructed source projection matches captured repeated path');
  const replayErrorMs = position() - row.mprisPositionMs;
  maxReplayDifferenceMs = Math.max(maxReplayDifferenceMs, Math.abs(replayErrorMs - row.measuredStoreErrorMs));
  // Capture recorded callback wall time after ingest and row monotonic time
  // separately: these missing stage clocks prohibit exact fractional replay.
  assert(Math.abs(replayErrorMs - row.measuredStoreErrorMs) <= 5, 'event-once reconstruction agrees within bounded missing-stage-clock tolerance');
  const e = fresh.events[eventIndex];
  if (primaryEligible(e, fresh.actions) && row.phaseAgeMs > 3000 && row.sameTrack && row.playing && row.mobilePlaying && row.desktopPlaying) primaryRows.push(row);
}
live.detector.clear();
const freshResults = ['fresh-start-1', 'fresh-start-2', 'fresh-start-3'].map(phase => {
  const rows = primaryRows.filter(r => r.phase === phase); assert(rows.length > 0);
  return { phase, n: rows.length, measuredStoreMedianMs: median(rows.map(r => r.measuredStoreErrorMs)),
    repeatedProjectionMedianMs: median(rows.map(r => r.repeatedProjectionMs - r.mprisPositionMs)),
    desktopMedianMs: median(rows.map(r => r.desktopPositionMs - r.mprisPositionMs)) };
});
assert.deepEqual(freshResults.map(r => Math.round(r.measuredStoreMedianMs)), [-174, -124, -194]);
console.log(JSON.stringify({ primaryEvidence: 'three successful explicit Next commands with observed track changes; position telemetry only', freshResults, maxReplayDifferenceMs }, null, 2));
// Synthetic auto-advance/track-change is an independent regression case, never a
// steady fresh-start calibration observation or evidence of audio presentation.
at(0); reset(); live = await connect(s => publish(s));
live.socket.event({ payloads: [raw(90000, wall)] });
at(100); const transition = raw(400, wall); transition.player_state.track.uri = 'spotify:track:0000000000000000000002';
live.socket.event({ payloads: [transition] });
assert.equal(store.getState().currentTrack.spotifyTrackId, '0000000000000000000002');
assert.equal(position(), 400); live.detector.clear();

// Captured JSON schema subsets: these frames include genuine server/player
// clock pairs, unlike the older reconstructed envelopes. Synthetic metadata
// values preserve the real asynchronous publication timing without identifiers.
const bootstraps = JSON.parse(readFileSync(new URL('./fixtures/spotify-bootstrap-captured.json', import.meta.url), 'utf8'));
for (const diagnostics of [false, true]) for (const capture of bootstraps.cases) for (const useClusterClock of [false, true]) {
  at(0); reset(); api.clearTimingCapture(); if (diagnostics) api.startTimingCapture();
  let current, catalog, metadataPending, resolveMetadata;
  const registrationPending = [];
  const actualPublish = s => {
    const input = { ...s, ...(catalog ?? {}) };
    if (!useClusterClock) { delete input.sourceServerTimestampMs; delete input.positionObservedAt; }
    return publish(input);
  };
  fetchResponse = (url, options) => options.method === 'GET'
    ? new Promise(resolve => { resolveMetadata = resolve; })
    : new Promise(resolve => registrationPending.push(resolve));
  live = await connect(s => {
    current = s; actualPublish(s);
    if (!metadataPending) metadataPending = live.detector.metadata(s.uri).then(m => { catalog = m; actualPublish(current); });
  });
  const events = capture.frames.map(frame => {
    const processed = capture.stages.find(s => s.kind === 'sample-callback' && s.wallMs >= frame.receiptMs && s.wallMs <= frame.receiptMs + 20);
    assert(processed, 'capture has an explicit callback time for every state frame');
    return { at: processed.wallMs, frame };
  });
  for (const s of capture.stages) {
    if (s.kind === 'explicit-observer-refresh') events.push({ at: s.wallMs, refresh: true });
    if (s.kind === 'metadata-resolved') events.push({ at: s.wallMs, metadata: true });
  }
  events.sort((a, b) => a.at - b.at);
  let next = 0; const errors = [];
  for (const row of capture.rows) {
    while (next < events.length && events[next].at <= row.wallMs) {
      const event = events[next++]; at(event.at);
      if (event.refresh) {
        live.detector.refresh(); live.socket = sockets.at(-1);
        live.socket.event({ headers: { 'Spotify-Connection-Id': 'bootstrap-refreshed' } }); await flush();
      } else if (event.metadata) {
        resolveMetadata({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({
          gid: '00000000000000000000000000000001', name: 'Synthetic', artist: [{ name: 'Synthetic' }], album: { name: 'Synthetic' },
        })).buffer }); await flush();
      } else if (event.frame.kind === 'registration') {
        registrationPending.shift()({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(event.frame.body)).buffer }); await flush();
      } else live.socket.event(event.frame.frame);
    }
    at(row.wallMs);
    if (current && row.sameTrack) errors.push({ phase: row.phase, at: row.wallMs, error: position() - row.mprisPositionMs });
  }
  const summaries = ['bootstrap', 'resumed', 'reobserve'].map(phase => {
    const values = errors.filter(x => x.phase === phase).map(x => x.error);
    return { phase, medianMs: median(values) };
  });
  if (useClusterClock) {
    assert(summaries.every(x => Math.abs(x.medianMs) < 150), 'captured bootstrap/resume/refresh agree without clock-offset constants');
    assert(Math.abs(summaries[0].medianMs - summaries[2].medianMs) < 120, 'reobservation does not reintroduce the server/local clock discrepancy');
    const originalReceipt = current.positionObservedAt;
    at(capture.rows.at(-1).wallMs + 1000);
    const before = api.detectorPacket(current).positionMs;
    const replay = { ...current, receivedAt: wall }; // legacy foreground relabel
    assert.equal(api.detectorPacket(replay).positionMs, before, 'immutable monotonic position receipt survives foreground replay');
    wall += 60000;
    assert.equal(api.detectorPacket(replay).positionMs, before, 'cluster-relative age ignores a local wall-clock jump');
    assert.equal(current.positionObservedAt, originalReceipt);
  } else assert(summaries[0].medianMs < -1300 && summaries[2].medianMs < -1300, 'same captured frames reproduce the old first-anchor/refresh lag');
  console.log(JSON.stringify({ bootstrapCapture: capture.name, useClusterClock, summaries }));
  live.detector.clear();
}
fetchResponse = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
// Explicit paired-clock guards: no extra transit correction, no invented skew,
// no coercion of an invalid/future scheduled reference into elapsed age.
at(250); reset();
const pair = { ...raw(10000, epoch + 1520), server_timestamp_ms: epoch + 1770 };
let paired; live = await connect(s => { paired = s; publish(s); });
live.socket.event({ payloads: [pair] }); assert.equal(position(), 10250, 'server-relative age compensates exactly once despite a different local epoch');
at(750); assert.equal(position(), 10750); assert.equal(api.detectorPacket(paired).positionMs, 10750);
const age = api.clusterPositionAge(paired); assert.equal(age, 250);
for (const server of [undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, epoch + 1519]) {
  assert.equal(api.clusterPositionAge({ ...paired, sourceServerTimestampMs: server }), undefined);
}
live.detector.clear();
at(0); api.clearTimingCapture();
const unrelated = api.sampleFrom({ server_timestamp_ms: epoch + 9000, data: raw(10000, epoch) });
assert.equal(unrelated.sourceServerTimestampMs, undefined, 'server reference must belong to the selected player snapshot');
const scheduled = api.sampleFrom({ ...raw(10000, epoch + 2000), server_timestamp_ms: epoch + 1000 });
assert.equal(api.clusterPositionAge(scheduled), undefined);
assert.equal(api.detectorPacket(scheduled).positionMs, 10000, 'future/scheduled pair retains legacy projection');
for (const malformed of ['bad', '', null, false]) {
  const invalid = api.sampleFrom({ ...raw(10000, epoch), server_timestamp_ms: malformed });
  assert.equal(invalid.sourceServerTimestampMs, undefined);
}
const binaryClock = [...textField(2, 'binary-device'), ...bytesField(3, playerBytes), ...numberField(9, epoch + 250)];
reset(); live = await connect(s => publish(s));
live.socket.event({ uri: 'hm://connect-state/v1/cluster', payloads: [bytesField(1, binaryClock)] });
assert.equal(position(), 10250, 'binary server field 9 works with diagnostics OFF'); live.detector.clear();

console.log(JSON.stringify({ reconstruction: fixture.provenance, results }, null, 2));
assert.equal(timers.size, 0, 'detector cleanup leaves no timers');
console.log('Spotify timing checks passed: actual event-once path, metadata replays, characterized failures, immutable bounded opt-in provenance and privacy.');
