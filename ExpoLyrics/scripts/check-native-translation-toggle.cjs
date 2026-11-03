/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const filename = path.join(__dirname, '../components/lyrics/native/native-skia-voice.tsx');
const bundle = source => buildSync({ stdin: { contents: source, resolveDir: path.dirname(filename), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['*'] }).outputFiles[0].text;
const currentCode = bundle(fs.readFileSync(filename, 'utf8'));
const baselineIndex = process.argv.indexOf('--baseline');
const baselineCode = baselineIndex < 0 ? null : bundle(fs.readFileSync(process.argv[baselineIndex + 1], 'utf8'));

function createVoiceHarness(code, spicy, layouts = {}) {
  const hookSlots = [];
  const hookCalls = [];
  let hookCursor = 0;
  const counters = { rectQueries: 0, paragraphBuilds: 0, spacingProbeBuilds: 0, mainParagraphBuilds: 0, translationParagraphBuilds: 0, mainParagraphLayouts: 0,
    translationParagraphLayouts: 0, glyphShapePasses: 0, spicyGlyphPictures: 0 };
  const arrivalContext = {};
  const fonts = { name: 'test-fonts' };
  const react = {
    memo: component => component,
    useEffect() {},
    createElement(type, props, ...children) { return { type, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }; },
    useContext(context) { hookCursor++; return context === arrivalContext ? { handle: layouts.arrivalHandle, generation: 1 } : fonts; },
    useRef(initial) { const index = hookCursor++; return hookSlots[index] ??= { current: initial }; },
    useState(initial) {
      const index = hookCursor++;
      const slot = hookSlots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, update => { slot.value = typeof update === 'function' ? update(slot.value) : update; }];
    },
    useMemo(factory, dependencies) {
      const index = hookCursor++;
      const prior = hookSlots[index];
      if (!prior || dependencies.some((value, i) => !Object.is(value, prior.dependencies[i])))
        hookSlots[index] = { dependencies, value: factory() };
      return hookSlots[index].value;
    },
  };
  for (const name of ['useContext', 'useEffect', 'useRef', 'useState', 'useMemo']) {
    const original = react[name]; react[name] = (...args) => { hookCalls.push(name); return original(...args); };
  }
  const makeParagraph = initialText => {
    let text = initialText;
    return { addText(value) { text += value; return this; }, pushStyle() { return this; }, pop() { return this; }, build() {
      counters.paragraphBuilds++;
      if (text === '0 ') counters.spacingProbeBuilds++;
      if (/translation/u.test(text)) counters.translationParagraphBuilds++;
      else counters.mainParagraphBuilds++;
      return { text, layout() { counters[/translation/u.test(text) ? 'translationParagraphLayouts' : 'mainParagraphLayouts']++; },
        getHeight: () => /translation/u.test(text) ? 18 : 42,
        getRectsForRange(start, end) { counters.rectQueries++; return layouts.rectsForRange?.(start, end) ?? [{ x: start * 8, y: 0, width: (end - start) * 8, height: 24 }]; } };
    } };
  };
  const skia = { ParagraphBuilder: { Make: () => makeParagraph('') }, Color: color => color };
  const NativeGlyphPicture = function NativeGlyphPictureMock() {};
  const modules = {
    react,
    "@/lib/lyrics-arrival-context": layouts.arrivalContextModule ?? { useArrivalVoice: () => ({ handle: layouts.arrivalHandle, generation: 1 }) },
    "@/lib/lyrics-arrival-trace": layouts.arrivalTrace ?? {},
    'react-native': { StyleSheet: { create: styles => styles, absoluteFill: {} } },
    '@shopify/react-native-skia': { Blur: 'Blur', Canvas: 'Canvas', Group: 'Group', LinearGradient: 'LinearGradient',
      Mask: 'Mask', Paint: 'Paint', Paragraph: 'Paragraph', Rect: 'Rect', Skia: skia, TextAlign: { Left: 0, Right: 1 } },
    'react-native-reanimated': { __esModule: true, default: { View: 'Animated.View' }, Easing: { bezier: () => () => 0 },
      useAnimatedReaction() {}, useAnimatedStyle: () => ({}), useDerivedValue: callback => ({ value: callback() }),
      useSharedValue: value => react.useMemo(() => ({ value }), []), withTiming: value => value },
    './native-glyph-model': {},
    './reference-motion': layouts.motion ?? { amllEmphasis: () => ({ scale: 1, x: 0, y: 0, glow: 0, radius: 0 }), amllFloat: () => 0, clamp01: value => value },
    './use-reference-word-motion': layouts.wordMotion ?? { useReferenceWordMotion: () => ({ value: {} }) },
    './native-glyph-picture': { NativeGlyphPicture, shapeGlyphWords(_paragraph, words, useSpicy) {
      counters.glyphShapePasses++;
      if (useSpicy) counters.spicyGlyphPictures += words.reduce((sum, word) => sum + (word.word.emphasized ? word.letters.length : 1), 0);
      return words.map(word => ({ ...word }));
    } },
    './spicy-native-layout': layouts.spicy ?? { wrapSpicyText: (text, words) => ({ text, words }) },
    './spicy-text-policy': layouts.textPolicy ?? { spicyIsRtl: () => false },
    './native-glyph-layout': layouts.glyphLayout ?? { amllRevealStart: () => 0 },
    './native-lyrics-fonts': { NativeLyricsFontContext: {} },
    './amll-native-layout': layouts.amll ?? { balanceAmllText: (text, words) => ({ text, words }) },
    'react/jsx-runtime': { jsx(type, props, key) { return { type, props: { ...props, ...(key === undefined ? {} : { key }) } }; },
      jsxs(type, props, key) { return { type, props: { ...props, ...(key === undefined ? {} : { key }) } }; } },
  };
  const moduleObject = { exports: {} };
  vm.runInNewContext(code, { __DEV__: !!layouts.dev, performance, module: moduleObject, exports: moduleObject.exports,
    require(name) { assert(name in modules, `native-only hook harness missing import ${name}`); return modules[name]; } });
  const NativeSkiaVoice = moduleObject.exports.NativeSkiaVoice;
  const defaults = { position: { value: 100 }, blur: { value: 0 }, lineActive: { value: true },
    lineMotion: { value: { scale: 1, bright: 0.9, dark: 0.3 } }, fontSize: 32, lineHeight: 42,
    right: false, background: false, staticLyrics: false, spicy, showTranslation: true, hasDuet: false, batched: true };
  return { counters, hookCalls, NativeGlyphPicture, render(voice, props = {}) {
    hookCursor = 0;
    return NativeSkiaVoice({ ...defaults, voice, ...props });
  } };
}

