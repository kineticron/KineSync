/* Execute the production Rust view, preparation and gesture callbacks with store
 * snapshots. Native scheduling and GPU pixels are checked separately. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync, transformSync } = require('esbuild');
const app = path.resolve(__dirname, '..');
const preparation = buildSync({ entryPoints: [path.join(app, 'lib/rust-lyrics-preparation.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
  tsconfig: path.join(app, 'tsconfig.json') }).outputFiles[0].text;
const prepared = { exports: {} };
vm.runInNewContext(preparation, { module: prepared, exports: prepared.exports, require, Intl });
const timingSource = buildSync({ entryPoints: [path.join(app, 'lib/lyrics-timing.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
  tsconfig: path.join(app, 'tsconfig.json') }).outputFiles[0].text;
const timing = { exports: {} };
vm.runInNewContext(timingSource, { module: timing, exports: timing.exports, require, Intl });
const compiled = transformSync(fs.readFileSync(path.join(app, 'components/lyrics/rust/rust-lyrics-view.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
let state;
let gesture;
let seek = [];
const opened = [];
const jsx = (type, props) => ({ type, props: props || {} });
const gestureModule = require('../lib/rust-lyrics-gesture.js');
const { createRustLyricsGesture } = gestureModule;
const imports = {
  react: { memo: f => f, useMemo: f => f(), useCallback: f => f, useRef: current => ({ current }), useState: current => [current, () => {}], useEffect: () => {} },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', Platform: { OS: 'ios' }, AppState: {},
    StyleSheet: { create: x => x }, useWindowDimensions: () => ({ width: 390, height: 640 }),
    Linking: { openURL: url => { opened.push(url); return Promise.resolve(); } }, PanResponder: { create: handlers => ({ panHandlers: handlers }) } },
  'expo-modules-core': { requireOptionalNativeModule: () => ({ abiVersion: () => 11, monotonicMs: () => 1000 }), requireNativeViewManager: () => 'NativeView' },
  '@/store/playback-store': { usePlaybackStore: select => select(state) },
  '@/lib/rust-lyrics-protocol': require('../lib/rust-lyrics-protocol.js'),
  '@/lib/rust-lyrics-preparation': prepared.exports,
  '@/lib/rust-lyrics-follow': require('../lib/rust-lyrics-follow.js'),
  '@/lib/rust-lyrics-gesture': { ...gestureModule, createRustLyricsGesture: options => {
    gesture = createRustLyricsGesture({ ...options, setTimer: () => 1, clearTimer: () => {} }); return gesture;
  } },
  '@/constants/player-layout': { LANDSCAPE_FONT_SCALE: 0.8 },
  '@/lib/lyrics-timing': timing.exports,
  '@/lib/lyrics-arrival-trace': { arrivalHandle: () => undefined },
};
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: id => { assert.ok(imports[id], id); return imports[id]; }, __DEV__: true, performance, console });
function nodes(node) {
  if (node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const line = { lineStartTime: 0, lineEndTime: 1000, syllables: [{ text: 'Word', startTime: 0, endTime: 1000 }] };
const initial = { currentTrack: { id: 'fixture' }, lyrics: [], lyricsMetadata: {}, lyricsSource: '', lyricsStatusMessage: '', lyricsStyle: 'spicy', showTranslatedText: true, showRustDebugOverlay: false };
const staticLine = { lineStartTime: 0, lineEndTime: 0, syllables: [{ text: 'Plain text', startTime: 0, endTime: 0 }] };
const partialLine = { lineStartTime: 0, lineEndTime: 4000, syllables: [{ text: 'First', startTime: 0, endTime: 4000 }] };
const render = () => nodes(mod.exports.RustLyricsView({ active: true, tapToSeekEnabled: false, onCreditsTimestampPress: position => seek.push(position) }));
assert.equal(timing.exports.shouldHideTimedRenderer([staticLine], 'spicy-lyrics-static', undefined), true, 'zero timing hides without an untimed flag');
assert.equal(timing.exports.shouldHideTimedRenderer([partialLine, staticLine], 'spicy-lyrics-syllable', undefined), false, 'one valid line keeps partial timing usable');
assert.equal(timing.exports.selectTimedLyricLines([partialLine, staticLine]).length, 1, 'invalid rows are filtered from partial timing');
state = { ...initial, lyrics: [staticLine], lyricsSource: 'spicy-lyrics-static' };
const staticPacket = JSON.parse(render().find(n => n.type === 'NativeView').props.trackJson);
assert.equal(staticPacket.lines.length, 0, 'static Spicy text must not enter the Rust payload');
assert.equal(staticPacket.empty.title, 'Plain lyrics available');
state = { ...initial, lyrics: [partialLine, staticLine], lyricsSource: 'spicy-lyrics-syllable' };
const partialPacket = JSON.parse(render().find(n => n.type === 'NativeView').props.trackJson);
assert.ok(partialPacket.lines.length > 0, 'partial timed data remains renderable');
let previousGeneration = 0;
for (const debug of [false, true]) {
  for (const snapshot of [
    { lyricsStatusMessage: 'Loading best lyrics source on mobile...' },
    { lyricsMetadata: { instrumental: true }, lyricsSource: 'Spicy' },
    { lyricsStatusMessage: 'Lyrics unavailable' },
    {},
    { lyrics: [line] },
    { lyricsMetadata: { instrumental: true } },
  ]) {
    state = { ...initial, ...snapshot, showRustDebugOverlay: debug };
    const view = render().find(n => n.type === 'NativeView');
    assert.ok(view, 'native content must mount with FPS overlay on or off, including zero rows');
    const packet = JSON.parse(view.props.trackJson);
    assert.ok(packet.generation > previousGeneration, 'status-only changes replace native state');
    previousGeneration = packet.generation;
    if (!state.lyrics.length) {
      assert.equal(packet.lines.length, 0);
      assert.equal(packet.empty.title, state.lyricsMetadata.instrumental ? 'This song is an instrumental' : 'No synced lyrics yet');
      assert.equal(packet.empty.subtitle, state.lyricsStatusMessage || `Source: ${state.lyricsSource || 'unavailable'}`);
    } else assert.equal(packet.empty, undefined);
  }
}
async function tap(target, url) {
  state = { ...initial, lyrics: [line], lyricsMetadata: { attribution: { maker: { username: 'maker', url }, uploader: { username: 'uploader', url } } } };
  const rendered = render();
  const view = rendered.find(n => n.type === 'NativeView');
  const packet = JSON.parse(view.props.trackJson);
  assert.equal(packet.credits.attribution.maker_url, url);
  assert.equal(packet.credits.attribution.uploader_url, url);
  let point;
  view.props.ref.current = { hitTest: (x, y) => { point = [x, y]; return Promise.resolve(target); }, setFollowing: () => Promise.resolve() };
  const wrap = rendered.find(n => n.props.onPanResponderGrant);
  wrap.props.onPanResponderGrant({ nativeEvent: { locationX: 45, locationY: 120 } });
  wrap.props.onPanResponderRelease();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(point, [45, 120]);
  gesture.terminate();
}
(async () => {
  await tap(-3, 'https://example.org/maker');
  await tap(-4, 'https://example.org/uploader');
  assert.deepEqual(opened, ['https://example.org/maker', 'https://example.org/uploader']);
  assert.deepEqual(seek, [], 'profile must not bubble to footer seek');
  await tap(-3, 'http://example.org/maker');
  await tap(-4, 'javascript:bad');
  assert.equal(opened.length, 2);
  await tap(-2, 'https://example.org/maker');
  assert.deepEqual(seek, [1000], 'footer seeks to max line end even with line tap-to-seek disabled');
  await tap(-1, 'https://example.org/maker');
  assert.deepEqual(seek, [1000]);
  const swift = fs.readFileSync(path.join(app, 'modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift'), 'utf8');
  const ffi = fs.readFileSync(path.join(app, '../native/lyrics-renderer/src/ffi.rs'), 'utf8');
  const renderBody = ffi.slice(ffi.indexOf('pub extern "C" fn kr_render('));
  assert.ok(renderBody.indexOf('if let Some(scene) = &engine.empty_scene') < renderBody.indexOf('if !engine.timeline.anchored'));
  assert.match(swift, /if event\["state"\] as\? String == "ready" \{\s*self.markDirty\(\)\s*self.lifecycle\(\)/);
  assert.match(swift, /else if result == 0 \{[\s\S]*self.metal.isHidden = false/, 'static present must reveal Metal independently of FPS metrics');
  console.log('Rust footer and empty PASS: real view/store/preparation packets, x/y taps, exact HTTPS links, footer seek, loading/instrumental/status/source transitions, FPS independence and static first-frame guards.');
})().catch(error => { console.error(error); process.exitCode = 1; });
