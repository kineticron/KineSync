import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { prepareBaselineHarness } from './prepare-baseline-harness.mjs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { SimulatorLogParser } from './parse-simulator-logs.mjs';
import { rotateSimulator } from './run-ios-simulator-test.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadBridge(fileSystem, logs = []) {
  const source = fs.readFileSync(path.join(root, 'lib/simulator-test-bridge.ts'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, __DEV__: true, process: { env: { EXPO_PUBLIC_SIMULATOR_TEST: '1' } },
    console: { info(line) { logs.push(line); } }, setTimeout, clearTimeout, require: () => { if (!fileSystem) throw Error('missing'); return fileSystem; },
  });
  return module.exports;
}

export async function testSimulatorProtocol() {
  const logs = [];
  const bridge = loadBridge(undefined, logs);
  const ready = { key: 'renderer-1', generation: 1, style: 'amll', linesCount: 42, trackId: 'song-1' };
  bridge.notifySimulatorRendererReady(ready);
  const fresh = bridge.waitForSimulatorRendererReady({ style: 'amll', trackId: 'song-2', timeoutMs: 20 });
  bridge.notifySimulatorRendererReady({ ...ready, generation: 2 });
  bridge.notifySimulatorRendererReady({ ...ready, generation: 3, trackId: 'song-2' });
  assert.equal((await fresh).trackId, 'song-2');
  await assert.rejects(bridge.waitForSimulatorRendererReady({ style: 'amll', trackId: 'song-2', timeoutMs: 10 }), /TIMEOUT/);
  const layout = { width: 844, height: 390, windowWidth: 844, windowHeight: 390, style: 'spicy' };
  bridge.notifySimulatorLayout(layout);
  await assert.rejects(bridge.waitForSimulatorOrientation('landscape', 10), /TIMEOUT/);
  const landscape = bridge.waitForSimulatorOrientation('landscape', 20);
  bridge.notifySimulatorLayout({ ...layout, windowWidth: 390, windowHeight: 844 });
  bridge.notifySimulatorLayout(layout);
  assert.equal((await landscape).orientation, 'landscape');
  const parser = new SimulatorLogParser();
  parser.activeStage = 'stage_7_rotation';
  parser.pendingRotation = 'landscape';
  parser.processLine(logs.at(-1));
  assert.equal(parser.landscapeConfirmed, true, 'Actual bridge emitter format must parse');
  const portrait = bridge.waitForSimulatorOrientation('portrait', 20);
  bridge.notifySimulatorLayout({ ...layout, width: 390, height: 844, windowWidth: 390, windowHeight: 844 });
  assert.equal((await portrait).orientation, 'portrait');
  await assert.rejects(bridge.waitForSimulatorScreenshotAck('stage', 'nonce', 10), /TRANSPORT_UNAVAILABLE/);
  let ack = { stage: 'stage', token: 'old' }, deleted = false;
  const files = loadBridge({ Paths: { cache: '/cache' }, File: class {
    get exists() { return true; }
    textSync() { return JSON.stringify(ack); }
    delete() { deleted = true; }
  } });
  await assert.rejects(files.waitForSimulatorScreenshotAck('stage', 'nonce', 10), /TIMEOUT/);
  assert.equal(deleted, false);
  ack = { stage: 'wrong', token: 'nonce' };
  await assert.rejects(files.waitForSimulatorScreenshotAck('stage', 'nonce', 10), /TIMEOUT/);
  ack = { stage: 'stage', token: 'nonce' };
  await files.waitForSimulatorScreenshotAck('stage', 'nonce', 10);
  assert.equal(deleted, true);

  const calls = [];
  rotateSimulator('landscape', 'chosen-udid', (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'xcrun') return JSON.stringify({ devices: { iOS: [{ udid: 'chosen-udid', state: 'Booted' }] } });
  });
  assert.ok(calls[1][1].includes('chosen-udid'));
  assert.equal(calls[2][0], 'osascript');
  assert.throws(() => rotateSimulator('landscape', 'chosen-udid', () => JSON.stringify({ devices: { iOS: [{ udid: 'other', state: 'Booted' }] } })), /only booted simulator/);
  assert.throws(() => rotateSimulator('portrait', 'chosen-udid', () => { throw Error('Accessibility denied'); }), /Accessibility denied/);
  testNativePublication();
  testHarnessStages();
  testBaselineIntegration();
  console.log('Simulator protocol, native publication, and rotation tests passed.');
}

