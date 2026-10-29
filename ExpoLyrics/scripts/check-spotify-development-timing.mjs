import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// Offline parser -> packet -> real store checks. No detector connection,
// playback controls, Spotify APIs, browser, or real timers are used.
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
export * from './lib/spotify-detector/development-timing-log';
export {sampleFrom,decodeStateBody} from './lib/spotify-detector/protocol';
export {detectorPacket} from './lib/spotify-detector/packet';
export {usePlaybackStore} from './store/playback-store';` }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'native-stubs', setup(b) {
    b.onResolve({ filter: /^(@react-native-async-storage\/async-storage|expo-secure-store|expo-constants|react-native)$/ }, a => ({ path: a.path, namespace: 'native' }));
    b.onLoad({ filter: /.*/, namespace: 'native' }, a => ({ contents: a.path === 'react-native'
      ? 'export const AppState={currentState:"background",addEventListener:()=>({remove(){}})};export const Platform={OS:"web"};'
      : 'export default {getItem:async()=>null,setItem:async()=>{}};export const getItemAsync=async()=>null;export const setItemAsync=async()=>{};export const deleteItemAsync=async()=>{};' }));
  } }],
});
const epoch = 1_800_000_000_000;
const marker = '[Spotify timing bootstrap] ';
function runtime(development, throwConsole = false) {
  const clock = { wall: epoch + 250, mono: 1000 }, logs = [], module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url),
    __DEV__: development, process: { env: { NODE_ENV: development ? 'development' : 'production' } },
    Date: class extends Date { static now() { return clock.wall; } }, performance: { now: () => clock.mono },
    console: { log(line) { if (throwConsole) throw new Error('console unavailable'); assert(line.startsWith(marker)); logs.push(JSON.parse(line.slice(marker.length))); } },
    setTimeout() { throw new Error('No real timers allowed'); }, clearTimeout() {}, setInterval() { throw new Error('No real timers allowed'); }, clearInterval() {},
    fetch() { throw new Error('No network allowed'); }, TextDecoder, TextEncoder, URL, Buffer,
  });
  const api = module.exports;
  api.usePlaybackStore.setState({ playbackMode: 'mobile' });
  return { api, clock, logs };
}
function input(player = epoch, server = epoch + 250) {
  return { active_device_id: 'private-device', server_timestamp_ms: server, player_state: {
    timestamp: player, session_id: 'private-session', position_as_of_timestamp: 10000, duration: 300000,
    is_playing: true, is_paused: false,
    track: { uri: 'spotify:track:0000000000000000000001', metadata: { title: 'private-title', artist_name: 'private-artist' } },
  } };
}
function sample(r, body, origin = 'registration') {
  const receipt = Object.freeze({ wallMs: r.clock.wall, monotonicMs: r.clock.mono });
  const s = r.api.sampleFrom(body, 0, { receipt, origin, connectionId: 'private-connection', generation: 2 });
  // Same assignment as detector.emit, without opening any socket or request.
  s.receivedAt = receipt.wallMs;
  if (s.sourceServerTimestampMs !== undefined) s.positionObservedAt = receipt;
  return s;
}
function publish(r, s) {
  r.api.logDevelopmentTiming('accepted', s);
  const packet = r.api.detectorPacket(s);
  r.api.usePlaybackStore.getState().ingestPacket(packet, 'mobile');
  const state = r.api.usePlaybackStore.getState();
  return { packet: JSON.parse(JSON.stringify(packet)), anchorPositionMs: state.anchorPositionMs,
    anchorMonotonicMs: state.anchorMonotonicMs, playing: state.isPlaying, driftOffset: state.driftOffset };
}
const cases = [
  { name: 'paired', body: input(), reason: 'paired', projection: 'paired' },
  { name: 'missing-player', body: input(undefined), reason: 'missing-player', projection: 'legacy', missing: 'player' },
  { name: 'null-player', body: input(null), reason: 'missing-player', projection: 'legacy' },
  { name: 'invalid-player', body: input('Bearer private-token'), reason: 'invalid-player', projection: 'legacy' },
  { name: 'non-epoch-player', body: input(0), reason: 'invalid-player', projection: 'legacy' },
  { name: 'nonfinite-player', body: input(Infinity), reason: 'invalid-player', projection: 'legacy' },
  { name: 'missing-server', body: input(), reason: 'missing-server', projection: 'legacy', missing: 'server' },
  { name: 'invalid-server', body: input(epoch, 'private-cookie'), reason: 'invalid-server', projection: 'legacy' },
  { name: 'unsafe-server', body: input(epoch, Number.MAX_SAFE_INTEGER + 1), reason: 'invalid-server', projection: 'legacy' },
  { name: 'scheduled-future', body: input(epoch + 500, epoch + 250), reason: 'future-player-relative-to-server', projection: 'legacy' },
];
for (const c of cases) {
  if (c.missing === 'player') delete c.body.player_state.timestamp;
  if (c.missing === 'server') delete c.body.server_timestamp_ms;
  const off = runtime(false), on = runtime(true);
  const offSample = sample(off, c.body), onSample = sample(on, c.body);
  assert.equal(offSample.developmentTiming, undefined);
  assert.deepEqual(publish(on, onSample), publish(off, offSample), `${c.name}: logger cannot change packet/store behavior`);
  assert.equal(off.logs.length, 0, 'production has no automatic logs');
  const line = on.logs.at(-1);
  assert.equal(line.stage, 'normalize'); assert.equal(line.projection, c.projection);
  assert(line.reasons.includes(c.reason), c.name);
  assert.equal(line.raw.origin, 'registration'); assert.equal(line.raw.playerPath, '$.player_state');
  assert.equal(line.raw.serverPath, '$'); assert.equal(line.raw.playerField, 'timestamp');
  assert.equal(line.raw.serverField, 'server_timestamp_ms');
  assert.equal(line.raw.receipt.wallMs, epoch + 250); assert.equal(line.raw.receipt.monotonicMs, 1000);
  assert.equal(line.raw.rawPositionMs, 10000);
  if (c.name === 'missing-player') assert.equal(line.raw.player.kind, 'missing');
  if (c.name === 'null-player') assert.equal(line.raw.player.kind, 'null');
  if (c.name === 'invalid-player') assert.deepEqual(line.raw.player, { kind: 'string', value: 'invalid' });
  if (c.name === 'nonfinite-player') assert.equal(line.raw.player.value, 'nonfinite');
  const safe = JSON.stringify(on.logs);
  for (const value of ['private-device', 'private-session', 'private-connection', 'private-token', 'private-cookie', 'private-title', 'private-artist', 'spotify:track:']) assert(!safe.includes(value), value);
}
// Exact decoded flag evidence only: do not coerce strings to booleans or copy unknown keys.
for (const flags of [
  { is_playing: true, is_paused: true, loading: false, is_buffering: false },
  { is_playing: true, is_paused: false, loading: true, is_buffering: 1 },
  { is_playing: true, paused: false, loading: 'private-token', is_buffering: null },
  { is_playing: true, is_buffering: { secret: 'private-cookie' } },
]) {
  const body = input(); delete body.player_state.is_paused;
  Object.assign(body.player_state, flags, { unknown_private_field: 'private-account' });
  body.started_playing_at_timestamp = epoch + 1000; // future evidence does NOT select a new normalization path
  const off = runtime(false), on = runtime(true), a = sample(off, body), b = sample(on, body);
  assert.deepEqual(publish(on, b), publish(off, a));
  const evidence = b.developmentTiming;
  assert(Object.isFrozen(evidence.stateFlags) && Object.isFrozen(evidence.stateFlags.loading));
  assert.equal(evidence.stateFlags.loading.present, Object.hasOwn(flags, 'loading'));
  assert.equal(evidence.stateFlags.paused.present, Object.hasOwn(flags, 'paused'));
  assert.equal(evidence.stateFlags.is_playing.value, true);
  assert.equal(evidence.flagPresenceScope, 'decoded-player-state');
  assert.equal(evidence.binaryFalseDefaultsPossible, true);
  assert.equal(evidence.clusterClocks.started_playing_at_timestamp.value, epoch + 1000);
  assert.equal(on.logs.at(-1).projection, 'paired');
  const originalFlags = evidence.stateFlags;
  on.clock.mono += 100; on.clock.wall += 100;
  publish(on, { ...b, title: 'Metadata', receivedAt: on.clock.wall });
  assert.equal(b.developmentTiming.stateFlags, originalFlags);
  assert.equal(on.logs.at(-1).raw.receipt.monotonicMs, 1000);
  assert(!/private-token|private-cookie|private-account|unknown_private_field/.test(JSON.stringify(on.logs)));
}
// Actual binary decode retains known cluster clocks with DEV diagnostics, without opt-in capture.
{
  const varint = value => { let n = BigInt(value); const bytes = []; do { const b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while (n); return bytes; };
  const number = (id, value) => [...varint(id * 8), ...varint(value)];
  const bytes = (id, value) => [...varint(id * 8 + 2), ...varint(value.length), ...value];
  const track = bytes(1, [...new TextEncoder().encode('spotify:track:0000000000000000000001')]);
  const player = [...number(1, epoch), ...bytes(7, track), ...number(10, 10000), ...number(12, 1)];
  const body = Uint8Array.from([...number(9, epoch + 250), ...number(11, epoch + 1000), ...bytes(3, player)]);
  const on = runtime(true), off = runtime(false);
  const decodedOn = on.api.decodeStateBody(body), decodedOff = off.api.decodeStateBody(body);
  assert.equal(decodedOn.started_playing_at_timestamp, epoch + 1000);
  assert.equal(decodedOff.started_playing_at_timestamp, undefined);
  const a = sample(off, decodedOff), b = sample(on, decodedOn);
  assert.deepEqual(publish(on, b), publish(off, a));
  // Decoder supplies false defaults. These are NOT claimed to be wire presence.
  assert.equal(b.developmentTiming.stateFlags.is_buffering.present, true);
  assert.equal(b.developmentTiming.stateFlags.is_buffering.value, false);
  assert.equal(b.developmentTiming.binaryFalseDefaultsPossible, true);
}
// Missing BOTH fields is not conflated with a malformed player timestamp.
{
  const r = runtime(true), body = input(); delete body.player_state.timestamp; delete body.server_timestamp_ms;
  publish(r, sample(r, body)); assert.deepEqual(r.logs.at(-1).reasons, ['missing-player', 'missing-server']);
}
// Immutable evidence is shared through real metadata spread / cached replay.
{
  const off = runtime(false), on = runtime(true);
  const a = sample(off, input(), 'dealer'), b = sample(on, input(), 'dealer'), original = b.developmentTiming;
  assert(Object.isFrozen(original) && Object.isFrozen(original.receipt));
  publish(off, a); publish(on, b);
  for (const r of [off, on]) { r.clock.wall += 500; r.clock.mono += 500; }
  const metadata = { title: 'Enriched', artist: 'Artist' };
  assert.deepEqual(publish(on, { ...b, ...metadata }), publish(off, { ...a, ...metadata }));
  const line = on.logs.at(-1); assert.equal(line.raw.origin, 'dealer'); assert.equal(line.raw.anchor, original.anchor);
  assert.equal(line.sinceOriginalReceiptMs, 500); assert.equal(line.elapsedMs, 750); assert.equal(line.elapsedClock, 'monotonic');
  on.api.logDevelopmentTiming('foreground-replay', b);
  assert.deepEqual(publish(on, { ...b, receivedAt: on.clock.wall }), publish(off, { ...a, receivedAt: off.clock.wall }));
  assert.equal(on.logs.at(-1).raw.receipt.wallMs, epoch + 250);
  assert.equal(on.logs.at(-1).legacyReceivedAtMs, epoch + 750);
  assert.equal(b.developmentTiming, original);
}
// Dynamic schema keys cannot become identifying log strings.
{
  const r = runtime(true); publish(r, sample(r, { 'private-account-key': input() }));
  assert.equal(r.logs.at(-1).raw.playerPath, '$.*.player_state');
  assert(!JSON.stringify(r.logs).includes('private-account-key'));
}
// Detail windows expire, but foreground/track contexts reopen bounded evidence.
{
  const r = runtime(true), s = sample(r, input());
  for (let i = 0; i < 200; i++) r.api.detectorPacket(s);
  assert.equal(r.logs.filter(l => l.stage === 'normalize').length, 96);
  assert.equal(r.api.developmentTimingActive(), true, 'bounded raw provenance remains available for later contexts');
  r.clock.mono += 121000;
  r.api.logDevelopmentLifecycle('app-state', { previous: 'background', next: 'active' });
  r.api.detectorPacket(s);
  assert.equal(r.logs.at(-1).stage, 'normalize');
  assert(r.logs.some(l => l.stage === 'app-state' && l.suppressedSinceLastLine > 0));
  assert.equal(r.logs.at(-1).raw.anchor, s.developmentTiming.anchor);
}
{
  const r = runtime(true), s = sample(r, input()); r.api.detectorPacket(s);
  const count = r.logs.length;
  r.clock.mono += 120000; r.api.detectorPacket(s);
  assert.equal(r.logs.length, count);
  r.api.logDevelopmentLifecycle('app-state', { previous: 'background', next: 'active' });
  r.api.detectorPacket(s); assert.equal(r.logs.at(-1).stage, 'normalize');
  r.clock.mono += 121000;
  const next = input(); next.player_state.track.uri = 'spotify:track:0000000000000000000002';
  publish(r, sample(r, next, 'dealer'));
  assert.equal(r.logs.at(-1).stage, 'normalize');
  assert.notEqual(r.logs.at(-1).track, r.logs.find(l => l.stage === 'normalize').track);
  assert.equal(r.logs[0].stage, 'js-startup'); assert.equal(r.logs[0].version, 3); assert.equal(r.logs[0].buildBase, '0453f4e');
  assert(!JSON.stringify(r.logs).includes('spotify:track:'));
}
{
  const r = runtime(true);
  for (let window = 0; window < 80; window++) {
    r.api.logDevelopmentLifecycle('app-state', { previous: 'background', next: 'active' });
    const s = sample(r, input());
    for (let i = 0; i < 100; i++) r.api.detectorPacket(s);
  }
  assert.equal(r.logs.filter(l => l.stage === 'normalize').length, 512);
  assert.equal(r.logs.filter(l => l.stage !== 'normalize').length, 64);
  r.clock.mono += 3600000;
  r.api.logDevelopmentLifecycle('app-state', { previous: 'background', next: 'active' });
  assert(r.logs.at(-1).suppressedSinceLastLine > 0);
}

{
  const r = runtime(true, true); assert.equal(r.api.detectorPacket(sample(r, input())).positionMs, 10250, 'console failure cannot change playback');
}
console.log('Spotify development timing diagnostics passed: production silence, unchanged normalization/store, explicit fallback reasons, immutable receipt, privacy and automatic bounds; no network or playback controls.');
