import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// Offline parser -> packet -> real store checks. No detector connection,
// playback controls, Spotify APIs, browser, or real timers are used.
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
export * from './lib/spotify-detector/development-timing-log';
export {sampleFrom} from './lib/spotify-detector/protocol';
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
// Per-JS-runtime cap and monotonic expiry, without recurring timers or resets.
{
  const r = runtime(true), s = sample(r, input());
  for (let i = 0; i < 200; i++) r.api.detectorPacket(s);
  assert.equal(r.logs.length, 96); assert.equal(r.logs.at(-1).sequence, 96);
  assert.equal(r.api.developmentTimingActive(), false);
  assert.equal(sample(r, input()).developmentTiming, undefined);
}
{
  const r = runtime(true), s = sample(r, input()); r.api.detectorPacket(s);
  r.clock.mono += 120000; r.api.detectorPacket(s);
  assert.equal(r.logs.length, 1); assert.equal(r.api.developmentTimingActive(), false);
}
{
  const r = runtime(true, true); assert.equal(r.api.detectorPacket(sample(r, input())).positionMs, 10250, 'console failure cannot change playback');
}
console.log('Spotify development timing diagnostics passed: production silence, unchanged normalization/store, explicit fallback reasons, immutable receipt, privacy and automatic bounds; no network or playback controls.');
