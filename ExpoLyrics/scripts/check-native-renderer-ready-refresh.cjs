/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const source = path.join(__dirname, '../components/lyrics/native/native-renderer-ready-refresh.ts');
const code = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const moduleObject = { exports: {} };
new Function('module', 'exports', code)(moduleObject, moduleObject.exports);
const { NativeRendererReadyRefreshGate, registerNativeRendererReadyResync, requestNativeRendererReadyResync } = moduleObject.exports;
let active = true, refreshes = 0, gate;
let unregister = registerNativeRendererReadyResync({ canResync: () => active, resyncPlayback: () => {
  refreshes++;
  if (gate) assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), false,
    'Synchronous re-entry is rejected because generation was locked before resyncPlayback');
} });

gate = new NativeRendererReadyRefreshGate();
let currentGeneration = gate.begin('amll:flash:canvas:track-a:packet-1');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), true, 'Initial live native ready requests one detector resync');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), false, 'Repeated onLayout/onContentSizeChange is once-only');
assert.equal(refreshes, 1);

const outgoingGeneration = currentGeneration;
currentGeneration = gate.begin('spicy:flash:canvas:track-a:packet-1');
assert.equal(gate.onReady(outgoingGeneration, true, requestNativeRendererReadyResync), false, 'Stale outgoing renderer callback is ignored after switch');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), true, 'A native renderer switch creates one fresh ready generation');
assert.equal(refreshes, 2);

currentGeneration = gate.begin('amll:flash:canvas:track-b:packet-2');
assert.equal(gate.onReady(currentGeneration, false, requestNativeRendererReadyResync), false, 'Desktop and demo renderers are excluded');
active = false;
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), false, 'Detector eligibility is rechecked at dispatch');
active = true;
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), true, 'An unsuccessful ineligible attempt can be retried on a later genuine ready event');
assert.equal(refreshes, 3);

// A ready layout may precede the sibling detector effect. Keep only a guarded,
// generation-scoped pending request and flush it when the detector registers.
unregister();
currentGeneration = gate.begin('amll:flat:clip:track-c:packet-3');
let rendererEligible = true;
const requestForCurrentRenderer = (generation, eligible = rendererEligible) => gate.onReady(generation, eligible,
  requestNativeRendererReadyResync, () => rendererEligible && gate.isCurrent(generation));
assert.equal(requestForCurrentRenderer(currentGeneration), true, 'Ready event is retained while detector registration is pending');
rendererEligible = false; // Same generation becomes an outgoing/inactive packet layer before detector effect.
unregister = registerNativeRendererReadyResync({ canResync: () => true, resyncPlayback: () => { refreshes++; } });
assert.equal(refreshes, 3, 'Late detector registration rejects a now-inactive renderer in the same generation');
rendererEligible = true;
unregister();
assert.equal(requestForCurrentRenderer(currentGeneration), true, 'Reactivated renderer can queue a fresh genuine ready event');
unregister = registerNativeRendererReadyResync({ canResync: () => true, resyncPlayback: () => { refreshes++; } });
assert.equal(refreshes, 4, 'Late detector registration services the reactivated renderer once');

unregister();
currentGeneration = gate.begin('amll:flat:clip:track-d:packet-4');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), true);
gate.setMounted(false);
unregister = registerNativeRendererReadyResync({ canResync: () => true, resyncPlayback: () => { refreshes++; } });
assert.equal(refreshes, 4, 'Pending ready callback after unmount is discarded');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), false, 'Unmount rejects late callbacks');

gate.setMounted(true);
currentGeneration = gate.foreground('amll:flat:clip:track-e:packet-5');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), true, 'Foreground reuses cached renderer readiness without layout/remount');
assert.equal(gate.onReady(currentGeneration, true, requestNativeRendererReadyResync), false, 'Foreground generation refreshes only once');
assert.equal(refreshes, 5);
currentGeneration = gate.begin('amll:flash:canvas:track-f:packet-6');
let failedAttempts = 0;
assert.equal(gate.onReady(currentGeneration, true, () => { failedAttempts++; throw Error('detector unavailable'); }), false);
assert.equal(gate.onReady(currentGeneration, true, () => { failedAttempts++; return true; }), true, 'Failed request rolls the once-only lock back');
assert.equal(failedAttempts, 2);
unregister();

