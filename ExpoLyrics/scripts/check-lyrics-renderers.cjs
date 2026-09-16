/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const babel = require('@babel/core');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.resolve(__dirname, '..');
const cache = new Map();
let platform = 'ios';
let playback = {};
let paintedStyles = [];
let nativeEffects = [];
let nativeAnimations = 0;
let nativeCancellations = 0;
let testDocument;
let TestResizeObserver;
let testClock = performance;
const flatten = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
function primitive(name) {
  return function NativePrimitive({ children, style }) {
    paintedStyles.push({ name, ...flatten(style) });
    return React.createElement(name === 'Text' ? 'span' : 'div', null, children);
  };
}
const View = primitive('View');
const Text = primitive('Text');
const easing = (value) => value;
const Easing = { linear: easing, ease: easing, out: () => easing, inOut: () => easing, bezier: () => easing };
const uiRuntime = vm.createContext({});
function unpackWorklet(worklet) {
  assert.ok(worklet.__workletHash, 'animated callbacks must be compiled as worklets');
  const unpacked = { __closure: {} };
  for (const [name, value] of Object.entries(worklet.__closure)) {
    if (typeof value === 'function') {
      if (['cancelAnimation', 'withTiming', 'withSpring', 'withDelay'].includes(name) || value === easing) {
        unpacked.__closure[name] = value;
        continue;
      }
      assert.ok(value.__workletHash, `UI callback captured non-worklet helper ${name}`);
      unpacked.__closure[name] = unpackWorklet(value);
    } else {
      unpacked.__closure[name] = value;
    }
  }
  // Match Worklets' release value-unpacker: evaluate only the serialized source,
  // then bind its closure. No module globals or JS function hoisting are available.
  const fn = vm.runInContext(`(${worklet.__initData.code})`, uiRuntime).bind(unpacked);
  unpacked._recur = fn;
  return fn;
}
const mocks = {
  react: { ...React, useEffect: (effect) => { nativeEffects.push(effect); } },
  'react-native': {
    View, Text, Pressable: primitive('Pressable'),
    Animated: { View, Text },
    Platform: { get OS() { return platform; } },
    StyleSheet: { create: (styles) => styles },
  },
  'react-native-reanimated': {
    __esModule: true,
    default: { View, Text },
    Easing,
    FadeOut: { duration: () => ({ easing: () => ({}) }) },
    useSharedValue: (value) => React.useRef({ value }).current,
    useAnimatedStyle: (compute) => unpackWorklet(compute)(),
    useDerivedValue: (compute) => ({ value: unpackWorklet(compute)() }),
    useFrameCallback: (compute) => {
      const frame = unpackWorklet(compute);
      return { setActive: active => { if (active) frame({ timeSincePreviousFrame: 16 }); } };
    },
    useAnimatedReaction: (prepare, react) => unpackWorklet(react)(unpackWorklet(prepare)(), null),
    withTiming: (value) => { nativeAnimations++; return value; },
    withSpring: (value) => { nativeAnimations++; return value; },
    withDelay: (_, value) => value,
    cancelAnimation: () => { nativeCancellations++; },
    runOnUI: (worklet) => unpackWorklet(worklet),
  },
  '@react-native-masked-view/masked-view': { __esModule: true, default: ({ children, maskElement }) =>
    React.createElement('div', null, maskElement, children) },
  'expo-linear-gradient': { LinearGradient: primitive('LinearGradient') },
  'zustand/react/shallow': { useShallow: (selector) => selector },
  '@/store/playback-store': {
    usePlaybackStore: Object.assign((selector) => selector(playback), { getState: () => playback }),
  },
};
function load(file) {
  const resolved = path.resolve(root, file);
  if (cache.has(resolved)) return cache.get(resolved).exports;
  const source = fs.readFileSync(resolved, 'utf8');
  const code = /lyric-line\.tsx|native-lyric-.*\.tsx|amll-native\.ts$/.test(resolved) ? babel.transformSync(source, {
    filename: resolved,
    babelrc: false,
    configFile: false,
    presets: ['babel-preset-expo'],
    caller: { name: 'metro', platform, supportsStaticESM: false },
    envName: 'production',
  }).code : ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  cache.set(resolved, module);
  const localRequire = (name) => {
    if (mocks[name]) return mocks[name];
    if (name.startsWith('@/')) return load(name.slice(2) + '.ts');
    if (name.startsWith('.')) {
      const target = path.resolve(path.dirname(resolved), name);
      return load(path.relative(root, target) + (fs.existsSync(target + '.tsx') ? '.tsx' : '.ts'));
    }
    return require(name);
  };
  vm.runInThisContext(`(function(require,module,exports,document,ResizeObserver,performance){${code}\n})`, { filename: resolved })(localRequire, module, module.exports, testDocument, TestResizeObserver, testClock);
  return module.exports;
}
const layout = load('lib/lyrics-layout.ts');
const makeLine = (start, end, text = 'Held words') => ({
  lineStartTime: start, lineEndTime: end,
  syllables: [{ text, startTime: start, endTime: end }],
});
const lines = [makeLine(1000, 4500), makeLine(3000, 5000), makeLine(6500, 8000), makeLine(16000, 18000)];
lines[0].backgroundSyllables = [{ text: 'echo', startTime: 2500, endTime: 5500 }];
function rangeAt(position) {
  const state = layout.getPlaybackWindowState(position, lines);
  return layout.getAutoScrollTargetRange(state, position, lines);
}
assert.deepEqual(rangeAt(3500), { startIndex: 0, endIndex: 1 }, 'overlaps anchor to the first active line');
assert.deepEqual(rangeAt(4800), { startIndex: 0, endIndex: 1 }, 'background extensions stay visible with the next lead');
assert.deepEqual(rangeAt(6000), { startIndex: 2, endIndex: 2 }, 'short gaps move to the next line');
assert.equal(layout.getPlaybackWindowState(10000, lines).isLongPause, true);
assert.equal(layout.getPlaybackWindowState(18000, lines).isLongPause, false);
assert.deepEqual(rangeAt(2000), { startIndex: 0, endIndex: 0 }, 'backward seeks rebuild the range');
assert.equal(layout.getAutoScrollTargetRange(layout.EMPTY_WINDOW_STATE, 0, []), null);
for (const anchor of [0, 32]) {
  const padding = layout.getBottomListPadding({ viewportHeight: 400, lyricsLength: 4, lastLineTop: 600, lastLineHeight: 84, creditsLayout: null, hasCredits: false, activeLineTopOffset: anchor });
  assert.equal(600 + 84 + padding - 400, 600 - anchor, 'last row reaches the native anchor without dead space');
}
assert.equal(layout.getCreditsAwareScrollOffset({ range: { startIndex: 3, endIndex: 3 }, lyricsLength: 4, listHeight: 400, creditsLayout: { top: 700, bottom: 1200 }, getAbsoluteLineTop: () => 600, creditsActive: true, hasCredits: true }), 824);

