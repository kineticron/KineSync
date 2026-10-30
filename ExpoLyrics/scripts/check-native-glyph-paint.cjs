/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const directory = path.join(__dirname, '../components/lyrics/native');
let blurFilterCreates = 0;
let blurFilterDisposals = 0;
const blurOutputRadii = [];
const recordedGlyphPictures = [];
const source = buildSync({ stdin: { contents: fs.readFileSync(path.join(directory, 'native-glyph-picture.tsx'), 'utf8') + '\nexport { drawVoice, glyphRowExtent, advanceReferenceWordMotion, initialWordSpringState };',
  resolveDir: directory, loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native-reanimated', '@shopify/react-native-skia'],
}).outputFiles[0].text;
const Skia = {
  PathBuilder: { Make: () => ({ rects: [], addRect(rect) { this.rects.push(rect); return this; },
    addPath(path) { this.rects.push(...path.rects); return this; }, detach() { return { rects: this.rects }; } }) },
  XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
  Paint: () => ({ alpha: 1, shader: null, setAntiAlias() {}, setShader(shader) { this.shader = shader; },
    setBlendMode(mode) { this.blendMode = mode; },
    setColor() {}, setAlphaf(alpha) { this.alpha = alpha; }, setImageFilter(filter) { this.imageFilter = filter; } }),
  Color: color => color,
  Shader: { MakeLinearGradient: (start, end, colors) => ({ start, end, colors }) },
  ImageFilter: { MakeBlur(sigmaX, sigmaY, tileMode) { blurFilterCreates++; return { sigmaX, sigmaY, tileMode,
    dispose() { blurFilterDisposals++; } }; } },
};
const moduleObject = { exports: {} };
vm.runInNewContext(source, { module: moduleObject, exports: moduleObject.exports,
  require: name => name === 'react' ? { memo: fn => fn } : name === '@shopify/react-native-skia' ? { Skia,
    createPicture: draw => {
      const glyphs = [];
      draw({ clipPath() {}, drawGlyphs: ids => glyphs.push(Array.from(ids)) });
      recordedGlyphPictures.push(glyphs);
      return 'glyph alpha';
    },
    BlendMode: { SrcIn: 5, SrcOver: 3 }, TileMode: { Clamp: 0, Decal: 1 }, ClipOp: { Intersect: 0 } } : {} });
const makePaints = () => ({ paint: Skia.Paint(), glowPaint: Skia.Paint(), blurRadii: [], blurFilters: [] });
const rect = { x: 0, y: 0, width: 20, height: 24 };
const word = { word: { text: 'sing', letters: ['s', 'i', 'n', 'g'], start: 0, end: 1000, emphasized: false }, rects: [rect], width: 20, before: 0,
  runs: [[{ glyphs: [42], positions: [{ x: 0, y: 20 }], font: {} }]], clips: [{}], emojiMask: [false] };
const motion = { scale: 1, y: 0, gradient: 1, glow: 0, letters: [] };
function paintLine(active, bright) {
  const draws = [];
  const paints = makePaints();
  const canvas = { save() {}, restore() {}, translate() {}, scale() {}, clipPath() {},
    drawGlyphs: (_glyphs, _positions, _x, _y, _font, paint) => draws.push({ alpha: paint.alpha, shader: paint.shader }) };
  moduleObject.exports.drawVoice(canvas, [word], [motion], 1100, active, false, false, 36, 1000,
    { bright, dark: 0.3 }, { active: false, releasePosition: 1000, elapsed: 100 }, paints);
  return draws[0];
}
const before = paintLine(true, 0.9);
const after = paintLine(false, 0.9);
assert.deepEqual(after, before, 'AMLL deactivation must preserve the filtered highlight rather than flash to dark');
assert.ok(paintLine(false, 0.5).shader.colors[0].includes('0.5'), 'Inactive highlights continue following the release filter');
function paintReveal(text, gradient, active = true, background = false, emphasized = false, masked = text.includes('♡'), spicy = true, time = 500, bright = 0.9, dark = 0.3) {
  const draws = [];
  const rects = [{ ...rect, width: 8 }, { ...rect, x: 8, width: 30 }, { ...rect, x: 38, width: 2 }];
  const letters = emphasized ? [text] : Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text), ({ segment }) => segment);
  const shapedWord = moduleObject.exports.shapeGlyphWords({ getLineMetrics: () => [{ baseline: 20, ascent: 20, descent: 4 }], extendedVisit: visit => visit(0, {
    glyphs: [42], positions: [{ x: 0, y: 20 }], origin: { x: 0, y: 0 },
    bounds: [{ x: 0, y: -16, width: 40, height: 20 }], font: { getGlyphWidths: () => [40] },
  }) }, [{ ...word, word: { ...word.word, text, emphasized, letters }, rects, letters: [rects] }], spicy)[0];
  assert.equal(shapedWord.emojiMask[0], masked, 'Layout classifies the slice before painting');
  const snapshotPaint = paint => ({ alpha: paint.alpha, shader: paint.shader, blendMode: paint.blendMode });
  const canvas = { save() {}, translate() {}, scale() {}, clipPath() {},
    saveLayer: () => draws.push('layer'), restore: () => draws.push('restore'),
    drawPicture: picture => draws.push(picture),
    drawPaint: paint => draws.push(snapshotPaint(paint)),
    drawGlyphs: (_glyphs, _positions, _x, _y, _font, paint) => draws.push(snapshotPaint(paint)) };
  const paints = makePaints();
  moduleObject.exports.drawVoice(canvas, [shapedWord], [{ ...motion, gradient }], time, active, spicy, background, 36, 1000,
    { bright, dark }, { active: true, releasePosition: 0, elapsed: 0 }, paints);
  if (!masked) {
    if (emphasized && !spicy) draws.splice(0, draws.length - 3);
    assert.ok(!draws.includes('layer'), 'Normal/fallback text must draw directly without a reveal layer');
    assert.ok(!draws.includes('glyph alpha'), 'Normal text uses drawGlyphs with the shader paint');
    assert.equal(draws.length, 3, 'One glyph draw and two restores, without a masking draw');
    return draws[0];
  }
  assert.equal(paints.paint.blendMode, 3, 'A masked slice restores SrcOver for subsequent text draws');
  if (!spicy && draws.filter(draw => draw === 'layer').length > 1) {
    assert.equal(draws.filter(draw => draw?.blendMode === 5).length, 2, 'AMLL glow and foreground both use the reveal mask');
  }
  // Emphasized AMLL may record a separate glow layer before the reveal.
  draws.splice(0, draws.lastIndexOf('layer'));
  assert.equal(draws[0], 'layer');
  assert.equal(draws[1], 'glyph alpha');
  assert.equal(draws[2].blendMode, 5, 'Reveal uses SrcIn against glyph alpha, including color glyphs');
  assert.equal(draws[3], 'restore', 'The mask must stay inside its own layer');
  assert.equal(draws.length, 6, 'The mask layer and both transform saves are balanced');
  return draws[2];
}
for (const emphasized of [false, true]) {
  for (const gradient of [0, 0.5, 1]) {
    const ltr = paintReveal('♡ yeah,', gradient, true, false, emphasized).shader;
    assert.equal(ltr.start.x, 40 * gradient, 'LTR sweep uses the entire multi-run syllable');
    assert.equal(ltr.end.x, 40 * gradient + 8);
    const rtl = paintReveal('שלום♡', gradient, true, false, emphasized).shader;
    assert.equal(rtl.start.x, 40 * (1 - gradient), 'RTL sweep starts at the union right edge');
    assert.equal(rtl.end.x, 40 * (1 - gradient) - 8);
  }
}
assert.equal(paintReveal('♡ yeah,', 0, false).alpha, 0.5, 'Inactive text fallback glyphs use paint alpha');
assert.equal(paintReveal('♡ yeah,', 0, false, true).alpha, 0.3);
assert.equal(paintReveal('sing', 0.5).shader.start.x, 20);
for (const text of ['😀', '🇺🇸', '1️⃣', '❤️', '👩‍🎤']) {
  for (const emphasized of [false, true]) {
    assert.equal(paintReveal(text, 0.5, true, false, emphasized, true).shader.start.x, 20);
  }
  assert.equal(paintReveal(text, 0, false, false, false, true).alpha, 0.5);
}
paintReveal('☀\uFE0E', 0.5);
// AMLL uses the same alpha mask: color font drawing need not honor a shader.
// Compare its mask paint with the direct text paint at the same clock position.
for (const emphasized of [false, true]) {
  for (const active of [false, true]) {
    for (const time of [-1, 0, 500, 1000, 1100]) {
      const textPaint = paintReveal('yeah,', 0.5, active, false, emphasized, false, false, time);
      for (const text of ['😀', '🇺🇸', '1️⃣', '❤️', '👩‍🎤', '♡ 😀,']) {
        const maskPaint = paintReveal(text, 0.5, active, false, emphasized, true, false, time);
        assert.deepEqual(maskPaint.shader, textPaint.shader, 'AMLL emoji follows the exact text reveal timing and release');
        assert.equal(maskPaint.alpha, textPaint.alpha);
      }
    }
  }
}
for (const bright of [0.9, 0.5, 0.3]) {
  const masked = paintReveal('♡ yeah,', 0, false, false, false, true, false, 1100, bright, 0.15);
  const direct = paintReveal('yeah,', 0, false, false, false, false, false, 1100, bright, 0.15);
  assert.deepEqual(masked.shader, direct.shader, 'Inactive AMLL mask follows changing release values');
  assert.ok(masked.shader.colors[0].includes(String(bright)));
  assert.ok(masked.shader.colors[1].includes('0.15'));
}
for (const spicy of [false, true]) {
  for (const text of ['?!,', '♪', '☀\uFE0E', '♡\uFE0E']) {
    paintReveal(text, 0.5, true, false, false, false, spicy);
  }
}

