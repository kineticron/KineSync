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
const staticSource = buildSync({ entryPoints: [path.join(app, 'components/lyrics/rust/static-lyrics-view.tsx')],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react-native'], tsconfig: path.join(app, 'tsconfig.json') }).outputFiles[0].text;
const rendererSource = fs.readFileSync(path.join(app, 'components/lyrics/rust/rust-lyrics-view.tsx'), 'utf8');
const compiled = transformSync(rendererSource, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
const releaseChecks = [
  ['components/lyrics/rust/rust-lyrics-view.tsx', /rust-fps-overlay|rust-frame-trace|Show Rust debug overlay|onFrameTrace|onMetrics|exportFrameTrace|lyrics-arrival-trace/],
  ['app/(tabs)/explore.tsx', /Rust diagnostics|Show Rust debug overlay|showRustDebugOverlay|Simulated Latency|Packet Drop Rate|Raw GSMTC|Spotify Bearer Token/],
  ['store/playback-store.ts', /kinesync_rust_debug_overlay|showRustDebugOverlay|setShowRustDebugOverlay|simulatedLatencyMs|packetDropRate|debuggerHost|timing-diagnostics|recordTiming|lyrics-arrival-trace/],
  ['lib/bridge-client.ts', /simulatedLatencyMs|packetDropRate/],
  ['lib/mobile-lyrics-service.js', /lyrics-arrival-trace|\[spicy-debug\]|\[spicy-profile\]|\[lyrics-translate\]/],
  ['components/lyrics/settings-menu.tsx', /Bridge pipeline|native extrap/],
  ['components/lyrics/spotify-browser-fallback.tsx', /Run Spotify browser diagnostics|setPositionState calls|safeWindowGlobals/],
  ['components/lyrics/spotify-native-detector.tsx', /Spotify timing diagnostics|runDiagnostics|browser-http-410|native-clock-diagnostics/],
  ['components/ui/launch-transition.tsx', /\[LaunchTransition\] Native splash/],
  ['lib/spotify-browser.ts', /readDiagnostics|setPositionStateCalls|safeWindowGlobals/],
  ...['binary', 'client', 'packet', 'protocol'].map(name => [
    `lib/spotify-detector/${name}.ts`, /timing-diagnostics|development-timing-log|timingProvenance|recordTiming|native-clock-diagnostics|dealer-delivery-experiment-log/,
  ]),
  ['app/arrival-lab.tsx', /@\/components\/lyrics\/native\/arrival-lab/],
  ['app/renderer-lab.tsx', /@\/components\/lyrics\/native\/renderer-lab/],
];
for (const [file, marker] of releaseChecks) {
  const source = fs.readFileSync(path.join(app, file), 'utf8');
  const transform = development => transformSync(source, {
    loader: path.extname(file).slice(1), format: 'cjs', jsx: 'automatic',
    define: { __DEV__: String(development) }, minifySyntax: true, treeShaking: true,
  }).code;
  assert.doesNotMatch(transform(false), marker, `Release bundle contains diagnostics from ${file}`);
  assert.match(transform(true), marker, `Development bundle should retain diagnostics from ${file}`);
}
const configModule = { exports: {} };
const eas = JSON.parse(fs.readFileSync(path.join(app, 'eas.json'), 'utf8'));
assert.equal(eas.build.production.env?.KINESYNC_BUILD_KIND, 'release', 'EAS production must exclude Expo development tools');
const configEnvironment = { env: { ...eas.build.production.env } };
vm.runInNewContext(fs.readFileSync(path.join(app, 'app.config.js'), 'utf8'), { module: configModule, process: configEnvironment });
const baseConfig = JSON.parse(fs.readFileSync(path.join(app, 'app.json'), 'utf8')).expo;
const releasePlugins = configModule.exports({ config: baseConfig }).plugins;
const devClient = releasePlugins.find(plugin => plugin[0] === 'expo-dev-client');
assert.equal(devClient?.[1].addGeneratedScheme, false, 'Release prebuild must omit the Expo Dev Client scheme');
const excludePlugin = './plugins/without-expo-dev-tools.js';
assert.ok(releasePlugins.includes(excludePlugin), 'Release prebuild must exclude native Expo development packages');
const { excludeAndroid, excludeIos } = require('../plugins/without-expo-dev-tools');
const settingsGradle = excludeAndroid('expoAutolinking.useExpoModules()\n');
const podfile = excludeIos('target "KineSync" do\n  use_expo_modules!\nend\n');
assert.match(settingsGradle, /expoAutolinking\.exclude = .*"expo-dev-launcher".*"expo-dev-menu"/);
assert.match(podfile, /use_expo_modules!\(exclude: %w\[.*expo-dev-launcher .*expo-dev-menu /);
assert.equal(excludeAndroid(settingsGradle), settingsGradle);
assert.equal(excludeIos(podfile), podfile);
const buildProperties = baseConfig.plugins.find(plugin => plugin[0] === 'expo-build-properties');
assert.equal(buildProperties?.[1].android.enableMinifyInReleaseBuilds, true, 'Production must run R8');
const androidModule = path.join(app, 'modules/kinesync-rust-lyrics/android');
const releaseRules = fs.readFileSync(path.join(androidModule, 'release-rules.pro'), 'utf8');
assert.match(releaseRules, /-checkdiscard class dev\.kineticron\.rustlyrics\.FrameObserver/);
assert.match(releaseRules, /-checkdiscard class dev\.kineticron\.rustlyrics\.FrameSample[\s\S]*?void emit\(\.\.\.\);/);
assert.match(fs.readFileSync(path.join(androidModule, 'build.gradle'), 'utf8'), /release \{\s+consumerProguardFiles "release-rules.pro"/);
configEnvironment.env.KINESYNC_BUILD_KIND = 'development';
assert.equal(configModule.exports({ config: baseConfig }), baseConfig, 'Development prebuild keeps Expo Dev Client support');
assert.ok(!baseConfig.plugins.includes(excludePlugin));
const iosRelease = fs.readFileSync(path.join(app, '../.github/workflows/ios-unsigned-ipa.yml'), 'utf8');
const androidRelease = fs.readFileSync(path.join(app, '../.github/workflows/android-apk.yml'), 'utf8');
assert.match(iosRelease, /KINESYNC_BUILD_KIND: release/);
assert.match(iosRelease, /Release ExpoModulesProvider registers Expo development tools/);
assert.match(androidRelease, /KINESYNC_BUILD_KIND: .*'development' \|\| 'release'/);
assert.match(iosRelease, /check-release-diagnostics\.cjs', 'ios'/);
assert.match(androidRelease, /check-release-diagnostics\.cjs android KineSync-Android\.apk/);
let state;
let gesture;
let seek = [];
const opened = [];
const jsx = (type, props) => ({ type, props: props || {} });
const gestureModule = require('../lib/rust-lyrics-gesture.js');
const { createRustLyricsGesture } = gestureModule;
let hooks = [];
let hookIndex = 0;
const react = {
  memo: fn => fn,
  useMemo(fn, deps) {
    const index = hookIndex++;
    const previous = hooks[index];
    if (!previous || !deps || previous.deps?.length !== deps.length ||
      deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      hooks[index] = { value: fn(), deps };
    }
    return hooks[index].value;
  },
  useCallback: fn => fn,
  useRef(current) { return hooks[hookIndex++] ??= { current }; },
  useState(initial) {
    const slot = hooks[hookIndex++] ??= { value: initial };
    return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
};
const imports = {
  react,
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', Platform: { OS: 'ios' }, AppState: {},
    StyleSheet: { create: x => x }, useWindowDimensions: () => ({ width: 390, height: 640 }),
    Linking: { openURL: url => { opened.push(url); return Promise.resolve(); } }, PanResponder: { create: handlers => ({ panHandlers: handlers }) } },
  'expo-modules-core': { requireOptionalNativeModule: () => ({ abiVersion: () => 11, monotonicMs: () => 1000 }), requireNativeViewManager: () => 'NativeView' },
  '@/store/playback-store': { usePlaybackStore: Object.assign(select => select(state), { getState: () => state }) },
  '@/lib/rust-lyrics-protocol': require('../lib/rust-lyrics-protocol.js'),
  '@/lib/rust-lyrics-preparation': prepared.exports,
  '@/lib/rust-lyrics-follow': require('../lib/rust-lyrics-follow.js'),
  '@/lib/rust-lyrics-gesture': { ...gestureModule, createRustLyricsGesture: options => {
    gesture = createRustLyricsGesture({ ...options, setTimer: () => 1, clearTimer: () => {} }); return gesture;
  } },
  '@/constants/player-layout': { LANDSCAPE_FONT_SCALE: 0.8 },
  '@/lib/lyrics-timing': timing.exports,
  '@/lib/lyrics-arrival-trace': { arrivalHandle: () => undefined },
  '@/lib/rust-frame-trace': {},
  './rust-fps-overlay': { RustFpsOverlay: 'RustFpsOverlay' },
};
const mod = { exports: {} };
const staticView = { exports: {} };
const requireStub = id => { assert.ok(imports[id], id); return imports[id]; };
vm.runInNewContext(staticSource, { module: staticView, exports: staticView.exports, require: requireStub, Intl, performance });
imports['./static-lyrics-view'] = staticView.exports;
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: requireStub, __DEV__: true, performance, console });
function nodes(node) {
  if (node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const line = { lineStartTime: 0, lineEndTime: 1000, syllables: [{ text: 'Word', startTime: 0, endTime: 1000 }] };
const initial = { currentTrack: { id: 'fixture' }, lyrics: [], lyricsMetadata: {}, lyricsSource: '', lyricsStatusMessage: '', lyricsStyle: 'spicy', showTranslatedText: true, showRustDebugOverlay: false };
const staticLine = { lineStartTime: 0, lineEndTime: 0, syllables: [{ text: 'Plain text', startTime: 0, endTime: 0 }] };
const partialLine = { lineStartTime: 0, lineEndTime: 4000, syllables: [{ text: 'First', startTime: 0, endTime: 4000 }] };
let renderedState;
const render = () => {
  if (renderedState !== state) hooks = [];
  renderedState = state;
  hookIndex = 0;
  return nodes(mod.exports.RustLyricsView({ active: true, tapToSeekEnabled: false, onCreditsTimestampPress: position => seek.push(position) }));
};
assert.equal(timing.exports.shouldHideTimedRenderer([staticLine], 'spicy-lyrics-static', undefined), true, 'zero timing hides without an untimed flag');
assert.equal(timing.exports.shouldHideTimedRenderer([partialLine, staticLine], 'spicy-lyrics-syllable', undefined), false, 'one valid line keeps partial timing usable');
assert.equal(timing.exports.selectTimedLyricLines([partialLine, staticLine]).length, 1, 'invalid rows are filtered from partial timing');
state = { ...initial, lyrics: [staticLine], lyricsSource: 'spicy-lyrics-static' };
const staticRender = render();
const plainView = staticRender.find(n => n.type === staticView.exports.StaticLyricsView);
assert.ok(plainView, 'static Spicy lyrics use the React Native view');
assert.equal(plainView.props.lines, state.lyrics);
assert.ok(!staticRender.some(n => n.type === 'NativeView'), 'static Spicy lyrics do not mount the Rust surface');
const plainContent = nodes(plainView.type(plainView.props));
assert.equal(plainContent[0].type, 'ScrollView');
assert.ok(plainContent.some(n => n.type === 'Text' && n.props.children === 'Plain text'));
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
  assert.ok(!rendered.some(n => n.props.onPanResponderGrant), 'gestures wait for native readiness');
  view.props.ref.current = {
    hitTest: (x, y) => { point = [x, y]; return Promise.resolve(target); },
    setFollowing: () => Promise.resolve(),
    setAnchor: () => Promise.resolve(),
  };
  view.props.onStatus({ nativeEvent: { state: 'ready', generation: packet.generation, message: 'ready' } });
  const ready = render();
  assert.equal(JSON.parse(ready.find(n => n.type === 'NativeView').props.trackJson).generation, packet.generation);
  const wrap = ready.find(n => n.props.onPanResponderGrant);
  assert.ok(wrap, 'the ready surface accepts gestures');
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