// Compile with Expo's production Babel/Worklets transform, then mount the actual
// native component and execute the animated-style callbacks. Plain TypeScript
// transpilation misses eager worklet closures capturing uninitialized helpers.
// Host primitives are mocked; this does not replace an iOS device test.
for (platform of ['ios', 'android']) {
  cache.delete(path.resolve(root, 'components/lyrics/lyric-line.tsx'));
  const { LyricLine } = load('components/lyrics/lyric-line.tsx');
  for (const rendererActive of [true, false]) {
  for (const landscapeMode of [false, true]) {
    for (const position of [0, 1500, 3000, 5000]) {
      for (const preview of [null, position]) {
        const line = makeLine(1000, 4500, 'Shining');
        line.backgroundSyllables = [{ text: 'echo', startTime: 800, endTime: 5500 }];
        line.translatedText = 'Translation';
        line.backgroundTranslatedText = 'Echo translation';
        playback = { playbackPosition: position, anchorPositionMs: position, anchorMonotonicMs: performance.now(), isPlaying: position > 0 && position < 5000 };
        paintedStyles = [];
        nativeEffects = [];
        nativeAnimations = nativeCancellations = 0;
        const html = renderToStaticMarkup(React.createElement(LyricLine, {
          rendererActive,
          line, isActive: position >= 1000 && position < 4500,
          isPast: position >= 4500, inactiveOpacityDistance: 1,
          shouldDrivePlaybackUpdates: true, showTranslatedText: true,
          tapEnabled: true, landscapeMode, fontScale: 0.9,
          playbackPositionOverrideMs: preview, blurAmount: 4,
          showPauseDotsBefore: true, pauseStartMs: 0,
          pauseVisualDurationMs: 7000, pauseHoldMs: 0,
        }));
        assert.ok(html.includes('Translation') && html.includes('Echo translation'));
        assert.equal(html.replace(/<[^>]*>/g, '').split('Shining').length - 1, 1,
          'the native lead paints a single text copy during playback and preview');
        assert.ok(!paintedStyles.some(style => style.overflow === 'hidden' && style.position === 'absolute'),
          'native reveal has no overlapping animated clip layers');
        assert.ok(paintedStyles.some((style) => Math.abs(style.fontSize - 32 * 1.05 * 0.9) < 0.001), JSON.stringify({ platform, landscapeMode, position, preview, sizes: paintedStyles.map((s) => s.fontSize).filter(Boolean) }));
        assert.ok(paintedStyles.some((style) => style.alignItems === (landscapeMode ? 'flex-end' : 'flex-start')));
        assert.ok(paintedStyles.some((style) => style.filter?.[0]?.blur === 4), 'native blur is preserved on both platforms');
        const checkFinite = (value) => {
          if (typeof value === 'number') assert.ok(Number.isFinite(value), 'animated styles stay finite');
          else if (value && typeof value === 'object') Object.values(value).forEach(checkFinite);
        };
        paintedStyles.forEach(checkFinite);
        const cleanups = nativeEffects.map((effect) => effect()).filter((cleanup) => typeof cleanup === 'function');
        if (!rendererActive) {
          assert.equal(nativeAnimations, 0, 'hidden native rows, backgrounds and dots start no animations');
        } else {
          assert.ok(nativeAnimations > 0, 'visible native rows retain their animation effects');
        }
        const cancellationsBeforeUnmount = nativeCancellations;
        cleanups.forEach((cleanup) => cleanup());
        if (nativeAnimations > 0) {
          assert.ok(nativeCancellations - cancellationsBeforeUnmount >= nativeAnimations,
            'unmounted/recycled rows cancel every animation they started');
        }
      }
    }
  }
  }
}
console.log('Lyrics checks passed: timeline, overlap/background ranges, seeks, credits, end padding, and 64 native mount/effect scenarios including hidden rows and unmount cleanup.');

