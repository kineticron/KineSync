/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { transformSync } = require('@babel/core');
const { buildSync } = require('esbuild');

const nativeDir = path.join(__dirname, '../components/lyrics/native');
const hookPath = path.join(nativeDir, 'use-native-lyrics-clock.ts');
const baselineHook = execFileSync('git', ['show', 'e609283a906c32572fced1a6ed6d5dd2f3aea590:ExpoLyrics/components/lyrics/native/use-native-lyrics-clock.ts'], { encoding: 'utf8' });
const build = (source, filename) => {
  const js = transformSync(source, { filename, presets: ['babel-preset-expo'] }).code;
  return buildSync({ stdin: { contents: js, resolveDir: nativeDir, loader: 'js' }, bundle: true,
    platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react-native', 'react-native-reanimated', 'react-native-worklets', 'expo-router', '@/store/playback-store'] }).outputFiles[0].text;
};
const currentCode = build(fs.readFileSync(hookPath, 'utf8'), hookPath);
const baselineCode = build(baselineHook, hookPath);
const sameDeps = (a, b) => a?.length === b?.length && a.every((value, index) => Object.is(value, b[index]));

function mount(code, instrumented, foregroundListenerFirst = false) {
  let jsNow = 1000, uiNow = 5000, inWorklet = false, appState = 'active', focused = false, cursor = 0;
  const slots = [], appListeners = new Set(), focus = { callback: null, cleanup: null };
  const playbackListeners = new Set();
  const calls = { cancel: 0, timing: [], subscribe: 0, unsubscribe: 0, appSubscribe: 0, appUnsubscribe: 0, focusSync: 0 };
  const timeline = [];
  const store = { current: { anchorPositionMs: 10000, anchorMonotonicMs: 1000, isPlaying: false } };
  const stats = { value: { captureEnabled: true, generation: 1, uiOffsetMs: 5, offsetErrorMs: 1 } };
  let generation = 1, capture = true, latestProjection;
  const pendingUi = [], diagnosticEvents = [], observers = new Set();
  const diag = instrumented ? {
    stats,
    report: (event, fields, expected) => { if (capture && (expected == null || expected === generation)) diagnosticEvents.push({ event, fields, generation }); },
    reportUi: (eventGeneration, event, uiTime, fields = {}, clock = { offsetMs: null, errorMs: null }) => {
      if (eventGeneration !== generation) return;
      if (clock.offsetMs == null) { pendingUi.push({ eventGeneration, event, uiTime, fields }); return; }
      diagnosticEvents.push({ event, fields, generation: eventGeneration, uiTime, clock });
    },
    recordProjection: projection => { latestProjection = projection; },
    getGeneration: () => generation,
    isCaptureActive: () => capture,
    registerClockObserver: callback => { observers.add(callback); callback(capture, latestProjection && { ...latestProjection, generation });
      return () => { observers.delete(callback); callback(false); }; },
  } : null;
  const equal = (a, b) => sameDeps(a, b);
  const slot = create => slots[cursor] ?? (slots[cursor] = create());
  const react = {
    createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
    useCallback(fn, deps) { const item = slot(() => ({})); if (!equal(item.deps, deps)) Object.assign(item, { fn, deps }); cursor++; return item.fn; },
    useEffect(setup, deps) { const item = slot(() => ({})); if (!equal(item.deps, deps)) Object.assign(item, { setup, deps, dirty: true }); cursor++; },
    useRef(value) { const item = slot(() => ({ current: value })); cursor++; return item; },
  };
  const shared = value => { const item = slot(() => ({ value, modify(fn) { this.value = fn(this.value); } })); cursor++; return item; };
  const reanimated = {
    useSharedValue: shared,
    useFrameCallback(fn, active = true) { const item = slot(() => ({ frame: true, active, fn: null }));
      if (item.fn !== fn) item.fn = fn; item.fn = hydrate(fn); item.active = item.active ?? false;
      item.control ??= { setActive: value => { item.active = value; } }; cursor++; return item.control; },
    cancelAnimation(value) { calls.cancel++; timeline.push(['cancel', value]); },
    Easing: { linear: 'linear' },
    withTiming(target, config) { calls.timing.push([target, config.duration, config.easing]); timeline.push(['timing', target, config.duration]); return target; },
  };
  let vmContext;
  const rnQueue = [];
  const hydrated = new WeakMap();
  function hydrate(fn) {
    if (!fn?.__initData) return fn;
    if (hydrated.has(fn)) return hydrated.get(fn);
    const worklet = vm.runInContext(fn.__initData.code, vmContext);
    const receiver = { __closure: fn.__closure.map(value => typeof value === 'function' ? hydrate(value) : value) };
    const bound = worklet.bind(receiver); receiver._recur = bound; hydrated.set(fn, bound); return bound;
  }
  const focusApi = { useFocusEffect(callback) {
    react.useEffect(() => {
      focus.callback = callback;
      if (focused) focus.cleanup = callback();
      return () => { focus.cleanup?.(); focus.cleanup = null; focus.callback = null; };
    }, [callback]);
  } };
  const appStateApi = { get currentState() { return appState; }, addEventListener(_event, callback) {
    appListeners.add(callback); calls.appSubscribe++; return { remove() { appListeners.delete(callback); calls.appUnsubscribe++; } };
  } };
  const playbackApi = { getState: () => store.current, subscribe(callback) { playbackListeners.add(callback); calls.subscribe++;
    return () => { playbackListeners.delete(callback); calls.unsubscribe++; }; } };
  const hookModule = { exports: {} };
  vmContext = vm.createContext({ module: hookModule, exports: hookModule.exports, performance: { now: () => inWorklet ? uiNow : jsNow }, __DEV__: true,
    scheduleOnRN: (fn, ...args) => rnQueue.push([fn, args]), setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === 'expo-router') return focusApi;
      if (name === 'react-native') return { AppState: appStateApi };
      if (name === 'react-native-worklets') return { scheduleOnRN: (fn, ...args) => rnQueue.push([fn, args]) };
      if (name === 'react-native-reanimated') return reanimated;
      if (name === '@/store/playback-store') return { usePlaybackStore: playbackApi };
      throw Error(`Unexpected dependency ${name}`);
    } });
  vmContext.global = vmContext;
  vm.runInContext(code, vmContext);
  const hook = hookModule.exports.useNativeLyricsClock;
  let result;
  const props = { active: true, duration: 60000, preview: null, demo: false, diagnostics: diag };
  function flushEffects() {
    for (const item of slots) if (item.dirty && item.setup) { item.cleanup?.(); item.cleanup = item.setup(); item.dirty = false; }
  }
  function render() { cursor = 0; result = hook(props); flushEffects(); }
  function setCapture(value, nextGeneration = generation + 1) {
    capture = value; generation = nextGeneration; stats.value = { ...stats.value, captureEnabled: value, generation, uiOffsetMs: null };
    if (!value) latestProjection = undefined;
    else if (latestProjection) latestProjection = { ...latestProjection, generation };
    for (const observer of observers) observer(value, value ? latestProjection : undefined);
  }
  function emitAppState(next, providerFirst) {
    appState = next;
    const provider = state => { if (state === 'background') setCapture(false, generation); else if (state === 'active') setCapture(true, generation + 1); };
    const callbacks = [...appListeners];
    if (providerFirst) provider(next);
    for (const callback of callbacks) callback(next);
    if (!providerFirst) provider(next);
  }
  function updateStore(next) { const previous = store.current; store.current = next; for (const callback of playbackListeners) callback(next, previous); }
  function flushRn() { while (rnQueue.length) { const [fn, args] = rnQueue.shift(); fn(...args); } }
  render();
  // Initial focus is intentionally delayed until after render, as in a cold mount.
  jsNow += 350; uiNow += 350; focused = true; focus.cleanup = focus.callback(); calls.focusSync++;
  const snapshot = () => ({ position: result.position.value, seekVersion: result.seekVersion.value,
    cancel: calls.cancel, timing: calls.timing.map(value => [...value]), subscribe: calls.subscribe,
    unsubscribe: calls.unsubscribe, appSubscribe: calls.appSubscribe, appUnsubscribe: calls.appUnsubscribe,
    focusSync: calls.focusSync, focusCallback: focus.callback });
  return { render, result: () => result, snapshot, calls, timeline, appListeners, playbackListeners, updateStore, emitAppState,
    setCapture, diag, diagnosticEvents, pendingUi, stats, rnQueue, flushRn, get generation() { return generation; },
    setClock(js, ui) { jsNow = js; uiNow = ui; }, get clock() { return { jsNow, uiNow }; },
    tickFrame() { inWorklet = true; try { for (const item of slots) if (item.frame && item.active) item.fn({ timestamp: uiNow, timeSincePreviousFrame: 16.7 }); }
      finally { inWorklet = false; } flushRn(); },
    blur() { focused = false; focus.cleanup?.(); focus.cleanup = null; },
    refocus() { focused = true; focus.cleanup = focus.callback(); calls.focusSync++; },
    dispose() { for (const item of slots) item.cleanup?.(); },
  };
}

