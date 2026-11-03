/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { buildSync } = require('esbuild');
const { mount } = require('./check-native-glyph-idle.cjs');
const { createVoiceHarness, currentCode } = require('./check-native-translation-toggle.cjs');
const native = path.join(__dirname, '../components/lyrics/native');
const contents = fs.readFileSync(path.join(native, 'native-glyph-picture.tsx'), 'utf8');
const code = buildSync({ stdin: { contents: contents + '\nexport { getRevealShader };', resolveDir: native, loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native-reanimated', 'react-native-worklets', '@shopify/react-native-skia'] }).outputFiles[0].text;
let creates = 0, disposals = 0;
const m = { exports: {} };
vm.runInNewContext(code, { module: m, exports: m.exports, require: name => name === 'react' ? { memo: fn => fn }
  : name === '@shopify/react-native-skia' ? { TileMode: { Clamp: 0 }, Skia: { Color: color => color,
    Shader: { MakeLinearGradient: (...args) => {
      assert.equal(args.length, 5, "Matrix/flags keep the factory defaults");
      assert.equal(args[2].length, 2); assert.equal(args[3], null); assert.equal(args[4], 0);
      assert.equal(args[0].y, args[1].y);
      creates++; return Object.freeze({ args, dispose() { disposals++; } });
    } } } } : {} });
const cache = () => ({ revealShaders: [] });
const base = [0, 2, 10, 0.9, 0.3];
const get = (paint, args = base) => m.exports.getRevealShader(paint, ...args);
const paints = cache(), original = get(paints), entries = paints.revealShaders;
assert.equal(get(paints), original);
assert.equal(paints.revealShaders, entries, 'A hit does not replace the cache array');
assert.equal(creates, 1);
for (let i = 0; i < base.length; i++) {
  const changed = [...base]; changed[i] += 1e-12;
  assert.notEqual(get(paints, changed), original, `Exact miss for varying input ${i}, without rounding`);
  assert.equal(get(paints, changed), get(paints, changed));
}
assert.notEqual(get(paints, [-0, ...base.slice(1)]), original, 'Signed zero retains an exact distinct key');
assert.equal(original.args[2][0], 'rgba(255,255,255,0.9)');
assert.equal(original.args[2][1], 'rgba(255,255,255,0.3)');
const bounded = cache();
const handles = Array.from({ length: 32 }, (_, i) => get(bounded, [i, ...base.slice(1)]));
assert.equal(get(bounded, base), handles[0]); // Promote oldest to MRU.
get(bounded, [32, ...base.slice(1)]);
assert.equal(bounded.revealShaders.length, 32);
assert.equal(get(bounded, base), handles[0]);
assert.notEqual(get(bounded, [1, ...base.slice(1)]), handles[1], 'LRU evicts the unpromoted oldest handle');
for (let i = 33; i < 1000; i++) {
  get(bounded, [i, ...base.slice(1)]);
  assert.equal(bounded.revealShaders.length, 32);
}
assert.equal(handles[0].args[0].x, 0, 'An evicted handle retained by a recording is never mutated');
assert.equal(disposals, 0, 'Eviction drops references, never explicitly disposes a shader');
assert.notEqual(get(cache()), original, 'Voice/remount cache ownership is independent');
console.log('Exact shader cache: all varying fields, signed-zero collision, fixed RGB/positions/tile semantics, LRU <=32, no disposal, stable handles and independent voice state passed.');

const at = process.argv.indexOf('--baseline');
if (at < 0) {
  console.log('Pass --baseline FILE exported from cf816c4 for complete real-path before/after recordings and counts.');
} else {
  const baseline = fs.readFileSync(process.argv[at + 1], 'utf8');
  const before = require('./fixtures/native-gradient-work-before.json');
  assert.equal(createHash('sha256').update(baseline).digest('hex'), before.sourceSha256, 'Untouched pinned cf816c4 required');
  function transformed(sourceText) {
    const babel = require('@babel/core').transformSync(sourceText, {
      filename: path.join(native, 'native-glyph-picture.tsx'), presets: ['babel-preset-expo'],
    }).code;
    return buildSync({ stdin: { contents: babel, resolveDir: native, loader: 'js' }, bundle: true,
      platform: 'node', format: 'cjs', write: false, external: ['react', 'react-native-reanimated', 'react-native-worklets', '@shopify/react-native-skia'] }).outputFiles[0].text;
  }
  const baselineCode = transformed(baseline), source = transformed(contents);
  function load(file) {
    const compiled = buildSync({ entryPoints: [path.join(native, file)], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
    const moduleObject = { exports: {} };
    vm.runInNewContext(compiled, { module: moduleObject, exports: moduleObject.exports, require });
    return moduleObject.exports;
  }
  const model = load('native-lyrics-model.ts');
  const layouts = { spicy: load('spicy-native-layout.ts'), amll: load('amll-native-layout.ts') };
  // Existing harness hydrates Babel's actual line-motion worklets. Native
  // scheduler/shared-value boundaries are still mocked, not a Hermes execution.
  let lineHarness = fs.readFileSync(path.join(__dirname, 'check-native-inactive-work.cjs'), 'utf8').split('for (const fps of [60, 120])')[0];
  lineHarness = lineHarness.replace("const baselineIndex = process.argv.indexOf('--baseline');", 'const baselineIndex = -1;');
  lineHarness += '\nmodule.exports={mount,source};';
  const lineModule = { exports: {} };
  vm.runInNewContext(lineHarness, { module: lineModule, exports: lineModule.exports, require, __dirname, console, process });
  function find(node, type) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === type) return node;
    for (const child of [node.props?.children].flat()) { const hit = find(child, type); if (hit) return hit; }
    return null;
  }
  function shape(voice, spicy) {
    const h = createVoiceHarness(currentCode, spicy, layouts);
    let tree = h.render(voice); tree.props.onLayout({ nativeEvent: { layout: { width: 320 } } }); tree = h.render(voice);
    return find(tree, h.NativeGlyphPicture).props.words.map((word, i) => {
      const parts = word.word.emphasized ? word.letters : [word.rects];
      return { ...word, runs: parts.map(rects => rects.length ? [{ glyphs: [i + 1], positions: [{ x: rects[0].x, y: 20 }], font: 'mock-font' }] : []),
        clips: parts.map(() => ({ mockClip: true })), pictures: parts.map(() => ({ mockSourcePicture: true })),
        emojiMask: parts.map(() => false), revealRects: parts.map(rects => rects[0]) };
    });
  }
  const results = [];
  let tickComparisons = 0;
  for (const expected of before.results) {
    const spicy = expected.style === 'spicy';
    const { lyrics } = require('../lib/lyrics-ttml-import').parseTtmlToLyrics(fs.readFileSync(path.join(__dirname, '../../DesktopBridge/test/fixtures/lrc-red', expected.id + '.ttml'), 'utf8'));
    const voices = model.buildNativeRows(lyrics, expected.style).flatMap(row => [row.lead, ...row.backgrounds]);
    const slices = voice => voice.paintWords.reduce((n, w) => n + (w.emphasized ? w.letters.length : 1), 0);
    const voice = voices.reduce((a, b) => slices(b) > slices(a) ? b : a);
    const words = shape(voice, spicy);
    const current = mount(source, spicy, words.length, voice.start, 4, words, voice.end);
    const old = mount(baselineCode, spicy, words.length, voice.start, 4, words, voice.end);
    const lm = !spicy ? lineModule.exports.mount(lineModule.exports.source, 60, { activeLine: { value: true } }) : null;
    const tick = time => {
      tickComparisons++;
      if (lm) { lm.setActive(current.active.value); lm.tick(1000 / 60); current.lineMotion.value = old.lineMotion.value = lm.motion; }
      current.tick(time, 1000 / 60); old.tick(time, 1000 / 60);
      assert.equal(current.picture, old.picture, `${expected.id}: complete canonical picture at ${time}`);
      assert.equal(JSON.stringify(current.motionState), JSON.stringify(old.motionState), 'Exact spring/clock/cache state parity');
      assert(current.reusablePaints.revealShaders.length <= 32);
      assert.equal(current.pictures, old.pictures, 'Exact recording cadence');
      assert.equal(current.blurFilters, old.blurFilters, 'Exact blur allocation count');
    };
    current.active.value = old.active.value = true; tick(voice.start);
    const start = { current: current.shaderCreates, old: old.shaderCreates, pictures: current.pictures };
    const frames = Math.ceil((voice.end - voice.start) * 60 / 1000);
    for (let i = 1; i <= frames; i++) tick(voice.start + i * 1000 / 60);
    const measured = { style: expected.style, id: expected.id, frames,
      pictures: current.pictures - start.pictures, before: old.shaderCreates - start.old, after: current.shaderCreates - start.current };
    assert.equal(measured.before, expected.shaders); assert.equal(measured.frames, expected.frames);
    assert.equal(measured.after, measured.before - expected.exactMatches32, 'Only exact baseline trace matches avoid the factory');
    results.push(measured);
    current.active.value = old.active.value = false;
    for (let i = 1; i <= 1200; i++) tick(voice.end + i * 1000 / 60);
    // Backward seek, pause/resume and forward seek retain full paint/motion parity.
    current.active.value = old.active.value = true; tick(voice.start + 100);
    for (let i = 0; i < 120; i++) tick(voice.start + 100);
    for (let i = 1; i <= 120; i++) tick(voice.start + 100 + i * 1000 / 60);
    current.active.value = old.active.value = false; tick(voice.end + 15000);
    current.unmount(); old.unmount(); lm?.unmount();
    const remount = mount(source, spicy, words.length, voice.start, 4, words, voice.end);
    assert.equal(remount.reusablePaints, null, 'Remount starts without retained paints or shaders');
    remount.active.value = true; remount.tick(voice.start); assert(remount.shaderCreates > 0); remount.unmount();
  }
  console.log(JSON.stringify({ label: 'HOST ONLY: real glyph/motion paths, mock native fonts/geometry/Skia; no device timing claim.', baselineCommit: before.commit, tickComparisons, results }, null, 2));
}