const nextRect = { ...rect, x: 20 };
const rowBelow = { ...rect, y: 24 };
const run = { glyphs: [1, 2, 3], positions: [{ x: 0, y: 20 }, { x: 20, y: 20 }, { x: 0, y: 44 }],
  origin: { x: 0, y: 0 }, bounds: [{ x: 0, y: -16, width: 19, height: 22 },
    { x: -3, y: -16, width: 23, height: 20 }, { x: 0, y: -16, width: 19, height: 20 }],
  font: { getGlyphWidths: () => [20, 20, 20] } };
const getLineMetrics = () => [{ baseline: 20, ascent: 20, descent: 4 }, { baseline: 44, ascent: 20, descent: 4 }];
const shaped = moduleObject.exports.shapeGlyphWords({ getLineMetrics, extendedVisit: visit => visit(0, run) },
  [rect, nextRect, rowBelow].map(r => ({ ...word, rects: [r], letters: [] })), false);
assert.deepEqual(Array.from(shaped[0].runs[0][0].glyphs), [1], 'The previous syllable must not acquire the next Hangul glyph through its overhang');
assert.deepEqual(Array.from(shaped[1].runs[0][0].glyphs), [2]);
assert.deepEqual(Array.from(shaped[2].runs[0][0].glyphs), [3], 'A descender must not acquire a duplicate layer in the next row');
assert.ok(shaped[1].clips[0].rects.some(r => r.x === 17 && r.width === 23), 'Owned Hangul overhang must remain visible');
const mixed = moduleObject.exports.shapeGlyphWords({ getLineMetrics, extendedVisit: visit => visit(0, run) }, [{ ...word,
  word: { ...word.word, text: 'a😀♡', letters: ['a', '😀', '♡'], emphasized: true },
  rects: [rect, nextRect, rowBelow], letters: [[rect], [nextRect], [rowBelow]] }])[0];
