/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const dir = path.resolve(__dirname, '../components/lyrics/native');
const mutable = value => ({ value, modify(fn) { this.value = fn(this.value); } });
function load(file, mocks = {}, bundle = true, dev = true) {
  const code = buildSync({ entryPoints: [path.resolve(dir, file)], bundle, platform: 'node', format: 'cjs', write: false,
    external: bundle ? ['react-native', 'expo-blur', '@react-native-masked-view/masked-view', 'expo-linear-gradient', 'react', 'react-native-reanimated', '@shopify/react-native-skia', 'react-native-worklets', '@react-native-async-storage/async-storage', '@/lib/relaxed-rendering'] : undefined }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, __DEV__: dev, require: name => {
    if (name in mocks) return mocks[name];
    if (name === 'react/jsx-runtime') return { jsx: (_type, props) => props, jsxs: (_type, props) => props };
    if (name === 'react') return { memo: fn => fn };
    if (name === 'react-native-reanimated') return { makeMutable: mutable };
    if (name === '@shopify/react-native-skia') return { Skia: { Color: () => new Float32Array([1, 1, 1, 1]) } };
    throw Error(`Unmocked boundary ${name}`);
  } });
  return module.exports;
}
const graph = load('relaxed-glyph-graph.tsx');
const epsilon = load('relaxed-epsilon.ts');
const blur = load('relaxed-blur-envelope.ts');
assert.equal(epsilon.changedScalar(0, 0.0009, true), false);
assert.equal(epsilon.changedScalar(0, 0.0011, true), true);
assert.equal(epsilon.changedScalar(0, 0.0001, false), true);
assert.equal(epsilon.changedScalar(0, 0.0001, true, true), true);
function words(start = 1000, width = 120) {
  const rect = { x: 0, y: 0, width, height: 32 };
  return [{ word: { text: 'hello', start, end: start + 1600, offset: 0, emphasized: true, letters: ['h', 'ello'] }, rects: [rect],
    letters: [[rect], [{ ...rect, x: width / 2, width: width / 2 }]], width, before: 0, runs: [[], []], revealRects: [rect, rect], clips: [{}, {}], pictures: [{}, {}], emojiMask: [false, false], overlapMask: [false, false] }];
}
const line = { scale: 1, velocity: 0, bright: 0.85, dark: 0.5 };
const snapshot = state => state.words.flatMap(w => [w.matrix.value, ...w.slices.flatMap(s => [s.matrix.value, s.start.value, s.end.value, s.glow.value, s.radius.value])]);
for (const spicy of [true, false]) for (const background of [true, false]) for (const width of [120, 520]) {
  const w = words(1000, width), exact = graph.createRelaxedGlyphState(w), gated = graph.createRelaxedGlyphState(w);
  const options = { spicy, background, fontSize: 32, lineEnd: 2600 };
  const update = (time, active) => {
    graph.updateRelaxedGlyphState(exact, w, time, active, 1 / 60, line, options);
    graph.updateRelaxedGlyphState(gated, w, time, active, 1 / 60, line, { ...options, epsilon: true });
  };
  update(1000, true); const first = JSON.stringify(snapshot(gated));
  for (let i = 1; i < 95; i++) update(1000 + i * 16, true);
  assert.notEqual(JSON.stringify(snapshot(gated)), first, 'reveal, emphasis and float continue animating');
  update(1300, true); // backwards seek bypasses epsilon
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot(gated))), JSON.parse(JSON.stringify(snapshot(exact))), 'seek applies immediately');
  for (let i = 0; i < 600; i++) update(1300, true); // paused spring still settles
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot(gated))), JSON.parse(JSON.stringify(snapshot(exact))), 'pause reaches exact presentation');
  for (let i = 0; i < 600; i++) update(9000, false);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot(gated))), JSON.parse(JSON.stringify(snapshot(exact))), 'release and final rest converge');
  const replacement = graph.createRelaxedGlyphState(words(20000, width * 2));
  assert.equal(replacement.time, -1, 'song/shape remount has no cached timeline');
  assert.notEqual(replacement.words[0].matrix, gated.words[0].matrix, 'orientation/song state isolated');
}
let envelope = { top: -Infinity, bottom: Infinity };
for (let frame = 0; frame < 600; frame++) {
  const target = { top: 100 + Math.sin(frame / 10) * 400, bottom: 400 + Math.sin(frame / 10) * 400 };
  envelope = blur.relaxBlurEnvelope(envelope, target, frame === 0 || frame === 180, frame % 120 === 0);
  assert(envelope.top <= target.top && envelope.bottom >= target.bottom, 'envelope contains arbitrary scroll/motion/seek');
}
assert.equal(blur.relaxBlurEnvelope(envelope, { top: -Infinity, bottom: 10 }, false, false).bottom, Infinity, 'unknown geometry opens safe zone');
const reset = blur.relaxBlurEnvelope(envelope, { top: 0, bottom: 200 }, true, false);
assert.equal(reset.top, -96); assert.equal(reset.bottom, 296);
// Actual component lifecycle: callback stops on unmount, changing shapes allocate independent buffers.
for (const gated of [false, true]) {
  let callback, enabled = false, cleanup;
  const api = load('relaxed-glyph-graph.tsx', {
    react: { memo: fn => fn, useMemo: fn => fn(), useCallback: fn => fn, useEffect: fn => { cleanup = fn(); }, createElement: (_type, props) => props },
    'react-native-reanimated': { makeMutable: mutable, useFrameCallback: fn => { callback = fn; return { setActive: value => { enabled = value; } }; } },
  });
  const output = api.RelaxedGlyphPicture({ words: words(), position: { value: 1700 }, active: { value: true }, lineMotion: { value: line }, spicy: true, background: false, fontSize: 32, lineEnd: 2600, epsilon: gated });
  assert(enabled); callback({ timeSincePreviousFrame: 16 }); assert.equal(output.state.time, 1700);
  cleanup(); assert.equal(enabled, false);
}
console.log('Relaxed rendering PASS: ON/OFF, continuous emphasis/reveal, pause convergence, seeks, song/rotation state isolation, conservative moving blur envelope, and callback cleanup. Host hooks only; no phone lifecycle claim.');

