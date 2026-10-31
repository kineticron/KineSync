/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const baselineIndex = process.argv.indexOf('--baseline');
const baseline = baselineIndex >= 0;
const clockPath = baseline ? path.resolve(process.argv[baselineIndex + 1])
  : path.join(root, 'components/lyrics/native/use-native-lyrics-clock.ts');
const transformed = babel.transformSync(fs.readFileSync(clockPath, 'utf8'), {
  filename: clockPath, babelrc: false, configFile: false, presets: ['babel-preset-expo'],
  caller: { name: 'metro', platform: 'ios', supportsStaticESM: false }, envName: 'production',
}).code;
// Use the installed animation setter and timing implementation, not a dt-based
// stand-in. Only platform scheduling, React and native services are substituted.
const compile = relative => buildSync({ entryPoints: [path.join(root, 'node_modules/react-native-reanimated/src', relative)],
  bundle: false, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const setterCode = compile('valueSetter.ts');
const timingCode = compile('animation/timing.ts');

function mount(initial = {}, options = {}) {
  let now = 10000, uiEpoch = 900000, frameEpoch = 420000;
  let state = { anchorPositionMs: 20000, anchorMonotonicMs: now, isPlaying: true,
    currentTrack: { id: 'song-a' }, ...initial };
  let props = { active: true, duration: 180000, demo: false, ...options };
  let context, cursor = 0, result;
  const slots = [], queue = [], frames = new Map(), listeners = new Set(), appListeners = new Set();
  const animations = new Set();
  let frameId = 0;
  const nativeNow = () => now;
  const nativeFunctions = new Set([nativeNow]);
  const hydrated = new WeakMap();
  const onUI = fn => {
    if (nativeFunctions.has(fn)) return fn; // JSI HostFunction transport.
    if (!fn.__initData) return { remote: fn }; // Ordinary RN callbacks are NOT callable on UI.
    if (hydrated.has(fn)) return hydrated.get(fn);
    const array = Array.isArray(fn.__closure);
    const closure = array ? [] : {};
    for (const [key, value] of Object.entries(fn.__closure ?? {})) {
      closure[key] = typeof value === 'function' ? onUI(value) : value;
    }
    const receiver = { __closure: closure };
    const bound = vm.runInContext(`(${fn.__initData.code})`, context).bind(receiver);
    receiver._recur = bound;
    hydrated.set(fn, bound);
    return bound;
  };
  const slot = create => slots[cursor++] ?? (slots[cursor - 1] = create());
  const same = (a, b) => a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]));
  const effect = (setup, deps) => {
    const item = slot(() => ({}));
    if (!same(item.deps, deps)) Object.assign(item, { setup, deps, dirty: true });
  };
  const react = {
    useRef: value => slot(() => ({ current: value })),
    useCallback: (fn, deps) => { const item = slot(() => ({}));
      if (!same(item.deps, deps)) Object.assign(item, { fn, deps }); return item.fn; },
    useEffect: effect,
  };
  const moduleFor = (code, require) => {
    const module = { exports: {} };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context)(require, module, module.exports);
    return module.exports;
  };
  const defineAnimation = (_initial, factory) => factory.__initData ? onUI(factory)() : factory();
  nativeFunctions.add(defineAnimation);
  const util = { defineAnimation, Easing: { inOut: fn => fn, quad: x => x * x },
    getReduceMotionForAnimation: () => false, assertEasingIsWorklet() {} };
  context = vm.createContext({ performance: { now: () => now + uiEpoch }, __DEV__: false,
    requestAnimationFrame: fn => { const id = ++frameId; frames.set(id, fn); return id; },
  });
  context.global = context;
  context._getAnimationTimestamp = () => now + frameEpoch;
  const { valueSetter } = moduleFor(setterCode, () => { throw Error('Unexpected setter dependency'); });
  const { withTiming } = moduleFor(timingCode, () => util);
  const shared = initialValue => {
    const mutable = { _value: initialValue, _animation: null };
    Object.defineProperty(mutable, 'value', { get: () => mutable._value,
      set: value => {
        queue.push(() => {
          if (value && typeof value === 'object' && value.onFrame) {
            value.onFrame = value.onFrame.__initData ? onUI(value.onFrame) : value.onFrame;
            value.onStart = value.onStart.__initData ? onUI(value.onStart) : value.onStart;
            animations.add(mutable);
          }
          valueSetter(mutable, value);
        });
      } });
    return mutable;
  };
  const appState = { currentState: 'active', addEventListener: (_, cb) => {
    appListeners.add(cb); return { remove: () => appListeners.delete(cb) };
  } };
  const mocks = {
    react, 'react-native': { AppState: appState },
    'expo-router': { useFocusEffect: fn => effect(fn, [fn]) },
    'react-native-reanimated': { useSharedValue: value => slot(() => shared(value)),
      cancelAnimation: value => queue.push(() => valueSetter(value, value._value)),
      Easing: { linear: x => x }, withTiming, defineAnimation,
    },
    '@/store/playback-store': { usePlaybackStore: { getState: () => state,
      subscribe: cb => { listeners.add(cb); return () => listeners.delete(cb); } } },
  };
  const module = { exports: {} };
  // RN performance.now is a native HostFunction in this version. The UI global
  // deliberately has a completely different epoch, as it does on Apple devices.
  vm.runInContext(`(function(require,module,exports,performance){${transformed}\n})`, context)(
    name => { assert(name in mocks, `Missing native clock mock: ${name}`); return mocks[name]; },
    module, module.exports, { now: nativeNow });
  function render(patch = {}) {
    props = { ...props, ...patch }; cursor = 0;
    result = module.exports.useNativeLyricsClock(props);
    for (const item of slots) if (item.dirty) {
      item.cleanup?.(); item.cleanup = item.setup(); item.dirty = false;
    }
  }
  render();
  return {
    get result() { return result; }, get now() { return now; }, get state() { return state; },
    get subscriptions() { return listeners.size + appListeners.size; },
    get animating() { return [...animations].some(value => value._animation && !value._animation.finished && !value._animation.cancelled); },
    flush() { while (queue.length) queue.shift()(); },
    advance(ms) { now += ms; },
    frame(ms = 0) {
      now += ms;
      const pending = [...frames.values()]; frames.clear();
      for (const fn of pending) fn(now + frameEpoch);
    },
    epochs(ui, frame) { uiEpoch = ui; frameEpoch = frame; },
    update(patch) { const previous = state; state = { ...state, ...patch };
      listeners.forEach(cb => cb(state, previous)); },
    foreground(value) { appState.currentState = value; appListeners.forEach(cb => cb(value)); },
    render,
    stop() { for (const item of slots) item.cleanup?.(); },
  };
}