assert.deepEqual(Array.from(mixed.emojiMask), [false, true, true], 'Emoji and heart letters get masks independently of their text neighbor');

function checkCapturedLayout(fixture, spicy = true) {
  const api = moduleObject.exports;
  assert.equal(fixture.rects.length, 2, 'CanvasKit separates the fallback heart from SF Pro text');
  const paragraph = { getLineMetrics: () => fixture.lines,
    extendedVisit: visit => fixture.runs.forEach(run => visit(run.line, { ...run,
      font: { getGlyphWidths: () => run.widths } })) };
  const shaped = api.shapeGlyphWords(paragraph, [{ word: fixture.syllable, rects: fixture.rects,
    letters: fixture.letters, width: fixture.rects.reduce((sum, rect) => sum + rect.width, 0), before: 0 }], spicy)[0];
  const right = Math.max(...fixture.rects.map(rect => rect.x + rect.width));
  const extent = api.glyphRowExtent(fixture.rects[0], fixture.rects, fixture.lines);
  assert.equal(extent.x + extent.width, right, 'Actual fallback/text rects share the complete paragraph row');
  assert.ok(extent.width > fixture.rects[0].width);
  assert.equal(shaped.revealRects[0].width, extent.width, 'Layout caches the full extent for drawVoice');
  assert.deepEqual(recordedGlyphPictures.at(-1), Array.from(shaped.runs[0], run => Array.from(run.glyphs)),
    'The actual heart and text/comma runs are recorded into the same alpha picture');
  assert.equal(shaped.emojiMask[0], true, 'The actual mixed heart/text syllable uses its recorded alpha mask');
  assert.equal(shaped.runs[0].length, 2, 'Both real font runs belong to this syllable');
  assert.deepEqual(Array.from(shaped.runs[0][0].glyphs), fixture.runs[0].glyphs);
  assert.deepEqual(Array.from(shaped.runs[0][1].glyphs), fixture.runs[1].glyphs.slice(0, 6),
    'The text run includes the comma, and excludes the later i syllables');
  for (const rect of fixture.rects) {
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    assert.ok(shaped.clips[0].rects.some(clip => x >= clip.x && x <= clip.x + clip.width && y >= clip.y && y <= clip.y + clip.height),
      'The syllable clip includes each actual fallback/text box');
  }
  const edges = [];
  for (const time of [48013, 48014, 48190, 48365, 48366, 49000, 48014]) {
    const motion = api.advanceReferenceWordMotion(fixture.syllable, api.initialWordSpringState(fixture.syllable), time, 1 / 60).motion;
    if (time >= fixture.syllable.end) assert.equal(motion.gradient, 1, 'Sung state completes independently of slice geometry');
    const draws = [];
    const canvas = { save() {}, restore() {}, translate() {}, scale() {}, clipPath() {}, saveLayer() {},
      drawPicture: picture => assert.equal(picture, shaped.pictures[0]),
      drawPaint: paint => draws.push({ shader: paint.shader, blendMode: paint.blendMode }),
      drawGlyphs: () => assert.fail('Mixed heart/text must use the recorded alpha mask') };
    // Exclude decorative glow to inspect the reveal commands alone.
    api.drawVoice(canvas, [shaped], [{ ...motion, glow: 0 }], time, true, spicy, false, fixture.provenance.fontSize, 50093,
      { bright: 0.85, dark: 0.5 }, { active: true, releasePosition: 0, elapsed: 0 }, makePaints());
    assert.equal(draws.length, 1, 'Both font runs share a single reveal mask');
    assert.equal(draws[0].blendMode, 5);
    if (time >= fixture.syllable.end) assert.equal(draws[0].shader.start.x, right, 'Sung yeah, is fully on the bright side');
    edges.push({ time, gradient: motion.gradient, x: draws[0].shader.start.x });
  }
  return { rects: fixture.rects, lines: fixture.lines, extent, edges };
}
for (const spicy of [false, true]) checkCapturedLayout(require('./fixtures/native-glyph-heart-layout.json'), spicy);
// Exercise exact-radius reuse and eviction through the real drawVoice path.
const cachePaints = makePaints();
const glowWord = { ...word, revealRects: [rect], pictures: ['glyph alpha'], emojiMask: [false] };
const glowCanvas = { save() {}, restore() {}, translate() {}, scale() {}, clipPath() {},
  saveLayer(paint) { blurOutputRadii.push(paint.imageFilter.sigmaX); },
  drawPicture() {}, drawGlyphs() {} };
