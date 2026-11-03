/* global __dirname */
// Real Skia WASM evidence, NOT native iOS. Production shaping/painting, real fonts.
// node scripts/check-native-shirorekha.cjs --font /path/to/Devanagari.ttf --rtl-font /path/to/Arabic.ttf --out /tmp/shirorekha
// Optional --source FILE runs an untouched glyph-picture negative control.
// --ownership-baseline FILE supplies the pinned pre-fix source without git. No app font changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Buffer } = require('node:buffer');
const { execFileSync } = require('node:child_process');
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
  const makeMatrix = Skia.ColorFilter.MakeMatrix.bind(Skia.ColorFilter);
  Skia.ColorFilter.MakeMatrix = values => makeMatrix(Array.from(values));
  const { JsiSkCanvas } = require(path.join(web, 'JsiSkCanvas'));
  const drawGlyphs = JsiSkCanvas.prototype.drawGlyphs;
  JsiSkCanvas.prototype.drawGlyphs = function(ids, positions, ...rest) { return drawGlyphs.call(this, Array.from(ids), Array.from(positions), ...rest); };
  const { JsiSkFont } = require(path.join(web, 'JsiSkFont'));
  const createPicture = draw => { const recorder = Skia.PictureRecorder(); draw(recorder.beginRecording(Skia.XYWHRect(-64, -64, 900, 350))); return recorder.finishRecordingAsPicture(); };
  const directory = path.join(__dirname, '../components/lyrics/native');
  const filename = process.argv.includes('--source') ? arg('--source') : path.join(directory, 'native-glyph-picture.tsx');
  const source = fs.readFileSync(filename, 'utf8');
  function load(contents) {
    const code = buildSync({ stdin: { contents: contents + '\nexport { drawVoice, advanceReferenceWordMotion, initialWordSpringState };', resolveDir: directory, loader: 'tsx' }, bundle: true,
      platform: 'node', format: 'cjs', write: false, external: ['react', 'react-native-reanimated', 'react-native-worklets', '@shopify/react-native-skia'] }).outputFiles[0].text;
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports, require: name => name === 'react' ? { memo: fn => fn } : name === '@shopify/react-native-skia' ?
      { Skia, createPicture, BlendMode, ClipOp, TileMode } : {} });
    return module.exports;
  }
  const api = load(source);
  // Compare ownership-preserving paths with the exact pre-fix source for this
  // worktree, not a hand-reimplemented draw or a copy of current noMask code.
  const baselineRevision = source.includes('useArrivalPictureMeasurement')
    ? '62dd2047ae87cbe31854f8b44db2c3c59c0bcfa9' : 'baca428b1a507804db9f279fcec854619102c465';
  const expectedBaselineHash = baselineRevision.startsWith('62dd204')
    ? 'bde154dafa6a57651a22927d3e03aa43a4a8a34f38e1e14c9b9b97e465fa491c'
    : 'de85eacea4a74ef504fa9e9569a71728e0d468aa08592f98d3d2a0ca6460c352';
  const baselineSource = process.argv.includes('--ownership-baseline') ? fs.readFileSync(arg('--ownership-baseline'), 'utf8')
    : execFileSync('git', ['show', `${baselineRevision}:ExpoLyrics/components/lyrics/native/native-glyph-picture.tsx`], { cwd: directory, encoding: 'utf8' });
  assert.equal(hash(baselineSource), expectedBaselineHash, 'Ownership baseline must be the exact pinned pre-fix production source');
  const baseline = load(baselineSource);
  const preCrossRevision = source.includes('useArrivalPictureMeasurement')
    ? 'e44adb46481b6ffb050ca0d7ffe32b2f1e1e7f94' : '8994dbfcd239ebb56869c9f2fee75c10e0d360c3';
  const preCrossSource = execFileSync('git', ['show', `${preCrossRevision}:ExpoLyrics/components/lyrics/native/native-glyph-picture.tsx`], { cwd: directory, encoding: 'utf8' });
  const preCross = load(preCrossSource);
  const fonts = { indic: fs.readFileSync(arg('--font')), arabic: fs.readFileSync(arg('--rtl-font')),
    latin: fs.readFileSync(path.join(__dirname, '../assets/fonts/SF-Pro-Display-Bold.otf')) };
  const resources = [];
  const rect = r => Skia.XYWHRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  function fixture(text, fontName, parts, rtl = false, fallbackName) {
    const data = fonts[fontName], provider = ck.TypefaceFontProvider.Make(); provider.registerFont(data, 'Diagnostic');
    const typeface = ck.Typeface.MakeTypefaceFromData(data);
    const fallback = fallbackName && ck.Typeface.MakeTypefaceFromData(fonts[fallbackName]);
    if (fallback) { provider.registerFont(fonts[fallbackName], 'Diagnostic fallback'); resources.push(fallback); }
    for (const char of text.replace(/\s/g, '')) assert.ok(typeface.getGlyphIDs(char)[0] || fallback?.getGlyphIDs(char)[0], `${fontName} / fallback must contain ${char}`);
    const builder = ck.ParagraphBuilder.MakeFromFontProvider(new ck.ParagraphStyle({ textDirection: rtl ? ck.TextDirection.RTL : ck.TextDirection.LTR,
      textAlign: ck.TextAlign.Left, textStyle: { fontFamilies: fallback ? ['Diagnostic', 'Diagnostic fallback'] : ['Diagnostic'], fontSize: 64, color: ck.WHITE } }), provider);
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
    return { input, runs, shape: (spicy, renderer = api) => renderer.shapeGlyphWords({ getLineMetrics: () => paragraph.getLineMetrics(), extendedVisit: visit => runs.forEach(run => visit(0, run)) }, input, spicy) };
  }
  function raster(words, options = {}) {
    const { renderer = api, spicy = false, active = true, alpha = 0.5, dark = alpha, glow = 0, gradient = 0.5, time = 500, letterScale = 1, letterGradients, motions, background = false, paints } = options;
    const surface = Skia.Surface.Make(750, 220), canvas = surface.getCanvas(); canvas.clear(Skia.Color('transparent')); canvas.translate(48, 64);
    const stats = { layers: 0, pictures: 0, glyphDraws: 0 };
    for (const [method, counter] of [['saveLayer', 'layers'], ['drawPicture', 'pictures'], ['drawGlyphs', 'glyphDraws']]) {
      const original = canvas[method].bind(canvas);
      canvas[method] = (...args) => { stats[counter]++; return original(...args); };
    }
    const motion = { scale: 1, y: 0, gradient, glow, letters: [] };
    renderer.drawVoice(canvas, words, motions ?? words.map(word => ({ ...motion, letters: word.word.letters.map((_, i) => ({ ...motion, scale: letterScale, gradient: letterGradients?.[i] ?? gradient })) })), time, active, spicy, background, 64, 2000,
      { bright: alpha, dark }, { active: true, releasePosition: 0, elapsed: 0 }, paints ?? { paint: Skia.Paint(), glowPaint: Skia.Paint(), blurRadii: [], blurFilters: [], revealShaders: [] });
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
  const noMask = words => words.map(word => ({ ...word, overlapMask: word.runs.map(() => false), unionGroup: undefined }));
  function oneSlice(word, i) {
    return { ...word, unionGroup: undefined, runs: [word.runs[i]], clips: [word.clips[i]], pictures: [word.pictures[i]], emojiMask: [word.emojiMask[i]],
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
      const beforeWords = data.shape(true, preCross);
      const beforeScaled = raster(beforeWords, { renderer: preCross, spicy: true, gradient: 1, letterScale: 1.1 });
      assert.ok(max(beforeScaled.pixels) > 218, 'Exact pre-new-fix source must reproduce cross-grapheme excess');
      assert.equal(max(scaled.pixels), 217, 'Independently scaled graphemes must now cap at the requested alpha');
      save('cross-grapheme-pre-new-fix', beforeScaled);
      assert.ok(max(union.pixels) <= 218, 'A single union slice has no excess alpha');
      results.push({ label: 'cross-grapheme-corrected', letters: words[0].word.letters, restingSplitMaximum: max(composite.pixels), preNewFixMaximum: max(beforeScaled.pixels), independentlyScaledMaximum: max(scaled.pixels), unionMaximum: max(union.pixels) });
      save('cross-grapheme-split', composite); save('cross-grapheme-scaled-limit', scaled); save('cross-grapheme-union-reference', union);
    }
  }
  // Actual RTL contextual shaping and a separately proven SF Pro fi ligature.
  // This installed Arabic font shapes lam/alef as two contextual glyphs; do not
  // mislabel it a single-glyph ligature or synthesize glyph ownership.
  const arabic = fixture('لا', 'arabic', [{ text: 'لا', offset: 0, emphasized: true, letters: ['ل', 'ا'] }], true);
  for (const spicy of [false, true]) {
    const words = arabic.shape(spicy), baselineWords = arabic.shape(spicy, baseline), slices = words[0].runs.map(runs => runs.flatMap(run => run.glyphs));
    assert.ok(words[0].overlapMask.every(mask => !mask), 'RTL separate slices retain the unmasked path');
    assert.equal(JSON.stringify(words.map(word => word.runs.map(runs => runs.map(run => [run.glyphs, run.positions])))),
      JSON.stringify(baselineWords.map(word => word.runs.map(runs => runs.map(run => [run.glyphs, run.positions])))), 'RTL glyph ownership/positions match the exact pre-fix source');
    assert.ok(words[0].letters[0][0].x > words[0].letters[1][0].x, 'Logical lam/alef ranges must occupy RTL positions');
    // -1 puts the RTL edge beyond overhanging ink for a clean dim plateau;
    // this controlled diagnostic value is outside the normal motion range.
    const plateaus = [];
    for (const gradient of [-1, 0.5, 1]) {
      const image = raster(words, { spicy, active: spicy, gradient, time: -1000 }); save(`rtl-${spicy ? 'spicy' : 'amll'}-${gradient}`, image);
      const before = raster(baselineWords, { renderer: baseline, spicy, active: spicy, gradient, time: -1000 });
      equalPixels(raster(noMask(words), { spicy, active: spicy, gradient, time: -1000 }), before, 'RTL unmasked raster must be byte-identical to exact pre-fix production source at the same gradient');
      save(`rtl-baseline-${spicy}-${gradient}`, before);
      plateaus.push(max(image.pixels));
      results.push({ baselineNoMaskPixelsEqual: true, baselineMaximum: max(before.pixels), label: `rtl-${spicy}-${gradient}`, glyphs: slices, maximum: max(image.pixels), ...image.stats });
      assert.ok(max(image.pixels) > 0, 'RTL contextual glyphs must remain visible');
    }
    if (spicy) {
      for (const [gradient, expected] of [[-1, 128], [1, 217]]) for (let i = 0; i < words[0].runs.length; i++) {
        const image = raster([oneSlice(words[0], i)], { spicy, active: spicy, gradient, time: -1000 });
        assert.ok(Math.abs(max(image.pixels) - expected) <= 1, 'Each actual RTL slice reaches the correct Spicy plateau');
      }
      assert.equal(plateaus[0], 128, 'RTL grouped slices cap dim alpha');
      assert.equal(plateaus[2], 217, 'RTL grouped slices cap bright alpha');
      results.push({ label: 'rtl-cross-slice-corrected', dimMaximum: plateaus[0], brightMaximum: plateaus[2], perSliceDim: 128, perSliceBright: 217 });
    }
  }
  // Direction is asserted on ONE RTL slice, so separate transformed slices
  // cannot make cross-slice alpha accumulation look like a sweep failure.
  const rtlSingle = fixture('سلام', 'arabic', [{ text: 'سلام', offset: 0 }], true).shape(true);
  assert.equal(rtlSingle.length, 1); assert.equal(rtlSingle[0].runs.length, 1);
  const rtlFull = raster(rtlSingle, { spicy: true, gradient: 1 });
  const rtlDim = raster(rtlSingle, { spicy: true, gradient: -1 });
  const rtlHalf = raster(rtlSingle, { spicy: true, gradient: 0.5 });
  assert.equal(max(rtlFull.pixels), 217, 'One RTL slice bright plateau is 0.85');
  assert.equal(max(rtlDim.pixels), 128, 'One RTL slice dim plateau is 0.5');
  const extent = rtlSingle[0].revealRects[0];
  let rightBrightPixels = 0, leftDimPixels = 0;
  for (let i = 3; i < rtlHalf.pixels.length; i += 4) {
    if (rtlFull.pixels[i] !== 217 || rtlDim.pixels[i] !== 128) continue;
    const x = Math.floor(i / 4) % 750 - 48;
    if (x >= extent.x + extent.width * 0.5 + 1 && x <= extent.x + extent.width - 1) {
      assert.equal(rtlHalf.pixels[i], 217, 'RTL sweep keeps solid ink right of the edge bright'); rightBrightPixels++;
    }
    if (x >= extent.x + 1 && x <= extent.x + extent.width * 0.3 - 1) {
      assert.equal(rtlHalf.pixels[i], 128, 'RTL sweep keeps solid ink left of the fade dim'); leftDimPixels++;
    }
  }
  assert.ok(rightBrightPixels > 0 && leftDimPixels > 0, 'Actual RTL half-sweep must exercise both sides on one slice');
  save('rtl-one-slice-direction', rtlHalf);
  results.push({ label: 'rtl-one-slice-direction', rightBrightPixels, leftDimPixels, dimMaximum: max(rtlDim.pixels), brightMaximum: max(rtlFull.pixels) });
  const ligature = fixture('fi', 'latin', [{ text: 'fi', offset: 0, emphasized: true, letters: ['f', 'i'] }]);
  for (const spicy of [false, true]) {
    const words = ligature.shape(spicy), baselineWords = ligature.shape(spicy, baseline), slices = words[0].runs.map(runs => runs.flatMap(run => run.glyphs));
    assert.ok(slices[0].some(id => slices[1].includes(id)), `Real SF Pro fi ligature must share a glyph across the requested character slices: ${JSON.stringify(slices)}`);
    for (const gradient of [-0.2, 0.5, 1]) {
      const image = raster(words, { spicy, active: spicy, gradient, time: -1000 }); save(`shared-ligature-${spicy}-${gradient}`, image);
      const before = raster(baselineWords, { renderer: baseline, spicy, active: spicy, gradient, time: -1000 });
      equalPixels(raster(noMask(words), { spicy, active: spicy, gradient, time: -1000 }), before, 'Shared-ligature no-mask ownership path must match exact pre-fix pixels');
      if (words.every(word => word.unionGroup === undefined && word.overlapMask.every(mask => !mask))) equalPixels(image, before, 'Unmasked shared-ligature foreground remains byte-identical');
      assert.ok(max(image.pixels) > 0, 'Shared ligature retains visible ink');
      results.push({ baselineNoMaskPixelsEqual: true, baselineMaximum: max(before.pixels), label: `shared-ligature-${spicy}-${gradient}`, glyphs: slices, maximum: max(image.pixels) });
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
  // Independent oracle: render each actual transformed slice through the
  // production path in isolation, then take the per-pixel alpha maximum in JS.
  // No font geometry is mocked and no ownership/timing is reconstructed.
  const emptySource = createPicture(() => {});
  function maxOracle(words, options) {
    const expected = new Uint8Array(750 * 220 * 4);
    let slices = 0;
    for (let wi = 0; wi < words.length; wi++) for (let li = 0; li < words[wi].runs.length; li++) {
      const isolated = words.map((word, i) => ({ ...word, unionGroup: undefined,
        runs: word.runs.map((runs, j) => i === wi && j === li ? runs : []),
        pictures: word.pictures.map((picture, j) => i === wi && j === li ? picture : emptySource),
        emojiMask: word.emojiMask.map((mask, j) => i === wi && j === li && mask),
        // Group slices always union their own opaque glyph coverage first,
        // including newly touching AA edges after a nonintegral transform.
        overlapMask: word.overlapMask.map((mask, j) => i === wi && j === li && (mask || word.unionGroup !== undefined)) }));
      const image = raster(isolated, options); slices++;
      for (let i = 3; i < expected.length; i += 4) expected[i] = Math.max(expected[i], image.pixels[i]);
    }
    return { pixels: expected, slices };
  }
  const crossFixtures = [
    ['indic-graphemes', fixture('देख', 'indic', [{ text: 'देख', offset: 0, emphasized: true, letters: ['दे', 'ख'] }])],
    ['rtl-contextual', arabic],
    ['fallback-run-join', fixture('Aदे', 'latin', [{ text: 'Aदे', offset: 0, emphasized: true, letters: ['A', 'दे'] }], false, 'indic')],
    ['shared-ligature', ligature],
    ['joined-timing-atoms', fixture('देख', 'indic', [{ text: 'दे', offset: 0, emphasized: true, letters: ['दे'], end: 1000, origin: 0 },
      { text: 'ख', offset: 2, emphasized: true, letters: ['ख'], start: 1000, origin: 1 }])],
  ];
  for (const [name, data] of crossFixtures) for (const spicy of [false, true]) for (const active of [false, true]) {
    const words = data.shape(spicy), oldWords = data.shape(spicy, preCross);
    assert.ok(words.every(word => word.unionGroup !== undefined), `${name}: connected slices must share a compositor`);
    for (const phase of ['dark', 'join-sweep', 'bright', 'glow']) {
      const options = { spicy, active, alpha: 0.85, dark: phase === 'dark' ? 0.5 : phase === 'bright' ? 0.85 : 0.3,
        time: phase === 'dark' ? -1000 : phase === 'bright' ? 3000 : 900,
        gradient: phase === 'dark' ? -1 : phase === 'bright' ? 1 : 0.5,
        letterGradients: phase === 'join-sweep' ? [1, 0] : undefined,
        letterScale: 1.1, glow: phase === 'glow' ? 1 : 0 };
      const fixed = raster(words, options), before = raster(oldWords, { ...options, renderer: preCross }), oracle = maxOracle(words, options);
      let error = 0, excessBefore = 0, changed = 0;
      for (let i = 3; i < fixed.pixels.length; i += 4) {
        error = Math.max(error, Math.abs(fixed.pixels[i] - oracle.pixels[i]));
        if (before.pixels[i] > oracle.pixels[i] + 2) excessBefore++;
        if (before.pixels[i] !== fixed.pixels[i]) changed++;
      }
      assert.ok(error <= 1, `${name}/${spicy}/${active}/${phase}: pixel alpha must equal the independent transformed-slice maximum (error ${error})`);
      const label = `cross-${name}-${spicy ? 'spicy' : 'amll'}-${active ? 'active' : 'inactive'}-${phase}`;
      save(label + '-fixed', fixed); save(label + '-pre-new-fix', before);
      results.push({ label, maximum: max(fixed.pixels), baselineMaximum: max(before.pixels), maxOracleError: error, excessBefore, changed, isolatedSlices: oracle.slices });
    }
  }
  // Use actual production spring trajectories, independent per-letter
  // gradients/translation/scale/glow and noncentral word origins. The oracle
  // retains every pose; it only isolates slices to measure their real pixels.
  for (const [name, data] of crossFixtures.filter(([name]) => name === 'indic-graphemes' || name === 'joined-timing-atoms')) {
    const words = data.shape(true);
    let states = words.map(word => api.initialWordSpringState(word.word));
    const cachedPaints = { paint: Skia.Paint(), glowPaint: Skia.Paint(), blurRadii: [], blurFilters: [], revealShaders: [] };
    let retained;
    for (let frame = 0; frame <= 120; frame++) {
      const time = frame * 1000 / 60;
      const advanced = words.map((word, i) => api.advanceReferenceWordMotion(word.word, states[i], time, 1 / 60));
      states = advanced.map(result => result.state);
      if (frame % 30 !== 0) continue;
      for (const active of [false, true]) {
        const options = { spicy: true, active, time, motions: advanced.map(result => result.motion), paints: cachedPaints };
        const fixed = raster(words, options), expected = maxOracle(words, { ...options, paints: undefined });
        let error = 0;
        for (let i = 3; i < fixed.pixels.length; i += 4) error = Math.max(error, Math.abs(fixed.pixels[i] - expected.pixels[i]));
        assert.ok(error <= 1, `${name}: actual spring frame ${frame}/${active} preserves the per-slice image maximum (error ${error})`);
        if (!retained) retained = cachedPaints.unionPaints;
        assert.equal(cachedPaints.unionPaints, retained, 'Union encode/decode paints and their filters are reused across frames');
        save(`spring-${name}-${frame}-${active}`, fixed);
        results.push({ label: `spring-${name}-${frame}-${active}`, maxOracleError: error, ...fixed.stats });
      }
    }
  }
  for (const style of ['amll', 'spicy']) {
    assert.ok(results.some(result => result.label.startsWith(`cross-indic-graphemes-${style}-`) && result.excessBefore > 0), `${style}: pre-new-fix source must reproduce actual cross-slice excess`);
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
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ renderer: 'CanvasKit real Skia WASM, not native iOS', baselineRevision, baselineSourceSha256: expectedBaselineHash, preCrossRevision, preCrossSourceSha256: hash(preCrossSource), coverage, fontSha256: Object.fromEntries(Object.entries(fonts).map(([name, bytes]) => [name, hash(bytes)])), results }, null, 2));
  console.log(JSON.stringify(results));
  for (const resource of resources) resource.delete();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
