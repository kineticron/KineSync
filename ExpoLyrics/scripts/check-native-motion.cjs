/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
function load(contents, resolveDir = root) {
  const output = buildSync({ stdin: { contents, resolveDir, loader: 'ts' }, bundle: true, platform: 'node',
    format: 'cjs', write: false }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require, performance });
  return module.exports;
}
const native = load('export * from "./components/lyrics/native/reference-motion"');
const spicyLayout = load('export * from "./components/lyrics/native/spicy-native-layout"');
const flexWords = [0, 4, 8].map((offset, index) => ({ text: 'abc', start: index, end: index + 1, offset, letters: ['a', 'b', 'c'], emphasized: false, joined: false, gapAfter: index < 2 }));
const wrappedFlex = spicyLayout.wrapSpicyText('abc abc abc', flexWords, 7, (start, end) => end - start);
assert.equal(wrappedFlex.text, 'abc \nabc abc', 'A trailing pseudo-element gap participates in flex wrapping');
assert.equal(wrappedFlex.words[1].offset, 5, 'Inserted breaks retain syllable paint offsets');
const floatClock = load('export * from "./components/lyrics/native/amll-float-clock"');
let release = floatClock.advanceAmllFloatClock({ active: false, releasePosition: -1, elapsed: 0 }, true, 5800, 16);
release = floatClock.advanceAmllFloatClock(release, false, 5800, 100);
assert.equal(floatClock.amllWordFloatPosition(release, 5800, 5000, 5100), 5700, 'Disable reverses the minimum-one-second float from its actual position');
release = floatClock.advanceAmllFloatClock(release, false, 5800, 200);
assert.equal(floatClock.amllWordFloatPosition(release, 5800, 5000, 5100), 5500, 'The float releases while the playback position is paused');
assert.equal(floatClock.amllWordFloatPosition(release, 5800, 0, 500), 700, 'Each word reverses from its own clamped WAAPI endpoint');
const textPolicy = load('export * from "./components/lyrics/native/spicy-text-policy"');
const spicyEntry = fs.readFileSync(path.join(root, 'components/lyrics/spicy-webview-entry.ts'), 'utf8');
const textReference = load(spicyEntry.slice(spicyEntry.indexOf('function stripZeroWidth('), spicyEntry.indexOf('function addSourceElement(')) + '\nexport { stripZeroWidth, isRtl };');
for (const text of ['12, مرحبا', 'hello مرحبا', '\uFB50', 'क्षि', '👨‍👩‍👧‍👦', 'a\u200Bb\u200Ec\u2060', 'می\u200Cروم']) {
  assert.equal(textPolicy.spicyIsRtl(text), textReference.isRtl(text), 'Direction matches the WebView first-character policy');
  assert.equal(textPolicy.spicyPaintText(text), textReference.stripZeroWidth(text), 'Only reference formatting characters are removed');
}
for (const [rtl, expected] of [[false, [1, 0.5, 0, 0.5]], [true, [0, 1, 1, 0.5]]]) {
  const joined = [true, true, false, false];
  assert.deepEqual(joined.map((value, index) => textPolicy.spicyWordOrigin(value, !!joined[index - 1], rtl)), expected,
    'Joined syllables follow CSS pivot specificity and RTL overrides');
}
const referencePath = path.join(root, 'components/lyrics/spicy-upstream-runtime.ts');
const reference = load(fs.readFileSync(referencePath, 'utf8') + '\nexport { SCALE_SPLINE, LETTER_SCALE_SPLINE, Y_OFFSET_SPLINE, LETTER_Y_OFFSET_SPLINE, GLOW_SPLINE, animateActiveWord };', path.dirname(referencePath));
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-10, `${message}: ${a} != ${b}`);
for (const [actual, expected] of [['SPICY_SCALE', 'SCALE_SPLINE'], ['SPICY_LETTER_SCALE', 'LETTER_SCALE_SPLINE'],
  ['SPICY_Y', 'Y_OFFSET_SPLINE'], ['SPICY_LETTER_Y', 'LETTER_Y_OFFSET_SPLINE'], ['SPICY_GLOW', 'GLOW_SPLINE']]) {
  for (let sample = 0; sample <= 1500; sample++) near(native.splineAt(native[actual], sample / 1500), reference[expected].at(sample / 1500), actual);
}
for (const [frequency, damping] of [[0.88, 0.64], [1.45, 0.4], [1.18, 0.56]]) {
  const spring = new reference.Spring(0.95, frequency, damping);
  let state = { p: 0.95, v: 0 };
  for (let frame = 0; frame < 1200; frame++) {
    const goal = frame < 300 ? Math.sin(frame / 85) * 0.1 + 1 : frame < 600 ? 1 : 0.95;
    const dt = [1 / 60, 1 / 120, 0.064, 1 / 240][frame % 4];
    spring.SetGoal(goal);
    state = native.stepSpicySpring(state, goal, frequency, damping, dt);
    near(state.p, spring.Step(dt), 'Spicy spring integration and sleep');
  }
}
const map = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@applemusic-like-lyrics/core/dist/amll-core.mjs.map'), 'utf8'));
const springSource = map.sourcesContent[map.sources.findIndex(name => name.endsWith('/utils/spring.ts'))];
const solver = load('export ' + springSource.slice(springSource.indexOf('function solveSpring('))).solveSpring;
for (const [mass, damping, stiffness] of [[2, 25, 100], [1, 20, 50], [0.9, 15, 90], [1, 10, 100]]) {
  for (const dt of [1 / 240, 1 / 60, 0.064, 0.5]) {
    const state = { p: 0.97, v: 0.12 };
    const expected = solver(state.p, state.v, 1, 0, { mass, damping, stiffness });
    near(native.stepAmllSpring(state, 1, mass, damping, stiffness, dt).p, expected(dt), 'AMLL bundled spring solver');
  }
}
const bezier = require('bezier-easing');
for (let sample = 0; sample <= 1000; sample++) {
  const p = sample / 1000;
  assert.ok(Math.abs(native.amllFloat(p * 2000, 0, 2000, false) - -0.05 * bezier(0, 0, 0.58, 1)(p)) < 1e-6);
}
const wordMotion = load('export * from "./components/lyrics/native/reference-word-motion"');
const emphasizedWord = { text: 'sing', start: 100, end: 1350, letters: ['s', 'i', 'n', 'g'], emphasized: true, joined: false, offset: 0 };
const element = () => ({ style: { setProperty() {} } });
const runtimeWord = { HTMLElement: element(), StartTime: 100, EndTime: 1100, TotalTime: 1000, LetterGroup: true,
  Letters: emphasizedWord.letters.map((_, index) => ({ HTMLElement: element(), StartTime: 100 + index * 250, EndTime: 350 + index * 250, TotalTime: 250, Emphasis: true })) };
