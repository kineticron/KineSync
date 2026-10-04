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

// Both lyrics styles are WebViews now: Spicy and AMLL (restored from main).
// The poor-performing AMLL native port (lyric-line, lyrics-view, native-*, amll-native)
// was removed. Verify both bundles, both view components, the style store, and wiring.
const spicyBundleSource = fs.readFileSync(path.resolve(root, 'components/lyrics/spicy-webview-bundle.ts'), 'utf8');
assert.ok(spicyBundleSource.includes('SPICY_WEBVIEW_JS'), 'Spicy WebView bundle exports JS');
assert.ok(spicyBundleSource.includes('SPICY_WEBVIEW_CSS'), 'Spicy WebView bundle exports CSS');
const amllBundleSource = fs.readFileSync(path.resolve(root, 'components/lyrics/amll-webview-bundle.ts'), 'utf8');
assert.ok(amllBundleSource.includes('AMLL_WEBVIEW_JS'), 'AMLL WebView bundle exports JS');
assert.ok(amllBundleSource.includes('AMLL_WEBVIEW_CSS'), 'AMLL WebView bundle exports CSS');
const spicyViewSource = fs.readFileSync(path.resolve(root, 'components/lyrics/spicy-lyrics-view.tsx'), 'utf8');
assert.ok(spicyViewSource.includes('SpicyLyricsView'), 'Spicy view component exists');
assert.ok(spicyViewSource.includes('spicy-webview-bundle'), 'Spicy view uses the Spicy bundle');
assert.ok(spicyViewSource.includes('spicy-lyrics-'), 'Spicy view remount key is style-scoped');
const amllViewSource = fs.readFileSync(path.resolve(root, 'components/lyrics/amll-lyrics-view.tsx'), 'utf8');
assert.ok(amllViewSource.includes('AmllLyricsView'), 'AMLL view component exists');
assert.ok(amllViewSource.includes('amll-webview-bundle'), 'AMLL view uses the AMLL bundle');
assert.ok(amllViewSource.includes('amll-lyrics-'), 'AMLL view remount key is style-scoped');
assert.ok(amllViewSource.includes('anchorMonotonicMs'), 'AMLL view projects the anchor clock like Spicy');
assert.ok(amllViewSource.includes('isPartOfWord'), 'AMLL view forwards join flags for Spicy sources');
const amllEntrySource = fs.readFileSync(path.resolve(root, 'components/lyrics/amll-webview-entry.ts'), 'utf8');
assert.ok(amllEntrySource.includes('buildAmllWords'), 'AMLL entry groups flagged fragments into words');
for (const removed of ['components/lyrics/lyric-line.tsx', 'components/lyrics/lyrics-view.tsx', 'components/lyrics/native-lyric-token.tsx', 'components/lyrics/native-lyric-motion.tsx', 'lib/amll-native.ts', 'app/amll-native-preview.tsx', 'components/lyrics/web-lyrics-view.tsx']) {
  assert.ok(!fs.existsSync(path.resolve(root, removed)), `native implementation removed: ${removed}`);
}
const storeSource = fs.readFileSync(path.resolve(root, 'store/playback-store.ts'), 'utf8');
assert.ok(storeSource.includes("LyricsStyle = 'spicy' | 'amll'") || storeSource.includes('spicy'), 'store defines Spicy/AMLL style');
assert.ok(storeSource.includes('lyricsStyle'), 'store exposes lyricsStyle');
assert.ok(!storeSource.includes("lyricsRendererMode: 'webview'"), 'legacy native/webview default is gone');
const settingsSource = fs.readFileSync(path.resolve(root, 'components/lyrics/settings-menu.tsx'), 'utf8');
assert.ok(!settingsSource.includes('Use WebView lyrics'), 'settings no longer toggles WebView vs native');
assert.ok(settingsSource.includes('lyricsStyle'), 'settings exposes lyrics style');
assert.ok(settingsSource.includes('Lyrics renderer'), 'renderer switch lives in its own labeled section');
assert.ok(settingsSource.includes('RendererOption'), 'renderer switch uses a dedicated picker, not source chips');
const homeSource = fs.readFileSync(path.resolve(root, 'app/(tabs)/index.tsx'), 'utf8');
assert.ok(homeSource.includes('SpicyLyricsView') && homeSource.includes('AmllLyricsView'), 'home renders both WebView styles');
assert.ok(!homeSource.includes('from "@/components/lyrics/lyrics-view"'), 'home no longer mounts the native renderer');
console.log('Lyrics checks passed: timeline, overlap/background ranges, seeks, credits, end padding, and Spicy/AMLL dual-WebView wiring.');


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
assert.ok([
  host.lyricScrollDuration(undefined, false, false, 84),
  host.lyricScrollDuration(300, true, false, 84),
  host.lyricScrollDuration(300, false, true, 84),
].every((duration) => duration === 440), 'unknown intervals, seeks and interludes keep the base scroll pace');
const rapidScroll = host.lyricScrollDuration(100, false, false, 84);
const spacedScroll = host.lyricScrollDuration(800, false, false, 84);
const farScroll = host.lyricScrollDuration(800, false, false, 600);
assert.ok(rapidScroll < spacedScroll && rapidScroll >= 240 && spacedScroll <= 440,
  `rapid lines snap quicker than spaced lines (${rapidScroll} < ${spacedScroll})`);
