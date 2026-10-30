/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const componentPath = path.resolve(__dirname, '../components/lyrics/native/native-interlude.tsx');
const motionPath = path.resolve(__dirname, '../components/lyrics/native/native-interlude-motion.ts');
const componentCode = buildSync({ entryPoints: [componentPath], bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['*'] }).outputFiles[0].text;
const motionCode = buildSync({ entryPoints: [motionPath], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const motionModule = { exports: {} };
new Function('module', 'exports', motionCode)(motionModule, motionModule.exports);
const { advanceSpicyDot, initialDotSpringState, spicyDotTiming } = motionModule.exports;

const start = 10_000, end = 40_000;
const timing = spicyDotTiming(start, end);
function snapshotAt(position) {
  return timing.map(([dotStart, dotEnd]) => advanceSpicyDot(initialDotSpringState(), position, dotStart, dotEnd, 0));
}
const middle = snapshotAt(24_800);
assert.equal(middle[0].opacity.p, 1, 'At a long-pause midpoint, a completed dot is filled');
assert.ok(middle[1].opacity.p > 0.35 && middle[1].opacity.p < 1, 'The current dot has partial progress');
assert.equal(middle[2].opacity.p, 0.35, 'A future dot remains in its empty baseline state');
const nearEnd = snapshotAt(35_000);
assert.equal(nearEnd[0].opacity.p, 1);
assert.equal(nearEnd[1].opacity.p, 1);
assert.ok(nearEnd[2].opacity.p > 0.35 && nearEnd[2].opacity.p < 1,
  'Near the end of a long pause, the final dot reflects current playback');

// Exercise SpicyDot itself before any frame callback, then after backward seek
// and refresh. This catches a default-state flash on mount and stale per-dot state.
let slots = [], cursor = 0, callbacks = [];
const dotHookSlots = [];
let sharedPosition = { value: 24_800 }, sharedSeek = { value: 0 };
const fonts = {};
const shallowEqual = (a, b) => a === b || a && b && typeof a === 'object' && typeof b === 'object' &&
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.is(a[key], b[key]));
const react = {
  memo: component => component,
  useContext() { cursor++; return fonts; },
  useMemo(factory, deps) {
    const index = cursor++, prior = slots[index];
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) slots[index] = { deps, value: factory() };
    return slots[index].value;
  },
  useCallback(callback) { cursor++; return callback; },
  useEffect() { cursor++; },
};
const modules = {
  react,
  'react-native': { StyleSheet: { create: value => value } },
  '@shopify/react-native-skia': { Canvas: 'Canvas', Shadow: 'Shadow', Text: 'SkiaText',
    matchFont: () => ({ measureText: () => ({ width: 8, height: 10, x: 0, y: 0 }), getGlyphWidths: () => [8], getGlyphIDs: () => [1] }) },
  'react-native-reanimated': { __esModule: true, default: { View: 'AnimatedView' }, Easing: { bezier: () => () => 0 },
    useSharedValue(value) { const index = cursor++, prior = slots[index]; if (!prior) slots[index] = { value }; return slots[index]; },
    useDerivedValue(callback) { cursor++; return { get value() { return callback(); } }; },
    useAnimatedReaction(prepare, reactToChange) {
      const index = cursor++, current = prepare(), prior = slots[index];
      if (!prior || !shallowEqual(current, prior.value)) reactToChange(current, prior?.value ?? null);
      slots[index] = { value: current };
    },
    useFrameCallback(callback) { cursor++; callbacks.push(callback); return { setActive() {} }; },
    useAnimatedStyle(callback) { cursor++; return callback(); },
    withTiming: value => value,
  },
  './native-interlude-motion': motionModule.exports,
  './native-lyrics-fonts': { NativeLyricsFontContext: {} },
  'react/jsx-runtime': { jsx(type, props, key) { return { type, props: { ...props, ...(key === undefined ? {} : { key }) } }; },
    jsxs(type, props, key) { return { type, props: { ...props, ...(key === undefined ? {} : { key }) } }; } },
};
const componentModule = { exports: {} };
vm.runInNewContext(componentCode, { module: componentModule, exports: componentModule.exports,
  require(name) { assert(name in modules, `native-only interlude harness missing import ${name}`); return modules[name]; } });
const NativeInterludeView = componentModule.exports.NativeInterludeView;
const interlude = { start, end };

function findDots(node, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (typeof node.type === 'function' && Number.isFinite(node.props?.start) && Number.isFinite(node.props?.end) &&
    node.props?.position && node.props?.seekVersion) result.push(node);
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) findDots(child, result);
  return result;
}
function renderDot(dotElement, dotIndex) {
  const parentSlots = slots, parentCursor = cursor;
  cursor = 0; slots = dotHookSlots[dotIndex] ?? []; callbacks = [];
  const props = { ...dotElement.props };
  props.position = sharedPosition;
  props.seekVersion = sharedSeek;
  props.start = timing[dotIndex][0];
  props.end = timing[dotIndex][1];
  const tree = dotElement.type(props);
  const animated = tree.props.style[1];
  assert.ok(animated && Number.isFinite(animated.opacity), 'Animated dot style is derived from current playback before a frame callback');
  dotHookSlots[dotIndex] = slots;
  slots = parentSlots; cursor = parentCursor;
  return { opacity: animated.opacity, callbacks };
}
function renderOuter() {
  cursor = 0; slots = [];
  const tree = NativeInterludeView({ interlude, position: sharedPosition, seekVersion: sharedSeek, spicy: true,
    fontSize: 20, viewportWidth: 390, right: false });
  const dots = findDots(tree);
  assert.equal(dots.length, 3, 'Native Spicy interlude retains exactly three dots');
  return dots;
}

const dotElements = renderOuter();
const firstResults = dotElements.map(renderDot);
const firstPaint = firstResults.map(result => result.opacity);
assert.deepEqual(firstPaint, middle.map(state => state.opacity.p),
  'First recorded native animated styles reflect the mounted playback position without waiting for a frame');
for (const result of firstResults) {
  assert.equal(result.callbacks.length, 1, 'Each mounted dot owns one native frame callback');
  result.callbacks[0]({ timeSincePreviousFrame: 16 });
}

sharedPosition = { value: 35_000 };
sharedSeek = { value: 1 };
const nearEndElements = renderOuter();
const nearEndResults = nearEndElements.map(renderDot);
const refreshed = nearEndResults.map(result => result.opacity);
assert.deepEqual(refreshed, nearEnd.map(state => state.opacity.p), 'Seek/refresh reprojects every dot from the new position');
for (const result of nearEndResults) result.callbacks[0]({ timeSincePreviousFrame: 16 });

sharedPosition = { value: 24_700 }; // backward seek while the renderer stays mounted
sharedSeek = { value: 2 };
const backwardElements = renderOuter();
const backward = backwardElements.map(renderDot).map(result => result.opacity);
assert.deepEqual(backward, snapshotAt(24_700).map(state => state.opacity.p), 'Backward seek does not preserve future dot state');

// Source-only guard: the current frame path still uses the existing spring
// update, and seek state only resets the private dot spring state.
const source = fs.readFileSync(componentPath, 'utf8');
assert.match(source, /seek:\s*seekVersion\.value/);
assert.match(source, /state\.value\.time\s*<\s*0[\s\S]*advanceSpicyDot\(state\.value,\s*position\.value,\s*start,\s*end,\s*0\)/);
console.log('Native Spicy interlude checks passed: mounted midpoint, near-end progress, future baseline, refresh, backward seek; mocked component styles, no device pixels.');