const rows = [];
for (const delay of [1000, 2000, 3000]) {
  for (const fps of [60, 30, 15]) {
    const clock = mount();
    clock.advance(delay); // Block the JS turn BEFORE its queued UI writes/start.
    clock.flush();
    const firstDrift = clock.result.position.value - (20000 + delay);
    for (let i = 0; i < fps * 4; i++) clock.frame(1000 / fps);
    const drift = clock.result.position.value - (20000 + clock.now - 10000);
    assert.ok(Math.abs(drift - (baseline ? -delay : 0)) < 0.00001, 'Start delay must not become permanent playback drift');
    rows.push({ blockedMountMs: delay, fps, firstDriftMs: Math.round(firstDrift), after4sDriftMs: Math.round(drift) });
    clock.stop(); clock.flush();
  }
}
console.log(JSON.stringify({ implementation: baseline ? 'old' : 'fixed', delayedStart: rows }));

// Missing frames AFTER animation start are a separate case. The old timing
// implementation already catches up; a capped-dt replacement would regress it.
const longFrame = mount(); longFrame.flush();
longFrame.frame(3000);
assert.equal(longFrame.result.position.value, 23000, 'A 3s missing-frame gap loses no media time');
for (let i = 0; i < 900; i++) longFrame.frame(1000 / 30);
assert.ok(Math.abs(longFrame.result.position.value - 53000) < 0.00001, '30fps does not accumulate drift');
longFrame.stop(); longFrame.flush();
console.log('Mid-animation 3000ms gap + 30s at 30fps: 0ms drift.');
if (baseline) process.exit(0);

