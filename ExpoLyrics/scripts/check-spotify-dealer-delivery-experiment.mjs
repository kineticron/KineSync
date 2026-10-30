import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// Actual detector emit -> detectorPacket -> playback-store path. Only platform
// storage/AppState are stubbed; no browser/WebView path is bundled.
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
export { SpotifyDetector } from './lib/spotify-detector/client';
export { DealerDeliveryBaseline } from './lib/spotify-detector/dealer-delivery-baseline';
export { setDealerDeliveryExperimentEnabled } from './lib/spotify-detector/dealer-delivery-experiment-toggle';
export { logDealerDeliveryDecision } from './lib/spotify-detector/dealer-delivery-experiment-log';
export { projectedPosition, sampleFrom } from './lib/spotify-detector/protocol';
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
const consoleLines = [];
const module = { exports: {} };
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports,
  require: createRequire(import.meta.url), __DEV__: true,
  process: { env: { NODE_ENV: 'development' } }, console: { log(...args) { consoleLines.push(args.join(' ')); }, warn() {}, error() {} },
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

// Native model A/B audit: pair the existing baseline methods with the
// experimental projection gate at the same receipt. These cases are synthetic
// and report model deltas only, never audio or Bluetooth presentation latency.
const auditRows = [];
function auditScenario(name, events, { seed = true, dealerIdentity = identity, clearBefore = false,
  seedObservation = observation(0, epoch, epoch - 100, dealerIdentity) } = {}) {
  const baseline = new api.DealerDeliveryBaseline();
  if (seed) baseline.observeDealer(seedObservation);
  if (clearBefore) baseline.clear();
  let worst = { deltaMs: 0, reason: 'zero-excess-or-fallback' };
  for (const event of events) {
    const currentIdentity = event.identity ?? dealerIdentity;
    const receipt = event.receipt ?? stamp(event.ms, event.wallOffsetMs ?? 0);
    const item = { serverMs: event.serverOffsetMs == null ? undefined : epoch + event.serverOffsetMs,
      playerTimestampMs: event.playerOffsetMs == null ? undefined : epoch + event.playerOffsetMs,
      receipt, nowMono: 1000 + event.ms + (event.receiptAgeMs ?? 0), identity: currentIdentity };
    const decision = baseline.registrationDecision(item, event.playing);
    const excess = decision.excessMs;
    const sample = { positionMs: event.positionMs, durationMs: 300000, playing: event.playing,
      receivedAt: receipt.wallMs, positionTimestampMs: item.playerTimestampMs,
      sourceServerTimestampMs: item.serverMs, positionObservedAt: receipt,
      dealerDeliveryExcessMs: excess };
    const off = api.projectedPosition({ ...sample, dealerDeliveryExperimentEnabled: false }, receipt.wallMs, receipt.monotonicMs);
    const on = api.projectedPosition({ ...sample, dealerDeliveryExperimentEnabled: true }, receipt.wallMs, receipt.monotonicMs);
    const deltaMs = on - off;
    assert(Math.abs(deltaMs - (event.expectedDeltaMs ?? 0)) < 0.001,
      `${name}: expected ${event.expectedDeltaMs ?? 0}ms ON/OFF model delta, got ${deltaMs}ms (${decision.reason})`);
    if (Math.abs(deltaMs) > Math.abs(worst.deltaMs)) worst = { deltaMs, reason: decision.reason };
    auditRows.push({ case: name, sample: event.label ?? 'one-sample', evidence: 'synthetic-native-model',
      playing: event.playing, reason: decision.reason, onMinusOffMs: deltaMs,
      excessMs: excess ?? null, receiptAgeMs: decision.receiptAgeMs ?? null,
      baselineFreshnessAgeMs: decision.baselineFreshnessAgeMs ?? null });
  }
  return worst;
}

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

