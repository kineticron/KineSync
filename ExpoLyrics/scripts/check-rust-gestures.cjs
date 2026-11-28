/* Execute the Rust renderer gesture contract with fake timers.
 * Mirrors native Skia row Pressables (540 ms long press, tap-to-seek) and the
 * list takeover that disables auto-follow until the next tap or resume. */
const assert = require('node:assert/strict');
require('./check-rust-reveal-touch.cjs');
require('./check-rust-scheduling.cjs');
require('./check-rust-footer-empty.cjs');
require('./check-rust-credits-switch.cjs');
require('../modules/kinesync-rust-lyrics/android/check-jni-contract.cjs');
require('./check-rust-follow-ownership.cjs');
require('./check-rust-follow-wiring.cjs');
require('./check-scroll-escape.cjs');
const { createRustLyricsGesture, LONG_PRESS_MS, DRAG_SLOP, nextFollowState, desiredFollow, clearFollowReset } = require('../lib/rust-lyrics-gesture.js');

function fixture(overrides = {}) {
  const calls = { follow: [], scroll: [], fling: [], press: [], long: [], auto: [], interaction: 0 };
  let timer = null;
  const gesture = createRustLyricsGesture({
    hitTest: () => 2,
    scrollBy: dy => calls.scroll.push(dy),
    fling: velocity => calls.fling.push(velocity),
    setFollowing: value => calls.follow.push(value),
    tapEnabled: () => true,
    onLinePress: index => calls.press.push(index),
    onLineLongPress: index => calls.long.push(index),
    onAutoFollowChange: value => calls.auto.push(value),
    onUserInteraction: () => { calls.interaction += 1; },
    setTimer: (fn, ms) => { timer = { fn, ms }; return 1; },
    clearTimer: () => { timer = null; },
    ...overrides,
  });
  return { gesture, calls, timer: () => timer };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

// Both native drag and release must use the same layout bounds and point-to-
// pixel conversion. The Rust motion tests exercise resistance, edge bounce and
// the near/far release decision.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const ffi = fs.readFileSync(path.join(__dirname, '../../native/lyrics-renderer/src/ffi.rs'), 'utf8');
  for (const [name, next, method, value] of [
    ['kr_scroll_by', 'kr_fling', 'drag', 'dy'],
  ]) {
    const body = ffi.slice(ffi.indexOf('fn ' + name + '('), ffi.indexOf('fn ' + next + '('));
    assert.match(body, /TrackScene::max_scroll/);
    assert.ok(body.includes('engine.scroll.' + method + '(' + value + ' * scale, max_offset, viewport)'));
  }
  const dragBody = ffi.slice(ffi.indexOf('fn kr_scroll_by('), ffi.indexOf('/// Release recapture needs'));
  const flingBody = ffi.slice(ffi.indexOf('fn kr_fling('), ffi.indexOf('fn kr_hit_test(')).replace(/\s+/g, ' ');
  assert.match(flingBody, /engine\s*\.\s*scroll\s*\.\s*release\(\s*velocity \* scale,\s*max_offset,\s*viewport,\s*target,\s*gesture_clock_ms\(\),?\s*\)/, 'release owns follow recapture using the internal monotonic grace clock');
  assert.match(flingBody, /engine\.following = resume/, 'release applies the recapture decision');
  assert.match(flingBody, /release_target\([\s\S]*engine\.timeline\.position\(native_ms\)/, 'release projects the authoritative anchored time');
  const targetHelper = ffi.slice(ffi.indexOf('fn release_target('), ffi.indexOf('/// Manual fling velocity'));
  assert.match(targetHelper, /if !anchored \|\| layout_generation != timeline_generation/);
  assert.match(targetHelper, /layout\.map\(\|layout\| layout\.scroll_target\(position_ms\)\)/);
  assert.doesNotMatch(targetHelper, /engine\.scroll\.position\(\)/, 'no layout fallback must not use the current offset as target');
  assert.match(flingBody, /fn kr_fling\(handle: u64, velocity: f64, native_ms: f64\)/, 'release carries its monotonic clock');
  assert.doesNotMatch(dragBody, /\.release\(|scroll_target/, 'active drags never recapture follow');
  assert.ok(dragBody.includes('engine.following = false'), 'active drags keep manual ownership');
  const swift = fs.readFileSync(path.join(__dirname, '../modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift'), 'utf8');
  assert.match(swift, /case \.ended:[\s\S]*?fling\(-Double\(pan\.velocity\(in: self\)\.y\) \/ 1000\.0\)/);
  assert.match(swift, /case \.cancelled, \.failed:\s*fling\(0\)/);
  assert.match(swift, /private var following = true/);
  assert.match(swift, /owner\?\.setFollowing\(following\)/, 'refresh replays the desired follow state');
  assert.match(swift, /let resumed = result == 1\s*DispatchQueue\.main\.async \{ completion\(resumed\) \}/);
  assert.match(swift, /self\.session == releaseSession/);
  assert.match(swift, /self\.generation == releaseGeneration/);
  assert.match(swift, /self\.followEpoch == releaseEpoch/);
  assert.match(swift, /self\.emitRecapturedFollow\(\)/);
  assert.match(swift, /identity\.track_id != trackId/);
  assert.match(swift, /followEpoch &\+= 1/);
  assert.match(swift, /override func touchesBegan[\s\S]*?releasePending = false[\s\S]*?followEpoch &\+= 1/);
  assert.match(swift, /private func lateGestureOwnershipAllowed/);
  const flingSource = swift.slice(swift.lastIndexOf('  func fling('), swift.lastIndexOf('  func hitTest('));
  const guardSource = flingSource.match(/guard let self,([\s\S]*?)else \{ return \}/)[1];
  const guardCondition = guardSource.split(',').map(part => part.trim()).filter(Boolean)
    .map(part => part.replace(/self\./g, 'state.')).join(' && ');
  const releaseStillValid = new Function('state', 'releaseSession', 'releaseGeneration', 'releaseEpoch', 'serial',
    `return !!(${guardCondition});`);
  const releaseState = { session: 1, generation: 7, followEpoch: 4, releaseSerial: 3, failed: false };
  assert.equal(releaseStillValid(releaseState, 1, 7, 4, 3), true);
  assert.equal(releaseStillValid({ ...releaseState, session: 2 }, 1, 7, 4, 3), false, 'old session');
  assert.equal(releaseStillValid({ ...releaseState, generation: 8 }, 1, 7, 4, 3), false, 'old track generation');
  assert.equal(releaseStillValid({ ...releaseState, followEpoch: 5 }, 1, 7, 4, 3), false, 'later touch or follow command');
  assert.equal(releaseStillValid({ ...releaseState, releaseSerial: 4 }, 1, 7, 4, 3), false, 'later release');
  assert.equal(releaseStillValid({ ...releaseState, failed: true }, 1, 7, 4, 3), false, 'failed surface');
  const android = fs.readFileSync(path.join(__dirname, '../modules/kinesync-rust-lyrics/android/src/main/java/dev/kineticron/rustlyrics/KineSyncRustLyricsView.kt'), 'utf8');
  assert.match(android, /session == releaseSession && generation == releaseGeneration &&\s*ownershipEpoch == releaseEpoch && releasePending && !failed/);
  assert.match(android, /releasePending = false\s*if \(resumed\) \{\s*following = true\s*onStatus/);
  assert.match(android, /if \(!releasePending\) o\.setFollowing\(following\)/, 'refresh must not replay manual ownership over an in-flight release');
  assert.match(android, /nextTrackId != trackId/);
  assert.match(android, /if \(gesture && !value\) gestureEpoch = ownershipEpoch/);
  assert.match(android, /if \(!ownsGesture\(epoch, commandGeneration\) \|\| !v\.isFinite\(\) \|\| !dragging\) return/);
  assert.match(android, /clearGesture\(\)\s*releasePending = true\s*o\.fling\(v, RustBridge\.nowMs\(\)\)/);
  const view = fs.readFileSync(path.join(__dirname, '../components/lyrics/rust/rust-lyrics-view.tsx'), 'utf8');
  assert.match(view, /onShouldBlockNativeResponder: \(\) => true/);
  assert.match(view, /if \(Platform\.OS === 'android' && nativeGestureReady\) return \(\) => gesture\.terminate\(\)/);
  assert.match(view, /nativeEvent\.state === 'follow'/, 'JS mirrors native follow recapture');
  assert.match(view, /follow\.current\.accept\(nativeEvent\.ownershipEpoch \?\? -1, revision\.generation\)/, 'stale release events are rejected by ownership epoch');
  assert.match(view, /follow\.current\.reassert\(revision\.generation\);\s*sendFollow\(command\);\s*sendAnchor\(\)/, 'ready reasserts the current follow intent before the anchor');
  assert.match(view, /follow\.current\.sync\(trackId, followEnabled\)/);
}


// Track reset ownership runs the same helper the view uses. A stale parent
// false from the previous song cannot suppress follow on the new track, and
// same-track translation, credit or layout revisions keep manual ownership.
{
  let state = { trackId: 'track-a', resetPending: false };
  assert.equal(desiredFollow(state, false), false, 'manual ownership stays manual within one track');
  state = nextFollowState(state, 'track-b', false);
  assert.equal(state.resetPending, true);
  assert.equal(desiredFollow(state, false), true, 'new track wins over stale parent false');
  state = nextFollowState(state, 'track-b', true);
  assert.equal(state.resetPending, false, 'parent acknowledgement clears the reset window');
  assert.equal(desiredFollow(state, true), true);
  state = clearFollowReset(state);
  assert.equal(desiredFollow(state, false), false, 'a real manual touch still owns the viewport');
  state = nextFollowState(state, 'track-b', false);
  assert.equal(desiredFollow(state, false), false, 'same-track revisions never reset follow');
  state = nextFollowState(state, 'track-c', false);
  assert.equal(state.resetPending, true);
  assert.equal(desiredFollow(state, false), true);
}

(async () => {
  assert.equal(LONG_PRESS_MS, 540);
  assert.equal(DRAG_SLOP, 4);

  for (const stamp of [999, 1001]) {
    const { createLyricsScrollEscape } = require('../lib/lyrics-scroll-escape');
    const { createRustLyricsFollow } = require('../lib/rust-lyrics-follow');
    const gate = createLyricsScrollEscape();
    const follow = createRustLyricsFollow();
    follow.sync('track', true);
    let now = 0, offset = 500;
    const { gesture } = fixture({
      now: () => now,
      hitTest: () => -1,
      setFollowing: value => {
        follow.issue(value, 1, true);
        if (value) gate.reset(offset);
      },
      scrollBy: dy => { offset += dy; gate.move(offset, 500, now); },
      fling: velocity => {
        if (gate.release(500, 64, now, velocity)) follow.accept(follow.epoch, 1);
      },
    });
    gate.begin(offset); gesture.grant(100);
    assert.equal(gate.graceUntil, 0, 'touch ownership never starts grace');
    gesture.move(-40); gesture.release();
    assert.equal(gate.graceUntil, 1000);
    now = stamp;
    gate.begin(offset); gesture.grant(100); gesture.move(-20);
    assert.equal(gate.graceUntil, 1000, 'later gesture ownership cannot restart grace');
    gesture.move(40); // Intentional reversal to the active line.
    // Termination releases with zero velocity, as the native cancellation path does.
    gesture.terminate();
    assert.equal(follow.desired, true, 'deliberate return wins even before grace expires');
    follow.issue(true, 1); gate.reset(offset);
    assert.equal(gate.graceUntil, 0, 'explicit resume cancels grace immediately');
    follow.sync('next-track', false);
    assert.equal(follow.desired, true);
    assert.equal(gate.graceUntil, 0, 'track changes never start grace');
  }

  // Touch-down takes ownership immediately, before the gesture is classified.
  {
    const { gesture, calls, timer } = fixture();
    gesture.grant(120);
    assert.deepEqual(calls.follow, [false]);
    assert.deepEqual(calls.auto, [false]);
    assert.equal(calls.interaction, 1);
    assert.equal(timer().ms, LONG_PRESS_MS);
    await flush();
    timer().fn();
    assert.deepEqual(calls.long, [2], '540 ms hold long-presses the hit row');
    assert.deepEqual(calls.press, [], 'long press never seeks');
    gesture.release();
    assert.deepEqual(calls.press, [], 'releasing a long press must not seek');
    assert.deepEqual(calls.scroll, []);
  }

  // Tap: restore follow, then seek the hit row.
  {
    const { gesture, calls } = fixture();
    gesture.grant(80);
    await flush();
    gesture.release();
    assert.deepEqual(calls.follow, [false, true]);
    assert.deepEqual(calls.auto, [false, true]);
    assert.deepEqual(calls.press, [2]);
    assert.equal(calls.interaction, 2);
  }

  // Sub-slop motion stays a tap; real drags scroll by the full travel and stop
  // the press path.
  {
    const { gesture, calls, timer } = fixture();
    gesture.grant(0);
    gesture.move(DRAG_SLOP - 1);
    assert.deepEqual(calls.scroll, []);
    assert.ok(timer(), 'sub-slop motion must not cancel the long press timer');
    gesture.move(-30);
    assert.deepEqual(calls.scroll, [30], 'an upward drag increases the content offset');
    assert.equal(timer(), null, 'drag cancels long press');
    gesture.move(-80);
    assert.deepEqual(calls.scroll, [30, 50], 'deltas are relative to the previous move');
    gesture.release();
    assert.deepEqual(calls.press, [], 'drag release never seeks');
    assert.deepEqual(calls.follow, [false], 'drag keeps auto-follow disabled');
    assert.equal(calls.fling.length, 1, 'drag release starts inertial scrolling');
    assert.ok(calls.fling[0] > 0, 'an upward flick flings the content upward');
  }

  // Tap-to-seek disabled: ownership still transfers and follow is restored, but
  // no seek callback fires.
  {
    const { gesture, calls } = fixture({ tapEnabled: () => false });
    gesture.grant(0);
    await flush();
    gesture.release();
    assert.deepEqual(calls.follow, [false, true]);
    assert.deepEqual(calls.press, []);
  }

  // A release can beat the native hit test; the pending press still seeks.
  {
    let resolveHit = () => {};
    const hit = new Promise(resolve => { resolveHit = resolve; });
    const { gesture, calls } = fixture({ hitTest: () => hit });
    gesture.grant(0);
    gesture.release();
    assert.deepEqual(calls.press, [], 'no seek before the row is known');
    resolveHit(2);
    await flush();
    assert.deepEqual(calls.follow, [false, true]);
    assert.deepEqual(calls.press, [2]);
  }

  // Cancellation (scroll view takeover/unmount) never resolves as a tap.
  {
    const { gesture, calls, timer } = fixture();
    gesture.grant(0);
    await flush();
    assert.ok(timer());
    gesture.terminate();
    assert.equal(timer(), null);
    gesture.release();
    assert.deepEqual(calls.press, []);
    assert.deepEqual(calls.follow, [false]);
  }

  // A slow released tap must not steal ownership back from a newer drag.
  {
    let resolveHit;
    const hit = new Promise(resolve => { resolveHit = resolve; });
    const { gesture, calls } = fixture({ hitTest: () => hit });
    gesture.grant(0);
    gesture.release();
    gesture.grant(0);
    gesture.move(-40);
    resolveHit(2);
    await flush();
    assert.deepEqual(calls.press, []);
    assert.deepEqual(calls.follow, [false, false]);
    gesture.terminate();
  }

  // Unmount also cancels deferred taps and long presses after release.
  for (const longPress of [false, true]) {
    let resolveHit;
    const hit = new Promise(resolve => { resolveHit = resolve; });
    const { gesture, calls, timer } = fixture({ hitTest: () => hit });
    gesture.grant(0);
    if (longPress) timer().fn();
    gesture.release();
    gesture.terminate();
    resolveHit(2);
    await flush();
    assert.deepEqual(calls.press, []);
    assert.deepEqual(calls.long, []);
    assert.deepEqual(calls.follow, [false]);
  }

  // Missing/out-of-range hit rows cannot seek.
  {
    const { gesture, calls } = fixture({ hitTest: () => -1 });
    gesture.grant(0);
    await flush();
    gesture.release();
    assert.deepEqual(calls.press, []);
  }
  console.log('Rust gesture ownership, 540 ms long press, tap-to-seek, 1:1 drag deltas, fling and cancellation passed.');
})().catch(error => { console.error(error); process.exit(1); });
