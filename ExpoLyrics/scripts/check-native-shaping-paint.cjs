/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { createHash } = require('node:crypto');
const { bundle, createVoiceHarness, currentCode } = require('./check-native-translation-toggle.cjs');
const native = path.join(__dirname, '../components/lyrics/native');
const baselineArg = process.argv.indexOf('--baseline');
const glyphBaselineArg = process.argv.indexOf('--glyph-baseline');
let baselineCode = currentCode;
if (baselineArg >= 0) {
  const baselineSource = fs.readFileSync(process.argv[baselineArg + 1], 'utf8');
  assert.equal(createHash('sha256').update(baselineSource).digest('hex'), require('./fixtures/native-shaping-work-before.json').sourceSha256, 'Untouched 3eff880 source required');
  baselineCode = bundle(baselineSource);
} else assert.ok(glyphBaselineArg >= 0, 'Pass --baseline FILE (3eff880 voice) or --glyph-baseline FILE (cf816c4 glyph module)');
const copy = value => JSON.parse(JSON.stringify(value));
function canvas(commands) {
  return Object.fromEntries(['save', 'restore', 'translate', 'scale', 'clipPath', 'saveLayer', 'drawPicture', 'drawPaint', 'drawGlyphs']
    .map(name => [name, (...args) => commands.push(copy([name, ...args]))]));
}
const Skia = {
  XYWHRect: (x, y, width, height) => ({ x, y, width, height }), Color: color => color,
  PathBuilder: { Make: () => ({ rects: [], addRect(rect) { this.rects.push(rect); return this; },
    addPath(other) { this.rects.push(...other.rects); return this; }, detach() { return { rects: this.rects }; } }) },
  Paint: () => ({ alpha: 1, color: 'black', shader: null, blendMode: 3, imageFilter: null,
    setAntiAlias(aa) { this.aa = aa; }, setColor(color) { this.color = color; }, setAlphaf(alpha) { this.alpha = alpha; },
    setShader(shader) { this.shader = shader; }, setBlendMode(blendMode) { this.blendMode = blendMode; },
    setImageFilter(imageFilter) { this.imageFilter = imageFilter; } }),
  Shader: { MakeLinearGradient: (...gradient) => ({ gradient }) }, ImageFilter: { MakeBlur: (...blur) => ({ blur }) },
};
function glyphApi(contents) {
  const glyphCode = buildSync({ stdin: { contents: contents +
    '\nexport { drawVoice, advanceReferenceWordMotion, initialWordSpringState };', resolveDir: native, loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react-native-reanimated', '@shopify/react-native-skia'] }).outputFiles[0].text;
  const moduleObject = { exports: {} };
  vm.runInNewContext(glyphCode, { module: moduleObject, exports: moduleObject.exports,
    require: name => name === 'react' ? { memo: fn => fn } : name === '@shopify/react-native-skia' ? { Skia,
      BlendMode: { SrcIn: 5, SrcOver: 3 }, ClipOp: { Intersect: 0 }, TileMode: { Clamp: 0, Decal: 1 },
      createPicture: draw => { const commands = []; draw(canvas(commands)); return { commands }; } } : {} });
  return moduleObject.exports;
}
const api = glyphApi(fs.readFileSync(path.join(native, 'native-glyph-picture.tsx'), 'utf8'));
let oldApi = api;
if (glyphBaselineArg >= 0) {
  const contents = fs.readFileSync(process.argv[glyphBaselineArg + 1], 'utf8');
  assert.equal(createHash('sha256').update(contents).digest('hex'), '1aaf487f4f96e709b78e0afb1329344104c63566753662171238f23dc8470d38', 'Pinned cf816c4 glyph source required');
  oldApi = glyphApi(contents);
}
function load(file) {
  const code = buildSync({ entryPoints: [path.join(native, file)], bundle: true,
    platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require });
  return module.exports;
}
const realMotion = load('reference-motion.ts');
const textPolicy = load('spicy-text-policy.ts');
const glyphLayout = load('native-glyph-layout.ts');
function resolveTree(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(resolveTree);
  if (typeof node.type === 'function') return resolveTree(node.type(node.props));
  return { type: node.type, props: { ...node.props,
    ...(node.props?.children === undefined ? {} : { children: resolveTree(node.props.children) }) } };
}
const heart = require('./fixtures/native-glyph-heart-layout.json');
const rect = (x, y, width = 20) => ({ x, y, width, height: 24 });
const cases = [
  { name: 'captured heart fallback', text: heart.syllable.text, letters: heart.syllable.letters,
    rects: heart.rects, letterRects: heart.letters, lines: heart.lines, runs: heart.runs },
  { name: 'RTL', text: 'אב♡', letters: ['א', 'ב', '♡'], rects: [rect(0, 0, 60)],
    letterRects: [[rect(40, 0)], [rect(20, 0)], [rect(0, 0)]], positions: [{ x: 40, y: 20 }, { x: 20, y: 20 }, { x: 0, y: 20 }] },
  { name: 'wrapped rows', text: 'ab\ncd', letters: ['a', 'b', '\n', 'c', 'd'], rects: [rect(0, 0, 40), rect(0, 24, 40)],
    letterRects: [[rect(0, 0)], [rect(20, 0)], [], [rect(0, 24)], [rect(20, 24)]],
    positions: [{ x: 0, y: 20 }, { x: 20, y: 20 }, { x: 0, y: 44 }, { x: 20, y: 44 }] },
  ...[
    ['punctuation', ['?', '!', '♪']],
    ['color emoji and text selector', ['😀', '♥︎', '!']],
    ['ZWJ and keycap', ['👩🏽‍💻', '1️⃣', '♡']],
  ].map(([name, letters]) => ({ name, text: letters.join(''), letters, rects: [rect(0, 0, 60)],
    letterRects: letters.map((_, i) => [rect(i * 20, 0)]), positions: letters.map((_, i) => ({ x: i * 20, y: 20 })) })),
];
function inputs(code, fixture, emphasized, spicy, batched, staticLyrics = false) {
  const voice = { start: 48014, end: 49214, translation: 'translation', words: [{ text: fixture.text, starts: [48014], ends: [49214], weights: [fixture.text.length] }], paintText: fixture.text,
    paintWords: [{ text: fixture.text, start: 48014, end: 49214, offset: 0, emphasized, letters: fixture.letters, joined: false }] };
  const position = { value: 48614 };
  const harness = createVoiceHarness(code, spicy, {
    motion: realMotion, textPolicy, glyphLayout,
    wordMotion: { useReferenceWordMotion: word => ({ value: api.advanceReferenceWordMotion(word, api.initialWordSpringState(word), position.value, 1 / 120).motion }) },
    spicy: { wrapSpicyText: (text, words) => ({ text, words }) },
    amll: { balanceAmllText: (text, words) => ({ text, words }) },
    rectsForRange: (start, end) => start === 0 && end === fixture.text.length ? fixture.rects : fixture.letterRects[fixture.letters.findIndex((_, i) => fixture.letters.slice(0, i).join('').length === start)] || [],
  });
  let tree = harness.render(voice, { batched, position, staticLyrics });
  tree.props.onLayout({ nativeEvent: { layout: { width: 320 } } });
  tree = harness.render(voice, { batched, position, staticLyrics });
  function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === harness.NativeGlyphPicture) return node.props.words;
    // Tree renderer's AnimatedWord receives the same full shaped input.
    if (node.props?.shaped) return [node.props.shaped];
    for (const child of [node.props?.children].flat()) { const match = find(child); if (match) return match; }
    return null;
  }
  if (staticLyrics) return copy(resolveTree(tree));
  const result = find(tree);
  assert.ok(result);
  return batched ? result : { shaped: result, tree: copy(resolveTree(tree)) };
}
let recordings = 0;
for (const fixture of cases) for (const spicy of [false, true]) for (const emphasized of [false, true]) {
  const positions = fixture.positions;
  const runs = fixture.runs || [{ origin: { x: 0, y: 0 }, glyphs: positions.map((_, i) => i + 1), positions,
    bounds: positions.map(() => ({ x: -1, y: -16, width: 22, height: 20 })), widths: positions.map(() => 20) }];
  const paragraph = { getLineMetrics: () => fixture.lines || [{ baseline: 20, ascent: 20, descent: 4 }, { baseline: 44, ascent: 20, descent: 4 }],
    extendedVisit: visit => runs.forEach((run, index) => visit(run.line || 0, { ...run,
      font: { id: index, getGlyphWidths: () => run.widths } })) };
  assert.deepEqual(inputs(currentCode, fixture, emphasized, spicy, true, true),
    inputs(baselineCode, fixture, emphasized, spicy, true, true), `${fixture.name}: static paragraph renderer output`);
  const oldInputs = inputs(baselineCode, fixture, emphasized, spicy, true);
  const newInputs = inputs(currentCode, fixture, emphasized, spicy, true);
  const used = words => words.map(word => { const result = copy(word); if (!emphasized) delete result.letters; return result; });
  assert.deepEqual(used(newInputs), used(oldInputs), `${fixture.name}: all consumed geometry, offsets, widths and timings`);
  const oldShaped = oldApi.shapeGlyphWords(paragraph, oldInputs, spicy);
  const newShaped = api.shapeGlyphWords(paragraph, newInputs, spicy);
  assert.deepEqual(used(newShaped), used(oldShaped), `${fixture.name}: glyph ownership, clips, reveal rects, alpha pictures, fonts and runs`);
  const oldTree = inputs(baselineCode, fixture, emphasized, spicy, false);
  const newTree = inputs(currentCode, fixture, emphasized, spicy, false);
  assert.deepEqual(used(newTree.shaped), used(oldInputs), `${fixture.name}: tree renderer consumes identical slices`);
  assert.deepEqual(newTree.tree, oldTree.tree, `${fixture.name}: complete resolved tree renderer output, including slice clips/reveal/transforms`);
  let state = api.initialWordSpringState(oldInputs[0].word);
  const makePaints = () => ({ paint: Skia.Paint(), glowPaint: Skia.Paint(), blurRadii: [], blurFilters: [], revealShaders: [] });
  const oldPaints = makePaints(), newPaints = makePaints();
  for (const time of [48013, 48014, 48614, 48614, 49214, 50000, 48014, 51000]) {
    const advanced = api.advanceReferenceWordMotion(oldInputs[0].word, state, time, 1 / 120);
    state = advanced.state;
    for (const active of [false, true]) for (const background of [false, true]) {
      const record = (renderer, words, paints) => {
        const commands = [];
        renderer.drawVoice(canvas(commands), words, [advanced.motion], time, active, spicy, background, 36, 49214,
          { scale: 1, bright: active ? 0.9 : 0.4, dark: 0.2 }, { active, releasePosition: 49214, elapsed: 100 },
          paints);
        return commands;
      };
      assert.deepEqual(record(api, newShaped, newPaints), record(oldApi, oldShaped, oldPaints), `${fixture.name}: complete canvas recording at ${time}/${active}/${background}`);
      recordings++;
    }
  }
}
console.log(`Native shaping parity passed: ${recordings} complete mocked canvas recordings; both styles, emphasis modes, resolved tree/static outputs, RTL, wrapped rows and captured fallback. Not device pixels.`);
