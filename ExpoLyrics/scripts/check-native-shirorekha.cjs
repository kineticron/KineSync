/* global __dirname */
// Real Skia WASM evidence, NOT native iOS. Production shaping/painting, real fonts.
// node scripts/check-native-shirorekha.cjs --font /path/to/Devanagari.ttf --rtl-font /path/to/Arabic.ttf --out /tmp/shirorekha
// Optional --source FILE runs an untouched glyph-picture baseline. No app font changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');
const { buildSync } = require('esbuild');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function main() {
  assert.ok(process.argv.includes('--font') && process.argv.includes('--rtl-font'), 'Supply real --font Devanagari.ttf and --rtl-font Arabic.ttf');
  const out = process.argv.includes('--out') ? arg('--out') : '/tmp/kinesync-shirorekha';
  fs.mkdirSync(out, { recursive: true });
  const ck = await require('canvaskit-wasm')({ locateFile: f => path.join(path.dirname(require.resolve('canvaskit-wasm')), f) });
  const web = path.join(path.dirname(require.resolve('@shopify/react-native-skia/package.json')), 'lib/commonjs/skia/web');
  const types = path.join(web, '../types');
  const { BlendMode } = require(path.join(types, 'Paint/BlendMode'));
  const { ClipOp } = require(path.join(types, 'Canvas'));
  const { TileMode } = require(path.join(types, 'ImageFilter/ImageFilter'));
  const Skia = require(path.join(web, 'JsiSkia')).JsiSkApi(ck);
  // CanvasKit uses instanceof Array; normalize only JS arrays crossing VM realms.
  const linearGradient = Skia.Shader.MakeLinearGradient.bind(Skia.Shader);
  Skia.Shader.MakeLinearGradient = (a, b, colors, ...rest) => linearGradient(a, b, Array.from(colors), ...rest);
  const { JsiSkCanvas } = require(path.join(web, 'JsiSkCanvas'));
  const drawGlyphs = JsiSkCanvas.prototype.drawGlyphs;
  JsiSkCanvas.prototype.drawGlyphs = function(ids, positions, ...rest) { return drawGlyphs.call(this, Array.from(ids), Array.from(positions), ...rest); };
  const { JsiSkFont } = require(path.join(web, 'JsiSkFont'));
  const createPicture = draw => { const recorder = Skia.PictureRecorder(); draw(recorder.beginRecording(Skia.XYWHRect(-64, -64, 900, 350))); return recorder.finishRecordingAsPicture(); };
  const directory = path.join(__dirname, '../components/lyrics/native');
  const filename = process.argv.includes('--source') ? arg('--source') : path.join(directory, 'native-glyph-picture.tsx');
  const source = fs.readFileSync(filename, 'utf8');
  function load(contents) {
    const code = buildSync({ stdin: { contents: contents + '\nexport { drawVoice };', resolveDir: directory, loader: 'tsx' }, bundle: true,
      platform: 'node', format: 'cjs', write: false, external: ['react', 'react-native-reanimated', 'react-native-worklets', '@shopify/react-native-skia'] }).outputFiles[0].text;
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, require: name => name === 'react' ? { memo: fn => fn } : name === '@shopify/react-native-skia' ?
      { Skia, createPicture, BlendMode, ClipOp, TileMode } : {} });
    return module.exports;
  }
  const api = load(source);
  const fonts = { indic: fs.readFileSync(arg('--font')), arabic: fs.readFileSync(arg('--rtl-font')),
    latin: fs.readFileSync(path.join(__dirname, '../assets/fonts/SF-Pro-Display-Bold.otf')) };
  const resources = [];
  const rect = r => Skia.XYWHRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  function fixture(text, fontName, parts, rtl = false) {
    const data = fonts[fontName], provider = ck.TypefaceFontProvider.Make(); provider.registerFont(data, 'Diagnostic');
    const typeface = ck.Typeface.MakeTypefaceFromData(data);
    for (const glyph of typeface.getGlyphIDs(text.replace(/\s/g, ''))) assert.notEqual(glyph, 0, `${fontName} must contain ${text}`);
    const builder = ck.ParagraphBuilder.MakeFromFontProvider(new ck.ParagraphStyle({ textDirection: rtl ? ck.TextDirection.RTL : ck.TextDirection.LTR,
      textAlign: ck.TextAlign.Left, textStyle: { fontFamilies: ['Diagnostic'], fontSize: 64, color: ck.WHITE } }), provider);
    builder.addText(text); const paragraph = builder.build(); paragraph.layout(650);
    const range = (start, end) => paragraph.getRectsForRange(start, end, ck.RectHeightStyle.Tight, ck.RectWidthStyle.Tight).map(box => rect(box.rect));
    const runs = paragraph.getShapedLines().flatMap(line => line.runs.map(run => {
      const font = new ck.Font(run.typeface, run.size), bounds = font.getGlyphBounds(run.glyphs);
      resources.push(font);
      return { glyphs: Array.from(run.glyphs), origin: { x: 0, y: 0 }, positions: Array.from(run.glyphs, (_, i) => ({ x: run.positions[i * 2], y: run.positions[i * 2 + 1] })),
        bounds: Array.from(run.glyphs, (_, i) => rect(bounds.subarray(i * 4, i * 4 + 4))), font: new JsiSkFont(ck, font) };
    }));
    resources.push(paragraph, builder, typeface, provider);
    const input = parts.map(part => {
      const letters = part.letters ?? [part.text];
      const rects = range(part.offset, part.offset + part.text.length);
      let offset = part.offset;
      return { word: { start: 0, end: 2000, ...part, letters }, rects, letters: letters.map(letter => { const start = offset; offset += letter.length; return range(start, offset); }),
        width: rects.reduce((n, r) => n + r.width, 0), before: 0 };
    });
    return { input, runs, shape: spicy => api.shapeGlyphWords({ getLineMetrics: () => paragraph.getLineMetrics(), extendedVisit: visit => runs.forEach(run => visit(0, run)) }, input, spicy) };
  }
  function raster(words, options = {}) {
    const { renderer = api, spicy = false, active = true, alpha = 0.5, dark = alpha, glow = 0, gradient = 0.5, time = 500, letterScale = 1 } = options;
    const surface = Skia.Surface.Make(750, 220), canvas = surface.getCanvas(); canvas.clear(Skia.Color('transparent')); canvas.translate(48, 64);
    const stats = { layers: 0, pictures: 0, glyphDraws: 0 };
    for (const [method, counter] of [['saveLayer', 'layers'], ['drawPicture', 'pictures'], ['drawGlyphs', 'glyphDraws']]) {
      const original = canvas[method].bind(canvas);
      canvas[method] = (...args) => { stats[counter]++; return original(...args); };
    }
    const motion = { scale: 1, y: 0, gradient, glow, letters: [] };
    renderer.drawVoice(canvas, words, words.map(word => ({ ...motion, letters: word.word.letters.map(() => ({ ...motion, scale: letterScale })) })), time, active, spicy, false, 64, 2000,
      { bright: alpha, dark }, { active: true, releasePosition: 0, elapsed: 0 }, { paint: Skia.Paint(), glowPaint: Skia.Paint(), blurRadii: [], blurFilters: [], revealShaders: [] });
    const image = surface.makeImageSnapshot();
    const pixels = image.ref.readPixels(0, 0, { width: 750, height: 220, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
    const display = Skia.Surface.Make(750, 220);
    display.getCanvas().clear(Skia.Color('#161c28')); display.getCanvas().drawImage(image, 0, 0);
    const preview = display.makeImageSnapshot(), png = preview.encodeToBytes();
    preview.dispose(); display.dispose(); image.dispose(); surface.dispose(); return { pixels, png, stats };
  }
  const results = [];
  const max = pixels => pixels.reduce((n, value, i) => i % 4 === 3 ? Math.max(n, value) : n, 0);
  const save = (label, image) => fs.writeFileSync(path.join(out, label + '.png'), image.png);
  const equalPixels = (a, b, message) => assert.equal(Buffer.compare(Buffer.from(a.pixels), Buffer.from(b.pixels)), 0, message);
  const noMask = words => words.map(word => ({ ...word, overlapMask: word.runs.map(() => false) }));
  function oneSlice(word, i) {
    return { ...word, runs: [word.runs[i]], clips: [word.clips[i]], pictures: [word.pictures[i]], emojiMask: [word.emojiMask[i]],
      overlapMask: [word.overlapMask[i]], revealRects: [word.revealRects[i]], letters: [word.word.emphasized ? word.letters[i] : word.rects],
      word: { ...word.word, letters: [word.word.letters[i] ?? word.word.text] } };
  }
  const indic = fixture('देख लो', 'indic', [{ text: 'देख', offset: 0, end: 1000 }, { text: 'लो', offset: 4, start: 1000 }]);
  for (const spicy of [false, true]) {
    const shaped = indic.shape(spicy), direct = noMask(shaped);
    for (const active of spicy ? [false] : [false, true]) for (const alpha of [0.3, 0.5, 0.85]) {
      const fixed = raster(shaped, { spicy, active, alpha }), before = raster(direct, { spicy, active, alpha });
      const expected = spicy ? 128 : Math.round(alpha * 255);
      const excess = before.pixels.reduce((n, value, i) => n + (i % 4 === 3 && value > fixed.pixels[i] + 4 ? 1 : 0), 0);
      const label = `${spicy ? 'spicy' : 'amll'}-${active ? 'active' : 'inactive'}-${alpha}`;
      save(label + '-before', before); save(label + '-after', fixed);
      results.push({ label, maximumBefore: max(before.pixels), maximumAfter: max(fixed.pixels), expected, excess });
      assert.ok(Math.abs(max(fixed.pixels) - expected) <= 1, `${label}: maximum ${max(fixed.pixels)} must equal requested alpha ${expected}`);
      assert.ok(excess > 0, `${label}: must reproduce actual overlapping ink`);
    }
  }
  // AMLL has its own line reveal/release shader: independently exercise its
  // bright and dark endpoints in BOTH active and inactive states. The shared
  // overlap mask must fix each path without routing through Spicy painting.
  const amllWords = indic.shape(false);
  for (const active of [false, true]) for (const [state, time, expectedDirect, expectedFixed] of [
    ['dark', -1000, 192, 128], ['bright', 3000, 249, 217],
  ]) {
    const options = { spicy: false, active, alpha: 0.85, dark: 0.5, time, glow: 0 };
    const direct = raster(noMask(amllWords), options), fixed = raster(amllWords, options);
    const label = `amll-${active ? 'active' : 'inactive'}-${state}-reveal`;
    assert.ok(Math.abs(max(direct.pixels) - expectedDirect) <= 1, `${label}: independent direct-alpha control`);
    assert.ok(Math.abs(max(fixed.pixels) - expectedFixed) <= 1, `${label}: shared alpha-union correction`);
    const excess = direct.pixels.reduce((n, value, i) => n + (i % 4 === 3 && value > fixed.pixels[i] + 4 ? 1 : 0), 0);
    assert.ok(excess > 0, `${label}: actual overlapping Devanagari ink must reproduce the defect`);
    save(`${label}-direct`, direct); save(`${label}-fixed`, fixed);
    results.push({ label, maximumDirect: max(direct.pixels), maximumFixed: max(fixed.pixels), expectedDirect, expectedFixed, excess });
  }
  // Independent review's active Spicy control, with only overlapMask disabled
  // for direct painting. At gradient=0 the first 20% is still a fade strip:
  // assert the 0.5 plateau beyond that strip, not a uniform-dark whole image.
  const activeSpicy = indic.shape(true);
  const fullyRevealed = raster(activeSpicy, { spicy: true, active: true, glow: 0, gradient: 1 });
  for (const [gradient, expectedDirect, expectedFixed] of [[0, 192, 128], [1, 249, 217]]) {
    const options = { spicy: true, active: true, glow: 0, gradient };
    const direct = raster(noMask(activeSpicy), options), fixed = raster(activeSpicy, options);
    let plateauPixels = 0, plateauMaximumDirect = 0, plateauMaximumFixed = 0, excess = 0;
    for (let i = 3; i < fixed.pixels.length; i += 4) {
      if (fullyRevealed.pixels[i] !== 217) continue; // Fully covered ink only.
      const x = Math.floor(i / 4) % 750 - 48; // Undo raster()'s canvas translation.
      if (gradient === 0 && !activeSpicy.some(word => {
        const rect = word.revealRects[0];
        return x >= rect.x + rect.width * 0.2 + 1 && x <= rect.x + rect.width - 1;
      })) continue;
      plateauPixels++;
      plateauMaximumDirect = Math.max(plateauMaximumDirect, direct.pixels[i]);
      plateauMaximumFixed = Math.max(plateauMaximumFixed, fixed.pixels[i]);
      assert.ok(Math.abs(fixed.pixels[i] - expectedFixed) <= 1, `Active Spicy solid plateau ${expectedFixed}`);
      if (direct.pixels[i] > fixed.pixels[i] + 4) excess++;
    }
    assert.ok(plateauPixels > 100 && excess > 0, 'Active Spicy control must contain solid plateau ink and excess overlap alpha');
    assert.ok(Math.abs(plateauMaximumDirect - expectedDirect) <= 1, `Active Spicy direct plateau ${expectedDirect}`);
    assert.ok(Math.abs(plateauMaximumFixed - expectedFixed) <= 1, `Active Spicy union plateau ${expectedFixed}`);
    if (gradient === 1) assert.equal(max(fixed.pixels), 217, 'Full active reveal caps the entire foreground at 0.85');
    save(`active-spicy-control-${gradient}-direct`, direct); save(`active-spicy-control-${gradient}-fixed`, fixed);
    results.push({ label: `active-spicy-control-${gradient}`, maximumDirect: max(direct.pixels), maximumFixed: max(fixed.pixels),
      plateauMaximumDirect, plateauMaximumFixed, expectedDirect, expectedFixed, plateauPixels, excess });
  }
  // Active Spicy: exact bright/dark plateaus and a half-swept frame. Neither
  // the line alpha argument nor disabling active can stand in for this path.
  for (const [name, data] of [['indic-word', indic], ['indic-graphemes', fixture('देख', 'indic', [{ text: 'देख', offset: 0, emphasized: true,
    letters: Array.from(new Intl.Segmenter('hi', { granularity: 'grapheme' }).segment('देख'), entry => entry.segment) }])]]) {
    const words = data.shape(true), plateaus = [];
    for (const [gradient, expected] of [[-0.2, 128], [1, 217]]) {
      const image = raster(words, { spicy: true, active: true, gradient }); save(`${name}-active-spicy-${expected}`, image);
      plateaus.push(image);
      assert.ok(Math.abs(max(image.pixels) - expected) <= 1, `${name}: resting active Spicy composite plateau ${expected}`);
      // Multiple emphasized graphemes can overlap each other; assert plateaus
      // on each slice separately, then characterize their composite below.
      for (const word of words) for (let i = 0; i < word.runs.length; i++) {
        const slice = oneSlice(word, i);
        const isolated = raster([slice], { spicy: true, active: true, gradient });
        assert.ok(Math.abs(max(isolated.pixels) - expected) <= 1, `${name}: active Spicy slice plateau ${expected}`);
      }
      results.push({ label: `${name}-active-spicy-${expected}`, compositeMaximum: max(image.pixels), perSliceExpected: expected });
    }
    const sweep = raster(words, { spicy: true, gradient: 0.5 }); save(`${name}-active-spicy-sweep`, sweep);
    let brightInteriorPixels = 0, dimInteriorPixels = 0;
    for (let i = 3; i < sweep.pixels.length; i += 4) {
      if (plateaus[0].pixels[i] !== 128 || plateaus[1].pixels[i] !== 217) continue;
      if (sweep.pixels[i] === 217) brightInteriorPixels++;
      if (sweep.pixels[i] === 128) dimInteriorPixels++;
    }
    assert.ok(brightInteriorPixels > 0 && dimInteriorPixels > 0, 'Active sweep includes both plateaus inside fully covered glyph ink, excluding antialiased edges');
    results.push({ label: `${name}-active-spicy-sweep`, brightInteriorPixels, dimInteriorPixels });
    const whole = fixture('देख', 'indic', [{ text: 'देख', offset: 0 }]).shape(true);
    if (name === 'indic-graphemes') {
      const composite = raster(words, { spicy: true, gradient: 1 }), union = raster(whole, { spicy: true, gradient: 1 });
      assert.ok(max(composite.pixels) <= 218, 'This resting grapheme fixture must keep its correct plateau');
      const scaled = raster(words, { spicy: true, gradient: 1, letterScale: 1.1 });
      assert.ok(max(scaled.pixels) > 218, `Independently scaled graphemes can still overlap: ${max(scaled.pixels)}`);
      assert.ok(max(union.pixels) <= 218, 'A single union slice has no excess alpha');
      results.push({ label: 'cross-grapheme-limit', letters: words[0].word.letters, restingSplitMaximum: max(composite.pixels), independentlyScaledMaximum: max(scaled.pixels), unionMaximum: max(union.pixels) });
      save('cross-grapheme-split', composite); save('cross-grapheme-scaled-limit', scaled); save('cross-grapheme-union-reference', union);
    }
  }
  // Actual RTL contextual shaping and a separately proven SF Pro fi ligature.
  // This installed Arabic font shapes lam/alef as two contextual glyphs; do not
  // mislabel it a single-glyph ligature or synthesize glyph ownership.
  const arabic = fixture('لا', 'arabic', [{ text: 'لا', offset: 0, emphasized: true, letters: ['ل', 'ا'] }], true);
  for (const spicy of [false, true]) {
    const words = arabic.shape(spicy), slices = words[0].runs.map(runs => runs.flatMap(run => run.glyphs));
    assert.ok(words[0].letters[0][0].x > words[0].letters[1][0].x, 'Logical lam/alef ranges must occupy RTL positions');
    // -1 puts the RTL edge beyond overhanging ink for a clean dim plateau;
    // this controlled diagnostic value is outside the normal motion range.
    const plateaus = [];
    for (const gradient of [-1, 0.5, 1]) {
      const image = raster(words, { spicy, active: spicy, gradient, time: -1000 }); save(`rtl-${spicy ? 'spicy' : 'amll'}-${gradient}`, image);
      plateaus.push(max(image.pixels));
      results.push({ label: `rtl-${spicy}-${gradient}`, glyphs: slices, maximum: max(image.pixels), ...image.stats });
      assert.ok(max(image.pixels) > 0, 'RTL contextual glyphs must remain visible');
    }
    if (spicy) {
      for (const [gradient, expected] of [[-1, 128], [1, 217]]) for (let i = 0; i < words[0].runs.length; i++) {
        const image = raster([oneSlice(words[0], i)], { spicy, active: spicy, gradient, time: -1000 });
        assert.ok(Math.abs(max(image.pixels) - expected) <= 1, 'Each actual RTL slice reaches the correct Spicy plateau');
      }
      assert.ok(plateaus[0] > 129 && plateaus[2] > 218, 'Separate emphasized RTL slices expose the same cross-slice limit even at rest');
      results.push({ label: 'rtl-cross-slice-limit', dimMaximum: plateaus[0], brightMaximum: plateaus[2], perSliceDim: 128, perSliceBright: 217 });
    }
  }
  const ligature = fixture('fi', 'latin', [{ text: 'fi', offset: 0, emphasized: true, letters: ['f', 'i'] }]);
  for (const spicy of [false, true]) {
    const words = ligature.shape(spicy), slices = words[0].runs.map(runs => runs.flatMap(run => run.glyphs));
    assert.ok(slices[0].some(id => slices[1].includes(id)), `Real SF Pro fi ligature must share a glyph across the requested character slices: ${JSON.stringify(slices)}`);
    for (const gradient of [-0.2, 0.5, 1]) {
      const image = raster(words, { spicy, active: spicy, gradient, time: -1000 }); save(`shared-ligature-${spicy}-${gradient}`, image);
      assert.ok(max(image.pixels) > 0, 'Shared ligature retains visible ink');
      results.push({ label: `shared-ligature-${spicy}-${gradient}`, glyphs: slices, maximum: max(image.pixels) });
    }
  }
  const nonoverlap = fixture('HI', 'latin', [{ text: 'HI', offset: 0 }]);
  for (const spicy of [false, true]) {
    const words = nonoverlap.shape(spicy);
    assert.ok(words.every(word => word.overlapMask.every(mask => !mask)), 'Real SF Pro nonoverlap must retain direct path');
    const image = raster(words, { spicy });
    assert.equal(image.stats.layers, 0, 'Nonoverlap foreground must allocate no alpha layer');
    assert.equal(image.stats.pictures, 0, 'Nonoverlap foreground must not draw a source picture');
    assert.ok(image.stats.glyphDraws > 0, 'Nonoverlap foreground draws actual glyphs directly');
    save(`nonoverlap-${spicy}`, image); results.push({ label: `nonoverlap-${spicy}`, ...image.stats });
  }
  // A saveLayer restore paint's shader has no raster effect in this Skia
  // backend. Compare the retained original condition with the proposed shader
  // suppression using real production draws with demonstrably visible glow.
  // Native iOS is not proved by this experiment, so preserve its original code.
  const glowCondition = 'spicy || word.emojiMask[letter] ? null : shader';
  assert.ok(source.includes(glowCondition), 'Locate the original production glow condition');
  const suppressedShader = load(source.replace(glowCondition, 'spicy || word.emojiMask[letter] || word.overlapMask?.[letter] ? null : shader'));
  for (const [name, data] of [['indic-one-slice', fixture('देख', 'indic', [{ text: 'देख', offset: 0, emphasized: true, letters: ['देख'] }])],
    ['indic-graphemes', fixture('देख', 'indic', [{ text: 'देख', offset: 0, emphasized: true, letters: ['दे', 'ख'] }])],
    ['nonoverlap', fixture('HI', 'latin', [{ text: 'HI', offset: 0, emphasized: true, letters: ['HI'] }])]]) {
    const words = data.shape(false), emojiReference = words.map(word => ({ ...word, emojiMask: word.emojiMask.map((mask, i) => mask || word.overlapMask[i]) }));
    const without = raster(words, { active: false, time: 900 }), withGlow = raster(words, { time: 900 });
    const suppressedWithout = raster(words, { active: false, time: 900, renderer: suppressedShader }), suppressedGlow = raster(words, { time: 900, renderer: suppressedShader });
    equalPixels(without, suppressedWithout, 'Glow conditional cannot affect the no-glow foreground');
    equalPixels(withGlow, raster(emojiReference, { time: 900 }), 'Overlap glow must match the established emoji alpha-mask path');
    const difference = withGlow.pixels.reduce((n, value, i) => n + (i % 4 === 3 && value !== suppressedGlow.pixels[i] ? 1 : 0), 0);
    const glowPixels = withGlow.pixels.reduce((n, value, i) => n + (i % 4 === 3 && value > without.pixels[i] ? 1 : 0), 0);
    assert.ok(glowPixels > 0, `${name}: actual emphasized AMLL glow must emit visible alpha`);
    equalPixels(withGlow, suppressedGlow, `${name}: suppression of the restore-paint shader must not change this backend's pixels`);
    if (name !== 'nonoverlap') assert.ok(words.some(word => word.overlapMask.some(Boolean)), 'Glow experiment must exercise the actual overlap branch');
    save(`amll-${name}-no-glow`, without); save(`amll-${name}-with-glow`, withGlow); save(`amll-${name}-suppressed-restore-shader-control`, suppressedGlow);
    results.push({ label: `amll-glow-${name}`, glowPixels, restoreShaderDifferencePixels: difference });
  }
  // Keep dual-renderer coverage explicit: dropping either renderer/state or
  // the real emphasized AMLL glow experiment must fail this standalone check.
  const coverage = {
    amllActive: results.some(result => result.label === 'amll-active-bright-reveal'),
    amllInactive: results.some(result => result.label === 'amll-inactive-dark-reveal'),
    amllGlow: results.some(result => result.label === 'amll-glow-indic-graphemes' && result.glowPixels > 0),
    spicyActive: results.some(result => result.label === 'active-spicy-control-1'),
    spicyInactive: results.some(result => result.label === 'spicy-inactive-0.5'),
  };
  for (const [name, present] of Object.entries(coverage)) assert.ok(present, `Missing independent production-path coverage: ${name}`);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ renderer: 'CanvasKit real Skia WASM, not native iOS', coverage, fontSha256: Object.fromEntries(Object.entries(fonts).map(([name, bytes]) => [name, hash(bytes)])), results }, null, 2));
  console.log(JSON.stringify(results));
  for (const resource of resources) resource.delete();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