const { syncNativeTimeline } = load('components/lyrics/native-lyric-token.tsx');
let revealValue = 500;
const revealWrites = [];
const revealProgress = { get value() { return revealValue; }, set value(value) { revealWrites.push(value); revealValue = value; } };
syncNativeTimeline(revealProgress, 550, 1000, true);
assert.deepEqual(revealWrites, [1000], 'small native clock corrections retarget without resetting the reveal value');
revealWrites.length = 0;
syncNativeTimeline(revealProgress, 100, 1000, true);
assert.deepEqual(revealWrites, [100, 1000], 'large native seeks reset progress immediately before continuing');
revealWrites.length = 0;
syncNativeTimeline(revealProgress, 600, 1000, false);
assert.deepEqual(revealWrites, [600], 'paused native previews remain exact');

// Golden values from AMLL 0.5.2's line mask, emphasis, interlude and layout
// algorithms. Run the serialized production worklets, not their JS originals.
const amll = load('lib/amll-native.ts');
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.0001, `${label}: ${actual} != ${expected}`);
const maskCursor = unpackWorklet(amll.amlMaskCursor);
const maskWords = [{text:'thin',startTime:1000,endTime:2000},{text:'wide',startTime:2500,endTime:4500}];
near(maskCursor(1000, maskWords, [40, 120], 20), -40, 'first word begins behind a full feather');
near(maskCursor(1500, maskWords, [40, 120], 20), -5, 'measured first-word sweep');
near(maskCursor(2000, maskWords, [40, 120], 20), 30, 'feather straddles adjacent words');
near(maskCursor(2400, maskWords, [40, 120], 20), 30, 'silence holds the cursor');
near(maskCursor(3500, maskWords, [40, 120], 20), 95, 'wide glyphs use actual width');
near(maskCursor(4500, maskWords, [40, 120], 20), 160, 'last word finishes the complete sweep');
near(maskCursor(500, maskWords, [40, 120], 20), -40, 'backward seek clears the highlight');
assert.equal(amll.shouldEmphasizeAml('shine', 999), false);
assert.equal(amll.shouldEmphasizeAml('shine', 1000), true);
assert.equal(amll.shouldEmphasizeAml('I', 2000), false);
assert.equal(amll.shouldEmphasizeAml('something', 2000), false);
assert.equal(amll.shouldEmphasizeAml('光', 2000), true);
const params = amll.amlEmphasisParameters(2000, true);
near(params.duration, 2400, 'last-word animation extends by 20%');
near(params.amount, 0.96, 'last-word expansion');
near(params.blur, 2 / 9, 'last-word glow');
const emphasisAt = unpackWorklet(amll.amlEmphasis);
const peak = emphasisAt(2200, 1000, 0, 4, params, 32, false);
near(peak.scale, 1.096, 'reference midpoint scale');
near(peak.shadowOpacity, 2 / 9, 'reference midpoint glow');
near(peak.shadowRadius, 32 / 15, 'reference glow radius');
near(emphasisAt(10000, 1000, 0, 4, params, 32, false).scale, 1, 'completed emphasis restores geometry');
const floatAt = unpackWorklet(amll.amlFloat);
near(floatAt(3000, 1000, 2000, 32, false), -1.6, 'lead floats .05em');
near(floatAt(3000, 1000, 2000, 32, true), -3.2, 'background floats .1em');
near(amll.amlBlur(2, 3, 4, false, false), 2.4, 'past lines receive the extra blur step');
assert.equal(amll.amlBlur(5, 3, 4, false, false), 1.6);
assert.equal(amll.amlBlur(5, 3, 4, false, true), 0);
near(amll.amlStagger(4, 2, 3), 100, 'row stagger starts at 50ms');
near(amll.amlStagger(5, 2, 3), 147.6190476, 'stagger decays after focus');
near(amll.amlPositionSpring(100, false, false).stiffness, 220, 'rapid lines use a faster spring');
near(amll.amlPositionSpring(800, false, false).stiffness, 170, 'spaced lines use a softer spring');
near(amll.amlPositionSpring(100, true, false).stiffness, 90, 'seek uses the reference slow spring');
const dotsAt = unpackWorklet(amll.amlInterlude);
near(dotsAt(400, 8000).opacity, 0, 'interlude waits before entering');
near(dotsAt(750, 8000).opacity, 0.5, 'interlude entry fade');
near(dotsAt(7900, 8000).opacity, 100 / 375, 'interlude exit fade');
near(dotsAt(8000, 8000).scale, 0, 'interlude exits completely');
console.log('AMLL 0.5.2 parity checks passed: measured mask boundaries, held-word emphasis, float, blur, stagger, spring policy and interlude snapshots.');

