/* Exercise the real follow ownership command stream with delayed native events
 * and delayed commands. The native apply guard is read from the Swift source and
 * evaluated as code, so a source-only string match cannot pass this test. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRustLyricsFollow } = require('../lib/rust-lyrics-follow.js');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const swift = read('../modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift');
const android = read('../modules/kinesync-rust-lyrics/android/src/main/java/dev/kineticron/rustlyrics/KineSyncRustLyricsView.kt');
const view = read('../components/lyrics/rust/rust-lyrics-view.tsx');

const swiftStart = swift.indexOf('private func followCommandAllowed');
const swiftEnd = swift.indexOf('  // Native drag starts ownership', swiftStart);
assert.ok(swiftStart >= 0 && swiftEnd > swiftStart, 'Swift follow guard must exist');
const conditions = [...swift.slice(swiftStart, swiftEnd).matchAll(/guard (.+?) else \{ return false \}/g)]
  .flatMap(match => match[1].split(',').map(condition => condition.trim().replace(/self\./g, 'state.')));
assert.equal(conditions.length, 4, 'Swift guard keeps identity, epoch, active-touch and release-pending conditions');
const nativeAllowed = new Function('state', 'value', 'nextEpoch', 'identity',
  `return !!(${conditions.map(condition => `(${condition})`).join(' && ')});`);

function nativeState(overrides = {}) {
  return { generation: 1, ownershipEpoch: 0, ownershipFloor: 0, touchActive: false, releasePending: false, following: true, ...overrides };
}
function apply(state, command) {
  if (!nativeAllowed(state, command.value, command.epoch, command.generation)) return false;
  state.ownershipEpoch = command.epoch;
  if (command.value) state.ownershipFloor = Math.max(state.ownershipFloor, command.epoch);
  state.releasePending = false;
  state.following = command.value;
  return true;
}
function beginTouch(state) {
  state.releasePending = false;
  state.touchActive = true;
  state.ownershipFloor = Math.max(state.ownershipFloor, state.ownershipEpoch + 1);
}
function endTouch(state) { state.touchActive = false; }
function resetTrack(state, generation) {
  state.generation = generation;
  state.ownershipEpoch = 0;
  state.ownershipFloor = 0;
  state.touchActive = false;
  state.following = true;
}
function accepted(follow, state, eventEpoch, generation) {
  if (!follow.accept(eventEpoch, generation)) return false;
  state.following = true;
  return true;
}

// Release A emits near-follow, then touch B starts and drags before the queued
// A event reaches JS. The delayed event must not move parent state or emit true.
{
  const follow = createRustLyricsFollow();
  const native = nativeState();
  follow.sync('track-a', true);
  const initial = follow.reconcile(1);
  assert.equal(apply(native, initial), true, 'initial follow command applies');

  beginTouch(native);
  const aDown = follow.issue(false, 1);
  assert.equal(apply(native, aDown), true, 'touch A owns the viewport');
  endTouch(native);
  const releaseEpoch = follow.epoch;
  assert.equal(native.ownershipEpoch, releaseEpoch);

  // Native release A has already queued its follow event.
  const queuedA = { generation: 1, ownershipEpoch: releaseEpoch };

  // Touch B and its false command arrive before the queued A event.
  beginTouch(native);
  const bDown = follow.issue(false, 1);
  assert.equal(apply(native, bDown), true, 'touch B wins ownership');
  assert.equal(follow.desired, false);
  assert.equal(follow.reconcile(1), null, 'a late parent effect must not emit stale true');

  assert.equal(accepted(follow, native, queuedA.ownershipEpoch, queuedA.generation), false,
    'same-track delayed release from touch A is stale');
  assert.equal(follow.desired, false, 'stale event cannot flip local follow intent');
  assert.equal(follow.reconcile(1), null, 'stale event cannot delay a true command into touch B');

  // B releases far from the active line. A delayed true from A still cannot win.
  endTouch(native);
  const delayedTrueA = { value: true, epoch: queuedA.ownershipEpoch, generation: 1 };
  assert.equal(apply(native, delayedTrueA), false, 'touch B epoch floor rejects the delayed true');
  assert.equal(native.following, false);
  assert.equal(follow.reconcile(1), null, 'no local command resurrects follow after B');
}

// A true command already sent by a parent effect can be delayed until after a
// newer touch has taken ownership. Native rejects it while active and after a
// far release, without blocking a real explicit follow command.
{
  const follow = createRustLyricsFollow();
  const native = nativeState({ ownershipEpoch: 1, ownershipFloor: 1, following: false });
  follow.sync('track-a', true);
  assert.equal(follow.reconcile(1).epoch, 1);
  follow.sync('track-a', false);
  const staleTrue = follow.issue(true, 1);
  assert.equal(staleTrue.epoch, 2);

  beginTouch(native);
  const bDown = follow.issue(false, 1);
  assert.equal(apply(native, bDown), true);
  assert.equal(apply(native, staleTrue), false, 'active touch rejects a queued true');
  endTouch(native);
  assert.equal(apply(native, staleTrue), false, 'far release keeps the touch epoch floor');

  const explicit = follow.issue(true, 1);
  assert.equal(apply(native, explicit), true, 'a real explicit follow still applies');
  assert.equal(native.following, true);
}

// A release event accepted with no newer touch is the only path that updates
// parent follow without sending a duplicate true command.
{
  const follow = createRustLyricsFollow();
  follow.sync('track-a', true);
  follow.reconcile(1);
  const down = follow.issue(false, 1);
  assert.equal(accepted(follow, nativeState({ ownershipEpoch: down.epoch }), down.epoch, 1), true);
  assert.equal(follow.desired, true);
  assert.equal(follow.reconcile(1), null, 'accepted native recapture does not echo a true command');
}

// Track generation changes reject delayed events and commands from the old
// track, while the new track reset still emits its own follow true.
{
  const follow = createRustLyricsFollow();
  const native = nativeState();
  follow.sync('track-a', true);
  const a = follow.reconcile(1);
  apply(native, a);
  const oldEventEpoch = follow.issue(false, 1).epoch;
  assert.equal(accepted(follow, native, oldEventEpoch, 1), true);

  follow.sync('track-b', false);
  const reset = follow.reconcile(2);
  assert.equal(reset.value, true, 'new track reset wins over stale parent false');
  assert.equal(reset.generation, 2);
  assert.equal(apply(native, reset), false, 'new generation command waits for the native track');

  resetTrack(native, 2);
  assert.equal(apply(native, reset), true, 'new track command applies after setTrack');
  assert.equal(accepted(follow, native, oldEventEpoch, 1), false, 'old-track release event is stale');
  assert.equal(apply(native, { value: true, epoch: 9, generation: 1 }), false, 'old-track command cannot apply');

  const ready = follow.reassert(2);
  assert.equal(ready.value, true);
  assert.equal(apply(native, ready), true, 'ready reasserts the current track intent');
}

// The view must route the real event and effect through the ownership stream.
assert.match(view, /createRustLyricsFollow/);
assert.match(view, /follow\.current\.accept\(nativeEvent\.ownershipEpoch \?\? -1, revision\.generation\)/);
assert.match(view, /follow\.current\.reconcile\(revision\.generation\)/);
assert.match(view, /follow\.current\.reassert\(revision\.generation\)/);
assert.match(view, /setFollowing\(command\.value, command\.epoch, command\.generation, command\.gesture\)/);
assert.doesNotMatch(view, /setFollowing\(followTarget\)/, 'no render-captured follow command remains');
assert.match(swift, /ownershipEpoch.*generation|"ownershipEpoch": self\.ownershipEpoch/s);
assert.match(swift, /followCommandAllowed\(value, nextEpoch: nextEpoch, identity: UInt64\(commandGeneration\)\)/);
assert.match(android, /followCommandAllowed\(value, nextEpoch\)/);
assert.match(android, /"ownershipEpoch" to ownershipEpoch/);
assert.match(android, /ownershipEpoch = 0; ownershipFloor = 0; touchActive = false/);

console.log('Rust follow ownership PASS: delayed release events, delayed true commands, same-track touches and generation resets.');