assert.equal(refreshes, 5, 'Refresh does not feed a playback sync loop');

// Execute the actual NativeLyricsView hook and FlashList callback with a small
// React hook scheduler. This catches callback dependency/init errors and proves
// the pending predicate reads the renderer's latest active prop.
const viewSource = path.join(__dirname, '../components/lyrics/native/native-lyrics-view.tsx');
const viewCode = buildSync({ entryPoints: [viewSource], bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['*'] }).outputFiles[0].text;
let hookCursor = 0;
const hookSlots = [];
const appListeners = new Set();
const appState = { currentState: 'active', addEventListener: (_type, listener) => {
  appListeners.add(listener); return { remove: () => appListeners.delete(listener) };
} };
const playback = { playbackMode: 'mobile', connectionStatus: 'disconnected', currentTrack: { id: 'actual-track' },
  isPlaying: true, lyricsSource: 'test', lyricsStatusMessage: '', lyricsMetadata: {}, durationMs: 10000 };
const jsx = (type, props) => ({ type, props: props ?? {} });
const react = {
  memo: fn => fn,
  createContext: () => ({ Provider: 'Provider' }),
  useRef(value) { const index = hookCursor++; return hookSlots[index] ??= { current: value }; },
  useState(value) { const index = hookCursor++; const slot = hookSlots[index] ??= { value: typeof value === 'function' ? value() : value };
    return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; }]; },
  useMemo(fn, deps) { const index = hookCursor++; const old = hookSlots[index];
    if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) hookSlots[index] = { deps, value: fn() };
    return hookSlots[index].value; },
  useCallback(fn, deps) { const index = hookCursor++; const old = hookSlots[index];
    if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) hookSlots[index] = { deps, value: fn };
    return hookSlots[index].value; },
  useEffect(fn, deps) { const index = hookCursor++; const old = hookSlots[index];
    if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
      old?.cleanup?.(); hookSlots[index] = { deps, cleanup: fn() };
    } },
};
const modules = {
  react,
  '@/lib/fast-lyric-loading': { useFastLyricLoading: () => true },
  'expo-blur': { BlurTargetView: 'BlurTargetView' },
  './native-shared-blur': {
    NativeSharedBlur: 'NativeSharedBlur',
    NativeSharedBlurContext: { Provider: 'NativeSharedBlurContext.Provider' },
    NativeBlurGeometryContext: { Provider: 'NativeBlurGeometryContext.Provider' },
    hasBlurGeometry: (rows, window, time) => Array.isArray(rows) && rows.length > 0 && rows.every(r => r && r.height > 0),
    SHARED_BLUR_PROFILES: { amll: true, spicy: true },
  },
  './batched-amll-motion': { composeBatchedRegistry: () => ({}) },
  '@/lib/lyrics-arrival-context': { LyricsArrivalContext: { Provider: 'TraceProvider' }, LyricsArrivalCommit: 'TraceCommit', useArrivalGeometry: () => ({}), useArrivalIdentity: () => ({ handle: undefined, identity: { id: 0 }, context: {}, producers: {} }) },
  '@/lib/lyrics-arrival-trace': { arrivalSpan: (_t, _id, _n, fn) => fn(), arrivalEvent: () => {} },
  '@/lib/native-clock-diagnostics': { emitNativeClockDiagnostic() {} },
  'react-native': { Platform: { OS: 'ios', Version: '17' }, AppState: appState, FlatList: 'FlatList', Linking: { openURL() {} }, Pressable: 'Pressable', StyleSheet: { create: x => x }, Text: 'Text', View: 'View' },
  'expo-image': { Image: 'Image' }, '@shopify/flash-list': { FlashList: 'FlashList' },
  'react-native-reanimated': { useAnimatedReaction() {}, useDerivedValue: fn => ({ value: fn() }), useSharedValue: value => ({ value }) },
  'react-native-worklets': { scheduleOnRN() {} },
  '../lyrics-packet-transition': { useLyricsPacketTransition: () => null, withLyricsPacketTransition: component => component },
  '@/store/playback-store': { usePlaybackStore: Object.assign(selector => { hookCursor++; return selector(playback); }, { getState: () => playback }) },
  '@/lib/lyrics-timing': { detectLyricsTimingMode: () => 'synced' },
  '@/lib/lyrics-layout': { getAutoScrollTargetRange: () => null, getBackgroundActiveLines: () => [], getLyricTimingIndex: () => ({}),
    getPlaybackWindowState: () => ({ visualActiveLineStartIndex: 0, visualActiveLineEndIndex: 0, focusLineIndex: 0 }) },
  './native-lyrics-model': { buildNativeRows: () => [{ key: 'row', line: {}, lead: { start: 0, end: 1000 }, backgrounds: [], index: 0 }], nativeFollowIndex: (_rows, index) => index, nativeScrollSourceKey: () => 'mock-source' },
  './native-lyric-row': { NativeLyricRowView: 'NativeLyricRowView' },
  './use-native-lyrics-clock': { useNativeLyricsClock: () => ({ position: { value: 0 }, running: false, seekVersion: 0 }) },
  './native-lyrics-fonts': { NativeLyricsFontContext: { Provider: 'Provider' }, useNativeLyricsFonts: () => undefined },
  './reference-scroll': { initialScrollCommand: { serial: 0, offset: 0, delta: 0, index: 0, firstVisible: 0, interval: 800,
    instant: true, interlude: false, snap: false }, ReferenceScrollContext: { Provider: 'Provider' }, ReferenceScrollView: 'ReferenceScrollView' },
  './amll-layout-cell': { AmllLayoutCell: 'AmllLayoutCell' },
  '../use-playback-timeline-clock': {},
  './native-cue-timeline': { buildNativeCueTimeline: () => ({ cues: [0], windows: [{ visualActiveLineStartIndex: 0, visualActiveLineEndIndex: 0 }] }) },
  './native-renderer-ready-refresh': moduleObject.exports,
  'react/jsx-runtime': { jsx, jsxs: jsx },
};
const viewModule = { exports: {} };
vm.runInNewContext(viewCode, { __DEV__: true, module: viewModule, exports: viewModule.exports,
  require: name => { assert(name in modules, `native view mock missing ${name}`); return modules[name]; } });