// Exercise the WebView scroll controller against measured DOM boxes, without a
// browser or external connector. Visual/CSS checks live in the preview harness.
let clockMs = 0;
let landscape = false;
class ElementBox {
  children = [];
  parentElement = null;
  dataset = {};
  hidden = false;
  scrollTop = 0;
  clientHeight = 400;
  className = '';
  classes = new Set();
  classList = { add: (...names) => names.forEach((n) => this.classes.add(n)), remove: (...names) => names.forEach((n) => this.classes.delete(n)), toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name), contains: (name) => this.classes.has(name) };
  isConnected = true;
  style = { setProperty: (name, value) => { this.style[name] = value; } };
  appendChild(child) {
    if (child.parentElement) child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
    child.parentElement = this;
    this.children.push(child);
  }
  prepend(child) { this.appendChild(child); this.children.unshift(this.children.pop()); }
  closest() { return landscape ? this : null; }
  get offsetTop() {
    if (this.className === 'content') return landscape ? 168 : 150;
    if (this.className === 'ks-lyric-row') return this.parentElement.children.indexOf(this) * 84;
    return 0;
  }
  get offsetHeight() { return this.className === 'ks-lyric-row' ? 84 : 0; }
}
testClock = { now: () => clockMs };
testDocument = { createElement: () => new ElementBox(), getElementById: () => null };
TestResizeObserver = class { observe() {} disconnect() {} };
const host = load('components/lyrics/spicy-layout-host.ts');
const source = Array.from({ length: 10 }, (_, i) => makeLine(i * 2000 + 1000, i * 2000 + 2500));
const viewport = new ElementBox();
const scrollRoot = new ElementBox();
const content = new ElementBox();
content.className = 'content';
scrollRoot.appendChild(content);
const runtime = source.map((line, sourceIndex) => ({ sourceIndex, StartTime: line.lineStartTime, EndTime: line.lineEndTime, HTMLElement: new ElementBox() }));
let followChanges = [];
const onFollow = (enabled) => followChanges.push(enabled);
host.initLyricsLayout(viewport, content, runtime, source);
host.scrollToActiveLine(1500, true, true, onFollow);
assert.equal(viewport.scrollTop, 150, 'mid-song open uses native portrait anchor');
host.scrollToActiveLine(2750, true, false, onFollow);
assert.ok(content.children[1].classList.contains('ks-preactive'), 'short gap highlights the same upcoming row that scrolling targets');
assert.equal(runtime[1].StartTime, 3000, 'preactivation never changes word/line timestamps');
host.scrollToActiveLine(3500, true, true, onFollow);
assert.ok(!content.children[1].classList.contains('ks-preactive'), 'preactivation clears at the actual start');
clockMs += 500;
host.scrollToActiveLine(3500, true, false, onFollow);
assert.equal(viewport.scrollTop, 234, 'seek anchors the correct measured row');
viewport.scrollTop = 700;
host.scrollToActiveLine(5500, false, false, onFollow);
assert.equal(viewport.scrollTop, 700, 'disabled follow never overrides manual scroll');
host.scrollToActiveLine(5500, true, true, onFollow);
clockMs += 500;
host.scrollToActiveLine(5500, true, false, onFollow);
assert.equal(viewport.scrollTop, 318, 'resume reaches active row');
clockMs = 3000;
viewport.scrollTop = 800;
host.noteLyricsUserScroll();
host.scrollToActiveLine(5500, true, false, onFollow);
assert.deepEqual(followChanges, [false], 'dragging away disables follow');
viewport.scrollTop = 318;
host.scrollToActiveLine(5500, false, false, onFollow);
assert.deepEqual(followChanges, [false, true], 'dragging back to the anchor resumes follow');
clockMs += 1000;
landscape = true;
host.resetLyricsScroll();
host.scrollToActiveLine(5500, true, true, onFollow);
assert.equal(viewport.scrollTop, 168 + 168 - 32, 'landscape uses 32px offset and 168px leading inset');
host.scrollToActiveLine(19500, true, true, onFollow);
assert.equal(viewport.scrollTop, 168 + 9 * 84 - 32, 'last line reaches landscape anchor');
assert.equal(parseFloat(scrollRoot.style['padding-bottom']), 400 - 84 - 32, 'bottom padding has no excess blank region');
assert.equal(content.children.length, source.length, 'one layout row per source line');
assert.ok(host.lyricScrollEasing(0.5) > 0.8 && host.lyricScrollEasing(0.5) < 1);
host.destroyLyricsLayout();
console.log('WebView controller checks passed: measured anchors, seeks, manual scroll, resume, landscape and last-line padding.');

