/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function extract(source, predicate) {
  const ast = ts.createSourceFile('test.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) { if (predicate(node)) found = node.getText(ast); ts.forEachChild(node, visit); }
  visit(ast); assert.ok(found); return found;
}
const defaults = extract(read('store/playback-store.ts'), n => ts.isFunctionDeclaration(n) && n.name?.text === 'initPlaybackStoreDefaults');
const initialize = extract(read('lib/simulator-test-harness.ts'), n => ts.isMethodDeclaration(n) && n.name?.getText() === 'initialize');
const gate = extract(read('app/(tabs)/index.tsx'), n => ts.isVariableDeclaration(n) && n.name.getText() === 'showEmptyState');
async function run(controller, fixed) {
  let release;
  const storage = new Promise(resolve => { release = resolve; });
  const playback = { playbackMode: 'desktop', showTranslatedText: false, translationLanguage: 'Korean',
    setShowTranslatedText(value) { playback.showTranslatedText = value; },
    setTranslationLanguage(value) { playback.translationLanguage = value; } };
  const session = { signedIn: false, loggedOut: false, setLoggedOut(value) { session.loggedOut = value; } };
  let effect, timer, ran = 0;
  const bridge = { exports: {}, process: { env: { EXPO_PUBLIC_SIMULATOR_TEST: '1', EXPO_PUBLIC_SIMULATOR_TEST_BUILD: 'release-arm64' } }, setTimeout, clearTimeout, Set, Date };
  vm.runInNewContext(compile(read('lib/simulator-test-bridge.ts')), bridge);
  const context = { exports: {}, _cachedBridgeUrl: null, _cachedHandshakeKey: null,
    getBridgeSettings: () => storage,
    usePlaybackStore: { getState: () => playback, setState: value => Object.assign(playback, value) },
    useSpotifySessionStore: { setState: value => Object.assign(session, value), getState: () => session },
    console: { info() {} },
  };
  vm.runInNewContext(compile(defaults + '\nclass Harness { ' + initialize + ' }; exports.Harness = Harness;'), context);
  const harness = new context.exports.Harness();
  Object.assign(harness, { isSupported: () => true, heartbeat: { start() {} }, cleanup() {}, runAutomatedScenario() { ran++; } });
  const pendingDefaults = context.exports.initPlaybackStoreDefaults();
  const component = { exports: {}, require: name => name === 'react' ? { useEffect: fn => { effect = fn; } } : name.includes('harness') ? { simulatorHarness: harness } : bridge.exports,
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { timer = undefined; } };
  vm.runInNewContext(compile(controller), component);
  component.exports.SimulatorTestController();
  let cancelledCallback = false;
  const cancel = bridge.exports.onSimulatorAppInitialized(() => { cancelledCallback = true; });
  cancel();
  const cleanup = effect();
  if (fixed) assert.equal(timer, undefined, 'scenario must wait for persisted defaults');
  release({ playbackMode: 'desktop', serverUrl: '', handshakeKey: '', onboardingCompleted: false });
  await pendingDefaults;
  bridge.exports.notifySimulatorAppInitialized();
  await assert.rejects(bridge.exports.waitForSimulatorRendererReady({ timeoutMs: 1 }), /TIMEOUT_WAITING_RENDERER_READY/, 'startup barrier cannot manufacture renderer readiness');
  assert.equal(cancelledCallback, false, 'unmounted startup listener cannot initialize a fixture');
  assert.ok(timer); timer(); assert.equal(ran, 1);
  if (fixed) {
    assert.equal(playback.showTranslatedText, true, 'fixture must pin translation visibility');
    assert.equal(playback.translationLanguage, 'English', 'fixture must pin translation language');
  }
  const player = { tour: { active: false }, currentTrack: { id: 'fixture' }, playbackMode: playback.playbackMode, spotifySignedIn: session.signedIn, connectionStatus: 'disconnected' };
  vm.runInNewContext(`result = (${gate.slice(gate.indexOf('=') + 1)})`, player);
  assert.equal(player.result, !fixed, fixed ? 'fixture must clear real player empty-state gate' : 'original controller deterministically hides native renderer');
  cleanup();
}
async function testSessionRestore(useSetter) {
  let resolveStorage;
  const storage = new Promise(resolve => { resolveStorage = resolve; });
  let state;
  const store = { getState: () => state, setState: value => Object.assign(state, value) };
  const context = { exports: {}, require: name => name === 'zustand' ? {
    create: factory => { state = factory(store.setState); return store; },
  } : { __esModule: true, default: { getItem: () => storage, setItem: () => Promise.resolve() } } };
  vm.runInNewContext(compile(read('store/spotify-session-store.ts')), context);
  if (useSetter) store.getState().setLoggedOut(false);
  store.setState({ signedIn: true, loggedOut: false });
  resolveStorage('true');
  await storage; await Promise.resolve();
  assert.equal(store.getState().signedIn, useSetter,
    'fixture setter must fence delayed persisted logout without changing production session store');
}
async function testTranslationRestore(pinSettings) {
  let release;
  const storage = new Promise(resolve => { release = resolve; });
  const source = read('store/playback-store.ts');
  const setter = name => extract(source, n => ts.isPropertyAssignment(n) && n.name.getText() === name);
  const persist = extract(source, n => ts.isFunctionDeclaration(n) && n.name?.text === 'persistTranslationSettings');
  const restore = source.slice(source.indexOf("void AsyncStorage.getItem('kinesync_translation_settings')"));
  const state = { showTranslatedText: true, translationLanguage: 'English' };
  const context = { exports: {}, AsyncStorage: { getItem: () => storage, setItem: async () => {} },
    normalizeTranslationLanguage: value => value,
    usePlaybackStore: { getState: () => state, setState: value => Object.assign(state, value) },
    set: value => Object.assign(state, value),
  };
  vm.runInNewContext(compile(`let translationSettingsChanged = false;
${persist}
exports.setters = ({${setter('setShowTranslatedText')}, ${setter('setTranslationLanguage')}});
${restore}`), context);
  Object.assign(state, context.exports.setters);
  if (pinSettings) { state.setShowTranslatedText(true); state.setTranslationLanguage('English'); }
  release(JSON.stringify({ showTranslatedText: false, translationLanguage: 'Korean' }));
  await storage; await Promise.resolve();
  assert.equal(state.showTranslatedText, pinSettings, 'actual store setters must fence delayed translation storage');
  assert.equal(state.translationLanguage, pinSettings ? 'English' : 'Korean');
}
(async () => {
  // Frozen failing controller from 466dbf389e1cf47d8039a4067cf00bd8dd0a92b2.
  // Keep the regression runnable in shallow CI/baseline checkouts.
  const original = `
    import { useEffect } from 'react';
    import { simulatorHarness } from '@/lib/simulator-test-harness';
    export function SimulatorTestController() {
      useEffect(() => {
        if (!simulatorHarness.isSupported()) return;
        simulatorHarness.initialize();
        const timeout = setTimeout(() => { void simulatorHarness.runAutomatedScenario(); }, 1000);
        return () => { clearTimeout(timeout); simulatorHarness.cleanup(); };
      }, []);
      return null;
    }
  `;
  await testTranslationRestore(false);
  await testTranslationRestore(true);
  await testSessionRestore(false);
  await testSessionRestore(true);
  await run(original, false);
  await run(read('components/simulator-test-controller.tsx'), true);
  console.log('Original startup race reproduced; startup barrier clears actual player gate.');
})().catch(error => { console.error(error); process.exitCode = 1; });
