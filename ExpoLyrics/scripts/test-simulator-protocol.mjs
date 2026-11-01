import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { prepareBaselineHarness } from './prepare-baseline-harness.mjs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { SimulatorLogParser } from './parse-simulator-logs.mjs';
import { rotateSimulator, createLineBufferConsumer, selectSimulatorDevice } from './run-ios-simulator-test.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadBridge(fileSystem, logs = [], development = true, env = { EXPO_PUBLIC_SIMULATOR_TEST: '1' }) {
  const source = fs.readFileSync(path.join(root, 'lib/simulator-test-bridge.ts'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, __DEV__: development, process: { env },
    console: { info(line) { logs.push(line); } }, setTimeout, clearTimeout, require: () => { if (!fileSystem) throw Error('missing'); return fileSystem; },
  });
  return module.exports;
}

export async function testSimulatorProtocol() {
  const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';
  const phone = { name: 'iPhone Test', udid: 'b', state: 'Shutdown', isAvailable: true };
  assert.equal(selectSimulatorDevice({ devices: { [runtime]: [phone, { ...phone, udid: 'a' }] } }).udid, 'a');
  assert.throws(() => selectSimulatorDevice({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [phone] } }), /iOS 27/);
  assert.throws(() => selectSimulatorDevice({ devices: { [runtime]: [phone, { ...phone, name: 'iPad', udid: 'other', state: 'Booted' }] } }), /Conflicting booted/);
  // Byte-by-byte includes a split UTF-8 character, split marker, and final no-LF record.
  const framed = [], recorded = [];
  const consume = createLineBufferConsumer(line => framed.push(line), chunk => recorded.push(chunk));
  const payload = Buffer.from('préface\n[KINESYNC_SIM] INIT_READY\n[KINESYNC_SIM] FINAL');
  for (const byte of payload) consume(Buffer.from([byte]));
  assert.deepEqual(framed, ['préface', '[KINESYNC_SIM] INIT_READY']);
  consume.flush(); consume.flush();
  assert.deepEqual(framed, ['préface', '[KINESYNC_SIM] INIT_READY', '[KINESYNC_SIM] FINAL']);
  assert.deepEqual(Buffer.concat(recorded), payload);

  // Compile-time Release opt-in requires both flags; runtime simctl env cannot enable a bundle.
  for (const [development, env, active] of [
    [false, {}, false],
    [false, { EXPO_PUBLIC_SIMULATOR_TEST: '1' }, false],
    [false, { EXPO_PUBLIC_SIMULATOR_TEST_BUILD: 'release-arm64' }, false],
    [false, { EXPO_PUBLIC_SIMULATOR_TEST: '1', EXPO_PUBLIC_SIMULATOR_TEST_BUILD: 'wrong' }, false],
    [false, { EXPO_PUBLIC_SIMULATOR_TEST: '1', EXPO_PUBLIC_SIMULATOR_TEST_BUILD: 'release-arm64' }, true],
    [true, { EXPO_PUBLIC_SIMULATOR_TEST: '1' }, true],
  ]) assert.equal(loadBridge(undefined, [], development, env).isSimulatorTestActive(), active);
  // Exercise every actual integration predicate with Release constants folded, not __DEV__ mocks alone.
  for (const file of ['app/_layout.tsx', 'providers/bridge-provider.tsx', 'lib/simulator-test-bridge.ts', 'components/lyrics/native/native-lyrics-view.tsx', 'components/lyrics/spotify-native-detector.tsx', 'components/lyrics/spotify-browser-fallback.tsx']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const gates = source.match(/\(\(typeof __DEV__[^\n]+?process\.env\.EXPO_PUBLIC_SIMULATOR_TEST === '1'/g);
    assert.ok(gates?.length, `Missing explicit harness gate in ${file}`);
    for (const gate of gates) for (const [test, build, active] of [['', '', false], ['1', '', false], ['', 'release-arm64', false], ['1', 'release-arm64', true]]) {
      const compiled = transformSync(`module.exports = ${gate};`, { minify: true, define: { __DEV__: 'false', 'process.env.EXPO_PUBLIC_SIMULATOR_TEST': JSON.stringify(test), 'process.env.EXPO_PUBLIC_SIMULATOR_TEST_BUILD': JSON.stringify(build) } }).code;
      const module = { exports: null };
      vm.runInNewContext(compiled, { module });
      assert.equal(module.exports, active, `${file}: ${test}/${build}`);
      assert.ok(!compiled.includes('process.env'), 'Activation must be baked into the bundle');
    }
  }
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

  process.env.DEVELOPER_DIR = '/explicit/Xcode.app/Contents/Developer';
  const calls = [];
  rotateSimulator('landscape', 'chosen-udid', (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'xcrun') return JSON.stringify({ devices: { iOS: [{ udid: 'chosen-udid', state: 'Booted' }] } });
    return JSON.stringify({ version: '0.13.0', udid: 'chosen-udid', orientation: 'landscape', accepted: true });
  });
  assert.deepEqual(calls[1][1].slice(1), ['chosen-udid', 'landscape']);
  assert.equal(calls[1][0], 'node');
  assert.throws(() => rotateSimulator('landscape', 'chosen-udid', () => JSON.stringify({ devices: { iOS: [{ udid: 'other', state: 'Booted' }] } })), /only booted simulator/);
  assert.throws(() => rotateSimulator('portrait', 'chosen-udid', () => { throw Error('native unavailable'); }), /native unavailable/);
  testNativePublication();
  testHarnessStages();
  await testSnapshotAnchors();
  testBaselineIntegration();
  testMainBaselinePreparation();
  testManualWorkflow();
  console.log('Simulator protocol, native publication, and rotation tests passed.');
}