function runVoice(code, spicy, expectOptimized = true) {
  const harness = createVoiceHarness(code, spicy);
  const { counters, NativeGlyphPicture } = harness;
  const position = { value: 100 }, blur = { value: 0 }, lineActive = { value: true };
  const lineMotion = { value: { scale: 1, bright: 0.9, dark: 0.3 } };
  const letters = ['s', 'i', 'n', 'g'];
  const voice = { words: [{ text: 'sing', starts: [0], ends: [500], weights: [4] }], paintText: 'sing',
    paintWords: [{ text: 'sing', start: 0, end: 500, offset: 0, emphasized: true, letters, joined: false,
      group: 0, emphasis: { start: 0, end: 500, index: 0, count: 4, last: true } }],
    start: 0, end: 500, translation: 'initial translation' };
  const baseProps = { voice, position, fontSize: 32, lineHeight: 42, right: false, background: false,
    staticLyrics: false, blur, lineActive, lineMotion, spicy, showTranslation: true, hasDuet: false, batched: true };
  function render(props) { return harness.render(props.voice, props); }
  let tree = render(baseProps);
  tree.props.onLayout({ nativeEvent: { layout: { width: 240 } } });
  tree = render(baseProps);
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) { const result = find(child, predicate); if (result) return result; }
    return null;
  };
  const glyphNode = () => find(tree, node => node.type === NativeGlyphPicture);
  const translationNode = () => find(tree, node => node.type === 'Paragraph');
  const height = () => tree.props.style[0].height;
  const initialMainBuilds = counters.mainParagraphBuilds;
  const initialMainLayouts = counters.mainParagraphLayouts;
  const initialGlyphShapes = counters.glyphShapePasses;
  const initialGlyphPictures = counters.spicyGlyphPictures;
  const initialNode = glyphNode();
  assert.ok(initialNode, 'Batched native renderer builds its glyph-picture child');
  const mainWords = initialNode.props.words;
  const mainKey = initialNode.props.key;
  const initialHeight = height();
  assert.ok(translationNode(), 'Visible translation has its own native Paragraph node');
  tree = render({ ...baseProps, showTranslation: false });
  assert.equal(translationNode(), null, 'Hiding translation removes its paragraph');
  assert.equal(height(), 42, 'Row voice height drops to the unchanged main-line height');
  const mainRebuildsOnToggle = counters.mainParagraphBuilds - initialMainBuilds;
  const mainLayoutsOnToggle = counters.mainParagraphLayouts - initialMainLayouts;
  const glyphShapePassesOnToggle = counters.glyphShapePasses - initialGlyphShapes;
  if (!expectOptimized) return { counters, initialMainBuilds, initialGlyphShapes, initialGlyphPictures,
    mainRebuildsOnToggle, mainLayoutsOnToggle, glyphShapePassesOnToggle,
    glyphPicturesOnToggle: counters.spicyGlyphPictures - initialGlyphPictures, initialHeight, hiddenHeight: height() };
  const hiddenNode = glyphNode();
  assert.equal(hiddenNode.props.words, mainWords, 'Translation toggle preserves the shaped glyph word array');
  assert.equal(hiddenNode.props.key, mainKey, 'Translation toggle preserves the glyph picture key');
  tree = render(baseProps);
  assert.ok(translationNode(), 'Showing translation again restores its paragraph');
  assert.equal(height(), initialHeight, 'Translation height is restored without changing main-line metrics');
  assert.equal(counters.mainParagraphBuilds, initialMainBuilds, 'Main paragraph shaping is memoized independently from translation');
  assert.equal(counters.mainParagraphLayouts, initialMainLayouts, 'Main paragraph layout is not repeated by translation visibility');
  assert.equal(counters.glyphShapePasses, initialGlyphShapes, 'shapeGlyphWords is not rerun by translation visibility');
  assert.equal(counters.spicyGlyphPictures, initialGlyphPictures, 'Spicy per-letter picture inputs are not rebuilt on toggles');

  const translatedVoice = { ...voice, translation: 'updated translation' };
  tree = render({ ...baseProps, voice: translatedVoice });
  assert.equal(translationNode().props.paragraph.text, 'updated translation', 'Updated translation reaches its own native Paragraph');
  assert.equal(glyphNode().props.words, mainWords, 'Late translation content update preserves shaped glyph words');
  assert.equal(glyphNode().props.key, mainKey, 'Late translation content update preserves glyph-picture identity');
  assert.equal(counters.mainParagraphBuilds, initialMainBuilds, 'Late translation update does not rebuild the main paragraph');
  assert.equal(counters.mainParagraphLayouts, initialMainLayouts, 'Late translation update does not relayout the main paragraph');
  assert.equal(counters.glyphShapePasses, initialGlyphShapes, 'Late translation update does not reshape glyphs');
  assert.equal(counters.translationParagraphBuilds, 3, 'Updated translation receives a fresh translation paragraph');

  const retimedVoice = { ...translatedVoice, words: [{ ...voice.words[0], starts: [25], ends: [525] }],
    paintWords: voice.paintWords.map(word => ({ ...word, start: 25, end: 525,
      emphasis: { ...word.emphasis, start: 25, end: 525 } })) };
  tree = render({ ...baseProps, voice: retimedVoice });
  assert.notEqual(glyphNode().props.key, mainKey, 'Timing-only source update resets the animated glyph-picture state');
  assert.equal(counters.mainParagraphBuilds, initialMainBuilds * 2, 'Timing-only update rebuilds the paragraph from fresh timed inputs');
  assert.equal(counters.mainParagraphLayouts, initialMainLayouts * 2, 'Timing-only update lays out its fresh main inputs');
  assert.equal(counters.glyphShapePasses, initialGlyphShapes + 1, 'Timing-only update refreshes timing-bound glyph shape inputs');
  return { counters, initialMainBuilds, initialGlyphShapes, initialGlyphPictures, mainRebuildsOnToggle: 0,
    mainLayoutsOnToggle: 0, glyphShapePassesOnToggle: 0,
    glyphPicturesOnToggle: 0, initialHeight, hiddenHeight: 42 };
}