const touchContent = new ElementBox();
touchContent.className = 'content';
scrollRoot.appendChild(touchContent);
host.initLyricsLayout(viewport, touchContent, runtime, source);
host.scrollToActiveLine(1500, true, true, () => {});
host.scrollToActiveLine(3500, true, true, () => {});
host.setLyricsUserTouching(true);
viewport.scrollTop = 600;
clockMs += 1500;
host.scrollToActiveLine(3500, true, false, () => {});
assert.equal(viewport.scrollTop, 600, 'a held touch wins over auto-follow after the idle interval');
host.setLyricsUserTouching(false);
for (let i = 0; i < 8; i++) {
  clockMs += 200;
  viewport.scrollTop += 10;
  host.noteLyricsViewportScroll();
  const manualOffset = viewport.scrollTop;
  host.scrollToActiveLine(3500, true, false, () => {});
  assert.equal(viewport.scrollTop, manualOffset, 'momentum keeps ownership beyond 700ms');
}
host.releaseLyricsUserScroll();
host.scrollToActiveLine(9500, true, true, () => {});
assert.notEqual(viewport.scrollTop, 680, 'an explicit seek releases manual ownership immediately');
host.destroyLyricsLayout();

const { getSpicyWordJoins } = load('components/lyrics/spicy-word-spacing.ts');
assert.deepEqual(getSpicyWordJoins([{ text: '한' }, { text: '글 ' }, { text: '가' }, { text: '사' }]),
  [true, false, true, false], 'KRC Korean syllables join only within source words');
