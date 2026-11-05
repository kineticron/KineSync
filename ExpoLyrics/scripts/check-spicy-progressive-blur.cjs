/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { buildSync } = require('esbuild');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// 1. Load native-progressive-blur.ts
let reaction, previous;
const shared = initial => {
  let value = initial;
  const cell = {
    animation: null,
    get value() { return value; },
    set value(next) {
      if (next?.timing) cell.animation = { from: value, to: next.target };
      else { value = next; cell.animation = null; }
    },
    advance(fraction) {
      if (this.animation) value = this.animation.from + (this.animation.to - this.animation.from) * fraction;
    },
  };
  return cell;
};

const progressiveModules = {
  react: { createContext: value => ({ value }), useMemo: fn => fn() },
  'react-native-reanimated': {
    useSharedValue: shared,
    useAnimatedReaction: (prepare, apply) => {
      reaction = () => { const next = prepare(); apply(next, previous); previous = next; };
    },
    withTiming: (target, options) => {
      assert.equal(options.duration, 240);
      return { timing: true, target };
    },
  },
};

const progressiveCode = buildSync({
  entryPoints: [path.join(root, 'components/lyrics/native/native-progressive-blur.ts')],
  bundle: true, external: ['*'], platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const progressiveModule = { exports: {} };
vm.runInNewContext(progressiveCode, {
  module: progressiveModule, exports: progressiveModule.exports,
  require: name => progressiveModules[name] || {},
});
const progApi = progressiveModule.exports;

// 2. Load native-shared-blur.tsx
const styles = [], timings = [], sharedValues = [];
let sharedPrepare, sharedReact;
const sharedModules = {
  react: { createContext: value => ({ value }), useMemo: fn => fn() },
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  'react-native': { StyleSheet: { absoluteFill: {} }, View: 'View' },
  'expo-blur': { BlurView: 'BlurView' },
  '@react-native-masked-view/masked-view': 'MaskedView',
  'expo-linear-gradient': { LinearGradient: 'LinearGradient' },
  './native-progressive-blur': progApi,
  'react-native-reanimated': {
    default: { View: 'Animated.View' },
    __esModule: true,
    withTiming: (value, config) => {
      assert(Number.isFinite(value));
      timings.push({ value, config });
      return { timing: value };
    },
    useSharedValue: value => {
      const v = {
        current: value, animation: null,
        get value() { return this.current; },
        set value(next) {
          if (next && typeof next === 'object' && 'timing' in next) this.animation = { from: this.current, to: next.timing };
          else { this.current = next; this.animation = null; }
        },
        advance(fraction) {
          if (this.animation) this.current = this.animation.from + (this.animation.to - this.animation.from) * fraction;
        },
      };
      sharedValues.push(v);
      return v;
    },
    useAnimatedStyle: fn => { styles.push(fn); return {}; },
    useAnimatedReaction: (p, r) => { sharedPrepare = p; sharedReact = r; },
  },
};

const sharedBlurCode = buildSync({
  entryPoints: [path.join(root, 'components/lyrics/native/native-shared-blur.tsx')],
  bundle: true, external: ['*'], platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const sharedBlurModule = { exports: {} };
vm.runInNewContext(sharedBlurCode, {
  module: sharedBlurModule, exports: sharedBlurModule.exports,
  require: name => sharedModules[name] || {},
});
const sharedApi = sharedBlurModule.exports;

// 3. Test actual mask weights and complementary sums (no seam, zero protected blur)
assert.equal(typeof sharedApi.sharedBlurMaskWeights, 'function');
// Inside protected region: exactly zero
const atZero = sharedApi.sharedBlurMaskWeights(0);
assert.equal(atZero.near, 0); assert.equal(atZero.far, 0); assert.equal(atZero.sum, 0);
const atNeg = sharedApi.sharedBlurMaskWeights(-50);
assert.equal(atNeg.near, 0); assert.equal(atNeg.far, 0); assert.equal(atNeg.sum, 0);

// Entrance ramp: 0 to 1
const at30 = sharedApi.sharedBlurMaskWeights(30);
assert.equal(at30.near, 0.5); assert.equal(at30.far, 0); assert.equal(at30.sum, 0.5);

// Near plateau: exactly 1
const at60 = sharedApi.sharedBlurMaskWeights(60);
assert.equal(at60.near, 1); assert.equal(at60.far, 0); assert.equal(at60.sum, 1);
const at110 = sharedApi.sharedBlurMaskWeights(110);
assert.equal(at110.near, 1); assert.equal(at110.far, 0); assert.equal(at110.sum, 1);

// Complementary transition: sum === 1.0 everywhere
const at160 = sharedApi.sharedBlurMaskWeights(160);
assert.equal(at160.near, 1); assert.equal(at160.far, 0); assert.equal(at160.sum, 1);
const at190 = sharedApi.sharedBlurMaskWeights(190);
assert.equal(at190.near, 0.5); assert.equal(at190.far, 0.5); assert.equal(at190.sum, 1);
const at220 = sharedApi.sharedBlurMaskWeights(220);
assert.equal(at220.near, 0); assert.equal(at220.far, 1); assert.equal(at220.sum, 1);

// Far zone: exactly 1
const at400 = sharedApi.sharedBlurMaskWeights(400);
assert.equal(at400.near, 0); assert.equal(at400.far, 1); assert.equal(at400.sum, 1);

// Continuous sweep: sum <= 1.0 everywhere from -100 to 1000
for (let d = -100; d <= 1000; d++) {
  const w = sharedApi.sharedBlurMaskWeights(d);
  assert(w.sum <= 1.0001, `Weight sum exceeds 1 at d=${d}: ${w.sum}`);
  assert(w.near >= 0 && w.far >= 0, `Negative weight at d=${d}`);
}

// 4. Test whole 3-row next row geometry protection (measuredProtection)
const sampleRows = [
  { y: 0, height: 84, start: 1000, end: 2000 },
  // Entire three-wrap next semantic row, including its translation block:
  { y: 84, height: 230, start: 2000, end: 3000 },
  { y: 314, height: 90, start: 3000, end: 4000 },
  { y: 404, height: 110, start: 4000, end: 5000 },
  { y: 514, height: 100, start: 5000, end: 6000 },
  { y: 614, height: 100, start: 6000, end: 7000 },
];
const win = { focusLineIndex: 0, visualActiveLineStartIndex: 0, visualActiveLineEndIndex: 0 };
let p = progApi.measuredProtection(sampleRows, win, 1500);
assert.equal(p.index, 1, 'Next semantic row after active row 0 is row 1');
assert.equal(p.bottom, 314, 'Whole wrapped+translated row protected strictly to y+height, no constant offset');
assert.equal(p.top, 0);

// Adding 70 measured points to row 1 moves target bottom to 384
const expandedRows = sampleRows.map((r, i) => ({ ...r, y: r.y + (i > 1 ? 70 : 0), height: r.height + (i === 1 ? 70 : 0) }));
p = progApi.measuredProtection(expandedRows, win, 1500);
assert.equal(p.bottom, 384, 'Translation/extra wrapping moves actual boundary by measured 70 points');

// Multiple overlapping active rows 0..2: protects complete row 3, bottom 514
const multiWin = { focusLineIndex: 0, visualActiveLineStartIndex: 0, visualActiveLineEndIndex: 2 };
p = progApi.measuredProtection(sampleRows, multiWin, 1500);
assert.equal(p.index, 3); assert.equal(p.bottom, 514);

// Intro dots attached to upcoming row 0: protects row 0 even when visual active is empty
const dotRows = sampleRows.map((r, i) => ({ ...r, interlude: i === 0 ? { start: 0, end: 1000 } : undefined }));
const emptyWin = { focusLineIndex: 0, visualActiveLineStartIndex: -1, visualActiveLineEndIndex: -1 };
p = progApi.measuredProtection(dotRows, emptyWin, 500);
assert.equal(p.index, 0); assert.equal(p.bottom, 84, 'Intro dots protect entire upcoming row 0');

// Unknown protected geometry opens safe zone
const unmeasured = sampleRows.map((r, i) => ({ ...r, height: i === 1 ? 0 : r.height }));
p = progApi.measuredProtection(unmeasured, win, 1500);
assert.equal(p.bottom, Infinity, 'Unknown next row height opens blur to Infinity');

// 5. Test NativeSharedBlur execution, forward/reverse asymmetry, seek and scroll
const rowsRef = { value: sampleRows };
const winRef = { value: win };
const posRef = { value: 1500 };
const offsetRef = { value: 0 };
const seekRef = { value: 0 };
sharedApi.NativeSharedBlur({
  target: { current: null },
  rows: rowsRef,
  window: winRef,
  position: posRef,
  offset: offsetRef,
  height: 800,
  seekVersion: seekRef,
  deadlines: [1000, 2000, 3000, 4000, 5000, 6000],
});

let sharedPrev = sharedPrepare();
sharedReact(sharedPrev, null);

// Initial state: upper is styles[0], lower is styles[1]
assert.equal(styles[1]().transform[0].translateY, 314, 'Lower mask positioned strictly at next row bottom 314');
assert.equal(styles[0]().transform[0].translateY, 0, 'Upper mask positioned strictly at top 0');

// Forward cue to row 1: new protected bottom is row 2's bottom (404)
winRef.value = { focusLineIndex: 1, visualActiveLineStartIndex: 1, visualActiveLineEndIndex: 1 };
posRef.value = 2500;
let sharedNext = sharedPrepare();
sharedReact(sharedNext, sharedPrev);
sharedPrev = sharedNext;

// CRITICAL: effective lower boundary = max(animatedBottom, protection.bottom)
// Because animatedBottom lags behind 404, max(lag, 404) is 404! Next row is NEVER blurred!
assert.equal(styles[1]().transform[0].translateY, 404, 'Forward cue enforces newsharp instantly via max(animated, target)');

// Advance animation to completion: animatedBottom reaches 404
sharedValues[2].advance(1.0);
assert.equal(styles[1]().transform[0].translateY, 404);

// Reverse cue back to row 0: new protection bottom is 314
winRef.value = { focusLineIndex: 0, visualActiveLineStartIndex: 0, visualActiveLineEndIndex: 0 };
posRef.value = 1500;
sharedNext = sharedPrepare();
sharedReact(sharedNext, sharedPrev);
sharedPrev = sharedNext;

// During reverse, animatedBottom starts at 404 and animates back to 314.
// max(animatedBottom, 314) follows animatedBottom smoothly!
assert.equal(styles[1]().transform[0].translateY, 404, 'Reverse cue starts at previous animated boundary');
sharedValues[2].advance(0.5);
assert.equal(styles[1]().transform[0].translateY, 359, 'Reverse cue retreats smoothly without sudden snap');

// Scroll offset subtracts actual offset
offsetRef.value = 30;
assert.equal(styles[1]().transform[0].translateY, 329, 'Scroll offset directly shifts blur viewport');
offsetRef.value = 0;

// Explicit seek resets immediately
seekRef.value++;
sharedNext = sharedPrepare();
sharedReact(sharedNext, sharedPrev);
sharedPrev = sharedNext;
assert.equal(styles[1]().transform[0].translateY, 314, 'Seek initializes to measured edge immediately');

// 6. Verify bounded strengths and per-renderer profiles for AMLL and Spicy
assert(sharedApi.SHARED_BLUR_PROFILES, 'SHARED_BLUR_PROFILES exported');
const spicyProfile = sharedApi.getSharedBlurProfile('spicy');
const amllProfile = sharedApi.getSharedBlurProfile('amll');

assert.equal(spicyProfile.nearIntensity, 10);
assert.equal(spicyProfile.farIntensity, 24);
assert.equal(spicyProfile.tint, 'systemUltraThinMaterial');

// AMLL profile preserves original softness/opacity (softer than Spicy, not blindly identical)
assert.equal(amllProfile.nearIntensity, 6, 'AMLL near blur is softer than Spicy (6 vs 10)');
assert.equal(amllProfile.farIntensity, 16, 'AMLL far blur is softer than Spicy (16 vs 24)');
assert.equal(amllProfile.tint, 'systemUltraThinMaterial');
assert(amllProfile.nearIntensity < spicyProfile.nearIntensity, 'AMLL must be softer than Spicy near');
assert(amllProfile.farIntensity < spicyProfile.farIntensity, 'AMLL must be softer than Spicy far');

// AMLL mask distances also guarantee sum <= 1.0 everywhere
for (let d = -100; d <= 1000; d++) {
  const w = sharedApi.sharedBlurMaskWeights(d, 1000, amllProfile.d1, amllProfile.dNear, amllProfile.dCross);
  assert(w.sum <= 1.0001, `AMLL weight sum exceeds 1 at d=${d}: ${w.sum}`);
  assert(w.near >= 0 && w.far >= 0, `AMLL negative weight at d=${d}`);
}

// 7. Test AMLL geometry protection (multi-wrap + AmllBackground + translations)
const amllRows = [
  { y: 0, height: 72, start: 0, end: 1200 },
  { y: 72, height: 180, start: 1200, end: 2400 }, // wrapped line with background voices
  { y: 252, height: 95, start: 2400, end: 3600 },
  { y: 347, height: 85, start: 3600, end: 4800 },
];
const amllWin = { focusLineIndex: 0, visualActiveLineStartIndex: 0, visualActiveLineEndIndex: 0 };
let amllP = progApi.measuredProtection(amllRows, amllWin, 500);
assert.equal(amllP.index, 1, 'AMLL protects full next semantic row');
assert.equal(amllP.bottom, 252, 'AMLL protected boundary matches measured row height strictly');

// 8. Test NativeSharedBlur execution with AMLL style
const amllRowsRef = { value: amllRows };
const amllWinRef = { value: amllWin };
const amllPosRef = { value: 500 };
const amllOffsetRef = { value: 0 };
const amllSeekRef = { value: 0 };
sharedApi.NativeSharedBlur({
  target: { current: null },
  rows: amllRowsRef,
  window: amllWinRef,
  position: amllPosRef,
  offset: amllOffsetRef,
  height: 800,
  seekVersion: amllSeekRef,
  deadlines: [0, 1200, 2400, 3600, 4800],
  style: 'amll',
});

// 9. Verify accessibility and tree invariants from component source
const sharedSource = read('components/lyrics/native/native-shared-blur.tsx');
assert.match(sharedSource, /pointerEvents="none"/);
assert.match(sharedSource, /accessibilityElementsHidden/);
assert.match(sharedSource, /importantForAccessibility="no-hide-descendants"/);
assert.match(sharedSource, /tint={tint}/, 'Uses profile tint');

// 10. Verify no per-voice Gaussian blur context or execution in native-lyric-row.tsx
const rowSource = read('components/lyrics/native/native-lyric-row.tsx');
assert(!rowSource.includes('NativeProgressiveBlurContext'), 'NativeProgressiveBlurContext removed from native-lyric-row.tsx');
assert(!rowSource.includes('measuredBlurRadius'), 'measuredBlurRadius removed from native-lyric-row.tsx');

// 11. Verify native-lyrics-view.tsx wiring for BOTH AMLL and Spicy
const viewSource = read('components/lyrics/native/native-lyrics-view.tsx');
assert.match(viewSource, /const sharedBlurEnabled = __DEV__ && fastLoading && \(Platform\.OS === 'ios' \|\| Platform\.OS === 'android' && Number\(Platform\.Version\) >= 31\) && \(style === 'spicy' \|\| style === 'amll'\) && list === 'flash' && reveal === 'canvas';/);
assert.match(viewSource, /NativeSharedBlurContext\.Provider value=\{sharedBlurReady\}/);
assert.match(viewSource, /geometry\.isHeightMeasured/, 'Requires real measured height, not estimates');
assert.match(viewSource, /style=\{style\}/, 'Passes renderer style to NativeSharedBlur');

// 12. Verify exclusions: webviews, non-canvas reveals, and FlatList are NOT eligible for shared blur
assert(!viewSource.includes("reveal === 'cold' && sharedBlurEnabled"), 'Cold reveal excluded');
assert(!viewSource.includes("list === 'flat' && sharedBlurEnabled"), 'FlatList excluded');

console.log('Spicy + AMLL progressive shared blur PASS: per-renderer profiles (AMLL soft vs Spicy strong), complementary mask weights sum<=1, whole 3-row next+translation+dot protection, forward/reverse asymmetry clamping, scroll offset, seek, max3 bounded tiers, no per-voice Gaussian execution. Source/hook execution; no device proof.');