// Diagnostic and non-diagnostic evaluations must make identical decisions
// and leave equivalent envelopes across accepted, duplicate and fallback data.
{
  const normal = new api.DealerDeliveryBaseline();
  const instrumented = new api.DealerDeliveryBaseline();
  const dealerInputs = [observation(0, epoch), observation(100, epoch + 100),
    observation(110, epoch + 100, epoch + 100), observation(200, epoch + 2000, epoch + 150),
    observation(300, epoch + 300)];
  for (const input of dealerInputs) {
    const diagnosticBaseline = instrumented.fork();
    const actualAccepted = instrumented.observeDealer(input);
    const diagnostic = diagnosticBaseline.observeDealerDecision(input);
    assert.equal(normal.observeDealer(input), actualAccepted);
    assert.equal(actualAccepted, diagnostic.accepted);
  }
  const registrations = [
    [observation(400, epoch + 370, epoch + 350), true],
    [observation(500, epoch + 470, epoch + 450), false],
    [observation(3400, epoch + 3370, epoch + 3350), true],
    [observation(3500, epoch + 3499, epoch + 3500), true],
  ];
  for (const [input, playing] of registrations) {
    const diagnosticBaseline = instrumented.fork();
    const actualExcess = instrumented.registrationExcess(input, playing);
    const diagnostic = diagnosticBaseline.registrationDecision(input, playing);
    assert.equal(normal.registrationExcess(input, playing), actualExcess);
    assert.equal(actualExcess, diagnostic.excessMs);
  }
  const nextDealer = observation(800, epoch + 800);
  const diagnosticBaseline = instrumented.fork();
  const actualNext = instrumented.observeDealer(nextDealer);
  assert.equal(normal.observeDealer(nextDealer), actualNext,
    'the following Dealer decision matches, proving prior diagnostic evaluation did not alter either envelope');
  assert.equal(actualNext, diagnosticBaseline.observeDealerDecision(nextDealer).accepted,
    'the diagnostic fork predicts but does not execute the live state transition');
}

const event = (ms, positionMs, playing = true, expectedDeltaMs = 80, label) => ({ ms, positionMs, playing,
  serverOffsetMs: ms - 80, playerOffsetMs: ms - 100, expectedDeltaMs, label });
auditScenario('ordinary-forward-progress', [event(300, 12000)]);
auditScenario('forward-seek', [event(300, 90000)]);
auditScenario('backward-seek', [event(300, 3500)]);
auditScenario('repeat-loop-restart', [event(300, 0)], { });
auditScenario('pause-freeze', [event(300, 20000, false, 0)]);
auditScenario('pause-then-resume', [event(300, 20000, false, 0, 'paused'), event(400, 20100, true, 80, 'resumed')]);
auditScenario('scrubbing', [event(300, 5000, true, 80, 'scrub-1'), event(500, 12500, true, 80, 'scrub-2'), event(700, 4600, true, 80, 'scrub-3')]);
auditScenario('auto-next', [event(300, 0, true, 80, 'new-track-player-transition')]);
auditScenario('manual-skip', [event(300, 0, true, 80, 'new-track-player-transition')]);
auditScenario('gapless-crossfade', [event(300, 199900), event(400, 0, true, 80, 'next-track-overlap')]);
auditScenario('buffering-stall', [event(300, 12000, false, 0)]);
auditScenario('network-reconnect-fallback', [event(300, 12000, true, 0)], { clearBefore: true });
// Identity changes are modeled through the actual delivery identity check.
for (const [name, changedIdentity] of [['device-handoff-stale-registration', { ...identity, device: 'synthetic-device-b' }],
  ['session-handoff-stale-registration', { ...identity, session: 'synthetic-session-b' }],
  ['route-change-stale-registration', { ...identity, routeEpoch: 2 }],
  ['auth-change-stale-registration', { ...identity, authEpoch: 2 }]]) {
  auditScenario(name, [{ ...event(300, 5000, true, 0), identity: changedIdentity }]);
}
auditScenario('cold-launch-no-baseline', [event(300, 10000, true, 0)], { seed: false });
auditScenario('stale-registration-receipt', [{ ...event(300, 10000, true, 0), receiptAgeMs: 1001 }]);
auditScenario('stale-dealer-envelope', [event(3100, 40000, true, 0)]);
auditScenario('missing-timestamp-fallback', [{ ...event(300, 10000, true, 0), playerOffsetMs: undefined }]);
auditScenario('future-source-pair-fallback', [{ ...event(300, 10000, true, 0),
  serverOffsetMs: 180, playerOffsetMs: 200 }]);

