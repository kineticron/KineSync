// Behavioral coverage for the input gate and the actual JS reference handlers.
const assert = require('node:assert/strict');
const { createLyricsScrollEscape } = require('../lib/lyrics-scroll-escape');
const { createRustLyricsFollow } = require('../lib/rust-lyrics-follow');
const { harness } = require('./check-native-translation-scroll.cjs');

for (const direction of [-1, 1]) {
  const gate = createLyricsScrollEscape();
  gate.begin(500);
  gate.move(500 + direction * 40, 500, 0);
  assert.equal(gate.release(500, 300, 3000), false, 'grace expiry alone never authorizes a return');
  gate.begin(500 + direction * 40);
  gate.move(500 + direction * 30, 500, 3100);
  assert.equal(gate.release(500, 300, 3100, direction), false, 'away release velocity blocks recapture');
  gate.begin(500 + direction * 30);
  gate.move(500 + direction * 20, 500, 3200);
  assert.equal(gate.release(500 + direction * 20, 300, 3300), false, 'playback moving the target cannot forge a return');
  gate.begin(500 + direction * 20);
  gate.move(500 + direction * 10, 500, 3400, false);
  assert.equal(gate.release(500, 300, 3400), false, 'momentum and rebound cannot create return intent');
  gate.begin(500 + direction * 10);
  gate.move(500, 500, 3500);
  assert.equal(gate.release(500, 300, 3500), true, 'deliberate return after grace reengages');
  gate.begin(500);
  gate.move(500 + direction * 40, 500, 4000);
  gate.move(500 + direction * 20, 500, 6499);
  assert.equal(gate.release(500, 300, 6500), true, 'deliberate return overrides grace');
  gate.reset(500 + direction * 40);
  gate.move(500, 500, 6501);
  assert.equal(gate.release(500, 300, 6501), true, 'a fresh track clears the old escape deadline');
}

for (const stamp of [999, 1000, 1001]) {
  const gate = createLyricsScrollEscape();
  gate.begin(500);
  assert.equal(gate.graceUntil, 0, 'touch alone starts no timer');
  gate.move(540, 500, 0);
  assert.equal(gate.graceUntil, 1000);
  gate.begin(540);
  gate.move(560, 500, stamp);
  assert.equal(gate.graceUntil, 1000, 'later gestures never extend grace');
  gate.move(500, 500, stamp);
  assert.equal(gate.release(500, 300, stamp), true, 'return overrides grace on both sides of boundary');
  gate.reset(500);
  assert.equal(gate.graceUntil, 0, 'resume and track reset clear grace');
  gate.move(540, 500, stamp, false);
  assert.equal(gate.graceUntil, 0, 'programmatic movement starts no timer');
}

// Exercise actual Skia drag, scroll, release, row and resume handlers.
const find = (node, type) => {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const result = find(child, type);
    if (result) return result;
  }
  return null;
};
for (const style of ['amll', 'spicy']) for (const list of ['flash', 'flat']) {
  const changes = [];
  const h = harness(style, list);
  h.render({ onAutoFollowChange: value => changes.push(value) });
  const scrollHost = find(h.treeSnapshot(), list === 'flash' ? 'FlashList' : 'FlatList');
  if (list === 'flat') scrollHost.props.CellRendererComponent({ index: 0 }).props.onLayout({ nativeEvent: { layout: { y: 500 } } });
  scrollHost.props.onScroll({ nativeEvent: { contentOffset: { y: 500 } } });
  h.drag();
  scrollHost.props.onScroll({ nativeEvent: { contentOffset: { y: 900 } } });
  scrollHost.props.onScrollEndDrag({ nativeEvent: {} });
  const manualCommands = h.commands.length;
  h.cue(5000);
  h.content();
  assert.equal(h.commands.length, manualCommands, `${style}/${list}: playback after grace cannot snap a manual viewport`);
  const host = find(h.treeSnapshot(), list === 'flash' ? 'FlashList' : 'FlatList');
  const row = h.row();
  host.props.renderItem({ item: row }).props.onPress(row);
  assert.equal(changes.at(-1), true, 'reference row tap still resumes');
  h.drag();
  h.render({ autoFollowEnabled: false });
  h.render({ autoFollowEnabled: true, resumeAutoFollowSignal: 1 });
  assert.ok(h.commands.length > manualCommands, 'explicit reference resume still issues a follow command');
}

for (const style of ['amll', 'spicy']) for (const list of ['flash', 'flat']) for (const stamp of [999, 1001]) {
  const changes = [];
  let now = 0;
  const h = harness(style, list, { clock: { now: () => now } });
  h.render({ onAutoFollowChange: value => changes.push(value) });
  const host = find(h.treeSnapshot(), list === 'flash' ? 'FlashList' : 'FlatList');
  if (list === 'flat') {
    const cell = host.props.CellRendererComponent({ index: 0 });
    cell.props.onLayout({ nativeEvent: { layout: { y: 500 } } });
  }
  // FlashList positions include the host's 150px first-item offset.
  const target = (list === 'flash' ? 650 : 500) - (style === 'amll' ? 72 : 0);
  const scroll = y => host.props.onScroll({ nativeEvent: { contentOffset: { y } } });
  const end = () => host.props.onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } });
  host.props.onTouchStart?.();
  assert.equal(changes.length, 0, 'ordinary touches leave follow enabled');
  scroll(target); // Programmatic arrival cannot escape.
  assert.equal(changes.length, 0);
  host.props.onScrollBeginDrag(); scroll(target + 100); end();
  assert.equal(changes.at(-1), false);
  const count = changes.length;
  now = stamp;
  host.props.onScrollBeginDrag(); scroll(target + 120);
  assert.equal(changes.length, count, 'later scroll gestures never deactivate again');
  scroll(target); end();
  assert.equal(changes.at(-1), true, 'deliberate return resumes without waiting for grace');
  h.render({ autoFollowEnabled: false });
  h.render({ autoFollowEnabled: true, resumeAutoFollowSignal: 1 });
  assert.ok(h.commands.length > 0, 'explicit resume commands the active line immediately');
}
console.log('Native scroll escape checks passed for hold, scroll, early return and explicit resume.');
