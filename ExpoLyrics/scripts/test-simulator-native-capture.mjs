import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createRequire } from 'node:module';
import { validateCaptureAttestation, NativeCapture, configureCaptureTransport, startNativeCapture } from './simulator-native-capture.mjs';
const requestProof = { id: 'nonce', session: 'session', udid: 'device', run: 'run', stage: 'stage_7_rotation', token: 'run_stage_7_rotation', phase: 'before', orientation: 'landscape' };
const proof = { ...requestProof, observedUDID: 'device', bundle: 'dev.kineticron.KineSync', foreground: 'true', deviceOrientation: 'landscape', windowWidth: '200', windowHeight: '100' };
validateCaptureAttestation(proof, requestProof, 'device');
for (const key of ['id', 'session', 'udid', 'observedUDID', 'run', 'stage', 'token', 'phase', 'bundle', 'foreground', 'deviceOrientation', 'windowWidth']) {
  assert.throws(() => validateCaptureAttestation({ ...proof, [key]: 'stale' }, requestProof, 'device'), /mismatch/);
}
const xcode = createRequire(import.meta.url)('xcode');
const project = xcode.project(new URL('./native-simulator-capture/Capture.xcodeproj/project.pbxproj', import.meta.url).pathname);
project.parseSync();
assert.equal(Object.values(project.hash.project.objects).filter(target => typeof target === 'object' && target.productType === '"com.apple.product-type.bundle.ui-testing"').length, 1);
const configuration = { Capture: { TestHostBundleIdentifier: 'dev.kineticron.simulator-capture.xctrunner', IsUITestBundle: true,
  EnvironmentVariables: { DYLD_LIBRARY_PATH: '__TESTROOT__/libs' }, TestHostPath: '__TESTROOT__/runner' },
  __xctestrun_metadata__: { FormatVersion: 1 } };
