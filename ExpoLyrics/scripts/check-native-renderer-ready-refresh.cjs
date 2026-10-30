/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');

const source = path.join(__dirname, '../components/lyrics/native/native-renderer-ready-refresh.ts');
const code = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const moduleObject = { exports: {} };
new Function('module', 'exports', code)(moduleObject, moduleObject.exports);
const { NativeRendererReadyRefreshGate, registerNativeRendererReadyResync, requestNativeRendererReadyResync } = moduleObject.exports;
let active = true, refreshes = 0, gate;
let unregister = registerNativeRendererReadyResync({ canResync: () => active, resyncPlayback: () => {
  refreshes++;
  if (gate) assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), false,
    'Synchronous re-entry is rejected because generation was locked before resyncPlayback');
} });

gate = new NativeRendererReadyRefreshGate();
let currentGeneration = gate.begin('amll:flash:canvas:track-a:packet-1');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), true, 'Initial live native ready requests one detector resync');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), false, 'Repeated onLayout/onContentSizeChange is once-only');
assert.equal(refreshes, 1);

const outgoingGeneration = currentGeneration;
currentGeneration = gate.begin('spicy:flash:canvas:track-a:packet-1');
assert.equal(gate.onReady(outgoingGeneration, true, requestNativeRendererReadyResync), false, 'Stale outgoing renderer callback is ignored after switch');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), true, 'A native renderer switch creates one fresh ready generation');
assert.equal(refreshes, 2);

currentGeneration = gate.begin('amll:flash:canvas:track-b:packet-2');
assert.equal(gate.onReady(currentGeneration, false, requestNativeRendererReadyResync), false, 'Desktop and demo renderers are excluded');
active = false;
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), false, 'Detector eligibility is rechecked at dispatch');
active = true;
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), true, 'An unsuccessful ineligible attempt can be retried on a later genuine ready event');
assert.equal(refreshes, 3);

// A ready layout may precede the sibling detector effect. Keep only a guarded,
// generation-scoped pending request and flush it when the detector registers.
unregister();
currentGeneration = gate.begin('amll:flat:clip:track-c:packet-3');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), true, 'Ready event is retained while detector registration is pending');
unregister = registerNativeRendererReadyResync({ canResync: () => true, resyncPlayback: () => { refreshes++; } });
assert.equal(refreshes, 4, 'Late detector registration services the current ready event exactly once');

unregister();
currentGeneration = gate.begin('amll:flat:clip:track-d:packet-4');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), true);
gate.setMounted(false);
unregister = registerNativeRendererReadyResync({ canResync: () => true, resyncPlayback: () => { refreshes++; } });
assert.equal(refreshes, 4, 'Pending ready callback after unmount is discarded');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), false, 'Unmount rejects late callbacks');

gate.setMounted(true);
currentGeneration = gate.foreground('amll:flat:clip:track-e:packet-5');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), true, 'Foreground reuses cached renderer readiness without layout/remount');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), false, 'Foreground generation refreshes only once');
assert.equal(refreshes, 5);
currentGeneration = gate.begin('amll:flash:canvas:track-f:packet-6');
let failedAttempts = 0;
assert.equal(gate.onReady(currentGeneration, true, () => { failedAttempts++; throw Error('detector unavailable'); }), false);
assert.equal(gate.onReady(currentGeneration, true, () => { failedAttempts++; return true; }), true, 'Failed request rolls the once-only lock back');
assert.equal(failedAttempts, 2);
unregister();

assert.equal(refreshes, 5, 'Refresh does not feed a playback sync loop');
console.log('Native renderer ready refresh checks passed: mount, repeated readiness, switches, stale callbacks, detector-registration race, desktop/demo exclusion, foreground cached readiness, unmount, re-entry, and no sync loop.');
