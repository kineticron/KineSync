/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.resolve(__dirname, '..');
const cache = new Map();
const effects = [], focusEffects = [], timings = [], jsQueue = [], styles = [];
const listeners = new Set(), appListeners = new Set();
let state = { playbackPosition: 2000, anchorPositionMs: 2000, anchorMonotonicMs: 2000, isPlaying: true };
let gesture;
let cancellations = 0;
const clock = { now: () => 3000 };
const appState = { currentState: 'active', addEventListener: (_, cb) => {
  appListeners.add(cb);
  return { remove: () => appListeners.delete(cb) };
} };
const update = (patch) => {
  const previous = state;
  state = { ...state, ...patch };
  listeners.forEach((cb) => cb(state, previous));
};
const foreground = (value) => { appState.currentState = value; appListeners.forEach((cb) => cb(value)); };
const ui = vm.createContext({});
function worklet(fn) {
  assert.ok(fn.__workletHash, 'execute the production-transformed UI callback');
  const closure = {};
  for (const [name, value] of Object.entries(fn.__closure)) {
    // Non-worklet functions cross as opaque remote references; only runOnJS
    // can call them. Direct invocation on the UI runtime would fail this test.
    closure[name] = ['cancelAnimation', 'runOnJS', 'withTiming'].includes(name) ? value : typeof value === 'function'
      ? value.__workletHash ? worklet(value) : { remote: value }
      : value;
  }
  return vm.runInContext(`(${fn.__initData.code})`, ui).bind({ __closure: closure });
}
const flushJS = () => { while (jsQueue.length) jsQueue.shift()(); };
const Primitive = ({ children }) => React.createElement('div', null, children);
const mocks = {
  react: { ...React, useEffect: (effect) => effects.push(effect) },
  'react-native': { AppState: appState, View: Primitive, Text: Primitive, TextInput: Primitive, Pressable: Primitive,
    StyleSheet: { create: (value) => value } },
  'expo-router': { useFocusEffect: (effect) => focusEffects.push(effect) },
  'expo-haptics': { selectionAsync: async () => {} },
  '@react-native-vector-icons/ionicons': Primitive,
  '@/store/playback-store': { usePlaybackStore: {
    getState: () => state,
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  } },
  'react-native-gesture-handler': { GestureDetector: Primitive, Gesture: { Pan: () => {
    gesture = {};
    const builder = { minDistance: () => builder };
    for (const name of ['onBegin', 'onUpdate', 'onFinalize']) builder[name] = (cb) => {
      gesture[name] = worklet(cb); return builder;
    };
    return builder;
  } } },
  'react-native-reanimated': {
    __esModule: true,
    default: { View: Primitive, createAnimatedComponent: () => Primitive },
    Easing: { linear: (x) => x },
    useSharedValue: (value) => React.useRef({ value }).current,
    useDerivedValue: (cb) => ({ get value() { return worklet(cb)(); } }),
    useAnimatedStyle: (cb) => { const compute = worklet(cb); styles.push(compute); return compute(); },
    useAnimatedProps: (cb) => worklet(cb)(),
    useEvent: (cb, events, rebuild) => { assert.deepEqual(events, ['onScrollBeginDrag']); assert.equal(rebuild, true); return worklet(cb); },
    cancelAnimation: () => { cancellations++; },
    withTiming: (value, options) => { timings.push({ value, options }); return value; },
    runOnJS: (cb) => (...args) => jsQueue.push(() => (cb.remote ?? cb)(...args)),
  },
};
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  let source = fs.readFileSync(filename, 'utf8');
  if (relative.endsWith('playback-controls.tsx')) source += '\nexport { PlaybackTimeline };';
  const code = babel.transformSync(source, {
    filename, babelrc: false, configFile: false, presets: ['babel-preset-expo'],
    caller: { name: 'metro', platform: 'ios', supportsStaticESM: false }, envName: 'production',
  }).code;
  const module = { exports: {} };
  cache.set(filename, module);
  const localRequire = (name) => {
    if (mocks[name]) return mocks[name];
    if (name.startsWith('@/lib/')) return load(name.replace('@/', '') + '.ts');
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), name + '.ts')));
    return require(name);
  };
  vm.runInThisContext(`(function(require,module,exports,performance){${code}\n})`)(localRequire, module, module.exports, clock);
  return module.exports;
}