configureCaptureTransport(configuration, '/explicit/mailbox', 'host-session');
assert.equal(configuration.Capture.EnvironmentVariables.KINESYNC_CAPTURE_MAILBOX, '/explicit/mailbox');
assert.equal(configuration.Capture.EnvironmentVariables.KINESYNC_CAPTURE_SESSION, 'host-session');
assert.equal(configuration.Capture.EnvironmentVariables.DYLD_LIBRARY_PATH, '__TESTROOT__/libs');
assert.equal(configuration.Capture.TestHostPath, '__TESTROOT__/runner');
assert.throws(() => configureCaptureTransport({}, '/mailbox', 'session'), /Unexpected/);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-capture-test-'));
try {
  // Execute startup with a runner whose cache/container is deliberately unrelated.
  // Host readiness must come from the manifest, carry the host nonce, and be live.
  const { EventEmitter } = await import('node:events');
  const plist = (await import('plist')).default;
  for (const mode of ['ready', 'stale', 'wrong-path', 'exit', 'timeout']) {
    const outputDir = path.join(root, `startup-${mode}`); fs.mkdirSync(outputDir);
    const oldMailbox = path.join(outputDir, 'diagnostics/native-capture-mailbox');
    fs.mkdirSync(oldMailbox, { recursive: true });
    fs.writeFileSync(path.join(oldMailbox, 'ready.json'), JSON.stringify({ session: 'stale-before-launch' }));
    let checks = 0, child;
    const state = { outputDir, children: [], update() {}, check() { if (++checks > 8) throw Error('startup timeout'); } };
    const command = async (cmd, args) => {
      assert.equal(cmd, 'xcodebuild'); assert.ok(args.includes('build-for-testing'));
      const products = path.join(args[args.indexOf('-derivedDataPath') + 1], 'Build/Products');
      fs.mkdirSync(products, { recursive: true });
      fs.writeFileSync(path.join(products, 'Capture.xctestrun'), plist.build(configuration));
    };
    const transport = (cmd, args) => {
      child = new EventEmitter();
      assert.ok(!args.includes('-project'));
      const manifest = plist.parse(fs.readFileSync(args[args.indexOf('-xctestrun') + 1], 'utf8'));
      const env = manifest.Capture.EnvironmentVariables;
      const mailbox = env.KINESYNC_CAPTURE_MAILBOX;
      assert.ok(!fs.existsSync(path.join(mailbox, 'ready.json')), 'Old readiness must be removed before launch');
      if (mode !== 'timeout' && mode !== 'exit') fs.writeFileSync(path.join(mailbox, 'ready.json'), JSON.stringify({
        session: mode === 'stale' ? 'old-session' : env.KINESYNC_CAPTURE_SESSION,
        mailbox: mode === 'wrong-path' ? '/other/cache' : mailbox }));
      if (mode === 'exit') queueMicrotask(() => child.emit('close', 7));
      return child;
    };
    const pending = startNativeCapture(state, 'device', transport, { command, pause: async () => {} });
    if (mode === 'ready') assert.equal((await pending).mailbox, path.join(outputDir, 'diagnostics/native-capture-mailbox'));
    else await assert.rejects(pending, /ownership mismatch|exited before readiness|startup timeout/);
  }
  const portrait = PNG.sync.write(new PNG({ width: 3, height: 5 }));
  const landscape = PNG.sync.write(new PNG({ width: 5, height: 3 }));
  const session = '12345678-1234-1234-1234-123456789abc';
  const owner = { run: 'run', stage: 'stage_7_rotation', token: 'run_stage_7_rotation', orientation: 'landscape' };
  for (const mode of ['pass', 'portrait-framebuffer', 'wrong-run', 'wrong-stage', 'wrong-token', 'wrong-session', 'wrong-id', 'wrong-orientation', 'after-foreground', 'dead', 'dead-on-response', 'timeout', 'png-before-timeout']) {
    const dir = path.join(root, mode); fs.mkdirSync(dir);
    let checks = 0, responseDead = false;
    const capture = new NativeCapture({ mailbox: dir, session, udid: 'device', command: async (cmd, args, _state, _run, cap) => { assert.equal(cmd, 'xcrun'); assert.deepEqual(args.slice(0, 6), ['simctl', 'io', 'device', 'screenshot', '--type=png', args.at(-1)]); assert.equal(cap, 30000); fs.writeFileSync(args.at(-1), mode === 'portrait-framebuffer' ? portrait : landscape); },
      state: { outputDir: dir, now: () => checks, check() { if (++checks > 10) throw Error('Scenario stage timeout'); } },
      alive: () => mode !== 'dead' && !responseDead, pause() {
        if (mode === 'timeout') return;
        const request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json')));
        if (mode === 'png-before-timeout') { fs.writeFileSync(path.join(dir, request.id + '.png'), landscape); return; }
        const response = { ...request };
        if (mode === 'after-foreground' && request.phase === 'after') response.foreground = 'false';
        if (mode.startsWith('wrong-')) response[mode.slice(6)] = 'stale';
        fs.writeFileSync(path.join(dir, request.id + '.png'), mode === 'portrait-framebuffer' ? portrait : landscape);
        fs.writeFileSync(path.join(dir, request.id + '.json'), JSON.stringify({ observedUDID: 'device', bundle: 'dev.kineticron.KineSync', foreground: 'true', deviceOrientation: request.orientation, windowWidth: request.orientation === 'landscape' ? '5' : '3', windowHeight: request.orientation === 'landscape' ? '3' : '5', ...response }));
        if (mode === 'dead-on-response') responseDead = true;
      } });
    const destination = path.join(dir, 'result.png');
    if (mode === 'pass') {
      assert.deepEqual(await capture.capture(destination, owner), landscape);
      assert.deepEqual(fs.readFileSync(destination), landscape, 'Native PNG bytes must be unchanged');
    } else {
      await assert.rejects(() => capture.capture(destination, owner), /dimensions invalid|ownership|exited|timeout/, mode);
      if (mode === 'portrait-framebuffer') assert.deepEqual(fs.readFileSync(destination), portrait, 'Rejected raw framebuffer must survive without conversion');
      else assert.ok(!fs.existsSync(destination), 'Unowned response must never publish a PNG');
      if (mode === 'png-before-timeout') {
        const record = JSON.parse(fs.readFileSync(path.join(dir, 'native-captures.jsonl'), 'utf8').trim());
        assert.deepEqual(fs.readFileSync(record.rejectedPNG), landscape, 'PNG before timeout is evidence only');
      }
    }
    await assert.rejects(() => capture.capture(destination, { ...owner, token: 'stale' }), /ownership/);
  }
  const dyingDir = path.join(root, 'dies-during-request'); fs.mkdirSync(dyingDir);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 50)']);
  let stopped = false;
  const closed = new Promise(resolve => child.once('close', () => { stopped = true; resolve(); }));
  child.once('error', () => { stopped = true; });
  const started = Date.now();
  const dyingCapture = new NativeCapture({ mailbox: dyingDir, session, udid: 'device', alive: () => !stopped,
    state: { outputDir: dyingDir, now: Date.now, check() { if (Date.now() - started > 2000) throw Error('Scenario stage timeout'); } } });
  try {
    await assert.rejects(() => dyingCapture.capture(path.join(dyingDir, 'result.png'), owner), /Native capture runner exited/);
    assert.equal(stopped, true);
    assert.equal(child.exitCode, 7);
  } finally { child.kill(); await closed; }
  const swift = fs.readFileSync(new URL('./native-simulator-capture/CaptureTests.swift', import.meta.url), 'utf8');
  assert.match(swift, /XCUIScreen.main.screenshot\(\)/);
  assert.match(swift, /screenshot.pngRepresentation.write/);
  assert.doesNotMatch(swift, /UIGraphics|CGContext|pngData\(|draw\(|CGAffineTransform/);
  console.log('Native capture ownership, raw byte preservation, orientation rejection, runner death and deadline tests passed.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

// Execute the actual app scenario, holding each capture ACK independently.
// Neither a layout callback nor an old ACK may release landscape ownership.
const { transformSync } = await import('esbuild');
const vm = await import('node:vm');
const module = { exports: {} }, markers = [], requests = [], orientations = [];
let position = 0;
const clock = class {
  pause() {} seek(value) { position = value; } play(value) { position = value; }
  isPlaying() { return false; } getPositionMs() { return position; } stop() {}
};
const bridge = {
  isSimulatorTestActive: () => true, setSimulatorCaptureFrozen() {},
  waitForSimulatorRendererReady: async ({ style }) => ({ style, generation: 1 }),
  waitForSimulatorOrientation: async orientation => { orientations.push(orientation); return { width: orientation === 'landscape' ? 874 : 402, height: orientation === 'landscape' ? 402 : 874 }; },
  waitForSimulatorScreenshotAck: (stage, token) => new Promise(resolve => requests.push({ stage, token, resolve })),
};
vm.runInNewContext(transformSync(fs.readFileSync(new URL('../lib/simulator-test-harness.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code, {
  module, exports: module.exports, Date, console: { info: line => markers.push(line), error: line => markers.push(line) },
  require: name => name.includes('simulator-playback-clock') ? { SimulatorPlaybackClock: clock } : bridge,
});
const harness = new module.exports.SimulatorTestHarness();
harness.delay = async () => {};
harness.loadTrack = index => { harness.tracksLoadedCount++; return { id: `track${index}`, linesCount: index ? 42 : 54 }; };
harness.switchRenderer = () => {};
harness.heartbeat.stop = () => ({ samples: 10, p50Ms: 0, p95Ms: 1, maxDelayMs: 2, blocksOver50Ms: 0, blocksOver100Ms: 0 });
const scenario = harness.runAutomatedScenario();
async function nextRequest() {
  for (let i = 0; i < 30 && !requests.length; i++) await Promise.resolve();
  assert.ok(requests.length, 'App must request a capture');
  return requests.shift();
}
for (let i = 1; i <= 6; i++) (await nextRequest()).resolve();
const landscape = await nextRequest();
assert.equal(landscape.stage, 'stage_7_rotation');
assert.deepEqual(orientations, ['landscape']);
assert.ok(!markers.some(line => line.includes('orientation=portrait')), 'No restoration before landscape capture ACK');
landscape.resolve();
const restore = await nextRequest();
assert.equal(restore.stage, 'stage_7_restore');
assert.notEqual(restore.token, landscape.token);
assert.ok(!markers.some(line => line.includes('STAGE_END stage_7_rotation')), 'Portrait layout cannot finish stage without native restore capture ACK');
restore.resolve();
await scenario;
assert.ok(markers.some(line => line.includes('HEARTBEAT_METRICS')));
assert.ok(markers.some(line => line.includes('SCENARIO_COMPLETE') && line.includes('"success":true')));
console.log('Actual app scenario holds landscape capture ownership and waits for a separate native portrait restoration ACK before full metrics.');
