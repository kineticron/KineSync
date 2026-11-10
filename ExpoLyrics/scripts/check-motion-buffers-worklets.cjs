/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');
const { buildSync } = require('esbuild');

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
const api = load(path.join(directory, 'motion-buffers.ts'));
const plainModule = { exports: {} };
const plainCode = buildSync({ entryPoints: [path.join(directory, 'motion-buffers.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
vm.runInNewContext(plainCode, { module: plainModule, exports: plainModule.exports });
const plainApi = plainModule.exports;
const reference = load(path.join(directory, 'reference-word-motion.ts'));
const { amllEmphasis } = load(path.join(directory, 'reference-motion.ts'));
const { advanceAmllFloatClock } = load(path.join(directory, 'amll-float-clock.ts'));

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
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const uiApi = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, transfer(fn)]));
for (const emphasized of [false, true]) {
  const word = { text: 'office', start: 1000, end: 3000, letters: ['o', 'f', 'f', 'i', 'c', 'e'], emphasized };
  // Ordinary JS works even in the broken version: only serialized UI execution
  // exposes the undefined function frozen into the eager Babel closure.
  const rn = plainApi.createMotionBuffers([{ word, runs: word.letters }], true);
  assert.doesNotThrow(() => plainApi.advanceWordMotionInto(word, rn.words[0], rn.motions[0], 1200, 1 / 60));
  const buffers = uiApi.createMotionBuffers([{ word, runs: word.letters }], true);
  let state = reference.initialWordSpringState(word);
  let clock = { active: false, releasePosition: -1, elapsed: 0 };
  const emphasis = {};
  for (let i = 0; i < 480; i++) {
    if (i === 320) { word.text = 'reset'; word.start = 1100; word.end = 3100; }
    const time = [900, 1200, 1216, 1800, 2800, 3100, 6000, 1000][Math.floor(i / 2) % 8] + i % 2 * 8;
    const dt = [0, 1 / 120, 1 / 60, 0.064][i % 4];
    const expected = reference.advanceReferenceWordMotion(word, state, time, dt);
    state = expected.state;
    uiApi.advanceWordMotionInto(word, buffers.words[0], buffers.motions[0], time, dt);
    // Buffer construction intentionally omits unused non-emphasized springs.
    if (!emphasized) state.letters.length = 0;
    same(buffers.words[0], state, 'UI spring parity across snap, stepping, seek and identity reset');
    same(buffers.motions[0], expected.motion, 'UI word and emphasized letter parity');
    const active = i % 5 < 2;
    clock = advanceAmllFloatClock(clock, active, time, dt * 1000);
    uiApi.advanceFloatClockInto(buffers.nextFloatClock, buffers.floatClock, active, time, dt * 1000);
    same(buffers.nextFloatClock, clock, 'UI float clock parity');
    Object.assign(buffers.floatClock, buffers.nextFloatClock);
    for (const last of [false, true]) for (const background of [false, true]) {
      uiApi.amllEmphasisInto(emphasis, time, word.start, word.end, i % 6, 6, last, background);
      same(emphasis, amllEmphasis(time, word.start, word.end, i % 6, 6, last, background), 'UI AMLL sampled emphasis parity');
    }
  }
}
console.log('Motion buffer serialized UI worklets: transitive Babel closures, Spicy/AMLL and reference parity PASS.');