const { useLyricScrollInterruption } = load('components/lyrics/use-lyric-scroll-interruption.ts');
const offset = { value: 400 }, active = { value: true };
let reportedOffset;
let interrupt;
renderToStaticMarkup(React.createElement(() => {
  interrupt = useLyricScrollInterruption(offset, active, (value) => { reportedOffset = value; });
  return null;
}));
const beforeCancel = cancellations;
interrupt({ contentOffset: { y: 317 } });
assert.equal(active.value, false, 'drag stops auto-follow while JS is still blocked');
assert.equal(cancellations, beforeCancel + 1);
assert.equal(reportedOffset, undefined, 'JS bookkeeping is asynchronous');
flushJS();
assert.equal(reportedOffset, 317, 'drag reports the actual native offset');

const { usePlaybackTimelineClock } = load('components/lyrics/use-playback-timeline-clock.ts');
let position;
renderToStaticMarkup(React.createElement(() => { position = usePlaybackTimelineClock(100000); return null; }));
const stopClock = focusEffects.pop()();
assert.equal(timings.at(-1).options.duration, 97000, 'project the anchor before starting the UI clock');
const anchorAnimations = timings.length;
for (let i = 0; i < 120; i++) update({ playbackPosition: 3000 + i * 64 });
assert.equal(timings.length, anchorAnimations, '120 store ticks do not restart the animation');
update({ isPlaying: false, anchorPositionMs: 4000 });
assert.equal(position.value, 4000, 'pause freezes at the new anchor');
foreground('background');
update({ isPlaying: true, anchorPositionMs: 5000 });
assert.equal(timings.length, anchorAnimations, 'background playback does not animate the timeline');
foreground('active');
assert.equal(timings.at(-1).options.duration, 94000, 'foreground projects the latest anchor');
stopClock();
assert.equal(listeners.size + appListeners.size, 0, 'unfocused/unmounted timeline releases subscriptions');

const { PlaybackTimeline } = load('components/lyrics/playback-controls.tsx');
let sought = null, preview = null;
styles.length = 0;
renderToStaticMarkup(React.createElement(PlaybackTimeline, {
  durationMs: 100000, onSeek: (value) => {
    sought = value;
    // Match the real host's synchronous optimistic seek anchor.
    update({ anchorPositionMs: value, anchorMonotonicMs: 3000, isPlaying: false });
  }, onScrubPreview: (value) => { preview = value; },
}));
const stopGestureClock = focusEffects.pop()();
// The initial test track is 1px wide; coordinates are normalized ratios.
gesture.onBegin({ x: 0.1 });
assert.equal(styles[1]().transform[0].scaleX, 0.1, 'thumb follows input before JS begins the scrub');
assert.ok(!('width' in styles[1]()), 'scrubbing never animates a layout width');
flushJS();
assert.equal(preview, 10000);
gesture.onUpdate({ x: 0.6 });
gesture.onFinalize({ x: 0.9 }, true);
assert.equal(styles[1]().transform[0].scaleX, 0.9, 'release is painted before the seek crosses to JS');
flushJS();
assert.equal(sought, 90000, 'seek uses release position even when final preview was throttled');
assert.equal(preview, null);
update({ anchorPositionMs: 90100 });
assert.equal(styles[1]().transform[0].scaleX, 0.901, 'accepted seeks immediately resume following playback without a 1.2s hold');
sought = null;
gesture.onBegin({ x: 0.2 });
gesture.onFinalize({ x: 0.3 }, false);
flushJS();
assert.equal(sought, null, 'cancelled gestures do not seek');
stopGestureClock();