// A forward wall-clock jump resets the comparison baseline; the fresh pair
// afterward only contributes its 20ms envelope excess, with no phone-time
// correction inferred from the step itself.
{
  const model = new api.DealerDeliveryBaseline();
  const counterpart = new api.DealerDeliveryBaseline();
  const seed = observation(0, epoch, epoch - 100);
  model.observeDealer(seed); counterpart.observeDealerDecision(seed);
  const stepped = { ...observation(100, epoch + 100, epoch + 50), receipt: stamp(100, 300) };
  const expected = counterpart.observeDealerDecision(stepped);
  assert.equal(model.observeDealer(stepped), expected.accepted);
  assert.equal(expected.reason, 'dealer-clock-discontinuity-reseed');
  assert.equal(expected.clockDriftMs, 300);
  assert.equal(expected.clockDriftLimitMs, 10);
  const row = event(200, 0, true, 20, 'after-phone-clock-step');
  row.serverOffsetMs = 180; row.playerOffsetMs = 160;
  row.receipt = stamp(200, 300);
auditScenario('phone-clock-step-reseed', [row], { seedObservation: stepped });
}

// Foreground replay and renderer switching reuse a frozen raw anchor. The real
// client/store toggle path above verifies ON/OFF reanchor behavior without an
// extra refresh; this synthetic view comparison records the same model delta.
auditScenario('foreground-replay-same-anchor', [event(300, 10000)]);
auditScenario('renderer-switch-same-anchor', [event(300, 10000)]);
assert.equal(auditRows.length, 28, 'all named native-only A/B regression cases ran');
const auditWorst = Math.max(...auditRows.map(row => Math.abs(row.onMinusOffMs)));
assert(auditWorst <= 500, 'no synthetic case exceeds the configured correction cap');