function testNativePublication() {
  // Execute the actual component callback with native state dependencies stubbed.
  const source = fs.readFileSync(path.join(root, 'components/lyrics/native/native-lyrics-view.tsx'), 'utf8');
  const callback = source.slice(source.indexOf('const markRendererReady = useCallback(') + 'const markRendererReady = useCallback('.length, source.indexOf('\n  const flashRef'));
  const expression = callback.slice(0, callback.lastIndexOf(', ['));
  for (const scenario of ['live', 'inactive', 'background', 'stale-key', 'stale-generation', 'unmounted', 'release', 'production', 'disabled']) {
    const notices = [];
    const state = { key: 'renderer-2', generation: scenario === 'stale-generation' ? 3 : 2, ready: false, eligible: scenario !== 'inactive' };
    const context = {
      rendererReadyState: { current: state }, usePlaybackStore: { getState: () => ({ playbackMode: 'mobile', connectionStatus: 'disconnected' }) },
      __DEV__: !['production', 'release'].includes(scenario), process: { env: { EXPO_PUBLIC_SIMULATOR_TEST: scenario === 'disabled' ? '0' : '1', EXPO_PUBLIC_SIMULATOR_TEST_BUILD: scenario === 'release' ? 'release-arm64' : undefined } }, emitNativeClockDiagnostic() {},
      rendererReadyGate: { current: { onReady() {}, isCurrent: () => scenario !== 'unmounted' } }, requestNativeRendererReadyResync() {},
      rendererReadyGeneration: 2, readyGate: { isCurrent: () => scenario !== 'unmounted' },
      canDispatchRendererReady: () => state.eligible && scenario !== 'background',
      style: 'amll', rendererIdentity: { current: { demo: false, trackId: 'captured-song' } }, latestLyrics: { current: [1, 2] },
      require: () => ({ notifySimulatorRendererReady: event => notices.push(event) }),
    };
    const code = transformSync(`const callback = ${expression}; callback(${JSON.stringify(scenario === 'stale-key' ? 'renderer-1' : 'renderer-2')}, 2);`, { loader: 'ts' }).code;
    vm.runInNewContext(code, context);
    assert.equal(notices.length, ['live', 'release'].includes(scenario) ? 1 : 0, scenario);
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
    for (const file of ['test-simulator-timeouts.mjs', 'run-with-ci-budget.mjs', 'simulator-run-lifecycle.mjs']) {
      assert.equal(fs.readFileSync(path.join(dir, 'ExpoLyrics/scripts', file), 'utf8'), fs.readFileSync(path.join(root, 'scripts', file), 'utf8'), `Prepared baseline must include current ${file}`);
    }
    for (const file of fs.readdirSync(path.join(dir, 'ExpoLyrics/scripts')).filter(f => f.endsWith('.mjs'))) {
      const script = path.join(dir, 'ExpoLyrics/scripts', file);
      for (const match of fs.readFileSync(script, 'utf8').matchAll(/(?:from\s+|import\s*)['"](\.\/[^'"]+)['"]/g)) assert.ok(fs.existsSync(path.resolve(path.dirname(script), match[1])), `${file} imports missing ${match[1]}`);
    }
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
  const heartbeat = new module.exports.SimulatorHeartbeat();
  heartbeat.delays = Array.from({ length: 18000 }, (_, i) => i / 17);
  const metrics = heartbeat.getMetrics();
  assert.equal(metrics.samples, 18000);
  assert.ok(!('delays' in metrics));
  assert.ok(Buffer.byteLength(JSON.stringify(metrics)) < 256);
  const summary = harness.transportSummary({ success: true, stages: Array.from({ length: 8 }, (_, i) => ({ stage: `stage_${i + 1}_switch_spicy`, status: 'PASS', durationMs: 1234, metadata: { huge: 'x'.repeat(10000) } })), heartbeat: metrics, renderersExercised: ['spicy', 'amll'], tracksLoaded: 2, totalDurationMs: 50000, errors: ['x'.repeat(10000)] });
  assert.ok(Buffer.byteLength('[KINESYNC_SIM] SCENARIO_COMPLETE ' + JSON.stringify(summary)) < 1024);
  harness.beginStage('stage_1_launch');
  assert.throws(() => harness.beginStage('stage_2_playback'), /unfinished/);
}

async function testSnapshotAnchors() {
  const source = fs.readFileSync(path.join(root, 'lib/simulator-test-harness.ts'), 'utf8');
  const clockSource = fs.readFileSync(path.join(root, 'lib/simulator-playback-clock.ts'), 'utf8');
  const clocks = { exports: {} };
  let now = 0;
  vm.runInNewContext(transformSync(clockSource, { loader: 'ts', format: 'cjs' }).code, {
    module: clocks, exports: clocks.exports, performance: { now: () => now }, setInterval: () => 1, clearInterval() {},
  });
  const module = { exports: {} }, markers = [];
  const supported = { isSimulatorTestActive: () => true, waitForSimulatorScreenshotAck: async () => {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, console: { info: line => markers.push(line) },
    require: name => name.includes('simulator-playback-clock') ? clocks.exports : name.includes('playback-store') ? { usePlaybackStore: { getState: () => ({ ingestPacket() {} }) } } : name.includes('fixtures') ? { SIMULATOR_FIXTURE_TRACKS: [{ id: 'test' }] } : supported,
  });
  const harness = new module.exports.SimulatorTestHarness();
  const expected = { stage_1_launch: 5000, stage_2_playback: 8000, stage_3_seek: 46000, stage_4_switch_amll: 46000, stage_5_skip_song: 5000, stage_6_switch_spicy: 5000, stage_7_rotation: 5000 };
  for (const drift of [0, 137, 9000]) {
    for (const [stage, position] of Object.entries(expected)) {
      harness.clock.play(1234); now += drift;
      const before = markers.length;
      harness.delay = async ms => {
        assert.equal(ms, 1000);
        assert.equal(harness.clock.isPlaying(), false);
        assert.equal(harness.clock.getPositionMs(), position);
        assert.equal(markers.length, before, 'No capture marker before settlement');
        now += ms + drift;
      };
      await harness.screenshot(stage, `positionMs=${position}`);
      assert.equal(harness.clock.getPositionMs(), position);
      assert.equal(markers.length, before + 1);
    }
  }
}

function testMainBaselinePreparation() {
  // Immutable main snapshot used for this audit, not the candidate renderer.
  const mainCommit = 'e9abf50510b84db9f9f3a20c6f45ceb11685771f';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-main-baseline-'));
  const patch = fs.readFileSync(path.join(root, 'scripts/patches/harness-integration.patch'), 'utf8');
  const paths = [...patch.matchAll(/^diff --git a\/(.+) b\//gm)].map(m => m[1]);
  const original = new Map();
  try {
    for (const file of paths) {
      const source = execFileSync('git', ['show', `${mainCommit}:${file}`], { cwd: path.dirname(root) });
      original.set(file, source);
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), source);
    }
    // Exercise Git checkout semantics, not only git-apply's no-repository fallback.
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    execFileSync('git', ['add', '--', ...paths], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Exact main integration sources'], { cwd: dir });
    const output = execFileSync(process.execPath, [path.join(root, 'scripts/prepare-baseline-harness.mjs'), '--candidate-dir', path.dirname(root), '--baseline-dir', dir], { encoding: 'utf8' });
    assert.ok(output.includes('harness-integration-main.patch'));
    const nativePath = path.join(dir, 'ExpoLyrics/components/lyrics/native/native-lyrics-view.tsx');
    testMainPublication(fs.readFileSync(nativePath, 'utf8'));
    const changed = execFileSync('git', ['diff', '--name-only'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(changed, [...paths].sort(), 'Only the five explicit observation/integration files may change');
    prepareBaselineHarness({ candidateDir: path.dirname(root), baselineDir: dir });
    // Reversing only the instrumentation must restore every main production file exactly.
    execFileSync('git', ['apply', '--reverse', path.join(root, 'scripts/patches/harness-integration-main.patch')], { cwd: dir });
    for (const [file, source] of original) assert.deepEqual(fs.readFileSync(path.join(dir, file)), source, `Adapter must preserve main renderer logic: ${file}`);
    assert.equal(execFileSync('git', ['diff', '--exit-code'], { cwd: dir, encoding: 'utf8' }), '', 'Reversing observation must leave no tracked production diff');
    assert.ok(fs.existsSync(path.join(dir, 'ExpoLyrics/scripts/test-simulator-protocol.mjs')));
    for (const file of ['simulator-rotation-worker.mjs', 'prepare-simulator-rotation.mjs']) assert.equal(fs.readFileSync(path.join(dir, 'ExpoLyrics/scripts', file), 'utf8'), fs.readFileSync(path.join(root, 'scripts', file), 'utf8'), 'Baseline must receive identical pinned rotation adapter');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function testMainPublication(source) {
  const start = source.indexOf('const publishSimulatorReady = useCallback(') + 'const publishSimulatorReady = useCallback('.length;
  const end = source.indexOf('\n  const onContentSizeChange', start);
  const callback = source.slice(start, end);
  const expression = callback.slice(0, callback.lastIndexOf(', ['));
  for (const scenario of ['live', 'inactive', 'background', 'stale-generation', 'unmounted', 'old-lyrics', 'release', 'production']) {
    const lyrics = [{}], events = [];
    const context = {
      __DEV__: !['production', 'release'].includes(scenario), process: { env: { EXPO_PUBLIC_SIMULATOR_TEST: '1', EXPO_PUBLIC_SIMULATOR_TEST_BUILD: scenario === 'release' ? 'release-arm64' : undefined } },
      mounted: { current: scenario !== 'unmounted' },
      simulatorProbe: { current: { eligible: scenario !== 'inactive', generation: scenario === 'stale-generation' ? 3 : 2 } },
      simulatorGeneration: 2, AppState: { currentState: scenario === 'background' ? 'background' : 'active' },
      simulatorTrackId: 'baseline-song', style: 'amll', lyrics, latestLyrics: { current: scenario === 'old-lyrics' ? [] : lyrics },
      require: () => ({ notifySimulatorRendererReady: event => events.push(event) }),
    };
    vm.runInNewContext(transformSync(`(${expression})()`, { loader: 'ts' }).code, context);
    assert.equal(events.length, ['live', 'release'].includes(scenario) ? 1 : 0, scenario);
    if (events.length) assert.equal(events[0].trackId, 'baseline-song');
  }
}

function testManualWorkflow() {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '../.github/workflows/ios-simulator-test.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const job = workflow.jobs['ios-simulator-test'];
  assert.equal(job['timeout-minutes'], 60);
  assert.equal(job.strategy['fail-fast'], false, 'Candidate failure must not cancel baseline');
  assert.ok(job.strategy.matrix.variant.includes('candidate') && job.strategy.matrix.variant.includes('baseline'));
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps.filter(step => step.run)) {
    const parsed = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
    assert.equal(parsed.status, 0, `${step.name}: ${parsed.stderr}`);
  }
  const steps = job.steps;
  const paths = steps.find(step => step.id === 'paths');
  assert.match(paths.run, /46 \* 60 \* 1000/);
  assert.match(paths.run, /pwd -P/);
  assert.match(steps.find(step => step.name === 'Expo prebuild (iOS)').run, /--no-install/);
  for (const [id, minutes] of [['pods_cache', 4], ['compiler_cache', 8]]) {
    const cache = steps.find(step => step.id === id);
    const save = steps.find(step => step.uses?.startsWith('actions/cache/save@') && step.with.key.includes(`steps.${id}.outputs.cache-primary-key`));
    assert.equal(cache.with.path, save.with.path);
    assert.ok(!cache.with.path.includes('..') && !cache.with.path.includes('~'));
    assert.ok(cache.with.key.includes('steps.compatibility.outputs.id'));
    assert.ok(cache.with.key.includes('matrix.variant'));
    assert.equal(save['timeout-minutes'], minutes);
    assert.ok(!save['continue-on-error'], 'Cache failures must not be falsely green');
    assert.ok(save.if.includes('!cancelled()'));
    assert.equal(cache.with['restore-keys'].trim(), cache.with.key.replace(/-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}-\$\{\{ matrix.variant \}\}$/, '-'));
  }
  assert.match(steps.find(step => step.id === 'pods_cache').with.key, /ios-sim-pods-v2-/);
  for (const id of ['pods_verified', 'compiler_verified']) {
    const verify = steps.find(step => step.id === id);
    assert.match(verify.run, /verify-ci-cache.mjs/);
    assert.ok(verify.if.includes('!cancelled()'));
  }
  const baseline = steps.find(step => step.name === 'Prepare trusted baseline source');
  assert.equal(baseline.if, "matrix.variant == 'baseline'");
  assert.match(baseline.run, /resolve-trusted-simulator-baseline.mjs/);
  assert.match(baseline.run, /prepare-baseline-harness.mjs/);
  assert.ok(steps.indexOf(baseline) < steps.findIndex(step => step.name === 'Install JS dependencies'));
  const compare = workflow.jobs.compare;
  assert.ok(compare.if.includes('always()'));
  assert.ok(compare.steps.some(step => step.name === 'Publish comparison summary' && step.if === 'always()'));
  assert.ok(steps.find(step => step.name === 'Upload Simulator Test Artifacts').if === 'always()');
}
