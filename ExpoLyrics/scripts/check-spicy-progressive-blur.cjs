/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const rowPath = 'components/lyrics/native/native-lyric-row.tsx';
function radiusFactory(source) {
  const ast = ts.createSourceFile('row.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'blurValue') body = node.initializer.arguments[0].body.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert(body);
  return new Function('row', 'presentationWindow', 'rowActive', 'staticLyrics', 'spicy', 'fastLoading', 'withTiming', 'Easing', body);
}
const factory = radiusFactory(process.env.SPICY_SOURCE_REV ? execFileSync('git', ['show', `${process.env.SPICY_SOURCE_REV}:ExpoLyrics/${rowPath}`], { cwd: root, encoding: 'utf8' }) : read(rowPath));
const window = { value: { focusLineIndex: 3, visualActiveLineStartIndex: 3, visualActiveLineEndIndex: 4 } };
function radius(index, fast = true, active = index >= 3 && index <= 4, staticLyrics = false) {
  return factory({ index }, window, { value: active }, staticLyrics, true, fast,
    (target, options) => ({ target, duration: options.duration }), { bezier() {} });
}
assert.equal(radius(3), 0); assert.equal(radius(4), 0); assert.equal(radius(5), 0, 'Immediate next row stays sharp');
assert.deepEqual(radius(6), { target: 1.25, duration: 240 });
assert.deepEqual(radius(7), { target: 2.5, duration: 240 });
assert.deepEqual(radius(100), { target: 6.83125, duration: 240 });
assert.equal(radius(100, true, false, true), 0);
// Execute the actual closure with controlled timing to demonstrate a radius,
// rather than opacity, transitioning between successive cue destinations.
let current = 2.5, destination;
factory({ index: 7 }, window, { value: false }, false, true, true,
  (target, options) => { destination = target; assert.equal(options.duration, 240); return current; }, {});
window.value = { ...window.value, focusLineIndex: 4, visualActiveLineEndIndex: 5 };
factory({ index: 7 }, window, { value: false }, false, true, true,
  target => { destination = target; return current; }, {});
assert.equal(destination, 1.25); current += (destination - current) * 0.5;
assert.equal(current, 1.875);
for (const revision of ['7729a20', '3791c00']) {
  const original = execFileSync('git', ['show', `${revision}:ExpoLyrics/${rowPath}`], { cwd: root, encoding: 'utf8' });
  const oldFactory = radiusFactory(original);
  for (let index = 0; index < 10; index++) {
    const args = [{ index }, window, { value: index === 4 || index === 5 }, false, true, false, target => target, { bezier() {} }];
    assert.equal(factory(...args), oldFactory(...args), 'Fast OFF preserves original radius semantics');
  }
}
const host = read('components/lyrics/native/native-lyrics-view.tsx');
assert.match(host, /const sharedBlurEnabled = false;/, 'Production mounts no shared backdrop overlay');
for (const file of ['native-lazy-skia-voice.tsx', 'native-skia-voice.tsx']) {
  const source = read(`components/lyrics/native/${file}`);
  assert.match(source, /!sharedBlur && \(batched \|\| !spicy\)/);
  assert.match(source, /<Blur blur=\{paintBlur\}/, 'Real Gaussian filter remains in voice canvas');
}
console.log('Spicy progressive blur PASS: active+next sharp, increasing capped radius, 240ms destinations, original OFF differential, shared overlay disabled. Timing mock, not native raster evidence.');