// Replay the two sanitized captures with raw registration/Dealer JSON and
// recorded callback/refresh ordering. Their temporary identifiers are used
// only for equality and never emitted in results.
const bootstrapCaptures = JSON.parse(readFileSync(new URL('./fixtures/spotify-bootstrap-captured.json', import.meta.url), 'utf8'));
const bootstrapAudit = [];
const auditWall = wall, auditMono = mono;
for (const capture of bootstrapCaptures.cases) {
  const model = new api.DealerDeliveryBaseline();
  const events = capture.frames.map(frame => {
    const callback = capture.stages.find(stage => stage.kind === 'sample-callback' &&
      stage.wallMs >= frame.receiptMs && stage.wallMs <= frame.receiptMs + 20);
    assert(callback, `${capture.name}: captured raw frame has a callback receipt`);
    return { at: callback.monoMs, frame, callback };
  });
  for (const stage of capture.stages) if (stage.kind === 'explicit-observer-refresh') events.push({ at: stage.monoMs, refresh: true });
  events.sort((a, b) => a.at - b.at);
  let lastIdentity;
  const registrations = [];
  for (const event of events) {
    mono = event.at;
    wall = epoch + event.at - 1000;
    if (event.refresh) {
      model.preserveForExplicitRefresh(mono, lastIdentity ?? identity);
      continue;
    }
    const { frame, callback } = event;
    const payload = frame.kind === 'registration' ? frame.body : frame.frame.payloads[0].cluster;
    const parsed = api.sampleFrom(payload);
    assert(parsed?.sourceServerTimestampMs && parsed.positionTimestampMs, `${capture.name}: raw captured timestamp pair parses`);
    const receipt = { wallMs: epoch + callback.wallMs, monotonicMs: callback.monoMs };
    parsed.positionObservedAt = receipt;
    const currentIdentity = { device: parsed.activeDeviceId ?? '', session: parsed.playbackSessionId ?? '', routeEpoch: 0, authEpoch: 0 };
    if (lastIdentity && (lastIdentity.device !== currentIdentity.device || lastIdentity.session !== currentIdentity.session)) model.clear();
    lastIdentity = currentIdentity;
    const observation = { serverMs: parsed.sourceServerTimestampMs, playerTimestampMs: parsed.positionTimestampMs,
      receipt, nowMono: callback.monoMs, identity: currentIdentity };
    if (frame.kind === 'dealer') model.observeDealer(observation);
    else {
      const decision = model.registrationDecision(observation, parsed.playing);
      const correction = decision.excessMs;
      const base = { positionMs: parsed.positionMs, durationMs: parsed.durationMs, playing: parsed.playing,
        receivedAt: receipt.wallMs, positionTimestampMs: parsed.positionTimestampMs,
        sourceServerTimestampMs: parsed.sourceServerTimestampMs, positionObservedAt: receipt };
      const off = api.projectedPosition({ ...base, dealerDeliveryExperimentEnabled: false }, receipt.wallMs, receipt.monotonicMs);
      const on = api.projectedPosition({ ...base, dealerDeliveryExperimentEnabled: true,
        dealerDeliveryExcessMs: correction }, receipt.wallMs, receipt.monotonicMs);
      registrations.push({ phase: callback.phase, correctionMs: correction ?? null, onMinusOffMs: on - off,
        reason: decision.reason });
      assert.equal(decision.reason, 'registration-baseline-unavailable', `${capture.name}: registration falls back without fresh Dealer baseline`);
      assert.equal(on - off, correction ?? 0, `${capture.name}: captured registration ON/OFF delta equals frozen model excess`);
    }
  }
  bootstrapAudit.push({ capture: capture.name, evidence: 'sanitized-captured-raw-json-with-captured-receipt-and-refresh-order', registrations });
}
wall = auditWall; mono = auditMono;

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
const markerLines = () => consoleLines.filter(line => line.startsWith('[Spotify delivery experiment] '));
assert.equal(markerLines().length, 2, 'enabled experiment logs Dealer baseline and registration decision');
const registrationLog = JSON.parse(markerLines().at(-1).slice('[Spotify delivery experiment] '.length));
assert.equal(registrationLog.outcome, 'correction-applied');
assert.equal(registrationLog.reason, 'registration-excess-within-cap');
assert.equal(registrationLog.units, 'ms');
assert.equal(registrationLog.rawExcessMs, 40);
assert.equal(registrationLog.frozenExcessMs, 40);
assert.equal(registrationLog.baselineOffsetMs, 0);
assert.equal(registrationLog.cutoffsMs.MAX_CORRECTION_MS, 500);
assert(!JSON.stringify(registrationLog).includes('synthetic-device'));
assert(!JSON.stringify(registrationLog).includes('synthetic-session'));
assert(!JSON.stringify(registrationLog).includes('spotify:track:'));
assert(!JSON.stringify(registrationLog).includes('Synthetic artist'));
assert.equal(api.detectorPacket(registration).positionMs, 10050, 'enabled packet contains the 40ms correction');
assert.equal(store.getState().anchorPositionMs, 10000,
  'ordinary registration remains inside the pre-existing 80ms store deadband');
const receivedAt = registration.positionObservedAt.monotonicMs;
const frozenCorrection = registration.dealerDeliveryExcessMs;

// Each toggle republishes the same raw anchor and never makes a network call.
api.setDealerDeliveryExperimentEnabled(false);
const logsBeforeOff = markerLines().length;
const beforeOffDuplicate = store.getState().anchorPositionMs;
emit('registration', state(epoch + 60, epoch + 50));
assert.equal(accepted.length, 3);
assert.equal(accepted.at(-1).dealerDeliveryExcessMs, frozenCorrection);
assert.equal(accepted.at(-1).dealerDeliveryExperimentEnabled, false);
assert.equal(accepted.at(-1).positionObservedAt.monotonicMs, receivedAt);
assert.equal(store.getState().anchorPositionMs, 10010,
  'OFF forces the actual store to remove 40ms despite its ordinary 80ms deadband');
assert.equal(store.getState().anchorPositionMs, beforeOffDuplicate, 'an OFF-mode duplicate does not change the anchor');
assert.equal(markerLines().length, logsBeforeOff, 'the actual detector emits no delivery log while the toggle is OFF');
api.logDealerDeliveryDecision('registration-correction', { accepted: true, reason: 'registration-excess-within-cap',
  excessMs: 40, sampleCount: 1, token: 'must-not-log' });
