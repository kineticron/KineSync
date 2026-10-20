/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const directory = path.join(__dirname, '../components/lyrics/native');
const source = buildSync({ stdin: { contents: fs.readFileSync(path.join(directory, 'native-glyph-picture.tsx'), 'utf8'),
  resolveDir: directory, loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native-reanimated', '@shopify/react-native-skia'],
}).outputFiles[0].text;
const Skia = {
  PathBuilder: { Make: () => ({ rects: [], addRect(rect) { this.rects.push(rect); return this; },
    addPath(path) { this.rects.push(...path.rects); return this; }, detach() { return { rects: this.rects }; } }) },
  XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
  Paint: () => ({ alpha: 1, shader: null, setAntiAlias() {}, setShader(shader) { this.shader = shader; },
    setColor() {}, setAlphaf(alpha) { this.alpha = alpha; } }),
  Color: color => color,
  Shader: { MakeLinearGradient: (_start, _end, colors) => ({ colors }) },
};
const moduleObject = { exports: {} };
vm.runInNewContext(source, { module: moduleObject, exports: moduleObject.exports,
  require: name => name === 'react' ? { memo: fn => fn } : name === '@shopify/react-native-skia' ? { Skia, TileMode: { Clamp: 0 }, ClipOp: { Intersect: 0 } } : {} });
const rect = { x: 0, y: 0, width: 20, height: 24 };
const word = { word: { text: 'sing', start: 0, end: 1000, emphasized: false }, rects: [rect], width: 20, before: 0,
  runs: [[{ glyphs: [42], positions: [{ x: 0, y: 20 }], font: {} }]], clips: [{}] };
const motion = { scale: 1, y: 0, gradient: 1, glow: 0, letters: [] };
function paintLine(active, bright) {
  const draws = [];
  const canvas = { save() {}, restore() {}, translate() {}, scale() {}, clipPath() {},
    drawGlyphs: (_glyphs, _positions, _x, _y, _font, paint) => draws.push({ alpha: paint.alpha, shader: paint.shader }) };
  moduleObject.exports.drawVoice(canvas, [word], [motion], 1100, active, false, false, 36, 1000,
    { bright, dark: 0.3 }, { active: false, releasePosition: 1000, elapsed: 100 });
  return draws[0];
}
const before = paintLine(true, 0.9);
const after = paintLine(false, 0.9);
assert.deepEqual(after, before, 'AMLL deactivation must preserve the filtered highlight rather than flash to dark');
assert.ok(paintLine(false, 0.5).shader.colors[0].includes('0.5'), 'Inactive highlights continue following the release filter');
const nextRect = { ...rect, x: 20 };
const rowBelow = { ...rect, y: 24 };
const run = { glyphs: [1, 2, 3], positions: [{ x: 0, y: 20 }, { x: 20, y: 20 }, { x: 0, y: 44 }],
  origin: { x: 0, y: 0 }, bounds: [{ x: 0, y: -16, width: 19, height: 22 },
    { x: -3, y: -16, width: 23, height: 20 }, { x: 0, y: -16, width: 19, height: 20 }],
  font: { getGlyphWidths: () => [20, 20, 20] } };
const shaped = moduleObject.exports.shapeGlyphWords({ extendedVisit: visit => visit(0, run) },
  [rect, nextRect, rowBelow].map(r => ({ ...word, rects: [r], letters: [] })), false);
assert.deepEqual(Array.from(shaped[0].runs[0][0].glyphs), [1], 'The previous syllable must not acquire the next Hangul glyph through its overhang');
assert.deepEqual(Array.from(shaped[1].runs[0][0].glyphs), [2]);
assert.deepEqual(Array.from(shaped[2].runs[0][0].glyphs), [3], 'A descender must not acquire a duplicate layer in the next row');
assert.ok(shaped[1].clips[0].rects.some(r => r.x === 17 && r.width === 23), 'Owned Hangul overhang must remain visible');
console.log('Native glyph paint checks passed: continuous AMLL highlight release, Hangul ownership and descender isolation.');