const live = mount(); live.flush();
const project = () => Math.max(0, Math.min(180000, live.state.anchorPositionMs +
  (live.state.isPlaying ? live.now - live.state.anchorMonotonicMs : 0)));
const expectProjected = message => assert.ok(Math.abs(live.result.position.value - project()) < 0.00001, message);
live.advance(2000);
live.update({ anchorPositionMs: 22000, anchorMonotonicMs: live.now, isPlaying: false });
live.advance(3000); live.flush(); live.frame(1000);
assert.equal(live.result.position.value, 22000, 'Delayed pause remains frozen at its authoritative position');
assert.equal(live.animating, false, 'Paused clock has no frame loop');
live.update({ anchorPositionMs: 22000, anchorMonotonicMs: live.now, isPlaying: true });
live.advance(1500); live.flush(); expectProjected('Delayed resume includes UI handoff time');
for (const position of [90000, 4000]) {
  live.update({ anchorPositionMs: position, anchorMonotonicMs: live.now });
  live.advance(1200); live.flush(); expectProjected('Seek retains timestamp through delayed UI receipt');
}
const serial = live.result.seekVersion.value;
for (let i = 0; i < 20; i++) {
  live.frame(1000 / 30);
  live.update({ playbackPosition: project() + (i % 2 ? 60 : -60) }); // Preserved store anchors/deadband.
  live.flush(); expectProjected('Deadband/diagnostic updates never restart or jitter playback');
}
assert.equal(live.result.seekVersion.value, serial, 'Jitter cannot manufacture seeks');
live.update({ currentTrack: { id: 'song-b' } }); live.flush();
assert.equal(live.result.seekVersion.value, serial + 1, 'Equal-position song switches reset presentation');
// Multiple queued syncs including song/pause changes must settle to the newest
// anchor. Transport-level obsolete async HTTP responses are tested separately.
live.update({ currentTrack: { id: 'song-c' }, anchorPositionMs: 1000, anchorMonotonicMs: live.now });
live.update({ anchorPositionMs: 7000, anchorMonotonicMs: live.now, isPlaying: false });
live.advance(3000); live.flush(); live.frame(1000);
assert.equal(live.result.position.value, 7000, 'Older queued starts cannot overwrite a newer pause/song anchor');
live.update({ isPlaying: true, anchorMonotonicMs: live.now }); live.flush();
live.foreground('background'); live.flush();
assert.equal(live.result.running.value, false); assert.equal(live.animating, false);
// Across simulated device sleep the UI steady-clock epoch changes. RN uptime
// and the store remain paired; frame timestamps must not enter the projection.
live.epochs(99000000, -550000);
live.advance(2000); live.foreground('active'); live.advance(1000); live.flush();
expectProjected('Foreground uses the same RN uptime domain after UI epoch changes');
live.frame(3000); expectProjected('UI performance/frame epoch changes cannot alter media time');
live.render({ preview: 12345 }); live.advance(2000); live.flush(); live.frame(1000);
assert.equal(live.result.position.value, 12345, 'Scrub preview freezes');
live.render({ preview: null }); live.flush(); expectProjected('Leaving preview restores authoritative playback');
live.render({ active: false }); live.flush(); assert.equal(live.animating, false);
live.advance(2000); live.render({ active: true }); live.flush(); expectProjected('Reactivation projects the live anchor');
live.update({ anchorPositionMs: 179000, anchorMonotonicMs: live.now });
live.advance(3000); live.flush(); assert.equal(live.result.position.value, 180000);
assert.equal(live.animating, false, 'Ended clock has no idle frame loop');
live.stop(); live.flush(); assert.equal(live.subscriptions, 0); assert.equal(live.animating, false);
const demo = mount({}, { demo: true }); demo.advance(2000); demo.flush();
assert.equal(demo.result.position.value, 2000, 'Unanchored demo starts at its JS timestamp');
demo.stop(); demo.flush();
console.log('Native clock checks passed: separate epochs, delayed pause/resume/seek, deadband stability, song identity, queued replacements, foreground, preview, inactive/end/unmount and demo.');
