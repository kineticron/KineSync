/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

// Transform every local dependency separately, as Metro does. Transforming only
// the renderer leaves imported helpers as JS functions and hides closure bugs.
const modules = new Map();
function load(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const code = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, presets: ['babel-preset-expo'], plugins: ['react-native-worklets/plugin'],
    configFile: false, babelrc: false,
  }).code;
  vm.runInNewContext(code, { module, exports: module.exports, global: { Error },
    require: name => name.startsWith('.') ? load(path.resolve(path.dirname(filename), `${name}.ts`)) : require(name),
  }, { filename });
  return module.exports;
}
const directory = path.join(__dirname, '../components/lyrics/native');
const api = load(path.join(directory, 'blur-layer-bounds.ts'));
// No module globals or require exist on this runtime. Reconstruct functions only
// from serialized worklet code and recursively transferred captured values.
const ui = vm.createContext({});
const transferred = new Map();
function transfer(value) {
  if (value === null || typeof value !== 'object' && typeof value !== 'function') return value;
  if (transferred.has(value)) return transferred.get(value);
  if (typeof value === 'function') {
    assert.ok(value.__initData, 'UI closures must contain worklets, never plain JS callbacks');
    const receiver = {};
    const fn = vm.runInContext(value.__initData.code, ui).bind(receiver);
    transferred.set(value, fn);
    receiver.__closure = transfer(value.__closure ?? []);
    receiver._recur = fn;
    return fn;
  }
  const copy = Array.isArray(value) ? [] : {};
  transferred.set(value, copy);
  for (const key of Object.keys(value)) copy[key] = transfer(value[key]);
  return copy;
}
const bounds = transfer(api.blurLayerBounds);
for (const sigma of [0, 0.01, 0.125, 2, 8, 20.5, 100]) {
  const clip = { x: -21.125, y: -14.75, width: 137.5, height: 91.25 };
  const result = bounds(clip, sigma);
  const pad = Math.ceil(4 * Math.max(0.01, sigma)) + 2;
  assert.equal(JSON.stringify(result), JSON.stringify({ x: clip.x - pad, y: clip.y - pad,
    width: clip.width + 2 * pad, height: clip.height + 2 * pad }));
  assert.ok(result.x <= clip.x - 3 * sigma && result.y <= clip.y - 3 * sigma);
}
const source = fs.readFileSync(path.join(directory, 'native-glyph-picture.tsx'), 'utf8');
assert.match(source, /if \(!spicy \|\| word.word.emphasized\) \{/);
assert.match(source, /else canvas.saveLayer\(glowPaint\)/);
console.log('Blur bounds serialized UI worklets: transitive Babel capture and conservative local bounds PASS.');