assert.deepEqual(getSpicyWordJoins([{ text: 'some', isPartOfWord: true }, { text: 'thing', isPartOfWord: false }, { text: 'new', isPartOfWord: false }]),
  [true, false, false], 'explicit Spicy join flags remain authoritative');
assert.deepEqual(getSpicyWordJoins([{ text: 'one' }, { text: ' two' }, { text: ' ' }, { text: 'three' }]),
  [false, false, false, false], 'leading/standalone spaces are boundaries too');

const { createSpicyPlaybackClock } = load('components/lyrics/spicy-playback-clock.ts');
for (const hz of [60, 90, 120, 144]) {
  const clock = createSpicyPlaybackClock();
  clock.sync(1000, true, 0);
  clock.sync(1950, true, 1000);
  assert.equal(clock.position(1000), 2000, 'a small backward packet never snaps the displayed clock');
  let previous = 2000;
  for (let i = 1; i <= hz; i++) {
    const value = clock.position(1000 + i * 1000 / hz);
    assert.ok(value > previous && value - previous <= 1.1 * 1000 / hz + 0.001, 'sync slews smoothly at every refresh rate');
    previous = value;
  }
  assert.equal(previous, 2950, 'correction converges without requiring another packet');
  clock.sync(3100, true, 2000);
  assert.equal(clock.position(2000), previous, 'forward corrections also preserve phase');
  clock.sync(3000, true, 2000, true);
  assert.equal(clock.position(2000), 3000, 'even a short explicit seek bypasses smoothing');
  clock.sync(400, true, 2100, true);
  assert.equal(clock.position(2100), 400, 'explicit backward seeks remain immediate');
  clock.sync(500, false, 2200);
  assert.equal(clock.position(4000), 500, 'pause never drifts');
}

const longSource = Array.from({ length: 1000 }, (_, i) => makeLine(i * 2000, i * 2000 + 1500));
const longContent = new ElementBox();
longContent.className = 'content';
scrollRoot.appendChild(longContent);
const longRuntime = longSource.map((line, sourceIndex) => ({ sourceIndex, StartTime: line.lineStartTime, EndTime: line.lineEndTime, HTMLElement: new ElementBox() }));
host.initLyricsLayout(viewport, longContent, longRuntime, longSource);
host.scrollToActiveLine(1000100, true, true, onFollow);
const visible = host.getVisibleLyricsLines();
assert.ok(visible.length > 0 && visible.length < 20, '1000 source rows only animate viewport plus overscan');
assert.ok(visible.some((line) => line.sourceIndex === 500));
assert.ok(longContent.children[0].classList.contains('ks-offscreen'), 'offscreen rows retain space without painting');
host.destroyLyricsLayout();