const { addHighRefreshRate } = require('../plugins/with-high-refresh-rate');
const template = 'class MainActivity : ReactActivity() {\n  override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(null) }\n}\n';
const generated = addHighRefreshRate(template);
assert.equal(addHighRefreshRate(generated), generated, 'Android prebuild is idempotent');
assert.ok(generated.includes('super.onWindowFocusChanged(hasFocus)'));
assert.ok(generated.includes('attributes.preferredRefreshRate = 0f'));

// Exercise the actual Zustand packet handler with deterministic wall/monotonic
// clocks. Only platform/persistence services and the interval scheduler are stubbed.
const packetTime = { wall: 100000, mono: 1000 };
const storeFilename = path.join(root, 'store/playback-store.ts');
const storeCode = babel.transformSync(fs.readFileSync(storeFilename, 'utf8'), {
  filename: storeFilename, babelrc: false, configFile: false, presets: ['babel-preset-expo'],
  caller: { name: 'metro', platform: 'ios', supportsStaticESM: false }, envName: 'production',
}).code;
const storeModule = { exports: {} };
const storeRequire = (name) => {
  if (name === 'react-native') return { AppState: { currentState: 'active' }, Platform: { OS: 'web' } };
  if (name === '@/lib/lyrics-enrich') return { enrichLyrics: (lines) => lines };
  if (name === '@/lib/network' || name === '@/lib/bridge-settings') return {};
  if (name.startsWith('@/lib/')) return load(name.replace('@/', '') + '.ts');
  return require(name);
};
vm.runInThisContext(`(function(require,module,exports,Date,performance,setInterval,clearInterval){${storeCode}\n})`)(
  storeRequire, storeModule, storeModule.exports, { now: () => packetTime.wall },
  { now: () => packetTime.mono }, () => 1, () => {},
);
const actualStore = storeModule.exports.usePlaybackStore;
const ingest = (patch = {}) => actualStore.getState().ingestPacket({
  type: 'playback', trackId: 'song-a', title: 'Test', artist: 'Test', durationMs: 180000,
  positionMs: 2000 + packetTime.mono - 1000, isPlaying: true, timestamp: packetTime.wall, ...patch,
}, 'desktop');
assert.equal(ingest().trackChanged, true);
for (let i = 0; i < 20; i++) {
  packetTime.wall += 1000;
  packetTime.mono += 1000;
  const expected = 2000 + packetTime.mono - 1000;
  ingest({ positionMs: expected + (i % 2 ? -60 : 60) });
  assert.equal(actualStore.getState().anchorPositionMs, 2000, 'packet jitter preserves the render anchor');
  assert.equal(actualStore.getState().anchorMonotonicMs, 1000);
  assert.equal(actualStore.getState().playbackPosition, expected, 'packet jitter cannot snap the clock');
}
ingest({ positionMs: 22120 });
assert.equal(actualStore.getState().anchorPositionMs, 22120, 'real drift beyond the deadband updates the anchor');
assert.equal(ingest({ positionMs: 60000 }).seekDetected, true);
assert.equal(actualStore.getState().playbackPosition, 60000, 'large seeks apply immediately');
ingest({ positionMs: 60020, isPlaying: false });
assert.equal(actualStore.getState().playbackPosition, 60020, 'pause applies even a small correction exactly');
ingest({ positionMs: 60030 });
assert.equal(actualStore.getState().anchorPositionMs, 60030, 'resume creates a fresh anchor');
assert.equal(ingest({ trackId: 'song-b', positionMs: 60040 }).trackChanged, true);
assert.equal(actualStore.getState().anchorPositionMs, 60040, 'new tracks bypass the old clock deadband');
storeModule.exports.stopPlaybackClock();
console.log('Playback performance checks passed: UI drag interruption, anchor-only clock, focus/background cleanup, immediate scrub feedback, exact release seek, cancellation, transform fill, Android prebuild, and real packet jitter/seek/track changes.');
