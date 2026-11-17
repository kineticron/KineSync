// Behavioral coverage for the input gate and the actual JS reference handlers.
const assert = require('node:assert/strict');
require('./check-spicy-scroll-escape.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
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
  const target = style === 'amll' ? 428 : 500;
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

// Run the real AMLL adapter touch/wheel/line/credits and options handlers.
const amll = fs.readFileSync(path.join(__dirname, '../components/lyrics/amll-webview-entry.ts'), 'utf8');
const handlers = new Map();
const playerHandlers = new Map();
const events = [];
let resets = 0;
const layouts = [];
const scheduledFrames = [];
const lyricReplacements = [];
let staticRenders = 0;
let selectionUpdates = 0;
const context = vm.createContext({
  autoFollowEnabled: true, sourceLines: [{}], tapToSeekEnabled: true,
  showTranslatedText: false, landscapeMode: false, staticLyricsMode: false,
  fontScale: 1, selectedKeys: {},
  resumeAutoFollowSignal: 0, longPressTimer: 0, touchMoved: false,
  touchStartSourceIndex: -1, lastLyricEndTime: 1000, IDLE_ANIMATION_GRACE_MS: 750,
  player: { addEventListener: (name, handler) => playerHandlers.set(name, handler), resetScroll: () => resets++,
    setLyricLines: (lines, position) => lyricReplacements.push({ lines, position }),
    getBottomLineElement: () => ({ addEventListener: (name, handler) => handlers.set(`credits-${name}`, handler) }) },
  playerElement: { addEventListener: (name, handler) => handlers.set(name, handler) },
  post: event => events.push(event), window: { clearTimeout() {}, setTimeout: () => 1 },
  scheduleFrame: grace => scheduledFrames.push(grace), getSourceIndexFromLineEvent: () => 0, getSourceIndexFromTarget: () => 0,
  setPressedSourceIndex() {}, relayout: force => { layouts.push(force); return Promise.resolve(); }, toFiniteMs: (value, fallback) => value ?? fallback,
  updatePlayerClass() {}, updateSelectionClasses: () => selectionUpdates++,
  renderStaticLyrics: () => staticRenders++, convertLines: lines => lines,
  getProjectedPosition: () => 1234,
});
const adapter = amll.slice(amll.indexOf('function setAutoFollow('), amll.indexOf('function playbackNeedsFrames('));
const options = amll.slice(amll.indexOf('function applyOptions('), amll.indexOf('function sync('));
vm.runInContext(ts.transpileModule(adapter + options, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
handlers.get('touchmove')();
assert.equal(context.autoFollowEnabled, true, 'touchmove without a scroll-away does not deactivate follow');
handlers.get('kinesync-escape')();
assert.equal(context.autoFollowEnabled, false);
handlers.get('touchend')();
handlers.get('kinesync-scroll')();
assert.equal(context.autoFollowEnabled, false, 'AMLL touch release and momentum do not recapture');
playerHandlers.get('line-click')({ type: 'line-click', preventDefault() {} });
assert.equal(context.autoFollowEnabled, true, 'AMLL deliberate line tap still resumes');
handlers.get('wheel')();
handlers.get('kinesync-escape')();
assert.equal(context.autoFollowEnabled, false);
handlers.get('credits-click')();
assert.equal(context.autoFollowEnabled, true, 'AMLL credits command still resumes');
handlers.get('wheel')();
handlers.get('kinesync-escape')();
context.applyOptions({ autoFollowEnabled: false, resumeAutoFollowSignal: 1, tapToSeekEnabled: true });
assert.equal(context.autoFollowEnabled, true, 'AMLL explicit resume overrides manual follow');
assert.equal(resets, 3);
assert.equal(layouts.at(-1), undefined, 'explicit resume requests the real adapter relayout');
assert.equal(scheduledFrames.at(-1), 1500, 'explicit resume wakes the return animation');
assert.equal(selectionUpdates, 1, 'unchanged layout updates selection without replacing lyrics');
assert.equal(context.fontScale, 1);
assert.equal(Object.keys(context.selectedKeys).length, 0);

const selectedKeys = { selected: true };
context.applyOptions({ showTranslatedText: true, tapToSeekEnabled: true, fontScale: 1.25, selectedKeys });
assert.equal(context.fontScale, 1.25);
assert.equal(context.selectedKeys, selectedKeys);
assert.equal(lyricReplacements.length, 1, 'translation changes exercise the synced lyrics branch');
assert.equal(lyricReplacements[0].lines, context.sourceLines);
assert.equal(lyricReplacements[0].position, 1234);
assert.equal(layouts.at(-1), true);
context.staticLyricsMode = true;
context.applyOptions({ showTranslatedText: true, landscapeMode: true, tapToSeekEnabled: true });
assert.equal(staticRenders, 1, 'static layout changes exercise the static lyrics branch');
assert.equal(lyricReplacements.length, 1, 'static changes do not replace synced lyrics');
assert.equal(resets, 3, 'layout branches do not manufacture a resume command');

const follow = createRustLyricsFollow();
follow.sync('old', true);
follow.reconcile(1);
const down = follow.issue(false, 1, true);
follow.sync('new', false);
const fresh = follow.reconcile(2);
assert.equal(fresh.value, true, 'new song follows even while parent carries old manual false');
assert.equal(follow.accept(down.epoch, 1), false, 'old release epoch cannot reclaim the new song');
assert.ok(fresh.epoch > down.epoch);

// Execute the player's real track-id effect, preserving its previous bug fix.
const playerSource = fs.readFileSync(path.join(__dirname, '../app/(tabs)/index.tsx'), 'utf8');
const ast = ts.createSourceFile('index.tsx', playerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let trackEffect;
function inspect(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
      node.arguments[0]?.getText(ast).includes('autoFollowTrackId.current')) trackEffect = node.arguments[0].getText(ast);
  ts.forEachChild(node, inspect);
}
inspect(ast);
assert.ok(trackEffect, 'player keeps its track identity reset effect');
let parentFollowing = false;
const trackContext = vm.createContext({ currentTrack: { id: 'old' }, autoFollowTrackId: { current: 'old' },
  setAutoFollowEnabled: value => { parentFollowing = value; } });
const resetCode = ts.transpileModule(`(${trackEffect})()`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
vm.runInContext(resetCode, trackContext);
assert.equal(parentFollowing, false, 'same-track playback cannot reset manual ownership');
trackContext.currentTrack = { id: 'new' };
vm.runInContext(resetCode, trackContext);
assert.equal(parentFollowing, true, 'new song resets even a manual false in the real parent effect');
console.log('Scroll escape and reference ownership behavioral checks passed.');

handlers.get('kinesync-escape')();
assert.equal(context.autoFollowEnabled, false);
handlers.get('kinesync-return')();
assert.equal(context.autoFollowEnabled, true, 'AMLL return event resumes immediately');
assert.equal(resets, 4, 'AMLL return cancels native inertia and grace');
