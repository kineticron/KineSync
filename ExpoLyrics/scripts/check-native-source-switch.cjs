/* global __dirname */
// Runs real native selectors/HOC/view/row/voice/glyph consumption and installed
// Reanimated handoff via the integration harness. Native transport/fonts remain
// modeled. Rotation recreates the wrapper, as the player layout branches do.
const assert = require('node:assert/strict');
const { scenario, near } = require('./check-native-switch-clock.cjs');

const epoch = 1700000000000;
const uri = 'spotify:track:0123456789abcdefghijkl';
const source = {
  title: 'Clock', artist: 'Fixture', album: '', artworkUrl: '', uri,
  positionMs: 10000, durationMs: 180000, playing: true, device: '',
  positionTimestampMs: epoch, activeDeviceId: 'fixture-device', playbackSessionId: 'fixture-session',
  sourceClockScope: 'fixture:1:1',
};
const initialPacket = { trackId: 'spotify-connect:0123456789abcdefghijkl',
  spotifyTrackId: '0123456789abcdefghijkl', positionMs: 20000, sourcePositionMs: source.positionMs,
  positionTimestampMs: epoch, sourceServerTimestampMs: epoch + 10000, uri, trackUri: uri,
  activeDeviceId: source.activeDeviceId, playbackSessionId: source.playbackSessionId, sourceClockScope: source.sourceClockScope };
const transitions = [
  { name: 'spicy->amll', from: 'spicy', to: 'amll', before: false, after: false },
  { name: 'amll->spicy', from: 'amll', to: 'spicy', before: false, after: false },
  ...['spicy', 'amll'].flatMap(style => [
    { name: `${style}:portrait->landscape`, from: style, to: style, before: false, after: true },
    { name: `${style}:landscape->portrait`, from: style, to: style, before: true, after: false },
  ]),
];
const results = [];
for (const transition of transitions) for (const stallMs of [500, 1000, 2000, 3000])
for (const experiment of [false, true]) for (const phase of ['before-receipt', 'after-receipt']) {
  const run = scenario({ initialPacket });
  const expected = () => 20000 + run.now - 10000;
  run.mount(transition.from, { landscapeMode: transition.before, width: transition.before ? 720 : 360 });
  run.flush(); run.frame(); run.ready();
  const staleReady = run.getReadyCallback();
  run.unmount(); run.flush();
  assert.equal(run.subscriptions, 0, 'Outgoing renderer releases clock subscription');
  run.mount(transition.to, { landscapeMode: transition.after, width: transition.after ? 720 : 360 });
  staleReady();
  assert.equal(run.refreshes, 1, 'Late outgoing layout cannot refresh the incoming renderer');
  // Delayed animation start is distinct from a long frame after start.
  run.advance(stallMs); run.flush(); run.frame();
  near(run.observed()[0].consumed, expected(), 'Blocked incoming mount consumes current native clock');
  run.onRefresh(() => {
    run.advance(1273.152);
    if (phase === 'before-receipt') run.advance(stallMs);
    const receipt = { wallMs: epoch + run.now, monotonicMs: run.now };
    const sample = { ...source, dealerDeliveryExperimentEnabled: experiment,
      // Model a newly received cluster envelope with the SAME raw source
      // anchor, normalized at least 1143.016ms behind the running store clock.
      // This is an imposed trace delta, not a server/network clock estimate.
      sourceServerTimestampMs: Math.floor(epoch + run.now - 1143.0161669254303),
      receivedAt: receipt.wallMs, positionObservedAt: receipt };
    if (phase === 'after-receipt') run.advance(stallMs);
    run.ingest(run.packet(sample));
  });
  run.ready(); run.flush(); run.frame();
  const first = run.observed()[0];
  near(first.position, first.consumed, 'Incoming glyph consumes its view shared clock');
  const afterRefreshDriftMs = first.consumed - expected();
  const anchor = run.store.getState().anchorMonotonicMs;
  run.ready();
  assert.equal(run.refreshes, 2, 'One refresh per real mounted generation; repeated readiness deduplicated');
  assert.equal(run.subscriptions, 1, 'Incoming renderer owns one clock subscription');
  // A mid-animation stall must catch up too; frame count/fps cannot own time.
  run.frame(stallMs);
  const afterLongFrameDriftMs = run.observed()[0].consumed - expected();
  for (let i = 0; i < 120; i++) run.frame(1000 / 30);
  const after30fpsDriftMs = run.observed()[0].consumed - expected();
  assert.equal(run.store.getState().anchorMonotonicMs, anchor, 'Rendering does not rewrite the store anchor');
  results.push({ transition: transition.name, stallMs, phase, experiment, registrationMs: 1273.152,
    afterRefreshDriftMs, afterLongFrameDriftMs, after30fpsDriftMs });
  run.stop();
  assert.equal(run.subscriptions, 0, 'Final wrapper cleanup');
}
console.log(JSON.stringify({ consumption: 'actual-native-wrapper/view/row/voice/glyph-picture', scenarios: results }));
const failures = results.filter(result => [result.afterRefreshDriftMs, result.afterLongFrameDriftMs,
  result.after30fpsDriftMs].some(drift => Math.abs(drift) > 0.00001));
assert.equal(failures.length, 0, `${failures.length}/${results.length} native switch/rotation scenarios drifted`);
console.log(`PASS ${results.length} native switch/rotation scenarios; modeled JSI/Skia, no device claim.`);