const NativeLyricsView = viewModule.exports.NativeLyricsView;
const lyrics = [{ lineStartTime: 0, lineEndTime: 1000, syllables: [{ text: 'x', startTime: 0, endTime: 1000 }] }];
const props = { style: 'amll', list: 'flash', reveal: 'canvas', active: true, tapToSeekEnabled: true,
  demoLyrics: undefined, autoFollowEnabled: false };
function renderView(nextProps) {
  hookCursor = 0;
  playback.lyrics = lyrics;
  const tree = NativeLyricsView(nextProps);
  return tree;
}
let viewTree = renderView(props);
const findFlash = node => !node || typeof node !== 'object' ? null : node.type === 'FlashList' ? node :
  (Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]).map(findFlash).find(Boolean);
const flash = findFlash(viewTree);
assert(flash?.props?.onContentSizeChange, 'actual native renderer exposes its existing ready callback');
flash.props.onContentSizeChange();
assert.equal(refreshes, 5, 'actual native view queues readiness before detector registration');
viewTree = renderView({ ...props, active: false });
registerNativeRendererReadyResync({ canResync: () => true, resyncPlayback: () => { refreshes++; } });
assert.equal(refreshes, 5, 'actual hook callback rejects late registration after same-generation renderer becomes inactive');
unregister = registerNativeRendererReadyResync({ canResync: () => true, resyncPlayback: () => { refreshes++; } });
viewTree = renderView({ ...props, active: true });
findFlash(viewTree).props.onContentSizeChange();
assert.equal(refreshes, 6, 'actual hook reactivation can retry once after rejected pending readiness');
unregister();

