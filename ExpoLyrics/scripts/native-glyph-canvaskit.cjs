/* global __dirname */
// Reproduce without an iOS runtime:
// node scripts/check-native-glyph-paint.cjs --canvaskit /path/to/NotoSansSymbols2-Regular.ttf
// Capture a fixture: node scripts/native-glyph-canvaskit.cjs /path/to/fallback.ttf > fixture.json
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function captureGlyphParagraph(fallbackPath) {
  assert.ok(fallbackPath, 'Pass a system-like text fallback font containing U+2661');
  const ck = await require('canvaskit-wasm')({
    locateFile: file => path.join(path.dirname(require.resolve('canvaskit-wasm')), file),
  });
  const primaryData = fs.readFileSync(path.join(__dirname, '../assets/fonts/SF-Pro-Display-Bold.otf'));
  const fallbackData = fs.readFileSync(fallbackPath);
  const primary = ck.Typeface.MakeTypefaceFromData(primaryData);
  const fallback = ck.Typeface.MakeTypefaceFromData(fallbackData);
  assert.equal(primary.getGlyphIDs('♡')[0], 0, 'The heart must actually fall back');
  assert.notEqual(fallback.getGlyphIDs('♡')[0], 0, 'Fallback must have the heart glyph');
  const provider = ck.TypefaceFontProvider.Make();
  provider.registerFont(primaryData, 'SF Pro Display');
  provider.registerFont(fallbackData, 'System-like symbols');
  const fontSize = 33.6;
  const fontStyle = { weight: ck.FontWeight.Bold };
  const builder = ck.ParagraphBuilder.MakeFromFontProvider(new ck.ParagraphStyle({
    textAlign: ck.TextAlign.Left,
    strutStyle: { strutEnabled: true, forceStrutHeight: true, halfLeading: true,
      fontFamilies: ['SF Pro Display'], fontSize, fontStyle, heightMultiplier: 1.5 },
    textStyle: { fontFamilies: ['SF Pro Display', 'System-like symbols'], fontSize, fontStyle,
      color: ck.WHITE, heightMultiplier: 1.5, halfLeading: true },
  }), provider);
  const text = '♡ yeah, i, i, i';
  builder.addText(text);
  const paragraph = builder.build();
  paragraph.layout(360);
  const rect = box => ({ x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] });
  const range = (start, end) => paragraph.getRectsForRange(start, end, ck.RectHeightStyle.Tight, ck.RectWidthStyle.Tight)
    .map(box => rect(box.rect));
  // CanvasKit exposes getShapedLines rather than native extendedVisit. Adapt
  // its real glyph IDs, typefaces, positions and bounds to that visitor API.
  const runs = paragraph.getShapedLines().flatMap((line, lineIndex) => line.runs.map(run => {
    const font = new ck.Font(run.typeface, run.size);
    const bounds = font.getGlyphBounds(run.glyphs);
    const result = { line: lineIndex, origin: { x: 0, y: 0 }, glyphs: Array.from(run.glyphs),
      positions: Array.from(run.glyphs, (_, i) => ({ x: run.positions[i * 2], y: run.positions[i * 2 + 1] })),
      bounds: Array.from(run.glyphs, (_, i) => rect(bounds.subarray(i * 4, i * 4 + 4))),
      widths: Array.from(font.getGlyphWidths(run.glyphs)) };
    font.delete();
    return result;
  }));
  const result = {
    provenance: { canvaskit: require('canvaskit-wasm/package.json').version,
      primary: 'assets/fonts/SF-Pro-Display-Bold.otf', fallback: path.basename(fallbackPath),
      fontSize, heightMultiplier: 1.5, width: 360,
      note: 'Real CanvasKit geometry with an explicit text fallback, not an iPhone capture.' },
    text, syllable: { text: '♡ yeah,', start: 48014, end: 48366, offset: 0, emphasized: false,
      letters: Array.from('♡ yeah,') },
    rects: range(0, 7), letters: Array.from({ length: 7 }, (_, i) => range(i, i + 1)),
    lines: paragraph.getLineMetrics(), runs,
  };
  paragraph.delete();
  builder.delete();
  provider.delete();
  primary.delete();
  fallback.delete();
  return result;
}

module.exports = captureGlyphParagraph;
if (require.main === module) captureGlyphParagraph(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error); process.exitCode = 1; });