// Execute the real overlay hooks; masks must remain stable within a conservative envelope.
for (const style of ['spicy', 'amll']) for (const height of [800, 380]) for (const enabled of [false, true]) {
  const reactions = [], styles = [];
  const api = load('native-shared-blur.tsx', {
    react: { createContext: value => ({ value }) },
    'react-native': { View: 'View', StyleSheet: { absoluteFill: {} } },
    'expo-blur': { BlurView: 'BlurView' }, '@react-native-masked-view/masked-view': 'MaskedView', 'expo-linear-gradient': { LinearGradient: 'Gradient' },
    'react-native-reanimated': { default: { View: 'Animated.View' }, __esModule: true, useSharedValue: mutable,
      withTiming: value => value, useAnimatedReaction: (p, r) => reactions.push({ p, r, previous: null }), useAnimatedStyle: fn => { styles.push(fn); return {}; } },
  });
  const rows = mutable([{ y: 100, height: 80, start: 0, end: 3000 }, { y: 220, height: 80, start: 3000, end: 6000 }]);
  const position = mutable(1000), offset = mutable(0), window = mutable({ visualActiveLineStartIndex: 0, visualActiveLineEndIndex: 0, focusLineIndex: 0 });
  const seekVersion = mutable(0), motions = mutable({}), attr = mutable({ y: 700, height: 30 });
  api.NativeSharedBlur({ target: { current: null }, rows, position, offset, window, seekVersion, motions, height, style, deadlines: [0, 3000, 6000], attribution: attr, hasAttribution: true, relaxedEnvelope: enabled });
  const tick = () => { for (const reaction of reactions) { const next = reaction.p(); reaction.r(next, reaction.previous); reaction.previous = next; } };
  tick(); const initial = styles.map(fn => JSON.stringify(fn()));
  for (let frame = 1; frame <= 20; frame++) { offset.value = frame; tick(); }
  if (enabled) assert.deepEqual(styles.map(fn => JSON.stringify(fn())), initial, 'ordinary motion does not redraw masks');
  offset.value = 250; motions.value = { 0: { row: -80, cell: 20, vLead: 10, settled: false }, 1: { row: 100, cell: 10, vLead: 20, settled: false } }; tick();
  const top = styles[0]().transform[0].translateY, bottom = styles[1]().transform[0].translateY;
  assert(top <= -150 && bottom >= 50, 'moving protected rows remain outside blur');
  seekVersion.value++; offset.value = 0; motions.value = {}; window.value = { visualActiveLineStartIndex: 1, visualActiveLineEndIndex: 1, focusLineIndex: 1 }; tick();
  assert(styles[0]().transform[0].translateY <= 220 && styles[1]().transform[0].translateY >= 300, 'seek resets immediately');
  attr.value = { y: 700, height: 30 }; offset.value = 710; tick();
  assert(styles[0]().transform[0].translateY <= -10 && (styles[1]().height === 0 || styles[1]().transform[0].translateY + styles[1]().height <= -10), 'partly visible attribution above viewport remains sharp');
  rows.value = []; tick(); assert.equal(styles[1]().height, 0, 'unknown geometry and attribution remain safe');
}
console.log('Actual shared-blur hooks PASS: independent ON/OFF, both styles/orientations, stable masks, manual scroll, moving rows, seeks, unknown geometry and partly visible attribution.');