assert.equal(markerLines().length, logsBeforeOff, 'OFF is silent for delivery experiment diagnostics');

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
api.setDealerDeliveryExperimentEnabled(false);
wall = epoch + 1200; mono = 2200;
emit('registration', state(epoch + 1160, epoch + 1150, 4000));
assert.equal(accepted.at(-1).dealerDeliveryExcessMs, 40);
assert.equal(api.detectorPacket(accepted.at(-1)).positionMs, 4010, 'OFF playback projection retains source age but excludes the frozen correction after a backward seek');
assert.equal(store.getState().anchorPositionMs, 4010, 'OFF accepts the real backward seek without the experimental excess');
api.setDealerDeliveryExperimentEnabled(true);
assert.equal(store.getState().anchorPositionMs, 4050, 'ON reapplies only the same registration correction after the seek');
wall = epoch + 1300; mono = 2300;
emit('registration', state(epoch + 1299, epoch + 1300, 4000));
assert.equal(accepted.at(-1).dealerDeliveryExcessMs, undefined, 'invalid timestamp pairs retain the uncorrected fallback');
const fallbackLog = JSON.parse(markerLines().at(-1).slice('[Spotify delivery experiment] '.length));
assert.equal(fallbackLog.outcome, 'fallback');
assert.equal(fallbackLog.reason, 'registration-server-before-player-timestamp');
assert.equal(fallbackLog.serverTimestampMs, epoch + 1299);
assert.equal(fallbackLog.playerTimestampMs, epoch + 1300);
const beforeStale = accepted.length;
emit('registration', state(epoch + 1199, epoch + 1200, 4000));
assert.equal(accepted.length, beforeStale, 'source-ordering stale anchor never enters playback');
const staleLog = JSON.parse(markerLines().at(-1).slice('[Spotify delivery experiment] '.length));
assert.equal(staleLog.outcome, 'fallback');
assert.equal(staleLog.reason, 'source-timestamp-older-than-watermark');

// Logging is rate-limited, whitelist-only, and observational: repeated log
// publication cannot alter the model's next registration decision.
const observerOnly = new api.DealerDeliveryBaseline();
observerOnly.observeDealer(observation(0, epoch));
const sameRegistration = observation(100, epoch + 60, epoch + 50);
const beforeLog = observerOnly.registrationDecision(sameRegistration, true);
mono += 11_000;
const beforeLimitedLogCount = markerLines().length;
for (let i = 0; i < 20; i++) api.logDealerDeliveryDecision('registration-correction', {
  ...beforeLog, privateValue: 'never serialized', reason: i === 0 ? beforeLog.reason : 'token-secret-device-id',
});
const limited = markerLines().slice(beforeLimitedLogCount);
assert.equal(limited.length, 12, 'console output is capped at 12 events per 10 seconds');
assert(limited.every(line => !line.includes('token-secret-device-id') && !line.includes('never serialized')),
  'the logger only emits fixed reason codes and whitelisted numeric fields');
assert.equal(observerOnly.registrationDecision(sameRegistration, true).excessMs, beforeLog.excessMs,
  'logging does not alter the model or registration correction');

const malformedDecision = observerOnly.registrationDecision(observation(200, epoch + 199, epoch + 200), true);
assert.equal(malformedDecision.reason, 'registration-server-before-player-timestamp');
assert.equal(malformedDecision.excessMs, undefined, 'invalid timestamp fallback remains uncorrected');

detector.clear();
console.log(JSON.stringify({ nativeSyntheticDeliveryAudit: { cases: auditRows.length, worstAbsModelDeltaMs: auditWorst,
  worstReason: auditRows.find(row => Math.abs(row.onMinusOffMs) === auditWorst)?.reason, rows: auditRows },
  capturedBootstrapAudit: bootstrapAudit }));
console.log('Spotify Dealer delivery experiment checks passed: actual detector, packet and store toggle paths reanchor one frozen 40ms correction in both directions; passive diagnostics are toggle-gated, rate-limited and model-neutral; ordinary updates retain the 80ms deadband.');