// Hydrate actual Babel-serialized worklets instead of calling their JS closure form.
for (const [code, label] of [[currentCode, 'instrumented'], [baselineCode, 'baseline']]) {
  const h = mount(code, label === 'instrumented');
  const a = h.snapshot();
  assert.equal(a.position, 10000, `${label}: focus uses the fresh paused anchor after delayed initialization`);
  if (label === 'instrumented') {
    const before = h.snapshot();
    h.setCapture(false, 2); h.render(); h.setCapture(true, 3); h.render();
    assert.equal(h.calls.cancel, before.cancel, 'Capture lifecycle cannot cancel playback animation');
    assert.deepEqual(h.calls.timing, before.timing, 'Capture lifecycle cannot start or alter playback animation');
    assert.equal(h.calls.subscribe, before.subscribe, 'Capture lifecycle cannot resubscribe playback');
    assert.equal(h.calls.appSubscribe, before.appSubscribe, 'Capture lifecycle cannot resubscribe AppState');
    assert.equal(h.snapshot().focusCallback, before.focusCallback, 'Stable diagnostics facade preserves focus callback identity');
  }
  h.updateStore({ anchorPositionMs: 11000, anchorMonotonicMs: 1400, isPlaying: true });
  assert.equal(h.result().position.value, 60000, `${label}: playing anchor follows baseline animation target`);
  const timingAfterPlay = h.calls.timing.at(-1);
  assert.deepEqual(timingAfterPlay, [60000, 49000, 'linear']);
  h.setClock(1600, 5600);
  h.updateStore({ anchorPositionMs: 12500, anchorMonotonicMs: 1600, isPlaying: false });
  assert.equal(h.result().position.value, 12500, `${label}: pause projection is exact`);
  h.updateStore({ anchorPositionMs: 9000, anchorMonotonicMs: 1600, isPlaying: false });
  assert.equal(h.result().position.value, 9000, `${label}: seek projection is exact`);
  const beforeBlur = h.snapshot(); h.blur(); h.refocus();
  assert.equal(h.calls.subscribe, beforeBlur.subscribe + 1, `${label}: focus return has only the normal playback subscription`);
  assert.equal(h.result().position.value, 9000);
  h.dispose();
}