assert.ok(farScroll >= spacedScroll && farScroll <= 440, 'longer glides take longer without exceeding the base');
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

// Opposite lines rely on upstream's column-gap (their ::after margins are
// zeroed upstream); only all-literal lines may zero it.
const spicyLayoutCss = fs.readFileSync(path.resolve(root, 'components/lyrics/spicy-layout.css'), 'utf8');
assert.ok(spicyLayoutCss.includes('.KineSyncLyricsRows .line.ks-literal-line'),
  'column-gap zeroing must be scoped to literal-spaced lines');
assert.ok(!/\.KineSyncLyricsRows \.line\s*\{[^}]*column-gap/.test(spicyLayoutCss),
  'no blanket column-gap override may shadow upstream opposite-line gaps');
const spicyEntrySource = fs.readFileSync(path.resolve(root, 'components/lyrics/spicy-webview-entry.ts'), 'utf8');
assert.ok(spicyEntrySource.includes('ks-literal-line'),
  'the WebView entry must mark all-literal lines for the scoped gap rule');

const { getSpicyWordJoins } = load('components/lyrics/spicy-word-spacing.ts');
assert.deepEqual(getSpicyWordJoins([{ text: '한' }, { text: '글 ' }, { text: '가' }, { text: '사' }]),
  [true, false, true, false], 'KRC Korean syllables join only within source words');
assert.deepEqual(getSpicyWordJoins([{ text: 'some', isPartOfWord: true }, { text: 'thing', isPartOfWord: false }, { text: 'new', isPartOfWord: false }]),
  [true, false, false], 'explicit Spicy join flags remain authoritative');
assert.deepEqual(getSpicyWordJoins([{ text: 'one' }, { text: ' two' }, { text: ' ' }, { text: 'three' }]),
  [false, false, false, false], 'leading/standalone spaces are boundaries too');

const { buildAmllWords } = load('components/lyrics/amll-word-spacing.ts');
const { getGraphemes } = load('lib/graphemes.ts');
const { repairSyllableClusters } = load('components/lyrics/cluster-safe-syllables.ts');
for (const [text, expected] of [
  ['कि', ['कि']], ['क्षि', ['क्षि']], ['కై', ['కై']], ['క్షి', ['క్షి']],
  ['น้ำ', ['น้ำ']], ['กิ้', ['กิ้']], ['👩🏽‍💻', ['👩🏽‍💻']], ['e\u0301', ['e\u0301']],
]) {
  assert.deepEqual(getGraphemes(text), expected, `complete clusters: ${text}`);
  const input = Array.from(text, (char, index) => ({ text: char, startTime: index * 300,
    endTime: (index + 1) * 300, isPartOfWord: index < Array.from(text).length - 1 }));
  const snapshot = JSON.stringify(input);
  const repaired = repairSyllableClusters(input);
  assert.deepEqual(repaired.map(part => part.text), expected, `repair timed fragments: ${text}`);
  assert.equal(repaired[0].startTime, 0);
  assert.equal(repaired.at(-1).endTime, input.at(-1).endTime);
  assert.equal(repaired.at(-1).isPartOfWord, false);
  assert.equal(JSON.stringify(input), snapshot, 'provider timing input stays immutable');
  assert.deepEqual(repairSyllableClusters(repaired), repaired, 'repair is idempotent');
  assert.equal(buildAmllWords(input, 0, 5000).map(part => part.word).join(''), text,
    'AMLL adds no spaces inside a repaired cluster');
}
const safeTokens = [{ text: 'Hello ', startTime: 100, endTime: 200 }, { text: 'world', startTime: 200, endTime: 500 }];
assert.deepEqual(repairSyllableClusters(safeTokens), safeTokens, 'safe text and timestamps stay intact');
assert.equal(repairSyllableClusters(safeTokens)[0], safeTokens[0], 'safe tokens retain identity');
const indicFragments = ['क', 'ि', 'ता', 'ब ', 'నీ', 'కు'].map((text, index) => ({
  text, startTime: index * 200, endTime: (index + 1) * 200,
}));
assert.equal(buildAmllWords(indicFragments, 0, 1200).map(word => word.word).join(''), 'किताब నీకు',
  'literal Indic fragments keep safe clusters together without invented word spaces');
