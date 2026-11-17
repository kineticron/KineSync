const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createHash } = require('node:crypto');
const entry = path.resolve(__dirname, '../../ExpoLyrics/scripts/fixtures/fullapp-test-entry.js');
const runner = path.resolve(__dirname, '../android-fullapp/src/dev/kineticron/fullapp/FullAppRunner.java');
const original = path.resolve(__dirname, '../android-fullapp/fixtures/original/fullapp-test-entry.js');
const sourceText = file => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const sha256 = source => createHash('sha256').update(source).digest('hex');
assert.equal(sha256(sourceText(runner)), '82487444b8a01e8e037b97e9a191f02d9a090a0e706af9190cfc447d1fc9cbbc');
assert.equal(sha256(sourceText(entry).replaceAll("require('../../", "require('./")),
  'fc7c6cec546ebbebb7ecf94d5b9a69c7227e2f672d28032108084e8f19a01cd2');
// Preserve all seed values, lyric definitions, metadata and fixture state transitions.
const fixtureDefinitions = source => source.slice(source.indexOf('const seed ='), source.indexOf('function handle(url)'))
  .replace('  armed = null;\n', '').replaceAll("require('../../", "require('./");
assert.equal(fixtureDefinitions(sourceText(entry)), fixtureDefinitions(sourceText(original)));
const logs = [];
let state = {};
let rootGetter;
let lock;
const store = {
  getState: () => state,
  setState: value => { state = { ...state, ...value }; },
  subscribe: () => () => {},
};
const bridge = { seekTo() {} };
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  forwardRef: fn => fn,
  useRef: value => ({ current: value }),
  useCallback: fn => fn,
  useState: value => [value, () => {}],
  useEffect: fn => fn(),
};
const rn = {
  View: 'View', PixelRatio: { get: () => 3 },
  LogBox: { ignoreAllLogs() {} },
  Linking: { openURL() {}, addEventListener() {}, getInitialURL: () => Promise.resolve(null) },
  AppRegistry: { registerComponent: (_name, getter) => { rootGetter = getter; } },
};
const adapters = [{ requireNativeViewManager: () => 'Native' }, { requireNativeViewManager: () => 'Native' }];
const demo = [0, 5000, 10000].map(start => ({ lineStartTime: start, lineEndTime: start + 4500,
  syllables: [{ text: 'Line', startTime: start, endTime: start + 4500 }] }));
const context = vm.createContext({ console: { info: line => logs.push(line) }, setTimeout: fn => fn(),
  performance: { now: () => 1000 }, require: name => {
    if (name === 'react') return react;
    if (name === 'react-native') return rn;
    if (name.includes('/src/NativeViewManagerAdapter')) return adapters[0];
    if (name.includes('/build/NativeViewManagerAdapter')) return adapters[1];
    if (name === '@react-native-async-storage/async-storage') return { default: { multiSet: () => Promise.resolve() } };
    if (name === '../../store/playback-store') return { usePlaybackStore: store, startPlaybackClock() {} };
    if (name === '../../lib/bridge-client') return { bridgeClient: bridge };
    if (name === '../../lib/onboarding-demo-lyrics') return { DEMO_LYRICS: demo };
    if (name === 'expo-screen-orientation') return { OrientationLock: { PORTRAIT_UP: 1, LANDSCAPE_LEFT: 3 }, lockAsync: value => { lock = value; return Promise.resolve(); } };
    if (name === 'expo-router/entry') { rn.AppRegistry.registerComponent('app', () => () => null); return {}; }
    throw new Error('Unexpected import ' + name);
  },
});
(async () => {
  vm.runInContext(fs.readFileSync(entry, 'utf8'), context);
  rootGetter()({});
  await Promise.resolve(); await Promise.resolve();
  const wrapper = adapters[0].requireNativeViewManager('KineSyncRustLyrics');
  const ref = { current: null };
  const rendered = wrapper({ style: { flex: 1 } }, ref);
  rendered.props.ref.current = { measureInWindow: callback => callback(200, 30, 500, 250) };
  let targetIndex = 2;
  const native = { hitTest: async () => targetIndex };
  rendered.children[0].props.ref(native);
  assert.equal(ref.current, native, 'real commands remain forwarded');
  vm.runInContext("apply('spicy'); apply('pause')", context);
  await vm.runInContext("probe('seek', 'seek-1')", context);
  assert.ok(logs.some(line => line === 'KSFX TARGET request=seek-1 x=1350 y=126 expected=10000 url='), 'uses measured landscape origin, native hit index and pixel ratio');
  bridge.seekTo(5000);
  assert.ok(!logs.some(line => line.includes('SEEK_OK')));
  bridge.seekTo(10000);
  assert.ok(!logs.some(line => line.includes('SEEK_OK')), 'request alone cannot prove store seek');
  store.setState({ anchorPositionMs: 10000, playbackPosition: 10000 });
  bridge.seekTo(10000);
  assert.ok(logs.includes('KSFX SEEK_OK request=seek-1 expected=10000 actual=10000'));
  vm.runInContext("apply('credits')", context);
  targetIndex = -3;
  await vm.runInContext("probe('link', 'link-1')", context);
  await rn.Linking.openURL('https://example.com/unrelated');
  assert.ok(!logs.some(line => line.includes('LINK_OK')));
  await rn.Linking.openURL('https://example.com/maker');
  assert.ok(logs.includes('KSFX LINK_OK request=link-1 url=https://example.com/maker'));
  // A different track invalidates a target, even if its URL matches.
  await vm.runInContext("probe('link', 'link-stale')", context);
  store.setState({ currentTrack: { id: 'different-track' } });
  await rn.Linking.openURL('https://example.com/maker');
  assert.ok(!logs.some(line => line.includes('LINK_OK request=link-stale')));
  vm.runInContext("handle('expolyrics://?fx=orientation-portrait')", context);
  await Promise.resolve();
  assert.equal(lock, 1);
  vm.runInContext("handle('expolyrics://?fx=orientation-landscape')", context);
  await Promise.resolve();
  assert.equal(lock, 3);
  rendered.children[0].props.ref(null);
  await vm.runInContext("probe('seek', 'missing')", context);
  assert.ok(logs.includes('KSFX TARGET_MISSING request=missing'));
  const java = fs.readFileSync(runner, 'utf8');
  assert.ok(java.includes('targetedTap("seek", s)') && java.includes('targetedTap("link", s)'));
  assert.ok(java.includes('W = bitmap.getWidth(); H = bitmap.getHeight()'));
  assert.ok(java.includes('expected != -3 || !url.equals("https://example.com/maker")'));
  assert.ok(!java.includes('new double[] { 0.62') && !java.includes('no LINK_OPEN from grid taps'));
  assert.ok(java.includes('name.startsWith("seek-tap-")') && java.includes('name.startsWith("credits-link-")'));
  console.log('Harness checks passed: measured targets, pixel conversion, exact seek with store state, exact link, stale track rejection, orientation, missing surface and runner failure gates. Java device execution remains unverified.');
})().catch(error => { console.error(error); process.exitCode = 1; });
