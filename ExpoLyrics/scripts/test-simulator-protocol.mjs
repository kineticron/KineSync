import assert from 'node:assert/strict';
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
import { rotateSimulator } from './run-ios-simulator-test.mjs';

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
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'], 'Pushes must never trigger this dedicated harness');
  assert.ok(workflow.on.workflow_dispatch.inputs.baseline_ref);
  assert.equal(workflow.jobs['ios-simulator-test']['timeout-minutes'], 30);
  const steps = workflow.jobs['ios-simulator-test'].steps;
  for (const step of steps.filter(step => step.run)) {
    const parsed = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
    assert.equal(parsed.status, 0, `${step.name}: ${parsed.stderr}`);
  }
  const prebuild = steps.find(step => step.name === 'Expo prebuild (iOS)');
  assert.match(prebuild.run, /--no-install/);
  const pods = steps.find(step => step.id === 'pods_cache');
  const compiler = steps.find(step => step.id === 'compiler_cache');
  assert.ok(steps.indexOf(pods) < steps.findIndex(step => step.id === 'install_pods'));
  assert.ok(steps.findIndex(step => step.id === 'install_pods') < steps.indexOf(compiler));
  for (const cache of [pods, compiler]) {
    assert.match(cache.uses, /^actions\/cache\/restore@/);
    assert.match(cache.with.key, /package-lock.json/);
    assert.match(cache.with.key, /steps.compatibility.outputs.id/);
    assert.match(cache.with.key, /runner.arch/);
    assert.match(cache.with.key, /github.run_id/);
    assert.equal(cache.with['restore-keys'].trim(), cache.with.key.replace(/-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}$/, '-'));
    const save = steps.find(step => step.uses?.startsWith('actions/cache/save@') && step.with.key.includes(`steps.${cache.id}.outputs.cache-primary-key`));
    assert.ok(save);
    assert.equal(save.with.path, cache.with.path);
    assert.match(save.if, /!cancelled\(\)/);
    assert.ok(!save.if.includes('success()'), 'Failed builds must still save');
    assert.equal(save['timeout-minutes'], 1);
    assert.ok(!cache.with.path.includes('env.HOME'));
    assert.ok(!cache.with.path.includes('baseline'));
  }
  assert.match(compiler.with.key, /Podfile.lock/);
  assert.match(compiler.with.key, /release-arm64-v2/);
  assert.match(compiler.with.path, /kinesync-ios-derived-sim/);
  assert.match(compiler.with.path, /kinesync-ios-ccache/);
  assert.match(pods.with.path, /ios\/Pods/);
  const identity = steps.find(step => step.id === 'compatibility');
  for (const command of ['xcodebuild -version', '--show-sdk-version', 'pod --version', 'ccache --version', 'uname -m']) assert.ok(identity.run.includes(command));
  assert.ok(steps.some(step => step.id === 'candidate_build'));
  const baseline = steps.find(step => step.name.startsWith('Run Baseline Comparison'));
  assert.ok(baseline.if.includes('!cancelled()') && baseline.if.includes("steps.candidate_build.outcome == 'success'"));
  assert.ok(baseline.run.includes('resolve-trusted-simulator-baseline.mjs'));
  assert.ok(baseline.run.includes('|| BASELINE_STATUS=$?'));
  assert.ok(baseline.run.includes('|| COMPARISON_STATUS=$?'));
  assert.ok(baseline.run.includes('[ "${BASELINE_STATUS}" -ne 0 ] || [ "${COMPARISON_STATUS}" -ne 0 ]'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-workflow-'));
  try {
    const shim = `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2].includes('compare-simulator')) {
 fs.mkdirSync('ExpoLyrics/.expo', { recursive: true });
 fs.writeFileSync('ExpoLyrics/.expo/comparison-report.md', 'comparison attempted');
 process.exit(Number(process.env.COMPARE_EXIT));
}
const outputIndex = process.argv.indexOf('--output-dir');
if (process.argv[outputIndex + 1] !== process.env.GITHUB_WORKSPACE + '/ExpoLyrics/.expo/baseline-test-output') process.exit(97);
process.exit(Number(process.env.BASELINE_EXIT));
`;
    fs.writeFileSync(path.join(dir, 'node'), shim, { mode: 0o755 });
    const script = baseline.run.slice(baseline.run.indexOf('BASELINE_STATUS=0')).replace(/^popd$/m, ':').replace(/^BASELINE$/m, '');
    for (const [baselineExit, compareExit] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const summary = path.join(dir, 'summary');
      fs.writeFileSync(summary, '');
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`,
          GITHUB_WORKSPACE: dir, BASELINE_APP: '/mock.app', BASELINE_REF: 'main', BASELINE_EXIT: String(baselineExit), COMPARE_EXIT: String(compareExit), GITHUB_STEP_SUMMARY: summary },
      });
      assert.equal(result.status, baselineExit || compareExit ? 1 : 0, result.stderr);
      assert.ok(fs.readFileSync(summary, 'utf8').includes('comparison attempted'), 'Comparison must run and publish even when baseline scenario fails');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

}
