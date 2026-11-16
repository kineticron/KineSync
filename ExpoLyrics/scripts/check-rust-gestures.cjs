/* Execute the Rust renderer gesture contract with fake timers.
 * Mirrors native Skia row Pressables (540 ms long press, tap-to-seek) and the
 * list takeover that disables auto-follow until the next tap or resume. */
const assert = require('node:assert/strict');
require('./check-rust-scheduling.cjs');
require('../modules/kinesync-rust-lyrics/android/check-jni-contract.cjs');
const { createRustLyricsGesture, LONG_PRESS_MS, DRAG_SLOP } = require('../lib/rust-lyrics-gesture.js');

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
// pixel conversion. The Rust motion tests exercise resistance and edge bounce.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const ffi = fs.readFileSync(path.join(__dirname, '../../native/lyrics-renderer/src/ffi.rs'), 'utf8');
  for (const [name, next, method, value] of [
    ['kr_scroll_by', 'kr_fling', 'drag', 'dy'],
    ['kr_fling', 'kr_hit_test', 'fling', 'velocity'],
  ]) {
    const body = ffi.slice(ffi.indexOf('fn ' + name + '('), ffi.indexOf('fn ' + next + '('));
    assert.match(body, /TrackScene::max_scroll/);
    assert.ok(body.includes('engine.scroll.' + method + '(' + value + ' * scale, max_offset, viewport)'));
  }
  const view = fs.readFileSync(path.join(__dirname, '../components/lyrics/rust/rust-lyrics-view.tsx'), 'utf8');
  assert.match(view, /onShouldBlockNativeResponder: \(\) => Platform\.OS !== 'android'/);
  const swift = fs.readFileSync(path.join(__dirname, '../modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift'), 'utf8');
  assert.match(swift, /case \.ended:[\s\S]*?fling\(-Double\(pan\.velocity\(in: self\)\.y\) \/ 1000\.0\)/);
  assert.match(swift, /case \.cancelled, \.failed:\s*fling\(0\)/);
}


(async () => {
  assert.equal(LONG_PRESS_MS, 540);
  assert.equal(DRAG_SLOP, 4);

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
