import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createRequire } from 'node:module';
import { NativeCapture } from './simulator-native-capture.mjs';
const xcode = createRequire(import.meta.url)('xcode');
const project = xcode.project(new URL('./native-simulator-capture/Capture.xcodeproj/project.pbxproj', import.meta.url).pathname);
project.parseSync();
assert.equal(Object.values(project.hash.project.objects).filter(target => typeof target === 'object' && target.productType === '"com.apple.product-type.bundle.ui-testing"').length, 1);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-capture-test-'));
try {
  const portrait = PNG.sync.write(new PNG({ width: 3, height: 5 }));
  const landscape = PNG.sync.write(new PNG({ width: 5, height: 3 }));
  const session = '12345678-1234-1234-1234-123456789abc';
  const owner = { run: 'run', stage: 'stage_7_rotation', token: 'run_stage_7_rotation', orientation: 'landscape' };
  for (const mode of ['pass', 'portrait-framebuffer', 'wrong-run', 'wrong-stage', 'wrong-token', 'wrong-session', 'wrong-id', 'wrong-orientation', 'dead', 'timeout', 'png-before-timeout']) {
    const dir = path.join(root, mode); fs.mkdirSync(dir);
    let checks = 0;
    const capture = new NativeCapture({ mailbox: dir, session, udid: 'device',
      state: { outputDir: dir, now: () => checks, check() { if (++checks > 10) throw Error('Scenario stage timeout'); } },
      alive: () => mode !== 'dead', pause() {
        if (mode === 'timeout') return;
        const request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json')));
        if (mode === 'png-before-timeout') { fs.writeFileSync(path.join(dir, request.id + '.png'), landscape); return; }
        const response = { ...request };
        if (mode.startsWith('wrong-')) response[mode.slice(6)] = 'stale';
        fs.writeFileSync(path.join(dir, request.id + '.png'), mode === 'portrait-framebuffer' ? portrait : landscape);
        fs.writeFileSync(path.join(dir, request.id + '.json'), JSON.stringify(response));
      } });
    const destination = path.join(dir, 'result.png');
    if (mode === 'pass') {
      assert.deepEqual(capture.capture(destination, owner), landscape);
      assert.deepEqual(fs.readFileSync(destination), landscape, 'Native PNG bytes must be unchanged');
    } else {
      assert.throws(() => capture.capture(destination, owner), /dimensions invalid|ownership|exited|timeout/, mode);
      if (mode === 'portrait-framebuffer') assert.deepEqual(fs.readFileSync(destination), portrait, 'Rejected raw framebuffer must survive without conversion');
      else assert.ok(!fs.existsSync(destination), 'Unowned response must never publish a PNG');
      if (mode === 'png-before-timeout') {
        const record = JSON.parse(fs.readFileSync(path.join(dir, 'native-captures.jsonl'), 'utf8').trim());
        assert.deepEqual(fs.readFileSync(record.rejectedPNG), landscape, 'PNG before timeout is evidence only');
      }
    }
    assert.throws(() => capture.capture(destination, { ...owner, token: 'stale' }), /ownership/);
  }
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
