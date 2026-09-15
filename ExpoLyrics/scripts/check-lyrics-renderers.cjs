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
  react: React,
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
    withTiming: (value) => value,
    withSpring: (value) => value,
    withDelay: (_, value) => value,
    cancelAnimation: () => {},
  },
  'zustand/react/shallow': { useShallow: (selector) => selector },
  '@/store/playback-store': {
    usePlaybackStore: Object.assign((selector) => selector(playback), { getState: () => playback }),
  },
};
function load(file) {
  const resolved = path.resolve(root, file);
  if (cache.has(resolved)) return cache.get(resolved).exports;
  const source = fs.readFileSync(resolved, 'utf8');
  const code = resolved.endsWith('lyric-line.tsx') ? babel.transformSync(source, {
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
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(resolved), name)) + '.ts');
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
  for (const landscapeMode of [false, true]) {
    for (const position of [0, 1500, 3000, 5000]) {
      for (const preview of [null, position]) {
        const line = makeLine(1000, 4500, 'Shining');
        line.backgroundSyllables = [{ text: 'echo', startTime: 800, endTime: 5500 }];
        line.translatedText = 'Translation';
        line.backgroundTranslatedText = 'Echo translation';
        playback = { playbackPosition: position, anchorPositionMs: position, anchorMonotonicMs: performance.now(), isPlaying: position > 0 && position < 5000 };
        paintedStyles = [];
        const html = renderToStaticMarkup(React.createElement(LyricLine, {
          line, isActive: position >= 1000 && position < 4500,
          isPast: position >= 4500, inactiveOpacityDistance: 1,
          shouldDrivePlaybackUpdates: true, showTranslatedText: true,
          tapEnabled: true, landscapeMode, fontScale: 0.9,
          playbackPositionOverrideMs: preview, blurAmount: 4,
          showPauseDotsBefore: true, pauseStartMs: 0,
          pauseVisualDurationMs: 7000, pauseHoldMs: 0,
        }));
        assert.ok(html.includes('Translation') && html.includes('Echo translation'));
        assert.ok(paintedStyles.some((style) => Math.abs(style.fontSize - 32 * 1.05 * 0.9) < 0.001), JSON.stringify({ platform, landscapeMode, position, preview, sizes: paintedStyles.map((s) => s.fontSize).filter(Boolean) }));
        assert.ok(paintedStyles.some((style) => style.alignItems === (landscapeMode ? 'flex-end' : 'flex-start')));
        assert.ok(paintedStyles.some((style) => style.filter?.[0]?.blur === 4), 'native blur is preserved on both platforms');
        const checkFinite = (value) => {
          if (typeof value === 'number') assert.ok(Number.isFinite(value), 'animated styles stay finite');
          else if (value && typeof value === 'object') Object.values(value).forEach(checkFinite);
        };
        paintedStyles.forEach(checkFinite);
      }
    }
  }
}
console.log('Lyrics checks passed: timeline, overlap/background ranges, seeks, credits, end padding, and 32 native mount scenarios.');

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
