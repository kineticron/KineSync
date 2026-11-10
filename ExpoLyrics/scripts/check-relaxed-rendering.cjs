/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const dir = path.resolve(__dirname, '../components/lyrics/native');
const mutable = value => ({ value, modify(fn) { this.value = fn(this.value); } });
function load(file, mocks = {}, bundle = true) {
  const code = buildSync({ entryPoints: [path.resolve(dir, file)], bundle, platform: 'node', format: 'cjs', write: false,
    external: bundle ? ['react', 'react-native-reanimated', '@shopify/react-native-skia', 'react-native-worklets', '@react-native-async-storage/async-storage', '@/lib/relaxed-rendering'] : undefined }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, __DEV__: true, require: name => {
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