// Compare production clock side effects and positions across diagnostics lifecycle.
const base = mount(baselineCode, false), instrumented = mount(currentCode, true);
function productionSnapshot(h) {
  const s = h.snapshot(); delete s.focusCallback; return s;
}
const compare = label => assert.deepEqual(productionSnapshot(instrumented), productionSnapshot(base), `${label}: playback side effects match baseline`);
compare('delayed mount');
for (const providerFirst of [true, false]) {
  const h = mount(currentCode, true, providerFirst);
  const oldGeneration = h.generation;
  h.updateStore({ anchorPositionMs: 10000, anchorMonotonicMs: 1350, isPlaying: true });
  h.emitAppState('background', providerFirst);
  h.setClock(2000, 2005);
  h.emitAppState('active', providerFirst);
  h.tickFrame();
  assert.equal(h.pendingUi.length, 1, 'The first frame can precede asynchronous clock calibration');
  const pending = h.pendingUi.shift();
  h.stats.value = { ...h.stats.value, uiOffsetMs: 5, offsetErrorMs: 1 };
  const pendingProjectionJs = pending.fields.projectionJsTimeMs;
  const uiAsJs = pending.uiTime - 5;
  pending.fields.projectionToFrameMs = Number(Math.max(0, uiAsJs - pendingProjectionJs).toFixed(2));
  pending.fields.expectedPositionMs = Math.round(pending.fields.projectedPositionMs + Math.max(0, uiAsJs - pendingProjectionJs));
  h.diagnosticEvents.push({ event: pending.event, fields: pending.fields, generation: pending.eventGeneration });
  assert.ok(h.diagnosticEvents.some(event => event.event === 'clock_ui_first_frame' && event.generation === oldGeneration + 1),
    `Foreground projection is measured when the playback listener is ${providerFirst ? 'after' : 'before'} capture listener`);
  const event = h.diagnosticEvents.find(item => item.event === 'clock_ui_first_frame');
  assert.equal(event.fields.projectedPositionMs, 10650);
  assert.equal(event.fields.isPlaying, true);
  assert.equal(event.fields.expectedPositionMs, 10650, 'Late calibration uses the JS projection timestamp and preserves playing advancement');
  const previousCancel = h.calls.cancel, previousSubscribe = h.calls.subscribe;
  h.setCapture(false, h.generation); h.tickFrame();
  assert.equal(h.calls.cancel, previousCancel, 'Expiry deactivates observation without touching playback animation');
  assert.equal(h.calls.subscribe, previousSubscribe, 'Expiry does not change playback subscription');
  h.setCapture(true, h.generation + 1); h.tickFrame();
  h.diagnosticEvents.length = 0;
  h.diag?.reportUi?.(oldGeneration, 'stale_ui', 10, {}, { offsetMs: 0, errorMs: 0 });
  assert.equal(h.diagnosticEvents.length, 0, 'Queued UI events from the previous run are discarded');
  assert.ok(h.generation > oldGeneration);
  h.dispose();
}

