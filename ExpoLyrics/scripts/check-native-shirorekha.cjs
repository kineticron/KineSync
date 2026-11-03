/* global __dirname */
// Real Skia WASM evidence, NOT native iOS. Uses production shapeGlyphWords/drawVoice.
// node scripts/check-native-shirorekha.cjs --font /path/to/Devanagari.ttf --out /tmp/shirorekha
// Optional --source FILE runs an untouched glyph-picture baseline. No app font changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
async function main() {
  assert.ok(process.argv.includes('--font'), 'Supply a real Devanagari font with --font');
  const out = process.argv.includes('--out') ? arg('--out') : '/tmp/kinesync-shirorekha';
  fs.mkdirSync(out, { recursive: true });
  const ck = await require('canvaskit-wasm')({ locateFile: f => path.join(path.dirname(require.resolve('canvaskit-wasm')), f) });
  const web = path.join(path.dirname(require.resolve('@shopify/react-native-skia/package.json')), 'lib/commonjs/skia/web');
  const types = path.join(web, '../types');
  const { BlendMode } = require(path.join(types, 'Paint/BlendMode'));
  const { ClipOp } = require(path.join(types, 'Canvas'));
  const { TileMode } = require(path.join(types, 'ImageFilter/ImageFilter'));
  const Skia = require(path.join(web, 'JsiSkia')).JsiSkApi(ck);
  // CanvasKit uses instanceof Array; normalize the VM realm's color array.
  const linearGradient = Skia.Shader.MakeLinearGradient.bind(Skia.Shader);
  Skia.Shader.MakeLinearGradient = (a, b, colors, ...rest) => linearGradient(a, b, Array.from(colors), ...rest);
  const { JsiSkCanvas } = require(path.join(web, 'JsiSkCanvas'));
  const drawGlyphs = JsiSkCanvas.prototype.drawGlyphs;
  JsiSkCanvas.prototype.drawGlyphs = function(ids, positions, ...rest) { return drawGlyphs.call(this, Array.from(ids), Array.from(positions), ...rest); };
  const { JsiSkFont } = require(path.join(web, 'JsiSkFont'));
  const createPicture = draw => { const recorder = Skia.PictureRecorder(); draw(recorder.beginRecording(Skia.XYWHRect(-64, -64, 800, 300))); return recorder.finishRecordingAsPicture(); };
  const directory = path.join(__dirname, '../components/lyrics/native');
  const filename = process.argv.includes('--source') ? arg('--source') : path.join(directory, 'native-glyph-picture.tsx');
  const code = buildSync({ stdin: { contents: fs.readFileSync(filename, 'utf8') + '\nexport { drawVoice };', resolveDir: directory, loader: 'tsx' }, bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['react', 'react-native-reanimated', 'react-native-worklets', '@shopify/react-native-skia'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => name === 'react' ? { memo: fn => fn } : name === '@shopify/react-native-skia' ?
    { Skia, createPicture, BlendMode, ClipOp, TileMode } : {} });
  const data = fs.readFileSync(arg('--font'));
  const provider = ck.TypefaceFontProvider.Make(); provider.registerFont(data, 'Diagnostic Indic');
  const typeface = ck.Typeface.MakeTypefaceFromData(data);
  for (const glyph of typeface.getGlyphIDs('देखलो')) assert.notEqual(glyph, 0);
  const builder = ck.ParagraphBuilder.MakeFromFontProvider(new ck.ParagraphStyle({ textStyle: { fontFamilies: ['Diagnostic Indic'], fontSize: 64, color: ck.WHITE } }), provider);
  builder.addText('देख लो'); const paragraph = builder.build(); paragraph.layout(600);
  const rect = r => Skia.XYWHRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  const range = (start, end) => paragraph.getRectsForRange(start, end, ck.RectHeightStyle.Tight, ck.RectWidthStyle.Tight).map(box => rect(box.rect));
  const runs = paragraph.getShapedLines().flatMap(line => line.runs.map(run => {
    const font = new ck.Font(run.typeface, run.size), bounds = font.getGlyphBounds(run.glyphs);
    return { glyphs: Array.from(run.glyphs), origin: { x: 0, y: 0 }, positions: Array.from(run.glyphs, (_, i) => ({ x: run.positions[i * 2], y: run.positions[i * 2 + 1] })),
      bounds: Array.from(run.glyphs, (_, i) => rect(bounds.subarray(i * 4, i * 4 + 4))), font: new JsiSkFont(ck, font) };
  }));
  const input = [{ text: 'देख', start: 0, end: 1000, offset: 0 }, { text: 'लो', start: 1000, end: 2000, offset: 4 }].map(word => {
    const rects = range(word.offset, word.offset + word.text.length);
    return { word: { ...word, emphasized: false, letters: [word.text] }, rects, letters: [rects], width: rects.reduce((n, r) => n + r.width, 0), before: 0 };
  });
  function raster(words, spicy, active, alpha, glow = 0, gradient = 0.5) {
    const surface = Skia.Surface.Make(600, 150), canvas = surface.getCanvas(); canvas.clear(Skia.Color('transparent')); canvas.translate(24, 32);
    module.exports.drawVoice(canvas, words, words.map(() => ({ scale: 1, y: 0, gradient, glow, letters: [] })), 500, active, spicy, false, 64, 2000,
      { bright: alpha, dark: alpha }, { active: true, releasePosition: 0, elapsed: 0 }, { paint: Skia.Paint(), glowPaint: Skia.Paint(), blurRadii: [], blurFilters: [], revealShaders: [] });
    const image = surface.makeImageSnapshot();
    const pixels = image.ref.readPixels(0, 0, { width: 600, height: 150, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
    // Composite only the saved visual against the app-like dark background;
    // assertions above use the uncomposited real raster alpha.
    const display = Skia.Surface.Make(600, 150);
    display.getCanvas().clear(Skia.Color('#161c28')); display.getCanvas().drawImage(image, 0, 0);
    const preview = display.makeImageSnapshot(), png = preview.encodeToBytes();
    preview.dispose(); display.dispose(); image.dispose(); surface.dispose(); return { pixels, png };
  }
  const results = [];
  const max = pixels => pixels.reduce((n, value, i) => i % 4 === 3 ? Math.max(n, value) : n, 0);
  for (const spicy of [false, true]) {
    const shaped = module.exports.shapeGlyphWords({ getLineMetrics: () => paragraph.getLineMetrics(), extendedVisit: visit => runs.forEach(run => visit(0, run)) }, input, spicy);
    const direct = shaped.map(word => ({ ...word, overlapMask: [false] }));
    for (const active of [false, true]) for (const alpha of [0.3, 0.5, 0.85]) {
      if (spicy && active) continue;
      const fixed = raster(shaped, spicy, active, alpha), before = raster(direct, spicy, active, alpha);
      const expected = spicy ? 128 : Math.round(alpha * 255);
      const excess = before.pixels.reduce((n, value, i) => n + (i % 4 === 3 && value > fixed.pixels[i] + 4 ? 1 : 0), 0);
      const label = `${spicy ? 'spicy' : 'amll'}-${active ? 'active' : 'inactive'}-${alpha}`;
      fs.writeFileSync(path.join(out, label + '-before.png'), before.png); fs.writeFileSync(path.join(out, label + '-after.png'), fixed.png);
      results.push({ label, maximumBefore: max(before.pixels), maximumAfter: max(fixed.pixels), expected, excess });
      assert.ok(Math.abs(max(fixed.pixels) - expected) <= 1, `${label}: maximum ${max(fixed.pixels)} must equal requested alpha ${expected}`);
      assert.ok(excess > 0, `${label}: must reproduce actual overlapping ink`);
    }
    for (const gradient of [0, 0.5, 1]) for (const glow of [0, 1]) {
      fs.writeFileSync(path.join(out, `${spicy ? 'spicy' : 'amll'}-sweep-${gradient}-glow-${glow}.png`), raster(shaped, spicy, true, 0.85, glow, gradient).png);
    }
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ renderer: 'CanvasKit real Skia WASM, not native iOS', fontSha256: require('node:crypto').createHash('sha256').update(data).digest('hex'), results }, null, 2));
  console.log(JSON.stringify(results));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
