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

// 8. Test NativeSharedBlur execution with AMLL style, spring motion envelope, and motion registry
const motionCode = buildSync({
  entryPoints: [path.join(root, 'components/lyrics/native/reference-motion.ts')],
  bundle: true, external: ['*'], platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
const motionModule = { exports: {} };
vm.runInNewContext(motionCode, { module: motionModule, exports: motionModule.exports, require });
const { stepAmllSpring, amllScrollSpring } = motionModule.exports;

const amllRowsRef = { value: amllRows };
const amllWinRef = { value: amllWin };
const amllPosRef = { value: 500 };
const amllOffsetRef = { value: 0 };
const amllSeekRef = { value: 0 };
const amllResidualRef = { value: 0 };
const amllMotionsRef = { value: {} };
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
  residual: amllResidualRef,
  motions: amllMotionsRef,
});

let amllPrev = sharedPrepare();
sharedReact(amllPrev, null);

// AMLL spring motion envelope: when spring is moving (residual = -45), expand protected region
amllResidualRef.value = -45;
assert.equal(styles[2]().transform[0].translateY, -45, 'Upper boundary expands upward by |residual|');
assert.equal(styles[3]().transform[0].translateY, 297, 'Lower boundary expands downward by |residual| (252 + 45)');

// AMLL spring settled: returns strictly to static row bounds
amllResidualRef.value = 0;
assert.equal(styles[2]().transform[0].translateY, 0, 'Settled upper boundary returns strictly to 0');
assert.equal(styles[3]().transform[0].translateY, 252, 'Settled lower boundary returns strictly to 252');

// 8b. Reviewer exact solver 120 delta simulation reproduction:
// Step both host spring and row 1 spring over 120 frames at 60fps (dt = 1/60).
// Staggered delay for row 1 holds rowRenderedP while host residual begins decaying.
// Under old code, host residual decayed to 28.79px at frame 11 while row 1 had 53.10px displacement (24.31px leak).
// At frames 30..55, host residual reached 0 while row was still settling (3.8px leak).
// With motions registry and transformed row envelope, verify ZERO breach across all 120 frames!
let hostSpring = { p: 120, v: 0, stiffness: 90, damping: 15 };
const rowSpringCfg = amllScrollSpring({ firstVisible: 0, index: 1, interval: 800, interlude: false }, 1);
let rowSpring = { p: 120, v: 0, renderedP: 120, delay: rowSpringCfg.delay, stiffness: rowSpringCfg.stiffness, damping: rowSpringCfg.damping };
const dt = 1 / 60;
let maxBreach = 0;
let frame11Displacement = 0;
let frame11LowerBoundary = 0;
let frame40HostResidual = 0;
let frame40RowP = 0;
let frame40LowerBoundary = 0;

for (let frame = 1; frame <= 120; frame++) {
  // Step host spring
  const nextHost = stepAmllSpring(hostSpring, 0, 0.9, hostSpring.damping, hostSpring.stiffness, dt);
  const hostSettled = Math.abs(nextHost.p) < 0.01 && Math.abs(nextHost.v) < 0.01;
  hostSpring = { ...hostSpring, p: hostSettled ? 0 : nextHost.p, v: hostSettled ? 0 : nextHost.v };
  const hostResidual = hostSpring.p;
  amllResidualRef.value = hostResidual;

  // Step row 1 spring
  if (rowSpring.delay > 0) {
    rowSpring = { ...rowSpring, renderedP: rowSpring.p, delay: Math.max(0, rowSpring.delay - dt) };
  } else {
    const nextRow = stepAmllSpring(rowSpring, 0, 0.9, rowSpring.damping, rowSpring.stiffness, dt);
    const rowSettled = Math.abs(nextRow.p) < 0.01 && Math.abs(nextRow.v) < 0.01;
    rowSpring = { ...rowSpring, p: rowSettled ? 0 : nextRow.p, v: rowSettled ? 0 : nextRow.v, renderedP: rowSettled ? 0 : nextRow.p };
  }
  const rowDy = rowSpring.renderedP - hostResidual;

  // Publish to motions registry as in production useReferenceRowScroll
  amllMotionsRef.value = { 1: { row: rowDy, cell: 0, settled: rowSpring.p === 0 && hostResidual === 0 } };

  // Evaluate NativeSharedBlur lower boundary
  const lowerBoundary = styles[3]().transform[0].translateY;
  const rowBottom = amllRows[1].y + amllRows[1].height + rowDy;
  const breach = rowBottom - lowerBoundary;
  if (breach > maxBreach) maxBreach = breach;

  if (frame === 11) {
    frame11Displacement = rowDy;
    frame11LowerBoundary = lowerBoundary;
  }
  if (frame === 40) {
    frame40HostResidual = hostResidual;
    frame40RowP = rowDy;
    frame40LowerBoundary = lowerBoundary;
  }
}

assert.ok(maxBreach <= 0.001, `No breach allowed across 120 frames of solver timeline (max breach was ${maxBreach})`);
assert.ok(frame11LowerBoundary >= 252 + frame11Displacement - 0.001, 'Frame 11 peak displacement fully covered by lower blur boundary');
assert.ok(Math.abs(frame40HostResidual) < 1.0, 'Frame 40 host residual has nearly settled');
assert.ok(frame40RowP > 0, 'Frame 40 row spring is still settling');
assert.ok(frame40LowerBoundary >= 252 + frame40RowP - 0.001, 'Frame 40 row settling is still fully protected after host settled');

