/* global __dirname */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { paragraphComposite } = require('./skia-paragraph-compositing-harness.cjs');
const path = require('node:path');
const { mount: exactMount, source } = require('./check-native-glyph-idle.cjs');
const { bundle, createVoiceHarness, currentCode } = require('./check-native-translation-toggle.cjs');
const lazyCode = bundle(fs.readFileSync(path.join(__dirname, '../components/lyrics/native/native-lazy-skia-voice.tsx'), 'utf8').replaceAll('NativeLazySkiaVoice', 'NativeSkiaVoice'));
const voice = { start: 100000, end: 100500, words: [{ text: 'song', starts: [100000], ends: [100500], weights: [4] }], paintText: 'song',
  paintWords: [{ text: 'song', offset: 0, start: 100000, end: 100500, letters: ['song'], emphasized: false }], translation: 'translation' };
const trace = { arrivalCounter() {}, arrivalNow() {}, arrivalEvent() {}, arrivalProduced: (_h, _g, value) => value, arrivalSpan: (_h, _g, _n, fn) => fn() };
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...[tree.props?.children].flat().flatMap(child => nodes(child, predicate))];
}
function render(code, spicy, props) {
  const h = createVoiceHarness(code, spicy, { dev: true, arrivalTrace: trace, animatePresentation: true });
  let tree = h.render(voice, props);
  tree.props.onLayout({ nativeEvent: { layout: { width: 320.125 } } });
  return { h, tree: h.render(voice, props) };
}
const plain = value => JSON.parse(JSON.stringify(value));
let cases = 0;
for (const spicy of [false, true]) for (const background of [false, true]) for (const sung of [false, true])
for (const right of [false, true]) for (const showTranslation of [false, true])
for (const dark of [0.13, 0.2, 0.4]) for (const bright of [0.2, 0.73, 1]) for (const blur of [0, 2.5, 5]) {
  const time = sung ? 200000 : 0;
  const exact = exactMount(source, spicy, 1, voice.start, 1, null, voice.end, { background });
  exact.lineMotion.value = { scale: 0.97, velocity: 0, dark, bright };
  exact.tick(time);
  const commands = JSON.parse(exact.picture);
  const paint = commands.find(command => command[0] === 'drawGlyphs').at(-1);
  let alpha = paint.alpha;
  if (paint.shader) {
    // Sample the actual recorded shader, rather than copying drawVoice policy.
    const [start, end, colors] = paint.shader.gradient;
    const alphas = colors.map(color => Number(color.match(/,([^,]+)\)$/)[1]));
    const samples = [0, 10, 20].map(x => {
      const t = Math.max(0, Math.min(1, (x - start.x) / (end.x - start.x)));
      return alphas[0] * (1 - t) + alphas[1] * t;
    });
    assert(samples.every(value => Math.abs(value - samples[0]) < 1e-12), 'inactive exact fixture must be uniform');
    alpha = samples[0];
  }
  const props = { prepareGlyphs: false, background, right, showTranslation, lineActive: { value: false }, position: { value: time },
    lineMotion: { value: { scale: 0.97, velocity: 0, dark, bright } }, blur: { value: blur } };
  const lazy = render(lazyCode, spicy, props), original = render(currentCode, spicy, props);
  const mainGroup = nodes(lazy.tree, node => node.type === 'Group' &&
    [node.props.children].flat().some(child => child?.type === 'Paragraph' && child.props.paragraph.text === voice.paintText))[0];
  const composite = paragraphComposite(mainGroup);
  assert.equal(composite.alpha, alpha, JSON.stringify({ spicy, background, sung, dark, bright, blur }));
  assert.equal(lazy.h.counters.glyphShapePasses, 0, 'cold inactive parity must not prepare glyphs');
  assert.equal(exact.blurFilters, 0, 'actual inactive painter has no internal blur at this HEAD');
  const presentation = tree => plain({ style: tree.props.style, canvas: nodes(tree, node => node.type === 'Canvas')[0].props.style,
    transforms: nodes(tree, node => node.type === 'Group' && node.props.transform).map(node => node.props.transform),
    blur: nodes(tree, node => node.type === 'Group' && nodes(node.props.layer, child => child.type === 'Blur').length).map(node => node.props.layer),
    translations: nodes(tree, node => node.type === 'Paragraph' && node.props.paragraph.text === 'translation').map(node => node.props) });
  assert.deepEqual(presentation(lazy.tree), presentation(original.tree), 'outer presentation, translations, transforms and blur equal exact wrapper');
  exact.unmount(); lazy.h.unmount(); original.h.unmount(); cases++;
}
console.log(`Inactive paint parity PASS: ${cases} actual exact-painter vs installed Skia paragraph-composite and outer-presentation cases; native raster acceptance remains separate.`);
