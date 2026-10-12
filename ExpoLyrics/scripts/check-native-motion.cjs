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
const amllLayout = load('export * from "./components/lyrics/native/amll-native-layout"');
const model = load('export * from "./components/lyrics/native/native-lyrics-model"');
for (const text of ['one two three four five six', 'sing   along with me tonight', 'Hello world again']) {
  const parts = text.match(/\S+\s*/gu).map((text, index) => ({ text, startTime: index * 1000, endTime: (index + 1) * 1000 }));
  const voice = model.buildNativeVoice(parts, 0, parts.length * 1000, 'amll');
  for (const width of [7, 10, 14]) {
    const balanced = amllLayout.balanceAmllText(voice.paintText, voice.paintWords, width, (start, end) => end - start);
    assert.ok(!/\n[^\S\n]/u.test(balanced.text), 'AMLL wrapped rows must not start with a preserved space');
    assert.equal(balanced.text.replace(/\s+/gu, ''), voice.paintText.replace(/\s+/gu, ''), 'Wrapping preserves all lyric characters');
    for (const word of balanced.words) assert.equal(balanced.text.slice(word.offset, word.offset + word.text.trimEnd().length), word.text.trimEnd(), 'Timing ranges follow removed spaces and inserted newlines');
  }
}
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
const reference = load(fs.readFileSync(referencePath, 'utf8') + '\nexport { SCALE_SPLINE, LETTER_SCALE_SPLINE, Y_OFFSET_SPLINE, LETTER_Y_OFFSET_SPLINE, GLOW_SPLINE, DOT_SCALE_SPLINE, DOT_Y_OFFSET_SPLINE, DOT_GLOW_SPLINE, DOT_OPACITY_SPLINE, animateActiveWord };', path.dirname(referencePath));
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
const interlude = load('export * from "./components/lyrics/native/native-interlude-motion"');
for (const [actual, expected] of [['SPICY_DOT_SCALE', 'DOT_SCALE_SPLINE'], ['SPICY_DOT_Y', 'DOT_Y_OFFSET_SPLINE'],
  ['SPICY_DOT_GLOW', 'DOT_GLOW_SPLINE'], ['SPICY_DOT_OPACITY', 'DOT_OPACITY_SPLINE']]) {
  for (let sample = 0; sample <= 1000; sample++) near(native.splineAt(native[actual], sample / 1000), reference[expected].at(sample / 1000), actual);
}
for (const duration of [3000, 4200, 8000, 14000]) {
  const timing = interlude.spicyDotTiming(1000, 1000 + duration);
  assert.deepEqual(JSON.parse(JSON.stringify(timing)), JSON.parse(JSON.stringify(reference.createDotTiming(1000, 1000 + duration))));
  for (const [start, end] of timing) {
    let state = interlude.initialDotSpringState();
    const dot = { HTMLElement: { style: { setProperty() {} } }, Dot: true, StartTime: start, EndTime: end, TotalTime: end - start };
    for (let time = 0; time <= 1000 + duration; time += 20) {
      reference.animateActiveWord(dot, time, 0.02);
      state = interlude.advanceSpicyDot(state, time, start, end, 0.02);
      for (const [actual, expected] of [['scale', 'Scale'], ['y', 'YOffset'], ['glow', 'Glow'], ['opacity', 'Opacity']])
        near(state[actual].p, dot.AnimatorStore[expected].p, 'Spicy interlude spring ' + actual);
    }
  }
}
const referenceElements = [];
const referenceModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/fixtures/amll-interlude-main.cjs'), 'utf8'), {
  module: referenceModule, document: { createElement: () => {
    const element = { style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute(_name, value) { this.transform = value; } };
    referenceElements.push(element);
    return element;
  } },
});
for (const duration of [2750, 3750, 7750, 13750]) {
  const dots = new referenceModule.exports();
  dots.setInterlude([1000, 1000 + duration]);
  for (let elapsed = 0; elapsed <= duration + 500; elapsed += 10) {
    dots.currentTime = 1000 + elapsed;
    dots.update(0);
    const snapshot = interlude.amllInterludeSnapshot(1000 + elapsed, 1000, 1000 + duration);
    const scale = Number(dots.getElement().transform.match(/scale\(([^)]+)\)/)[1]);
    near(snapshot.scale, scale, 'AMLL main interlude breathe/entrance/exit');
    for (const [index, element] of [dots.dot0, dots.dot1, dots.dot2].entries())
      near(snapshot.dots[index], Number(element.style.opacity), 'AMLL main dot lighting/fade');
  }
}
console.log('Native interlude motion matches main AMLL snapshots and Spicy dot timing, splines and all four springs.');
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
const syllableRect = { x: 20, y: 0, width: 40, height: 20 };
for (const advanced of [0, 10, 20, 40, 80]) {
  const edges = [0, 1, 2, 3].map(letter => glyphLayout.amllRevealStart({ ...syllableRect, x: 20 + letter * 10, width: 10 }, [syllableRect], advanced, 0, 10));
  assert.ok(edges.every(x => x === edges[0]), 'Sustained letters share a syllable reveal edge instead of starting parallel reveal streams');
}
const wrappedSyllable = [syllableRect, { x: 0, y: 20, width: 20, height: 20 }];
assert.equal(glyphLayout.amllRevealStart(wrappedSyllable[1], wrappedSyllable, 60, 0, 10), 0, 'A wrapped syllable consumes the preceding row before revealing the next');
const wrappedRun = { glyphs: [11, 12, 13], positions: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
  origin: { x: 3, y: 75 }, bounds: Array.from({ length: 3 }, () => ({ x: 0, y: -10, width: 10, height: 10 })) };
