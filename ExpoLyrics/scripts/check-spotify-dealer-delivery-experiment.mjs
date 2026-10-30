import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// Actual detector emit -> detectorPacket -> playback-store path. Only platform
// storage/AppState are stubbed; no browser/WebView path is bundled.
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
export { SpotifyDetector } from './lib/spotify-detector/client';
export { DealerDeliveryBaseline } from './lib/spotify-detector/dealer-delivery-baseline';
export { setDealerDeliveryExperimentEnabled } from './lib/spotify-detector/dealer-delivery-experiment-toggle';
export { detectorPacket } from './lib/spotify-detector/packet';
export { usePlaybackStore } from './store/playback-store';` }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'native-stubs', setup(b) {
    b.onResolve({ filter: /^(@react-native-async-storage\/async-storage|expo-secure-store|expo-constants|react-native)$/ }, a => ({ path: a.path, namespace: 'native-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'native-stub' }, a => ({ contents: a.path === 'react-native'
      ? 'export const AppState={currentState:"background",addEventListener:()=>({remove(){}})};export const Platform={OS:"web"};'
      : 'export default {getItem:async()=>null,setItem:async()=>{}};export const getItemAsync=async()=>null;export const setItemAsync=async()=>{};export const deleteItemAsync=async()=>{};' }));
  } }],
});

const epoch = 1_800_000_000_000;
let wall = epoch, mono = 1000;
const module = { exports: {} };
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports,
  require: createRequire(import.meta.url), __DEV__: true,
  process: { env: { NODE_ENV: 'development' } }, console: { log() {}, warn() {}, error() {} },
  Date: class extends Date { static now() { return wall; } }, performance: { now: () => mono },
  fetch: () => { throw new Error('Toggle must not make Spotify requests'); },
  setTimeout: () => { throw new Error('No timers expected'); }, setInterval: () => { throw new Error('No timers expected'); },
  clearTimeout() {}, clearInterval() {}, AbortController, TextDecoder, TextEncoder, URL, Buffer,
});
const api = module.exports;
const identity = { device: 'device', session: 'session', routeEpoch: 1, authEpoch: 1 };
const stamp = (ms, wallOffset = 0) => ({ monotonicMs: 1000 + ms, wallMs: epoch + ms + wallOffset });
const observation = (ms, serverMs, playerTimestampMs = epoch + ms, currentIdentity = identity, ageMs = 0) => ({
  serverMs, playerTimestampMs, receipt: stamp(ms), nowMono: 1000 + ms + ageMs, identity: currentIdentity,
});

// Model rules: Dealer-only lower envelope, registration-only projection,
// bounded freshness, monotonic ordering and same-instance explicit-refresh carry.
{
  const model = new api.DealerDeliveryBaseline();
  assert.equal(model.registrationExcess(observation(0, epoch)), undefined, 'registration cannot seed a baseline');
  assert.equal(model.observeDealer(observation(0, epoch)), true, 'first valid Dealer sample seeds zero excess');
  assert.equal(model.registrationExcess(observation(100, epoch + 60, epoch + 50), true), 40);
  assert.equal(model.registrationExcess(observation(200, epoch + 150, epoch + 50), true), 50,
    'registration probes do not train or renew the Dealer envelope');
  assert.equal(model.registrationExcess(observation(300, epoch + 155, epoch + 150), true), 145,
    'variable complete-message delivery is measured above the fastest Dealer baseline');
  assert.equal(model.registrationExcess(observation(400, epoch + 60, epoch + 50), false), 0,
    'paused playback receives no delivery correction');
  assert.equal(model.registrationExcess(observation(500, epoch + 60, epoch - 1), true), undefined,
    'backward player timestamp is not used as an eligible registration anchor');
  assert.equal(model.registrationExcess(observation(600, epoch + 60, undefined), true), undefined);
  assert.equal(model.registrationExcess(observation(700, epoch + 60, epoch + 50, identity, 1001), true), undefined,
    'stale receipt evidence falls back');
  assert.equal(model.registrationExcess(observation(800, epoch + 799, epoch + 800), true), undefined,
    'server timestamp before player timestamp is rejected');
  assert.equal(model.registrationExcess(observation(900, Number.MAX_SAFE_INTEGER + 1), true), undefined,
    'unsafe/future timestamp is rejected');

  const duplicate = observation(1000, epoch + 1000);
  assert.equal(model.observeDealer(duplicate), true);
  assert.equal(model.observeDealer(observation(1001, epoch + 1000, epoch + 1000)), false,
    'duplicate Dealer envelope never renews freshness');
  assert.equal(model.registrationExcess(observation(4101, epoch + 4061), true), undefined,
    'stale Dealer envelope expires');

  const carry = new api.DealerDeliveryBaseline();
  carry.observeDealer(observation(0, epoch));
  carry.preserveForExplicitRefresh(1200, identity);
  assert.equal(carry.registrationExcess(observation(100, epoch + 60, epoch + 50), true), 40,
    'fresh matching Dealer evidence survives one explicit same-instance refresh');
  const noCarry = new api.DealerDeliveryBaseline();
  noCarry.observeDealer(observation(0, epoch));
  noCarry.preserveForExplicitRefresh(1200, identity);
  assert.equal(noCarry.registrationExcess(observation(100, epoch + 60, epoch + 50,
    { ...identity, device: 'other-device' }), true), undefined, 'device handoff cannot borrow a carried baseline');
  for (const changed of [{ session: 'other-session' }, { authEpoch: 2 }, { routeEpoch: 2 }]) {
    const isolated = new api.DealerDeliveryBaseline();
    isolated.observeDealer(observation(0, epoch));
    assert.equal(isolated.registrationExcess(observation(100, epoch + 60, epoch + 50,
      { ...identity, ...changed }), true), undefined, 'session/auth/route mismatch cannot borrow a baseline');
  }
  const expiredCarry = new api.DealerDeliveryBaseline();
  expiredCarry.observeDealer(observation(0, epoch));
  expiredCarry.preserveForExplicitRefresh(7000, identity);
  assert.equal(expiredCarry.registrationExcess(observation(7001, epoch + 6961, epoch + 6960), true), undefined,
    'stale pre-refresh evidence cannot be carried');

  const reset = new api.DealerDeliveryBaseline();
  reset.observeDealer(observation(0, epoch));
  assert.equal(reset.observeDealer(observation(100, epoch + 250, epoch + 100,
    identity, 0)), false, 'an unexplained server-clock low outlier is rejected');
  assert.equal(reset.observeDealer({ ...observation(200, epoch + 200), receipt: stamp(200, 250) }), true,
    'a wall/monotonic clock step resets and reseeds the model');
  assert.equal(reset.registrationExcess({ ...observation(300, epoch + 300, epoch + 250), receipt: stamp(300, 250) }, true), 0,
    'post-step Dealer evidence reseeds with zero claimed excess');
  assert.equal(reset.observeDealer(observation(300, epoch + 300, epoch + 300,
    { ...identity, routeEpoch: 2 })), true, 'route/session epoch change establishes an independent baseline');

  const drift = new api.DealerDeliveryBaseline();
  drift.observeDealer(observation(0, epoch));
  assert.equal(drift.observeDealer({ ...observation(20_000, epoch + 20_000), receipt: stamp(20_000, 2) }), true,
    'small accumulated wall/monotonic drift remains within the conservative tolerance');
  assert.equal(drift.registrationExcess({ ...observation(20_100, epoch + 20_000, epoch + 20_000),
    receipt: stamp(20_100, 2) }, true), 100);
  assert.equal(drift.observeDealer({ ...observation(21_000, epoch + 21_000), receipt: stamp(21_000, 30) }), true,
    'excessive wall/monotonic drift resets and reseeds rather than extending old evidence');
  assert.equal(drift.registrationExcess({ ...observation(21_100, epoch + 21_100, epoch + 21_000),
    receipt: stamp(21_100, 30) }, true), 0);

  const cleared = new api.DealerDeliveryBaseline();
  cleared.observeDealer(observation(0, epoch));
  cleared.clear();
  assert.equal(cleared.registrationExcess(observation(100, epoch + 60, epoch + 50), true), undefined,
    'ordinary reconnect/reset clears the learned baseline');

  const captured = new api.DealerDeliveryBaseline();
  captured.observeDealer(observation(0, epoch, epoch - 200));
  const captureObservation = { ...observation(99.836582959, epoch - 45, epoch - 100),
    receipt: stamp(99.836582959) };
  const captureExcess = captured.registrationExcess(captureObservation, true);
  assert(Math.abs(captureExcess - 144.836582959) < 0.001, 'captured 325ms decomposition yields its ~145ms envelope-relative excess');
  assert(Math.abs((324.836582959 - captureExcess) - 180) < 0.001,
    'the separate ~180ms source residual remains after the experimental delivery correction');
}

const store = api.usePlaybackStore;
store.setState({ playbackMode: 'mobile', currentTrack: null, anchorPositionMs: 0,
  anchorMonotonicMs: mono, anchorTimestampMs: wall, playbackPosition: 0, isPlaying: false,
  clockSkewBaselineMs: NaN, lastSourceClockMs: 0, playbackCompensationMs: 0, bridgeTiming: {} });
api.setDealerDeliveryExperimentEnabled(true);
const accepted = [];
const detector = new api.SpotifyDetector({ sample: s => {
  accepted.push(s);
  store.getState().ingestPacket(api.detectorPacket(s), 'mobile');
}, ready() {}, status() {}, sessionNeeded() {}, authenticated() {} });
detector.setEnabled(true);

function state(serverMs, playerMs, positionMs = 10000) {
  return { server_timestamp_ms: serverMs, active_device_id: 'synthetic-device', player_state: {
    timestamp: playerMs, position_as_of_timestamp: positionMs, duration: 300000,
    is_playing: true, is_paused: false, session_id: 'synthetic-session',
    track: { uri: 'spotify:track:0000000000000000000001', metadata: {
      title: 'Synthetic', artist_name: 'Synthetic artist', album_title: 'Synthetic album' } },
  } };
}
// Invoke the real private event acceptance method with captured-equivalent
// decoded frames; this leaves parsing/acceptance/model/toggle/packet/store real.
const emit = (origin, body) => detector.emit(body, wall, { origin,
  connectionId: 'synthetic-connection', generation: 1, receipt: { wallMs: wall, monotonicMs: mono } });

// Dealer establishes the sole baseline. Registration arrives at +100ms, with
// a 40ms excess relative to that baseline; registration does not train it.
emit('dealer', state(epoch, epoch));
wall = epoch + 100; mono = 1100;
emit('registration', state(epoch + 60, epoch + 50));
assert.equal(accepted.length, 2);
const registration = accepted.at(-1);
assert.equal(registration.dealerDeliveryExcessMs, 40);
assert.equal(registration.dealerDeliveryExperimentEnabled, true);
assert.equal(api.detectorPacket(registration).positionMs, 10050, 'enabled packet contains the 40ms correction');
assert.equal(store.getState().anchorPositionMs, 10000,
  'ordinary registration remains inside the pre-existing 80ms store deadband');
const receivedAt = registration.positionObservedAt.monotonicMs;
const frozenCorrection = registration.dealerDeliveryExcessMs;

// Each toggle republishes the same raw anchor and never makes a network call.
api.setDealerDeliveryExperimentEnabled(false);
assert.equal(accepted.length, 3);
assert.equal(accepted.at(-1).dealerDeliveryExcessMs, frozenCorrection);
assert.equal(accepted.at(-1).dealerDeliveryExperimentEnabled, false);
assert.equal(accepted.at(-1).positionObservedAt.monotonicMs, receivedAt);
assert.equal(store.getState().anchorPositionMs, 10010,
  'OFF forces the actual store to remove 40ms despite its ordinary 80ms deadband');

api.setDealerDeliveryExperimentEnabled(true);
assert.equal(accepted.length, 4);
assert.equal(store.getState().anchorPositionMs, 10050,
  'ON forces the same native anchor back to its frozen 40ms corrected value');
assert.equal(accepted.at(-1).positionObservedAt.monotonicMs, receivedAt);

// Ordinary same-track 40ms changes retain the established anchor deadband.
const ordinary = { ...accepted.at(-1), dealerDeliveryExperimentEnabled: false,
  dealerDeliveryExperimentReanchor: false, positionMs: accepted.at(-1).positionMs - 40 };
const beforeOrdinary = store.getState().anchorPositionMs;
store.getState().ingestPacket(api.detectorPacket(ordinary), 'mobile');
assert.equal(store.getState().anchorPositionMs, beforeOrdinary,
  'non-toggle 40ms updates still preserve the existing anchor');

wall = epoch + 1000; mono = 2000;
emit('dealer', state(epoch + 1000, epoch + 1000, 5000));
assert.equal(accepted.at(-1).positionMs, 5000, 'a newer Dealer player timestamp can report a real backward seek');
assert.equal(store.getState().anchorPositionMs, 5000, 'store keeps the real backward seek without monotonic clamping');

detector.clear();
console.log('Spotify Dealer delivery experiment checks passed: actual detector, packet and store toggle paths reanchor one frozen 40ms correction in both directions; ordinary updates retain the 80ms deadband.');