// A serialized UI worklet must retain imported helper code, guard generations,
// and recompute moving playback projection after calibration arrives late.
const diagnosticsPath = path.join(nativeDir, 'native-render-diagnostics.tsx');
const diagnosticsJs = transformSync(fs.readFileSync(diagnosticsPath, 'utf8'), { filename: diagnosticsPath, presets: ['babel-preset-expo'] }).code;
const helperCode = buildSync({ stdin: { contents: diagnosticsJs, resolveDir: nativeDir, loader: 'js' }, bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native', 'react-native-reanimated', 'react-native-worklets'] }).outputFiles[0].text;
const helperModule = { exports: {} };
const helperContext = vm.createContext({ module: helperModule, exports: helperModule.exports, __DEV__: true, performance: { now: () => 100 },
  setTimeout() {}, clearTimeout() {}, console, require(name) {
    if (name === 'react') return { createContext: value => ({ Provider: 'Provider', value }), useContext: () => null };
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === 'react-native') return { AppState: { addEventListener: () => ({ remove() {} }) } };
    if (name === 'react-native-reanimated') return { useSharedValue: value => ({ value }) };
    if (name === 'react-native-worklets') return { scheduleOnRN() {}, scheduleOnUI() {} };
    throw Error(`Unexpected helper dependency ${name}`);
  } });
helperContext.global = helperContext; vm.runInContext(helperCode, helperContext);
const diagnosticHelpers = helperModule.exports;

// Exercise the actual provider under a small React hook/effect scheduler. StrictMode
// replays every passive effect's cleanup/setup without remounting hook state.
function strictReplayProvider(enabled, dev = true) {
  let cursor = 0, now = 1000, tree;
  const hooks = [], effects = [], uiQueue = [];
  const provider = {};
  const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    createContext: () => ({ Provider: provider }), useContext: () => null,
    useRef(value) { const i = cursor++; return hooks[i] ?? (hooks[i] = { current: value }); },
    useState(value) { const i = cursor++; hooks[i] ??= { state: typeof value === 'function' ? value() : value };
      return [hooks[i].state, next => { hooks[i].state = typeof next === 'function' ? next(hooks[i].state) : next; }]; },
    useCallback(fn, deps) { const i = cursor++; const old = hooks[i]; if (!old || !same(old.deps, deps)) hooks[i] = { fn, deps };
      return hooks[i].fn; },
    useMemo(fn, deps) { const i = cursor++; const old = hooks[i]; if (!old || !same(old.deps, deps)) hooks[i] = { value: fn(), deps };
      return hooks[i].value; },
    useEffect(fn, deps) { const i = cursor++; const old = effects[i];
      if (!old || !same(old.deps, deps)) effects[i] = { setup: fn, deps, cleanup: null }; },
  };
  const reactModule = { ...react, default: react };
  let moduleContext;
  const context = vm.createContext({ module: (moduleContext = { exports: {} }), exports: moduleContext.exports,
    __DEV__: dev, performance: { now: () => now }, console: { info() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require(name) {
      if (name === 'react') return reactModule;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === 'react-native') return { AppState: { addEventListener: () => ({ remove() {} }) } };
      if (name === 'react-native-reanimated') return { useSharedValue: value => { const i = cursor++; return hooks[i] ?? (hooks[i] = { value }); } };
      if (name === 'react-native-worklets') return { scheduleOnRN() {}, scheduleOnUI: (fn, ...args) => uiQueue.push([fn, args]) };
      throw Error(`Unexpected provider dependency ${name}`);
    } });
  context.global = context;
  vm.runInContext(helperCode, context);
  const component = moduleContext.exports.NativeRenderDiagnosticsProvider;
  function render() { cursor = 0; tree = component({ enabled, renderer: 'test:list:word', runId: 1, reason: 'mount', children: 'child' }); }
  const findSession = () => hooks.find(slot => slot?.current && typeof slot.current.enabled === 'boolean' &&
    typeof slot.current.generation === 'number' && typeof slot.current.startedAtJsMs === 'number');
  function setupEffects(force = false) {
    for (const effect of effects.filter(Boolean)) {
      if (force || effect.cleanup === null) effect.cleanup = effect.setup();
    }
  }
  render(); setupEffects();
  const beforeGeneration = findSession().current.generation;
  for (const effect of effects.filter(Boolean)) { effect.cleanup?.(); effect.cleanup = null; }
  setupEffects(true);
  const sessionRef = findSession();
  assert.ok(sessionRef, 'Actual provider session ref was initialized');
  return { active: sessionRef.current.enabled, generation: sessionRef.current.generation, beforeGeneration,
    scheduledUi: uiQueue.length, contextValue: tree.props.value };
}
const inactiveReplay = strictReplayProvider(false, true);
assert.equal(inactiveReplay.active, false, 'Disabled outgoing/inactive provider stays capture-disabled after StrictMode effect replay');
const nonDevReplay = strictReplayProvider(true, false);
assert.equal(nonDevReplay.active, false, 'Non-DEV provider never becomes capture-enabled after effect replay');
const activeReplay = strictReplayProvider(true, true);
assert.equal(activeReplay.active, true, 'Enabled DEV provider reactivates after StrictMode effect replay');
assert.ok(activeReplay.generation > activeReplay.beforeGeneration, 'Reactivation receives a fresh diagnostic generation');