const { createLyricsFrameLoop } = load('components/lyrics/spicy-frame-loop.ts');
let nextId = 0, renders = 0, delay = null;
const frames = new Map(), timers = new Map();
const loop = createLyricsFrameLoop({
  requestFrame: (cb) => { frames.set(++nextId, cb); return nextId; },
  cancelFrame: (id) => frames.delete(id),
  setTimer: (cb, ms) => { timers.set(++nextId, { cb, ms }); return nextId; },
  clearTimer: (id) => timers.delete(id),
  render: () => { renders++; return delay; },
});
const flushFrame = () => { const [id, cb] = frames.entries().next().value; frames.delete(id); cb(); };
loop.wake(); loop.wake();
assert.equal(frames.size, 1, 'bridge bursts coalesce into one frame');
flushFrame();
assert.equal(frames.size + timers.size, 0, 'paused/settled renderer has no outstanding callbacks');
delay = 0; loop.wake(); flushFrame();
assert.equal(frames.size, 1, 'animation continues at display refresh rate');
loop.setSuspended(true);
assert.equal(frames.size + timers.size, 0, 'backgrounding cancels work immediately');
loop.wake(); assert.equal(frames.size, 0, 'hidden bridge updates cannot restart rendering');
delay = 1200; loop.setSuspended(false); flushFrame();
assert.equal(timers.values().next().value.ms, 1200, 'gaps sleep until the next timeline cue');
loop.wake(); assert.equal(timers.size, 0, 'seeks cancel obsolete gap timers');
flushFrame(); loop.setSuspended(true);
assert.equal(frames.size + timers.size, 0, 'suspension also cancels a sleeping timer');
assert.ok(renders >= 3);

const spicy = load('components/lyrics/spicy-upstream-runtime.ts');
let styleWrites = 0;
const wordElement = new ElementBox();
wordElement.style.setProperty = (name, value) => { styleWrites++; wordElement.style[name] = value; };
const animated = { HTMLElement: new ElementBox(), StartTime: 1000, EndTime: 4500, TotalTime: 3500, sourceIndex: 0,
  Syllables: { Lead: [{ HTMLElement: wordElement, StartTime: 1000, EndTime: 4500, TotalTime: 3500 }] } };
spicy.resetSpicyAnimatorState();
spicy.animate([animated], 1500, 'Syllable', 0, true);
clockMs += 16;
spicy.animate([animated], 2000, 'Syllable', 0, false);
let moving = true;
for (let i = 0; i < 1000 && moving; i++) { clockMs += 16; moving = spicy.animate([animated], 2000, 'Syllable', 0, false); }
assert.equal(moving, false, 'paused springs eventually sleep');
const settledWrites = styleWrites;
for (let i = 0; i < 120; i++) { clockMs += 16; spicy.animate([animated], 2000, 'Syllable', 0, false); }
assert.equal(styleWrites, settledWrites, 'settled words cause zero repeated style writes');
clockMs += 16;
spicy.animate([animated], 500, 'Syllable', 0, false);
assert.equal(wordElement.style['--gradient-position'], '-20%', 'backward seek resets the reveal before start');
assert.ok(animated.HTMLElement.classList.contains('NotSung'));
spicy.animate([], 4000);
clockMs += 16;
spicy.animate([animated], 5000, 'Syllable', 0, false);
assert.equal(wordElement.style['--gradient-position'], '100%', 'offscreen reentry paints the current timestamp');
console.log('Performance checks passed: bounded visible work, advance highlight, idle/suspended scheduling, spring sleep and seek recovery.');

const futureWords = Array.from({ length: 100 }, (_, i) => ({ HTMLElement: new ElementBox(), StartTime: 5000 + i * 100, EndTime: 5100 + i * 100, TotalTime: 100 }));
const sparseLine = { HTMLElement: new ElementBox(), StartTime: 1000, EndTime: 20000, TotalTime: 19000, sourceIndex: 0, Syllables: { Lead: futureWords } };
spicy.resetSpicyAnimatorState();
spicy.animate([sparseLine], 1000);
let springSteps = 0;
for (const word of futureWords) for (const spring of Object.values(word.AnimatorStore)) {
  const step = spring.Step.bind(spring);
  spring.Step = (dt) => { springSteps++; return step(dt); };
}
for (let i = 1; i <= 120; i++) { clockMs += 1000 / 120; spicy.animate([sparseLine], 1000 + i * 1000 / 120); }
assert.equal(springSteps, 0, '120Hz active lines do not step springs for 100 settled future words');
clockMs += 1000 / 120;
spicy.animate([sparseLine], 5050);
assert.ok(springSteps > 0, 'the same words wake on their real timestamps');
console.log('Additional checks passed: touch/momentum ownership, KRC spacing, continuous 60/90/120/144Hz clocks and settled-word spring suppression.');