const fullSlice = glyphLayout.selectGlyphSlice(wrappedRun, [{ x: 3, y: 60, width: 30, height: 20 }]);
assert.deepEqual(Array.from(fullSlice.glyphs), [11, 12, 13], 'Wrapping keeps the final glyph independently of native cluster indices');
assert.equal(fullSlice.positions[2].y, 75, 'Glyphs retain the shaped run baseline');
const ligature = { glyphs: [42], positions: [{ x: 0, y: 0 }], origin: { x: 0, y: 10 }, bounds: [{ x: 0, y: -10, width: 20, height: 10 }] };
for (const x of [0, 10]) assert.equal(glyphLayout.selectGlyphSlice(ligature, [{ x, y: 0, width: 10, height: 12 }]).glyphs[0], 42,
  'A ligature intersecting two animated slices is preserved in both clipped draws');
const descender = { glyphs: [77], positions: [{ x: 0, y: 0 }], origin: { x: 5, y: 18 },
  bounds: [{ x: 0, y: -12, width: 10, height: 10 + 12 }] };
assert.equal(glyphLayout.selectGlyphSlice(descender, [{ x: 0, y: 0, width: 20, height: 20 }]).glyphs.length, 1,
  'A g descender is retained on its own baseline row');
assert.equal(glyphLayout.selectGlyphSlice(descender, [{ x: 0, y: 20, width: 20, height: 20 }]).glyphs.length, 0,
  'Overhanging descender ink cannot be duplicated into the next wrapped row');
const hangulOverhang = { glyphs: [81, 82], positions: [{ x: 0, y: 0 }, { x: 20, y: 0 }], origin: { x: 0, y: 24 },
  advances: [20, 20], bounds: [{ x: 0, y: -20, width: 19, height: 22 }, { x: -3, y: -20, width: 23, height: 22 }] };
assert.deepEqual(Array.from(glyphLayout.selectGlyphSlice(hangulOverhang, [{ x: 0, y: 0, width: 20, height: 30 }]).glyphs), [81],
  'The left overhang of the next Hangul syllable cannot move with the preceding emphasis/glow');
assert.deepEqual(Array.from(glyphLayout.selectGlyphSlice(hangulOverhang, [{ x: 20, y: 0, width: 20, height: 30 }]).glyphs), [82],
  'The overhanging glyph retains its own shaped owner');
for (const x of [0, 10]) assert.equal(glyphLayout.selectGlyphSlice({ ...ligature, advances: [20] }, [{ x, y: 0, width: 10, height: 12 }]).glyphs[0], 42,
  'A real ligature can still span two clipped letter slices');
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
require('./check-native-scroll.cjs');
require('./check-native-background-layout.cjs');
require('./check-native-layout-cell.cjs');
require('./check-amll-layout-reference.cjs');
require('./check-native-interlude-layout.cjs');
require('./check-native-glyph-paint.cjs');