const oldIntlSegmenter = Intl.Segmenter;
try {
  Intl.Segmenter = undefined;
  assert.deepEqual(getGraphemes('श्री'), ['श्री'], 'no Intl.Segmenter required');
} finally {
  Intl.Segmenter = oldIntlSegmenter;
}
const amllFlagged = buildAmllWords([
  { text: 'Hel', startTime: 1000, endTime: 1200, isPartOfWord: true },
  { text: 'lo', startTime: 1200, endTime: 1500, isPartOfWord: false },
  { text: 'wor', startTime: 1600, endTime: 1800, isPartOfWord: true },
  { text: 'ld', startTime: 1800, endTime: 2100, isPartOfWord: false },
], 1000, 2100);
assert.deepEqual(amllFlagged.map((w) => w.word), ['Hello ', 'world'],
  'Spicy fragments group into whole words with a synthesized separator');
assert.equal(amllFlagged[0].startTime, 1000, 'grouped word starts at its first fragment');
assert.equal(amllFlagged[0].endTime, 1500, 'grouped word ends at its last fragment');
assert.equal(amllFlagged.map((w) => w.word).join(''), 'Hello world',
  'AMLL joins grouped words into the correct line text');
const amllPunct = buildAmllWords([
  { text: 'Hello', startTime: 1000, endTime: 1500, isPartOfWord: false },
  { text: ',', startTime: 1500, endTime: 1600, isPartOfWord: false },
  { text: 'world', startTime: 1600, endTime: 2100, isPartOfWord: false },
], 1000, 2100);
assert.equal(amllPunct.map((w) => w.word).join(''), 'Hello, world',
  'closing punctuation clings without a synthesized gap');
const amllCjk = buildAmllWords([
  { text: '光', startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: 'の', startTime: 1200, endTime: 1400, isPartOfWord: false },
], 1000, 1400);
assert.equal(amllCjk.map((w) => w.word).join(''), '光の',
  'CJK word boundaries take no space');
const amllLiteral = buildAmllWords([
  { text: '한', startTime: 1000, endTime: 1500 },
  { text: '글 ', startTime: 1500, endTime: 2000 },
  { text: '테', startTime: 2000, endTime: 2500 },
], 1000, 2500);
assert.deepEqual(amllLiteral.map((w) => w.word), ['한', '글 ', '테'],
  'unflagged syllables pass through 1:1 with literal spacing intact');
assert.equal(amllLiteral.map((w) => w.word).join(''), '한글 테',
  'literal trailing spaces survive the AMLL bridge');

const amllAposEnding = buildAmllWords([
  { text: "lil'", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: "pose", startTime: 1200, endTime: 1500, isPartOfWord: false },
], 1000, 1500);
assert.equal(amllAposEnding.map((w) => w.word).join(''), "lil' pose",
  'words ending in apostrophes separate properly from the next word');

const amllAposLeading = buildAmllWords([
  { text: "sing", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: "'cause", startTime: 1200, endTime: 1500, isPartOfWord: false },
], 1000, 1500);
assert.equal(amllAposLeading.map((w) => w.word).join(''), "sing 'cause",
  'words starting with apostrophes separate properly from the previous word');

const amllTellEm = buildAmllWords([
  { text: "tell", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: "'em", startTime: 1200, endTime: 1500, isPartOfWord: false },
], 1000, 1500);
assert.equal(amllTellEm.map((w) => w.word).join(''), "tell 'em",
  "'em does not merge into the preceding verb");

const amllRockNRoll = buildAmllWords([
  { text: "rock", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: "'n'", startTime: 1200, endTime: 1400, isPartOfWord: false },
  { text: "roll", startTime: 1400, endTime: 1600, isPartOfWord: false },
], 1000, 1600);
assert.equal(amllRockNRoll.map((w) => w.word).join(''), "rock 'n' roll",
  "rock 'n' roll preserves spaces around 'n'");

const amllContraction = buildAmllWords([
  { text: "It", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: "'s", startTime: 1200, endTime: 1400, isPartOfWord: false },
  { text: "fine", startTime: 1400, endTime: 1600, isPartOfWord: false },
], 1000, 1600);
assert.equal(amllContraction.map((w) => w.word).join(''), "It's fine",
  "apostrophe contractions attach without space and separate from next word");

const amllQuotes = buildAmllWords([
  { text: "said,", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: '"Hello"', startTime: 1200, endTime: 1500, isPartOfWord: false },
  { text: "world", startTime: 1500, endTime: 1800, isPartOfWord: false },
], 1000, 1800);
assert.equal(amllQuotes.map((w) => w.word).join(''), 'said, "Hello" world',
  'quoted words maintain spaces on both sides');

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