// Blur readiness track-change and virtualization regression:
const findNode = (node, type) => !node || typeof node !== 'object' ? null :
  node.type === type ? node :
  (Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]).map(c => findNode(c, type)).find(Boolean);

let measured = false;
const flashHost = {
  getLayout: () => measured ? { y: 0, height: 77, isHeightMeasured: true } : undefined,
  getFirstItemOffset: () => 0,
  onContentSizeChange: flash.props.onContentSizeChange,
};
findFlash(viewTree).props.ref.current = flashHost;

// 1. Initial mount of track-1: starts unready before measurement
let blurProvider = findNode(viewTree, 'NativeSharedBlurContext.Provider');
assert.equal(blurProvider.props.value, false, 'Initial mount starts unready before measurement');
assert.ok(!findNode(viewTree, 'NativeSharedBlur'), 'NativeSharedBlur not mounted when unready');

// 2. Virtualization keeps blur unready when unmeasured
let blurGeomProvider = findNode(viewTree, 'NativeBlurGeometryContext.Provider');
let refreshGeometry = blurGeomProvider.props.value;
refreshGeometry(); // measured is false -> hasBlurGeometry returns false
viewTree = renderView(props);
assert.equal(findNode(viewTree, 'NativeSharedBlurContext.Provider').props.value, false, 'Virtualization withholding keeps blur unready');

// 3. Measured geometry marks blur ready and mounts NativeSharedBlur
measured = true;
findFlash(viewTree).props.ref.current = flashHost;
refreshGeometry();
viewTree = renderView(props);
assert.equal(findNode(viewTree, 'NativeSharedBlurContext.Provider').props.value, true, 'Ready once geometry is measured');
assert.ok(findNode(viewTree, 'NativeSharedBlur'), 'NativeSharedBlur mounted when ready');

// 4. Track change to track-b: immediately revokes readiness and unmounts blur
playback.currentTrack = { id: 'track-b' };
viewTree = renderView(props);
assert.equal(findNode(viewTree, 'NativeSharedBlurContext.Provider').props.value, false, 'Track change immediately revokes blur readiness');
assert.ok(!findNode(viewTree, 'NativeSharedBlur'), 'Previous track blur immediately unmounted on track change');

// 5. Track-b stays unready until measured
measured = false;
blurGeomProvider = findNode(viewTree, 'NativeBlurGeometryContext.Provider');
refreshGeometry = blurGeomProvider.props.value;
findFlash(viewTree).props.ref.current = flashHost;
refreshGeometry();
viewTree = renderView(props);
assert.equal(findNode(viewTree, 'NativeSharedBlurContext.Provider').props.value, false, 'Track-b unmeasured geometry keeps blur unready');

// 6. Track-b measured geometry mounts fresh blur
measured = true;
findFlash(viewTree).props.ref.current = flashHost;
refreshGeometry();
viewTree = renderView(props);
assert.equal(findNode(viewTree, 'NativeSharedBlurContext.Provider').props.value, true, 'Track-b blur becomes ready once measured');
assert.ok(findNode(viewTree, 'NativeSharedBlur'), 'Track-b NativeSharedBlur mounted');

for (const slot of hookSlots) slot?.cleanup?.();
assert.equal(appListeners.size, 0, 'actual native view lifecycle removes its AppState observer');
console.log('Native renderer ready refresh checks passed: mount, repeated readiness, switches, stale callbacks, detector-registration race, desktop/demo exclusion, foreground cached readiness, unmount, re-entry, no sync loop, and blur track-change/virtualization readiness.');