let emphasizedState = wordMotion.initialWordSpringState(emphasizedWord);
for (let time = 0; time <= 1800; time += 10) {
  reference.animateActiveWord(runtimeWord, time, 0.01);
  const result = wordMotion.advanceReferenceWordMotion(emphasizedWord, emphasizedState, time, 0.01);
  emphasizedState = result.state;
  for (const [field, store] of [['scale', 'Scale'], ['y', 'YOffset'], ['glow', 'Glow']]) {
    near(result.motion[field], runtimeWord.AnimatorStore[store].p, 'Full reference word animator: ' + field);
    result.motion.letters.forEach((letter, index) => near(letter[field], runtimeWord.Letters[index].AnimatorStore[store].p * (field === 'y' ? 2 : 1), 'Full reference letter animator: ' + field + ' at ' + time + ' letter ' + index));
  }
}
const glyphLayout = load('export * from "./components/lyrics/native/native-glyph-layout"');
const wrappedRun = { glyphs: [11, 12, 13], positions: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
  origin: { x: 3, y: 75 }, bounds: Array.from({ length: 3 }, () => ({ x: 0, y: -10, width: 10, height: 10 })) };
const fullSlice = glyphLayout.selectGlyphSlice(wrappedRun, [{ x: 3, y: 60, width: 30, height: 20 }]);
assert.deepEqual(Array.from(fullSlice.glyphs), [11, 12, 13], 'Wrapping keeps the final glyph independently of native cluster indices');
assert.equal(fullSlice.positions[2].y, 75, 'Glyphs retain the shaped run baseline');
const ligature = { glyphs: [42], positions: [{ x: 0, y: 0 }], origin: { x: 0, y: 10 }, bounds: [{ x: 0, y: -10, width: 20, height: 10 }] };
for (const x of [0, 10]) assert.equal(glyphLayout.selectGlyphSlice(ligature, [{ x, y: 0, width: 10, height: 12 }]).glyphs[0], 42,
  'A ligature intersecting two animated slices is preserved in both clipped draws');
const waitingWord = { text: 'wait', start: 5000, end: 6000, letters: ['w', 'a', 'i', 't'], emphasized: false, joined: false, offset: 0 };
let wordState = wordMotion.initialWordSpringState(waitingWord);
const referenceScale = new reference.Spring(0.95, 0.88, 0.64);
let animatedScale;
for (let time = 0; time <= 5200; time += 10) {
  const goal = reference.SCALE_SPLINE.at(Math.max(0, Math.min(1, (time - 5000) / 1000)));
  referenceScale.SetGoal(goal, time === 0);
  const expected = referenceScale.Step(0.01);
  const result = wordMotion.advanceReferenceWordMotion(waitingWord, wordState, time, 0.01);
  wordState = result.state;
  animatedScale = result.motion.scale;
  near(animatedScale, expected, 'An idle word enters with the reference spring, without snapping');
}
assert.notEqual(animatedScale, reference.SCALE_SPLINE.at(0.2), 'Normal playback retains spring lag');
const seek = wordMotion.advanceReferenceWordMotion(waitingWord, wordState, 5800, 0.01);
const largeSeek = wordMotion.advanceReferenceWordMotion(waitingWord, seek.state, 3000, 0.01);
near(largeSeek.motion.scale, 0.95, 'Backward seeks reset the reference word spring');
console.log('Native motion matches bundled reference coefficients and spring trajectories: 7,505 spline samples, 3,600 spring frames, idle-word activation, seeks, AMLL solver and word float.');