function testNativePublication() {
  // Execute the actual component callback with native state dependencies stubbed.
  const source = fs.readFileSync(path.join(root, 'components/lyrics/native/native-lyrics-view.tsx'), 'utf8');
  const callback = source.slice(source.indexOf('const markRendererReady = useCallback(') + 'const markRendererReady = useCallback('.length, source.indexOf('\n  const flashRef'));
  const expression = callback.slice(0, callback.lastIndexOf(', ['));
  for (const scenario of ['live', 'inactive', 'background', 'stale-key', 'stale-generation', 'unmounted', 'production', 'disabled']) {
    const notices = [];
    const state = { key: 'renderer-2', generation: scenario === 'stale-generation' ? 3 : 2, ready: false, eligible: scenario !== 'inactive' };
    const context = {
      rendererReadyState: { current: state }, usePlaybackStore: { getState: () => ({ playbackMode: 'mobile', connectionStatus: 'disconnected' }) },
      __DEV__: scenario !== 'production', process: { env: { EXPO_PUBLIC_SIMULATOR_TEST: scenario === 'disabled' ? '0' : '1' } }, emitNativeClockDiagnostic() {},
      rendererReadyGate: { current: { onReady() {}, isCurrent: () => scenario !== 'unmounted' } }, requestNativeRendererReadyResync() {},
      rendererReadyGeneration: 2, readyGate: { isCurrent: () => scenario !== 'unmounted' },
      canDispatchRendererReady: () => state.eligible && scenario !== 'background',
      style: 'amll', rendererIdentity: { current: { demo: false, trackId: 'captured-song' } }, latestLyrics: { current: [1, 2] },
      require: () => ({ notifySimulatorRendererReady: event => notices.push(event) }),
    };
    const code = transformSync(`const callback = ${expression}; callback(${JSON.stringify(scenario === 'stale-key' ? 'renderer-1' : 'renderer-2')}, 2);`, { loader: 'ts' }).code;
    vm.runInNewContext(code, context);
    assert.equal(notices.length, scenario === 'live' ? 1 : 0, scenario);
    if (notices.length) assert.equal(notices[0].trackId, 'captured-song');
  }
}


function testBaselineIntegration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-integration-'));
  const candidate = path.dirname(root);
  const patch = path.join(root, 'scripts/patches/harness-integration.patch');
  const paths = [...fs.readFileSync(patch, 'utf8').matchAll(/^diff --git a\/(.+) b\//gm)].map(m => m[1]);
  try {
    for (const file of paths) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(candidate, file), path.join(dir, file));
    }
    execFileSync('git', ['apply', '--reverse', patch], { cwd: dir });
    prepareBaselineHarness({ candidateDir: candidate, baselineDir: dir });
    for (const file of paths) assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), fs.readFileSync(path.join(candidate, file), 'utf8'), file);
    prepareBaselineHarness({ candidateDir: candidate, baselineDir: dir });
    fs.writeFileSync(path.join(dir, 'ExpoLyrics/app/_layout.tsx'), '// incompatible baseline');
    assert.throws(() => prepareBaselineHarness({ candidateDir: candidate, baselineDir: dir }), /incompatible/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function testHarnessStages() {
  const source = fs.readFileSync(path.join(root, 'lib/simulator-test-harness.ts'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, console: { info() {} },
    require: name => name.includes('simulator-playback-clock') ? { SimulatorPlaybackClock: class {} } : {},
  });
  const harness = new module.exports.SimulatorTestHarness();
  harness.beginStage('stage_1_launch');
  assert.throws(() => harness.beginStage('stage_2_playback'), /unfinished/);
}