// Execute the recording path with epsilon alone, not only the retained graph.
const recording = require('./check-native-glyph-idle.cjs');
for (const spicy of [true, false]) {
  const exact = recording.mount(recording.source, spicy, 3, 1000);
  const gated = recording.mount(recording.source, spicy, 3, 1000, 4, null, 2800, { epsilon: true });
  exact.active.value = gated.active.value = true;
  exact.tick(1000); gated.tick(1000); const first = gated.picture;
  for (let i = 1; i < 90; i++) { exact.tick(1000 + i * 16); gated.tick(1000 + i * 16); }
  assert.notEqual(gated.picture, first, 'epsilon alone keeps reveal/glow moving');
  exact.tick(1200); gated.tick(1200); assert.equal(gated.picture, exact.picture, 'backward seek bypasses recording gate');
  for (let i = 0; i < 600; i++) { exact.tick(1200); gated.tick(1200); }
  assert.equal(gated.picture, exact.picture, 'paused recording converges exactly');
  exact.active.value = gated.active.value = false;
  for (let i = 0; i < 600; i++) { exact.tick(9000); gated.tick(9000); }
  assert.equal(gated.picture, exact.picture, 'released recording converges exactly');
  exact.unmount(); gated.unmount();
}
console.log('Actual NativeGlyphPicture epsilon-only path PASS: continuous visuals, pause, seek, release and exact rest.');

for (const dev of [true, false]) for (const glyphPicture of [false, true]) for (const epsilonFlag of [false, true]) for (const blurEnvelope of [false, true]) {
  const flags = { glyphPicture, epsilon: epsilonFlag, blurEnvelope };
  const api = load('relaxed-glyph-switch.tsx', {
    '@/lib/relaxed-rendering': { useRelaxedRendering: () => flags },
    './native-glyph-picture': { NativeGlyphPicture: 'recorded' }, './relaxed-glyph-graph': { RelaxedGlyphPicture: 'persistent' },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
  }, false, dev);
  const result = api.RelaxedGlyphSwitch({ lineEnd: 1234 });
  assert.equal(result.type, dev && glyphPicture ? 'persistent' : 'recorded');
  assert.equal(result.props.epsilon, dev && epsilonFlag);
}
(async () => {
  let hydrate; const writes = [];
  const settings = load('../../../lib/relaxed-rendering.ts', {
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    '@react-native-async-storage/async-storage': { getItem: () => new Promise(resolve => { hydrate = resolve; }), setItem: async (_key, value) => { writes.push(JSON.parse(value)); } },
  }, false);
  assert.deepEqual(JSON.parse(JSON.stringify(settings.useRelaxedRendering())), { glyphPicture: false, blurEnvelope: false, epsilon: false }, 'three independent default-OFF flags');
  const pending = settings.loadRelaxedRendering(); settings.setRelaxedRendering('epsilon', true);
  hydrate(JSON.stringify({ glyphPicture: true, blurEnvelope: true, epsilon: false })); await pending;
  assert.equal(settings.useRelaxedRendering().glyphPicture, false, 'late hydration cannot overwrite a user change');
  settings.setRelaxedRendering('glyphPicture', true); settings.setRelaxedRendering('epsilon', false);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(writes.at(-1), { glyphPicture: true, blurEnvelope: false, epsilon: false }, 'serialized writes preserve independent choices');
  console.log('Actual setting/switch boundaries PASS: all combinations, development/release guard, default OFF, hydration race and ordered persistence.');
})().catch(error => { console.error(error); process.exitCode = 1; });