const drawGlow = glow => moduleObject.exports.drawVoice(glowCanvas, [glowWord], [{ ...motion, glow }], 100, true, true, false,
  36, 1000, { bright: 1, dark: 0 }, { active: true, releasePosition: 0, elapsed: 0 }, cachePaints);
drawGlow(1);
const firstFilter = cachePaints.blurFilters[0];
const createsAfterFirstRadius = blurFilterCreates;
drawGlow(1);
assert.equal(blurFilterCreates, createsAfterFirstRadius, 'Identical sigma reuses the same native blur filter');
assert.equal(cachePaints.blurFilters[0], firstFilter);
drawGlow(0.999999);
assert.equal(blurFilterCreates, createsAfterFirstRadius + 1, 'Distinct exact sigma values are never quantized together');
assert.equal(blurOutputRadii.at(-1), 2 + 0.999999, 'The distinct exact sigma reaches the recorded glow unchanged');
for (let index = 2; index < 80; index++) drawGlow(index / 80);
assert.equal(cachePaints.blurRadii.length, 32, 'The per-voice blur cache stays within its fixed capacity');
assert.equal(cachePaints.blurFilters.length, cachePaints.blurRadii.length);
assert.ok(cachePaints.blurRadii.every((radius, index, radii) => radii.indexOf(radius) === index), 'LRU has no duplicate exact keys');
const beforeEvictionReuse = blurFilterCreates;
drawGlow(1);
assert.equal(blurFilterCreates, beforeEvictionReuse + 1, 'An evicted exact sigma is recreated safely on demand');
const longRunPaints = makePaints();
const drawLongRunGlow = glow => moduleObject.exports.drawVoice(glowCanvas, [glowWord], [{ ...motion, glow }], 100, true, true, false,
  36, 1000, { bright: 1, dark: 0 }, { active: true, releasePosition: 0, elapsed: 0 }, longRunPaints);
