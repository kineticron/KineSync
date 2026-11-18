const assert = require('node:assert/strict');
const { createRustLyricsGesture, LONG_PRESS_MS, DRAG_SLOP } = require('../lib/rust-lyrics-gesture');
function fixture({ reveal = true, following = true } = {}) {
  let now = 0, hidden = true;
  const calls = { hit: 0, reveal: 0, press: 0, long: 0, footer: 0, follow: [], scroll: [], fling: [], timers: [] };
  const gesture = createRustLyricsGesture({
    shouldRevealTap: pageY => reveal && hidden && pageY >= 600,
    hitTest: () => { calls.hit++; return 0; },
    tapEnabled: () => true,
    setFollowing: value => { following = value; calls.follow.push(value); },
    onAutoFollowChange() {},
    onUserInteraction: () => { hidden = false; calls.reveal++; },
    onLinePress: () => calls.press++, onLineLongPress: () => calls.long++,
    onFooterPress: () => calls.footer++,
    scrollBy: value => calls.scroll.push(value), fling: value => calls.fling.push(value),
    now: () => now, setTimer: fn => { calls.timers.push(fn); return fn; }, clearTimer() {},
  });
  return { gesture, calls, tick: ms => { now += ms; }, show: () => { hidden = false; }, following: () => following };
}
// Invoke the production PanResponder callbacks too: the native target receives
// pageY for policy, local coordinates for hits, and both movement axes.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const view = ts.createSourceFile('rust.tsx', fs.readFileSync(path.resolve(__dirname, '../components/lyrics/rust/rust-lyrics-view.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let responder;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(view) === 'panResponder') responder = node.initializer.arguments[0].body.arguments[0];
  ts.forEachChild(node, visit);
}
visit(view);
const bind = gesture => vm.runInNewContext(ts.transpileModule(`(${responder.getText(view)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, { gesture, Platform: { OS: 'ios' } });
module.exports = (async () => {
  for (const enabled of [true, false]) {
    const { createRustLyricsFollow } = require('../lib/rust-lyrics-follow');
    const follow = createRustLyricsFollow(); follow.sync('track', true);
    const before = follow.issue(enabled, 1);
    const nativeFloor = before.epoch + 1; // touchesBegan invalidates prior releases.
    const sent = [];
    const gesture = createRustLyricsGesture({
      shouldRevealTap: () => true,
      reserveTouchEpoch: () => { follow.issue(follow.desired, 1, true); },
      hitTest: () => { throw Error('reveal tap must not hit-test'); },
      setFollowing: value => sent.push(value), scrollBy() {}, tapEnabled: () => true,
      onLinePress() {}, onLineLongPress() {}, onAutoFollowChange() {}, onUserInteraction() {},
    });
    gesture.grant(100, 0, 700); gesture.release();
    assert.equal(follow.desired, enabled);
    assert.deepEqual(sent, [], 'epoch reservation sends no native follow/grace command');
    assert.ok(follow.issue(true, 1).epoch > nativeFloor, 'next explicit resume passes the native epoch floor');
  }
  for (const following of [true, false]) for (const y of [600, 601, 999]) {
    const h = fixture({ following });
    h.gesture.grant(100, 0, y);
    assert.equal(h.calls.hit, 0, 'reveal touches never query rows or footer hit targets');
    assert.deepEqual(h.calls.follow, [], 'grant never changes the prior follow/grace state');
    h.show(); // Another event can reveal controls before this touch releases.
    h.tick(LONG_PRESS_MS - 1); h.gesture.release();
    assert.equal(h.calls.reveal, 1, 'latched bottom tap only reveals controls');
    assert.equal(h.following(), following);
    assert.deepEqual([h.calls.press, h.calls.long, h.calls.footer], [0, 0, 0]);
  }
  for (const duration of [LONG_PRESS_MS, LONG_PRESS_MS + 1000]) {
    const h = fixture(); h.gesture.grant(100, 0, 600); h.tick(duration); h.gesture.release();
    assert.deepEqual([h.calls.reveal, h.calls.hit, h.calls.press, h.calls.long, h.calls.footer], [0, 0, 0, 0, 0]);
    assert.deepEqual(h.calls.follow, [], 'a bottom hold does not disable autoscroll');
    assert.equal(h.calls.timers.length, 0, 'no delayed row-selection callback exists');
  }
  for (const [dx, dy] of [[0, 10], [10, 0], [3, 3], [-10, -10]]) {
    const h = fixture(); h.gesture.grant(100, 0, 700); h.gesture.move(dy, dx);
    assert.deepEqual(h.calls.follow, [false], 'actual move takes normal drag ownership');
    h.gesture.release();
    assert.equal(h.calls.fling.length, 1, 'drag follows the existing release path');
    assert.equal(h.calls.reveal, 1, 'only drag ownership reports interaction, never a second tap');
    assert.deepEqual([h.calls.hit, h.calls.press, h.calls.long, h.calls.footer], [0, 0, 0, 0]);
  }
  const actual = fixture();
  const handlers = bind(actual.gesture);
  handlers.onPanResponderGrant({ nativeEvent: { locationY: 100, locationX: 20, pageY: 700 } });
  handlers.onPanResponderMove({}, { dy: 0, dx: 10 });
  handlers.onPanResponderRelease();
  assert.equal(actual.calls.hit, 0);
  assert.deepEqual(actual.calls.follow, [false], 'horizontal native drag is not classified as a reveal tap');
  assert.equal(actual.calls.fling.length, 1);
  const terminated = fixture(); const cancelHandlers = bind(terminated.gesture);
  cancelHandlers.onPanResponderGrant({ nativeEvent: { locationY: 100, locationX: 20, pageY: 700 } });
  cancelHandlers.onPanResponderTerminate(); cancelHandlers.onPanResponderRelease();
  assert.equal(terminated.calls.reveal, 0); assert.deepEqual(terminated.calls.follow, []);
  const slight = fixture(); slight.gesture.grant(100, 0, 600); slight.gesture.move(0, DRAG_SLOP); slight.gesture.release();
  assert.equal(slight.calls.reveal, 1, 'movement at the slop boundary remains a tap');
  assert.deepEqual(slight.calls.follow, []);
  const cancel = fixture(); cancel.gesture.grant(100, 0, 700); cancel.gesture.terminate(); cancel.gesture.release(); cancel.tick(1000);
  assert.equal(cancel.calls.reveal, 0); assert.deepEqual(cancel.calls.follow, []);
  const dragCancel = fixture(); dragCancel.gesture.grant(100, 0, 700); dragCancel.gesture.move(10, 0); dragCancel.gesture.terminate(); dragCancel.gesture.release();
  assert.deepEqual(dragCancel.calls.fling, [0], 'drag cancellation retains the normal rebound handoff');
  for (const reveal of [true, false]) {
    const h = fixture({ reveal }); h.gesture.grant(100, 0, 599);
    await Promise.resolve(); await Promise.resolve();
    h.gesture.release();
    assert.equal(h.calls.press, 1, 'taps above the boundary retain normal seek');
    assert.deepEqual(h.calls.follow, [false, true]);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
