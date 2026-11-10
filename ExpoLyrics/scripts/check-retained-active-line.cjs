/* global __dirname */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { bundle, createVoiceHarness, currentCode } = require('./check-native-translation-toggle.cjs');
const lazy = bundle(fs.readFileSync(path.join(__dirname, '../components/lyrics/native/native-lazy-skia-voice.tsx'), 'utf8').replaceAll('NativeLazySkiaVoice', 'NativeSkiaVoice'));
const voice = { start: 100, end: 102, words: [], paintText: 'hello', paintWords: [{ text: 'hello', offset: 0, start: 100, end: 102, letters: ['h','e','l','l','o'], emphasized: true, joined: false }] };
function find(node, type) { if (!node || typeof node !== 'object') return null; if (node.type === type) return node; for (const child of [node.props?.children].flat()) { const found = find(child, type); if (found) return found; } return null; }
for (const code of [currentCode, lazy]) for (const spicy of [true, false]) {
 const settings = { dev: false, retained: false }, h = createVoiceHarness(code, spicy, settings);
 let tree = h.render(voice); tree.props.onLayout({ nativeEvent: { layout: { width: 320 } } });
 for (const enabled of [false,true,false,true,false]) { settings.retained = enabled; tree = h.render(voice); assert.equal(!!find(tree, 'RetainedGlyphPicture'), enabled); assert.equal(!!find(tree, h.NativeGlyphPicture), !enabled); if(enabled) assert.equal(find(tree, 'RetainedGlyphPicture').props.spicy, spicy); }
 h.unmount();
}
console.log('Retained routing PASS: both styles/voice paths, default off and repeated on/off replacement');
async function checkStore(dev, os) {
 const vm = require('node:vm'), { buildSync } = require('esbuild');
 let resolveLoad; const changes = [], effects = [], listeners = new Set();
 const code = buildSync({ entryPoints: [path.join(__dirname, '../lib/retained-active-line.ts')], bundle: true, external: ['*'], platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
 const module = { exports: {} };
 vm.runInNewContext(code, { __DEV__: dev, module, exports: module.exports, require(name) {
  if (name === 'react-native') return { Platform: { OS: os } };
  if (name === '@react-native-async-storage/async-storage') return { getItem: () => new Promise(r => { resolveLoad = r; }), setItem: async (_key, value) => changes.push(value) };
  return { useSyncExternalStore(subscribe, snapshot) { listeners.add(subscribe(() => {})); return snapshot(); }, useEffect(fn) { effects.push(fn); } };
 } });
 const api = module.exports; assert.equal(api.getRetainedActiveLine(), false);
 api.useRetainedActiveLine(); effects.forEach(fn => fn());
 await api.setRetainedActiveLine(true); resolveLoad?.('false'); await api.loadRetainedActiveLine();
 assert.equal(api.getRetainedActiveLine(), dev && os !== 'web', 'late storage load must not undo user toggle; web/release stay off');
 await api.setRetainedActiveLine(false); assert.equal(api.getRetainedActiveLine(), false);
 for (const unsubscribe of listeners) unsubscribe();
 if (dev && os !== 'web') assert.deepEqual(changes, ['true', 'false']); else assert.deepEqual(changes, []);
}
Promise.all([checkStore(true,'ios'), checkStore(false,'ios'), checkStore(true,'web')]).then(() => console.log('Retained settings PASS: default off, persistence, load race, release/web gate, subscription cleanup')).catch(error => { console.error(error); process.exitCode = 1; });
{
 const vm = require('node:vm'), { buildSync } = require('esbuild');
 const code = buildSync({ entryPoints: [path.join(__dirname, '../components/lyrics/native/retained-glyph-graph.tsx')], bundle: true, external: ['*'], platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
 const effects = [], frames = [], module = { exports: {} };
 vm.runInNewContext(code, { module, exports: module.exports, require(name) {
  if (name === 'react') return { memo: fn => fn, useMemo: fn => fn(), useCallback: fn => fn, useEffect: fn => effects.push(fn) };
  if (name === 'react-native-reanimated') return { makeMutable: value => ({ value }), useFrameCallback: () => { const calls = []; frames.push(calls); return { setActive: value => calls.push(value) }; } };
  if (name === './reference-word-motion') return { initialWordSpringState: () => ({}) };
  if (name === './spicy-text-policy') return { spicyIsRtl: () => false };
  if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
  return {};
 } });
 const props = { words: [{ word: { text: 'hello', emphasized: false, letters: [] }, runs: [] }], position: { value: 100 }, active: { value: true }, lineMotion: { value: {} }, spicy: true, background: false, fontSize: 32, lineEnd: 102 };
 const first = module.exports.RetainedGlyphPicture(props); const stop = effects.pop()(); assert.deepEqual(frames[0], [true]); stop(); assert.deepEqual(frames[0], [true,false]);
 const second = module.exports.RetainedGlyphPicture({ ...props, spicy: false }); const stopSecond = effects.pop()(); assert.notEqual(first.props.state, second.props.state); stopSecond(); assert.deepEqual(frames[1], [true,false]);
 console.log('Retained lifecycle PASS: actual component enables/disables frame callbacks on mount/unmount; remount owns fresh state');
}