const beforeLongRun = blurFilterCreates;
drawLongRunGlow(100 / 10000);
const evictedFilterHeldByRecordedDraw = longRunPaints.blurFilters[0];
for (let index = 101; index < 10100; index++) drawLongRunGlow(index / 10000);
assert.equal(blurFilterCreates - beforeLongRun, 10000, 'A fresh 10,000-radius sequence creates each distinct exact radius once');
assert.equal(longRunPaints.blurRadii.length, 32, 'The cache remains bounded after 10,000 changing radii');
assert.equal(longRunPaints.blurFilters.length, 32);
assert.deepEqual(longRunPaints.blurRadii, Array.from({ length: 32 }, (_, index) => 2 + (10068 + index) / 10000),
  'The bounded cache retains the 32 newest exact sigma values');
assert.deepEqual(blurOutputRadii.slice(-10000), Array.from({ length: 10000 }, (_, index) => 2 + (100 + index) / 10000),
  'All changing radii reach recorded paint commands without quantization');
assert.equal(longRunPaints.blurFilters.includes(evictedFilterHeldByRecordedDraw), false, 'The oldest radius is evicted from the bounded cache');
longRunPaints.glowPaint.setImageFilter(evictedFilterHeldByRecordedDraw);
assert.equal(longRunPaints.glowPaint.imageFilter, evictedFilterHeldByRecordedDraw,
  'A paint can continue referencing the evicted filter without cache ownership');
assert.equal(evictedFilterHeldByRecordedDraw.sigmaX, 2 + 100 / 10000,
  'The separately retained filter remains usable after cache eviction');
assert.equal(blurFilterDisposals, 0, 'Evicting a cache entry never disposes the referenced native filter');
const afterLongRun = blurFilterCreates;
drawLongRunGlow(10099 / 10000);
assert.equal(blurFilterCreates, afterLongRun, 'The most recently used exact radius survives in the LRU');
drawLongRunGlow(100 / 10000);
assert.equal(blurFilterCreates, afterLongRun + 1, 'The oldest exact radius is evicted and recreated on demand');
assert.equal(blurFilterDisposals, 0, 'Eviction never explicitly disposes filters still potentially referenced by recorded pictures');
const canvasKitArg = process.argv.indexOf('--canvaskit');
if (canvasKitArg >= 0) require('./native-glyph-canvaskit.cjs')(process.argv[canvasKitArg + 1])
  .then(fixture => console.log('Live CanvasKit layout + real shapeGlyphWords/glyphRowExtent:', JSON.stringify(checkCapturedLayout(fixture), null, 2)))
  .catch(error => { console.error(error); process.exitCode = 1; });
console.log('Native glyph paint checks passed: direct text drawing, exact bounded blur caching, heart/emoji masking in Spicy and AMLL, multi-run Spicy reveal in LTR/RTL, continuous AMLL highlight release, Hangul ownership and descender isolation.');
