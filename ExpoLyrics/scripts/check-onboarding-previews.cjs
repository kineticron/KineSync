const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const app = path.resolve(__dirname, '..');
const code = buildSync({
  stdin: {
    contents: `export { RustLyricsView } from './components/lyrics/rust/rust-lyrics-view';
      export { DEMO_LYRICS } from './lib/onboarding-demo-lyrics';`,
    resolveDir: app,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  write: false,
  tsconfig: path.join(app, 'tsconfig.json'),
  external: ['react', 'react/jsx-runtime', 'react-native', 'expo-modules-core', '@/store/playback-store'],
}).outputFiles[0].text;

function load(available, live) {
  const effects = [];
  const jsx = (type, props) => ({ type, props });
  const rejectLiveInput = () => assert.fail('A demo must use its own inputs');
  const liveState = live ?? new Proxy({}, { get: rejectLiveInput });
  const mocks = {
    react: {
      memo: fn => fn, useMemo: fn => fn(), useCallback: fn => fn, useRef: current => ({ current }),
      useState: initial => [initial, () => {}], useEffect: fn => effects.push(fn),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': {
      View: 'View', Text: 'Text', ScrollView: 'ScrollView', Platform: { OS: 'ios' },
      AppState: { addEventListener: live ? () => ({ remove() {} }) : rejectLiveInput }, StyleSheet: { create: styles => styles },
      PanResponder: { create: () => ({ panHandlers: {} }) }, useWindowDimensions: () => ({ width: 390, height: 844 }),
    },
    'expo-modules-core': {
      requireOptionalNativeModule: () => available ? { abiVersion: () => 11, monotonicMs: () => 9000 } : null,
      requireNativeViewManager: () => 'NativeView',
    },
    '@/store/playback-store': { usePlaybackStore: Object.assign(select => select(liveState), {
      getState: live ? () => live : rejectLiveInput, subscribe: live ? () => () => {} : rejectLiveInput,
    }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, require: name => mocks[name] ?? require(name),
    __DEV__: false, performance: { now: () => 3000 }, Intl, setTimeout, clearTimeout,
  });
  return { ...module.exports, effects };
}

function nodes(node, type) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, type));
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
}

const options = { active: true, tapToSeekEnabled: false, demoDurationMs: 25000, showTranslatedText: true, fontScale: 0.82 };
for (const demoStyle of ['spicy', 'amll']) {
  const { RustLyricsView, DEMO_LYRICS, effects } = load(true);
  const tree = RustLyricsView({ ...options, demoStyle, demoLyrics: DEMO_LYRICS,
    demoPlayback: { anchorPositionMs: 0, anchorMonotonicMs: 2000, isPlaying: true } });
  const [native] = nodes(tree, 'NativeView');
  const packet = JSON.parse(native.props.trackJson);
  assert.equal(packet.track_id, 'kinesync-demo');
  assert.equal(packet.settings.style, demoStyle);
  assert.equal(packet.settings.font_scale, 0.82);
  assert.equal(packet.lines.length, DEMO_LYRICS.length);
  assert.equal(packet.lines[0].paint.translation, DEMO_LYRICS[0].translatedText);
  assert.equal(packet.credits, undefined);
  assert.equal(nodes(tree, 'ScrollView').length, 0);
  assert.equal(native.props.onMetrics, undefined);

  const anchors = [];
  native.props.ref.current = {
    setAnchor: async value => { anchors.push(JSON.parse(value)); },
    setFollowing: async () => {},
  };
  effects.forEach(effect => effect());
  native.props.onStatus({ nativeEvent: { state: 'ready', generation: packet.generation } });
  assert.equal(anchors.length, 2);
  for (const [index, anchor] of anchors.entries()) {
    assert.deepEqual(anchor, { generation: packet.generation, sequence: index + 1, positionMs: 1000,
      nativeMs: 9000, playing: true, rate: 1, snap: true });
  }

  const scrubTree = RustLyricsView({ ...options, demoStyle, demoInteractive: true, demoLyrics: DEMO_LYRICS,
    demoPlayback: { anchorPositionMs: 0, anchorMonotonicMs: 2000, isPlaying: true }, previewPositionMs: 7000 });
  const [scrub] = nodes(scrubTree, 'NativeView');
  const scrubGeneration = JSON.parse(scrub.props.trackJson).generation;
  scrub.props.ref.current = native.props.ref.current;
  scrub.props.onStatus({ nativeEvent: { state: 'ready', generation: scrubGeneration } });
  assert.equal(anchors.at(-1).positionMs, 7000);
  assert.equal(anchors.at(-1).playing, false);
}

const { RustLyricsView, DEMO_LYRICS } = load(false);
const unavailable = RustLyricsView({ ...options, demoLyrics: DEMO_LYRICS });
assert.equal(nodes(unavailable, 'NativeView').length, 0);
assert.ok(nodes(unavailable, 'Text').some(({ props }) => [props.children].flat().join('').includes('Lyrics preview unavailable')));

const live = {
  currentTrack: { id: 'live', durationMs: 28000 }, lyrics: DEMO_LYRICS, lyricsMetadata: {}, lyricsSource: '',
  lyricsStyle: 'amll', showTranslatedText: false, showRustDebugOverlay: true,
  anchorPositionMs: 5000, anchorMonotonicMs: 2000, isPlaying: true,
};
const release = load(true, live);
const releaseTree = release.RustLyricsView({ active: true, tapToSeekEnabled: true });
const [releaseNative] = nodes(releaseTree, 'NativeView');
const releasePacket = JSON.parse(releaseNative.props.trackJson);
assert.equal(releasePacket.track_id, 'live');
assert.equal(releasePacket.settings.style, 'amll');
assert.equal(releasePacket.lines[0].paint.translation, undefined);
assert.equal(nodes(releaseTree, 'ScrollView').length, 0);
const releaseAnchors = [];
releaseNative.props.ref.current = { setAnchor: async payload => releaseAnchors.push(JSON.parse(payload)), setFollowing: async () => {} };
release.effects.forEach(effect => effect());
assert.equal(releaseAnchors[0].positionMs, 6000);
console.log('Rust previews and release player use independent anchors and the expected style, with native availability feedback.');
