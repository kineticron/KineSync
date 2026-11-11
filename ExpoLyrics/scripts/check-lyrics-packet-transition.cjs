/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

// Run the production host with deterministic hooks and UI animation completions.
const code = buildSync({ entryPoints: [path.resolve(__dirname, '../components/lyrics/lyrics-packet-transition.tsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, tsconfigRaw: { compilerOptions: { jsx: 'react' } },
  external: ['react', 'react-native', 'react-native-reanimated', 'react-native-worklets', 'zustand/react/shallow', '@/store/playback-store'],
}).outputFiles[0].text;
function harness(reduced = false, active = true, options = {}) {
  let packet = { lyrics: [], lyricsSource: '', lyricsMetadata: {}, lyricsStatusMessage: '', currentTrack: { id: 'song' } };
  let cursor = 0, dirty = false, output;
  const hooks = [], effects = new Map(), timers = new Map(), deadlines = new Map();
  let timerId = 0;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const memo = (fn, deps) => {
    const index = cursor++;
    if (!hooks[index] || !equal(hooks[index].deps, deps)) hooks[index] = { value: fn(), deps };
    return hooks[index].value;
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, key: props?.key, props: { ...props, children: children.length === 1 ? children[0] : children } }),
    createContext: () => ({ Provider: 'provider' }), memo: fn => fn, useContext: () => null,
    useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
    useState: initial => {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, next => {
        const value = typeof next === 'function' ? next(hooks[index].value) : next;
        if (value !== hooks[index].value) { hooks[index].value = value; dirty = true; }
      }];
    },
    useEffect: (fn, deps) => {
      const index = cursor++;
      if (!hooks[index] || !equal(hooks[index].deps, deps)) {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps };
        effects.set(index, fn);
      }
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => ({
    react, 'react-native': { View: 'view', StyleSheet: { create: v => v } },
    'react-native-reanimated': { default: { View: 'animated' }, Easing: { bezier: () => 'ease' }, useReducedMotion: () => reduced,
      useSharedValue: initial => memo(() => ({ value: initial, get() { return this.value; }, set(next) {
        if (next && typeof next === 'object') {
          this.value = next.target;
          timers.set(this, { fn: () => { timers.delete(this); next.complete(true); }, ms: next.options.duration,
            cancel: () => next.complete(false) });
        } else this.value = next;
      } }), []),
      useAnimatedStyle: fn => ({ get opacity() { return fn().opacity; } }),
      withTiming: (target, options, complete) => ({ target, options, complete }),
      cancelAnimation: value => { const animation = timers.get(value); timers.delete(value); animation?.cancel(); },
    },
    'react-native-worklets': { scheduleOnRN: (fn, ...args) => fn(...args) },
    'zustand/react/shallow': { useShallow: fn => fn }, '@/store/playback-store': { usePlaybackStore: () => packet },
  })[name], setTimeout: (fn, ms) => { deadlines.set(++timerId, {fn, ms}); return timerId; }, clearTimeout: id => deadlines.delete(id) });
  const Wrapped = module.exports.withLyricsPacketTransition('renderer', options);
  const Live = Wrapped({}).type;
  const render = () => {
    if (options.store) {
      const state = options.store.getState();
      const next = Object.fromEntries(['lyrics','lyricsSource','lyricsMetadata','lyricsStatusMessage','currentTrack'].map(key=>[key,state[key]]));
      if (Object.keys(next).some(key=>next[key]!==packet[key])) packet=next;
    }
    let count = 0;
    do {
      assert.ok(count++ < 10, 'render must settle');
      dirty = false; cursor = 0; output = Live({ active, onActiveLineChange() {} });
    } while (dirty);
    for (const [index, fn] of effects) hooks[index].cleanup = fn();
    effects.clear();
    return output.props.children.filter(Boolean);
  };
  return { render, deadlines,
    expireReady: () => { for (const [id, task] of [...deadlines]) { deadlines.delete(id); task.fn(); } return render(); },
    unmount: () => { for (const hook of hooks) hook?.cleanup?.(); },
    set: patch => { packet = { ...packet, ...patch }; return render(); }, timers,
    activate: value => { active = value; return render(); },
    finish: () => { for (const { fn } of [...timers.values()]) fn(); return render(); },
    demo: lyrics => Wrapped({ demoLyrics: lyrics }) };
}
const opacity = layer => layer.props.style.at(-1).opacity;
const context = layer => layer.props.children.props.value;
if (require.main === module) {
const missingReady = harness(); missingReady.render();
let waiting = missingReady.set({lyrics:[{lineStartTime:0}],lyricsSource:'missingReady'});
assert.equal(missingReady.deadlines.size, 1, 'an unready replacement has a bounded handoff');
assert.equal([...missingReady.deadlines.values()][0].ms, 5000);
const expired = [...missingReady.deadlines.values()][0].fn;
waiting = missingReady.expireReady();
assert.equal(missingReady.timers.size, 1, 'deadline releases the ready barrier through the existing UI fade');
waiting = missingReady.finish(); assert.equal(waiting.length, 1);
missingReady.set({lyrics:[{lineStartTime:1}],lyricsSource:'next'});
expired();
assert.deepEqual(missingReady.render().map(opacity), [1,0], 'old deadlines cannot ready a new generation');
missingReady.unmount(); assert.equal(missingReady.deadlines.size, 0, 'unmount disposes ready deadline');

const h = harness();
let layers = h.render();
assert.equal(layers.length, 1);
const firstKey = layers[0].key;
const staleReady = context(layers[0]).onReady;
layers = h.set({ lyricsMetadata: { instrumental: true }, lyricsStatusMessage: 'loading' });
assert.equal(layers[0].key, firstKey, 'metadata/status alone must not remount the renderer');
const a = [{ lineStartTime: 0 }], b = [{ lineStartTime: 1000 }], c = [{ lineStartTime: 2000 }];
layers = h.set({ lyrics: a, lyricsSource: 'provider-a' });
assert.equal(layers.length, 2);
assert.equal(layers[0].key, firstKey, 'outgoing renderer retains its mounted identity');
assert.equal(context(layers[0]).packet.lyricsMetadata.instrumental, true);
assert.deepEqual(layers.map(opacity), [1, 0], 'old content stays visible until replacement is ready');
assert.equal(layers[0].props.pointerEvents, 'none');
assert.equal(layers[0].props.children.props.children.props.active, false);
assert.equal(layers[0].props.children.props.children.props.onActiveLineChange, undefined);
assert.equal(layers[1].props.accessibilityElementsHidden, true);
staleReady();
assert.deepEqual(h.render().map(opacity), [1, 0], 'late readiness from an old generation is ignored');
context(layers[1]).onReady();
layers = h.render();
assert.deepEqual(layers.map(opacity), [0, 1]);
assert.equal([...h.timers.values()][0].ms, 240);
const progress = h.timers.keys().next().value;
progress.value = 0.25;
assert.deepEqual(layers.map(opacity), [0.75, 0.25], 'Both layers use the same continuous UI progress');
assert.equal(h.render().length, 2, 'React activity cannot retire a partially completed UI fade');
progress.value = 1;
layers = h.set({ lyrics: b, lyricsSource: 'provider-b' });
layers = h.set({ lyrics: c, lyricsSource: 'provider-c' });
assert.equal(context(layers[1]).packet.lyrics, a, 'packet bursts cannot replace content halfway through its fade');
layers = h.finish();
assert.equal(layers.length, 2);
assert.equal(context(layers[0]).packet.lyrics, a);
assert.equal(context(layers[1]).packet.lyrics, c, 'after the fade only the newest queued packet is displayed');
context(layers[1]).onReady(); h.render();
layers = h.finish();
assert.equal(layers.length, 1, 'old renderer is released after the fade');
layers = h.set({ lyrics: b });
assert.equal(layers.length, 2, 'replacement packets from the same provider also crossfade');
const replacementKey = layers[1].key;
layers = h.set({ lyricsMetadata: { instrumental: false } });
assert.equal(layers[1].key, replacementKey, 'metadata during a fade must retain the incoming renderer');
context(layers[1]).onReady(); h.render(); h.finish();
layers = h.set({ currentTrack: { id: 'next-song' }, lyrics: [], lyricsSource: '' });
assert.equal(layers.length, 2, 'track clearing fades out the old song');
assert.equal(h.demo(a).type, 'renderer', 'onboarding previews keep their existing lifecycle');

// Missing readiness must preserve the visible content and allow newer packets.
const stalled = harness();
stalled.render();
layers = stalled.set({ lyrics: a });
assert.equal(layers.length, 2);
assert.deepEqual(layers.map(opacity), [1, 0], 'replacement waiting for readiness');
assert.equal(stalled.timers.size, 0, 'An unready renderer waits for readiness or its explicit deadline');
const stalledReady = context(layers[1]).onReady;
const visibleKey = layers[0].key;
layers = stalled.set({ lyrics: b });
assert.equal(layers.length, 2, 'Replacing stalled content keeps at most two renderers');
assert.equal(layers[0].key, visibleKey, 'The displayed renderer stays mounted');
assert.equal(context(layers[1]).packet.lyrics, b, 'A newer packet supersedes a stalled incoming renderer');
stalledReady();
assert.deepEqual(stalled.render().map(opacity), [1, 0], 'Discarded renderer readiness cannot reveal the replacement');
context(layers[1]).onReady(); stalled.render();
assert.equal(stalled.finish().length, 1, 'Ready replacement releases the previous renderer');
layers = stalled.set({ lyrics: c });
stalled.activate(false);
assert.equal(stalled.finish().length, 1, 'Deactivating an already waiting screen releases its outgoing renderer');

// Inactive screen: finishes immediately without waiting for onReady
const inactive = harness(false, false);
inactive.render();
layers = inactive.set({ lyrics: a });
assert.equal(layers.length, 2);
assert.equal([...inactive.timers.values()][0].ms, 0, 'Inactive screen uses 0ms transition duration');
assert.equal(inactive.finish().length, 1, 'Inactive screen releases previous renderer immediately');

const reduced = harness(true);
reduced.render();
layers = reduced.set({ lyrics: a });
context(layers[1]).onReady(); reduced.render();
assert.equal([...reduced.timers.values()][0].ms, 0);
assert.equal(reduced.finish().length, 1, 'Reduced Motion releases the old layer immediately');
console.log('Lyrics packet transition checks passed: readiness, frozen outgoing content, bursts, stale callbacks, stalled replacement, inactive cleanup, tracks, previews and Reduced Motion.');

// The opt-in used only by the native list must reach an existing renderer
// instance, otherwise row/voice memo reuse would be bypassed by the real host.
const native = harness(false, true, { reuseSameSourcePackets: true });
native.render();
const original = [{ lineStartTime: 0, lineEndTime: 1000, syllables: [{ text: 'source', startTime: 0, endTime: 900 }] }];
layers = native.set({ lyrics: original, lyricsSource: 'native-provider' });
context(layers[1]).onReady(); native.render(); layers = native.finish();
const nativeKey = layers[0].key;
for (const patch of [
  { translatedText: 'late translation' },
  { translatedText: 'updated translation' },
  { syllables: [{ text: 'corrected source', startTime: 25, endTime: 925 }] },
  { backgroundSyllables: [{ text: 'echo', startTime: 500, endTime: 1200 }] },
]) {
  const next = [{ ...context(layers[0]).packet.lyrics[0], ...patch }];
  layers = native.set({ lyrics: next });
  assert.equal(layers.length, 1, 'native incremental updates must not create an outgoing layer');
  assert.equal(layers[0].key, nativeKey, 'native source/translation updates retain mounted list and row caches');
  assert.equal(context(layers[0]).packet.lyrics, next, 'new source and translation data reach the mounted native renderer');
  assert.equal(native.timers.size, 0, 'incremental updates introduce no fade/reset');
}
layers = native.set({ lyrics: original, lyricsSource: 'replacement-provider' });
assert.equal(layers.length, 2, 'native provider replacements retain readiness transitions');
const incomingKey = layers[1].key;
const pendingTranslation = [{ ...original[0], translatedText: 'translation before ready' }];
layers = native.set({ lyrics: pendingTranslation });
assert.equal(layers[1].key, incomingKey, 'translation before readiness retains incoming generation');
assert.equal(context(layers[1]).packet.lyrics, pendingTranslation);
assert.equal(native.timers.size, 0, 'translation cannot reveal an unready incoming provider');
context(layers[1]).onReady(); native.render(); native.finish();
layers = native.set({ currentTrack: { id: 'next-native-song' }, lyrics: original });
assert.equal(layers.length, 2, 'native track changes retain normal replacement semantics');
console.log('Native packet opt-in PASS: same-source mounted identity, incremental updates, pending readiness, provider and track isolation.');

}
module.exports={harness,context,opacity};