const uiContext = vm.createContext({ __DEV__: true, Math, Number, JSON, Object, console,
  performance: { now: () => 800 }, scheduleOnRN: (fn, ...args) => fn(...args) });
const serialize = fn => {
  assert.ok(fn.__initData?.code, `${fn.name} is Babel serialized as a worklet`);
  const hydrated = vm.runInContext(fn.__initData.code, uiContext);
  const receiver = { __closure: (fn.__closure ?? []).map(value => typeof value === 'function' ? serialize(value) : value) };
  const bound = hydrated.bind(receiver); receiver._recur = bound; return bound;
};
const initialStats = { uiOffsetMs: null, offsetErrorMs: null, lastSampleUiMs: 0, rowCallbacks: 0, leadVoiceCallbacks: 0,
  backgroundVoiceCallbacks: 0, pictureRebuilds: 0, maxCallbackMs: 0, currentFrameToken: -1, currentFrameWorkMs: 0,
  maxFrameWorkMs: 0, maxFrameGapMs: 0, idleCallbacks: 0, cachedCallbacks: 0, cachedActivations: 0,
  firstGlyphPicture: false, captureEnabled: true, generation: 4, captureStartedJsMs: 1000 };
const reset = serialize(diagnosticHelpers.clearFrameStats);
const resetStats = reset({ ...initialStats, rowCallbacks: 12, uiOffsetMs: 7 }, true, 5, 1100);
assert.equal(resetStats.generation, 5); assert.equal(resetStats.rowCallbacks, 0); assert.equal(resetStats.captureStartedJsMs, 1100);
assert.equal(reset({ ...resetStats, rowCallbacks: 8 }, true, 4, 900).rowCallbacks, 8, 'Older reset cannot overwrite a newer run');
const calibration = serialize(diagnosticHelpers.applyUiClockCalibration);
assert.equal(calibration(resetStats, 4, 7, 1).uiOffsetMs, null, 'Old calibration write is rejected');
assert.equal(calibration(resetStats, 5, 7, 1).uiOffsetMs, 7, 'Current calibration is applied');
const projection = serialize(diagnosticHelpers.projectUiFrameFromJsProjection);
const late = projection(1500, 10000, true, 2035, 5);
assert.deepEqual({ ...late }, { projectionToFrameMs: 530, expectedPositionMs: 10530 },
  'Late calibration recomputes both elapsed projection and expected playing position');

console.log('Native diagnostics harness passed: real clock hook baseline parity, delayed mount, focus/playback/pause/seek, foreground listener order, inactive/reactivation, stale generations, and Babel-hydrated reset/calibration/projection worklets.');