if (require.main === module) {
for (const spicy of [false, true]) {
  const result = runVoice(currentCode, spicy);
  assert.equal(result.mainRebuildsOnToggle, 0);
  assert.equal(result.mainLayoutsOnToggle, 0);
  assert.equal(result.glyphShapePassesOnToggle, 0);
  console.log(`${spicy ? 'Spicy' : 'AMLL'} actual NativeSkiaVoice hook toggle: main paragraph builds/layouts ` +
    `${result.initialMainBuilds}/${result.initialMainBuilds}, glyph shape passes ${result.initialGlyphShapes}, ` +
    `modeled per-letter pictures ${result.initialGlyphPictures}; all unchanged across hide/show.`);
  if (baselineCode) {
    const baseline = runVoice(baselineCode, spicy, false);
    console.log(`${spicy ? 'Spicy' : 'AMLL'} pre-fix hook baseline: main paragraph rebuilds/layouts on hide ` +
      `${baseline.mainRebuildsOnToggle}/${baseline.mainLayoutsOnToggle}, glyph shape passes on hide ` +
      `${baseline.glyphShapePassesOnToggle}, modeled per-letter pictures on hide ${baseline.glyphPicturesOnToggle}.`);
    assert(baseline.mainRebuildsOnToggle > 0, 'Baseline demonstrates the original main-shaping invalidation');
    assert(baseline.glyphShapePassesOnToggle > 0, 'Baseline demonstrates glyph shaping invalidation');
  }
}
console.log('Native translation-toggle checks passed: stable row-owned glyph inputs and separate translation layout; modeled hook counts only, not device frame timings.');

}
module.exports = { createVoiceHarness, bundle, currentCode };