// 8c. Concurrent AmllLayoutCell motion test:
// Layout shift adds 50px of displacement (motion.value.p = 50)
amllMotionsRef.value = { 1: { row: 15, cell: 50, settled: false } };
amllResidualRef.value = 0;
assert.equal(styles[3]().transform[0].translateY, 252 + 15 + 50, 'Lower boundary includes combined row + AmllLayoutCell motion (65px total)');

// 8d. Interrupted cue and seek:
amllSeekRef.value++;
let seekNext = sharedPrepare();
sharedReact(seekNext, amllPrev);
amllPrev = seekNext;
// Seek retargets with new row position without dropping protection
amllMotionsRef.value = { 1: { row: 30, cell: 0, settled: false } };
assert.equal(styles[3]().transform[0].translateY, 252 + 30, 'Seek retargeting retains transformed envelope protection');

// 8e. Settled recovery:
amllMotionsRef.value = { 1: { row: 0, cell: 0, settled: true } };
amllResidualRef.value = 0;
assert.equal(styles[3]().transform[0].translateY, 252, 'Settled motions return strictly to static row bottom');

// 9. Test virtualization readiness (hasBlurGeometry) without full-song deadlock
const virtualizedRows = Array.from({ length: 40 }, (_, i) => ({
  y: i * 80,
  height: i < 3 ? 80 : 0, // only first 3 items mounted by FlashList
  start: i * 1000,
  end: (i + 1) * 1000,
}));
assert(sharedApi.hasBlurGeometry(virtualizedRows, win, 1500), 'Active + next rows measured: ready even when offscreen rows are 0');

const coldUnmountedRows = virtualizedRows.map((r, i) => ({ ...r, height: i === 0 ? 0 : r.height }));
assert(!sharedApi.hasBlurGeometry(coldUnmountedRows, win, 1500), 'Unmeasured active row safely delays ready flag to prevent jump');

// 10. Test Source-Over optical composited output
assert.equal(typeof sharedApi.compositeAlpha, 'function');
assert.equal(sharedApi.compositeAlpha(0, 0), 0, 'Protected zone composite is strictly 0');
assert.equal(sharedApi.compositeAlpha(1, 0), 1, 'Near plateau composite is 1.0');
assert.equal(sharedApi.compositeAlpha(0, 1), 1, 'Far plateau composite is 1.0');
// Arithmetic 0.5 + 0.5 = 1.0 yields 0.75 optical composite in dual Source-Over passes:
assert.equal(sharedApi.compositeAlpha(0.5, 0.5), 0.75, 'Source-Over midpoint composite is 0.75, not an opaque 1.0 crossfade');

// 11. Test offscreen viewport clipping
const distantViewport = sharedApi.sharedBlurViewport({ top: 0, bottom: 300 }, 5000, 800);
assert(distantViewport.top <= -800, 'Distant scroll shifts upper mask out of viewport');
assert(distantViewport.bottom <= 0, 'Distant scroll clamps lower mask within safe limits');

// 12. Verify accessibility and tree invariants from component source
const sharedSource = read('components/lyrics/native/native-shared-blur.tsx');
assert.match(sharedSource, /pointerEvents="none"/);
assert.match(sharedSource, /accessibilityElementsHidden/);
assert.match(sharedSource, /importantForAccessibility="no-hide-descendants"/);
assert.match(sharedSource, /tint={tint}/, 'Uses profile tint');

// 13. Verify no per-voice Gaussian blur context or execution in native-lyric-row.tsx
const rowSource = read('components/lyrics/native/native-lyric-row.tsx');
assert(!rowSource.includes('NativeProgressiveBlurContext'), 'NativeProgressiveBlurContext removed from native-lyric-row.tsx');
assert(!rowSource.includes('measuredBlurRadius'), 'measuredBlurRadius removed from native-lyric-row.tsx');

// 14. Verify native-lyrics-view.tsx wiring for BOTH AMLL and Spicy (no spicy-only gate)
const viewSource = read('components/lyrics/native/native-lyrics-view.tsx');
assert.match(viewSource, /const sharedBlurEnabled = __DEV__ && fastLoading && \(Platform\.OS === 'ios' \|\| Platform\.OS === 'android' && Number\(Platform\.Version\) >= 31\) && Boolean\(SHARED_BLUR_PROFILES\[style\]\) && list === 'flash' && reveal === 'canvas';/);
assert(!viewSource.includes("style === 'spicy' && list === 'flash'"), 'No style spicy gate remains');
assert.match(viewSource, /NativeSharedBlurContext\.Provider value=\{sharedBlurReady\}/);
assert.match(viewSource, /geometry\.isHeightMeasured/, 'Requires real measured height, not estimates');
assert.match(viewSource, /style=\{style\}/, 'Passes renderer style to NativeSharedBlur');
assert.match(viewSource, /residual=\{scrollResidual\}/, 'Passes scroll residual for AMLL spring motion envelope');
assert.match(viewSource, /motions=\{motionRegistry\}/, 'Passes motion registry for AMLL row/cell spring motion envelope');

// 15. Verify exclusions: webviews, non-canvas reveals, and FlatList are NOT eligible for shared blur
assert(!viewSource.includes("reveal === 'cold' && sharedBlurEnabled"), 'Cold reveal excluded');
assert(!viewSource.includes("list === 'flat' && sharedBlurEnabled"), 'FlatList excluded');

console.log('Spicy + AMLL progressive shared blur PASS: per-renderer profiles (AMLL soft vs Spicy strong), complementary mask weights sum<=1, whole 3-row next+translation+dot protection, forward/reverse asymmetry clamping, scroll offset, seek, max3 bounded tiers, no per-voice Gaussian execution. Source/hook execution; no device proof.');
