import './test-simulator-review-png.mjs';
import './test-simulator-artifact-acceptance.mjs';
import './test-simulator-native-capture.mjs';
import './test-simulator-raw-metadata.mjs';
import './test-simulator-failure-evidence.mjs';
import './test-simulator-marquee.mjs';
import './test-simulator-initialization.cjs';
// Unit and integration tests for simulator test harness components
// Validates clock monotonicity, log parser assertions, adversarial log detection, and screenshot comparison

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { testSimulatorProtocol } from './test-simulator-protocol.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import CrcCalculator from 'pngjs/lib/crc.js';
import { reviewPNG } from './simulator-review-png.mjs';
import { SimulatorLogParser } from './parse-simulator-logs.mjs';
import { analyzeScreenshotContent, compareScreenshots, validateRunArtifacts } from './compare-simulator-screenshots.mjs';
import './test-simulator-build.mjs';
import './test-ci-cache.mjs';
import './test-simulator-baseline.mjs';
import './test-simulator-timeouts.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-harness-'));

function createSolidPng(width, height, r, g, b, a = 255) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}

function createTextMockPng(width, height) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      // Background gradient
      const bg = Math.floor((y / height) * 100);
      let r = bg;
      let g = bg + 20;
      let b = bg + 50;

      // Draw synthetic "lyrics text" stripes
      if (y % 40 > 10 && y % 40 < 25 && x > 30 && x < width - 30) {
        if ((x + y) % 7 > 2) {
          r = 240;
          g = 240;
          b = 240;
        }
      }

      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function testLogParser() {
  console.log('Testing SimulatorLogParser (happy path)...');
  const parser = new SimulatorLogParser();

  const sampleLogs = [
    '[KINESYNC_SIM] INIT_BEGIN',
    '[KINESYNC_SIM] INIT_READY',
    '[KINESYNC_SIM] SCENARIO_START',
    '[KINESYNC_SIM] STAGE_BEGIN stage_1_launch timestamp=1000',
    '[KINESYNC_SIM] TRACK_LOADED id=spotify-connect:sim_rewind_track lines=54 parseMs=4.2',
    '[KINESYNC_SIM] RENDERER_ACTIVE style=spicy generation=1 lines=54 track=spotify-connect:sim_rewind_track',
    '[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_1_launch style=spicy track=spotify-connect:sim_rewind_track positionMs=5000',
    '[KINESYNC_SIM] STAGE_END stage_1_launch status=PASS durationMs=2500',
    '[KINESYNC_SIM] STAGE_BEGIN stage_2_playback timestamp=3500',
    '[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_2_playback style=spicy track=spotify-connect:sim_rewind_track positionMs=8000',
    '[KINESYNC_SIM] STAGE_END stage_2_playback status=PASS durationMs=3000',
    '[KINESYNC_SIM] STAGE_BEGIN stage_3_seek timestamp=6500',
    '[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_3_seek style=spicy track=spotify-connect:sim_rewind_track positionMs=46000',
    '[KINESYNC_SIM] STAGE_END stage_3_seek status=PASS durationMs=1200',
    '[KINESYNC_SIM] STAGE_BEGIN stage_4_switch_amll timestamp=7700',
    '[KINESYNC_SIM] RENDERER_ACTIVE style=amll generation=2 lines=54 track=spotify-connect:sim_rewind_track',
    '[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_4_switch_amll style=amll track=spotify-connect:sim_rewind_track positionMs=47000',
    '[KINESYNC_SIM] STAGE_END stage_4_switch_amll status=PASS durationMs=1400',
    '[KINESYNC_SIM] STAGE_BEGIN stage_5_skip_song timestamp=9100',
    '[KINESYNC_SIM] TRACK_LOADED id=spotify-connect:sim_seesaw_track lines=42 parseMs=3.8',
    '[KINESYNC_SIM] RENDERER_ACTIVE style=amll generation=3 lines=42 track=spotify-connect:sim_seesaw_track',
    '[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_5_skip_song style=amll track=spotify-connect:sim_seesaw_track positionMs=5000',
    '[KINESYNC_SIM] STAGE_END stage_5_skip_song status=PASS durationMs=2200',
    '[KINESYNC_SIM] STAGE_BEGIN stage_6_switch_spicy timestamp=11300',
    '[KINESYNC_SIM] RENDERER_ACTIVE style=spicy generation=4 lines=42 track=spotify-connect:sim_seesaw_track',
    '[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_6_switch_spicy style=spicy track=spotify-connect:sim_seesaw_track positionMs=5000',
    '[KINESYNC_SIM] STAGE_END stage_6_switch_spicy status=PASS durationMs=1100',
    '[KINESYNC_SIM] STAGE_BEGIN stage_7_rotation timestamp=12400',
    '[KINESYNC_SIM] TRIGGER_SIMULATOR_ROTATION orientation=landscape stage=stage_7_rotation token=run_stage_7_rotation',
    '[KINESYNC_SIM] VIEWPORT_LAYOUT width=844 height=390 windowWidth=844 windowHeight=390 orientation=landscape style=spicy',
    '[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_7_rotation style=spicy track=spotify-connect:sim_seesaw_track positionMs=5000 orientation=landscape width=844 height=390',
    '[KINESYNC_SIM] TRIGGER_SIMULATOR_ROTATION orientation=portrait stage=stage_7_rotation token=run_stage_7_restore',
    '[KINESYNC_SIM] VIEWPORT_LAYOUT width=390 height=844 windowWidth=390 windowHeight=844 orientation=portrait style=spicy',
    '[KINESYNC_SIM] READY_FOR_PORTRAIT_RESTORE stage=stage_7_rotation token=run_stage_7_restore',
    '[KINESYNC_SIM] STAGE_END stage_7_rotation status=PASS durationMs=2600',
    '[KINESYNC_SIM] STAGE_BEGIN stage_8_complete timestamp=15000',
    '[KINESYNC_SIM] STAGE_END stage_8_complete status=PASS durationMs=50',
    '[KINESYNC_SIM] HEARTBEAT_METRICS {"samples":100,"p50Ms":1.2,"p95Ms":3.4,"maxDelayMs":8.1,"blocksOver50Ms":0,"blocksOver100Ms":0}',
    '[KINESYNC_SIM] SCENARIO_COMPLETE {"success":true,"stages":[],"heartbeat":{"samples":100},"renderersExercised":["spicy","amll"],"totalDurationMs":15050,"tracksLoaded":2,"errors":[]}',
  ];

  // Derive the summary from the preceding observed stage records, as the app does.
  for (const line of sampleLogs) {
    if (line.includes('SCENARIO_COMPLETE')) {
      const summary = { success: true, stages: parser.stages, heartbeat: parser.heartbeat, tracksLoaded: 2, renderersExercised: ['spicy', 'amll'], errors: [] };
      parser.processLine(`[KINESYNC_SIM] SCENARIO_COMPLETE ${JSON.stringify(summary)}`);
    } else parser.processLine(line);
  }
  testEvidenceMutations(sampleLogs);
  testRunnerCli(sampleLogs, parser);

  const failures = parser.validateAssertions();
  assert.strictEqual(failures.length, 0, `Unexpected parser assertion failures: ${failures.join(', ')}`);
  assert.strictEqual(parser.appLaunched, true);
  assert.strictEqual(parser.tracksLoaded, 2);
  assert.strictEqual(parser.renderers.has('spicy'), true);
  assert.strictEqual(parser.renderers.has('amll'), true);
  assert.strictEqual(parser.landscapeConfirmed, true);
  assert.strictEqual(parser.portraitConfirmed, true);
  assert.strictEqual(parser.summary.success, true);

  const report = parser.generateMarkdownReport();
  assert.ok(report.includes('Status: PASSED'), 'Report should indicate PASSED');
  assert.ok(report.includes('Landscape Viewport Confirmed: Yes'), 'Report should show landscape confirmation');
  console.log('SimulatorLogParser happy path passed.');
}

function testAdversarialLogParser() {
  console.log('Testing SimulatorLogParser adversarial and fail-closed cases...');

  // Case 1: Missing summary record
  {
    const parser = new SimulatorLogParser();
    parser.processLine('[KINESYNC_SIM] INIT_READY');
    parser.processLine('[KINESYNC_SIM] HEARTBEAT_METRICS {"samples":50}');
    const failures = parser.validateAssertions();
    assert.ok(failures.some((f) => f.includes('Missing SCENARIO_COMPLETE')), 'Must fail if summary record is missing');
  }

  // Case 2: Summary reports success=false
  {
    const parser = new SimulatorLogParser();
    parser.processLine('[KINESYNC_SIM] SCENARIO_COMPLETE {"success":false}');
    const failures = parser.validateAssertions();
    assert.ok(failures.some((f) => f.includes('success=false')), 'Must fail if summary success is false');
  }

  // Case 3: Missing heartbeat metrics
  {
    const parser = new SimulatorLogParser();
    parser.processLine('[KINESYNC_SIM] SCENARIO_COMPLETE {"success":true}');
    const failures = parser.validateAssertions();
    assert.ok(!failures.some((f) => f.includes('heartbeat')), 'Missing telemetry cannot gate screenshots');
  }

  // Case 4: Zero samples in heartbeat
  {
    const parser = new SimulatorLogParser();
    parser.processLine('[KINESYNC_SIM] HEARTBEAT_METRICS {"samples":0}');
    const failures = parser.validateAssertions();
    assert.ok(!failures.some((f) => f.includes('heartbeat')), 'Performance telemetry does not gate screenshot delivery');
  }

  // Case 5: Fake intent log with 0 lines or null track
  {
    const parser = new SimulatorLogParser();
    parser.processLine('[KINESYNC_SIM] RENDERER_ACTIVE style=spicy generation=1 lines=0 track=null');
    assert.strictEqual(parser.renderers.has('spicy'), false, 'Fake intent with 0 lines must not register renderer');
    assert.ok(parser.errors.length > 0, 'Fake intent must log an execution error');
  }

  // Case 6: Incomplete stages (< 8 stages)
  {
    const parser = new SimulatorLogParser();
    parser.processLine('[KINESYNC_SIM] STAGE_BEGIN stage_1_launch timestamp=100');
    parser.processLine('[KINESYNC_SIM] STAGE_END stage_1_launch status=PASS durationMs=100');
    const failures = parser.validateAssertions();
    assert.ok(failures.some((f) => f.includes('Incomplete scenario')), 'Must fail if fewer than 8 stages');
  }

  // Case 7: Stage failure
  {
    const parser = new SimulatorLogParser();
    parser.processLine('[KINESYNC_SIM] STAGE_BEGIN stage_1_launch timestamp=100');
    parser.processLine('[KINESYNC_SIM] STAGE_FAIL stage_1_launch error=SimulatedFailure');
    const failures = parser.validateAssertions();
    assert.ok(failures.some((f) => f.includes('SimulatedFailure')), 'Must fail if stage reports error');
  }

  // Case 8: Missing screenshot requests
  {
    const parser = new SimulatorLogParser();
    const failures = parser.validateAssertions();
    assert.ok(failures.some((f) => f.includes('Missing screenshot request')), 'Must fail if required screenshots were not requested');
  }

  // Case 9: Missing landscape confirmation
  {
    const parser = new SimulatorLogParser();
    const failures = parser.validateAssertions();
    assert.ok(failures.some((f) => f.includes('Rotation stage did not produce confirmed native landscape')), 'Must fail if rotation unconfirmed');
  }

  console.log('SimulatorLogParser adversarial tests passed.');
}

function testScreenshotAnalysis() {
  console.log('Testing Screenshot Content Analysis...');
  fs.mkdirSync(tempDir, { recursive: true });

  const solidBlack = createSolidPng(200, 400, 0, 0, 0);
  const blankAnalysis = analyzeScreenshotContent(solidBlack);
  assert.strictEqual(blankAnalysis.nonBlank, false, 'Solid black image should be rejected as blank');

  const solidWhite = createSolidPng(200, 400, 255, 255, 255);
  const whiteAnalysis = analyzeScreenshotContent(solidWhite);
  assert.strictEqual(whiteAnalysis.nonBlank, false, 'Solid white image should be rejected as blank');

  const lyricsMock = createTextMockPng(200, 400);
  const lyricsAnalysis = analyzeScreenshotContent(lyricsMock);
  assert.strictEqual(lyricsAnalysis.nonBlank, true, 'Image with mock text stripes should be recognized as non-blank');
  assert.ok(lyricsAnalysis.stdDev > 10.0, 'Variance should be substantially greater than blank');

  // Corrupted / zero-byte buffer
  const corruptAnalysis = analyzeScreenshotContent(Buffer.from([0, 1, 2, 3]));
  assert.strictEqual(corruptAnalysis.nonBlank, false, 'Corrupted buffer should return nonBlank=false');

  console.log('Screenshot Content Analysis tests passed.');
}

function testScreenshotComparison() {
  console.log('Testing Screenshot Comparison...');
  const branchDir = path.join(tempDir, 'branch');
  const baselineDir = path.join(tempDir, 'baseline');
  fs.mkdirSync(branchDir, { recursive: true });
  fs.mkdirSync(baselineDir, { recursive: true });

  const img1 = createTextMockPng(100, 200);
  fs.writeFileSync(path.join(branchDir, 'stage_1_launch.png'), img1);
  fs.writeFileSync(path.join(baselineDir, 'stage_1_launch.png'), img1);

  // Second image with small difference
  const img2Branch = createTextMockPng(100, 200);
  const img2Base = createSolidPng(100, 200, 20, 20, 20);
  fs.writeFileSync(path.join(branchDir, 'stage_2_playback.png'), img2Branch);
  fs.writeFileSync(path.join(baselineDir, 'stage_2_playback.png'), img2Base);

  const comp = compareScreenshots(branchDir, baselineDir);
  assert.strictEqual(comp.error, null);
  assert.strictEqual(comp.results.length, 2);

  const res1 = comp.results.find((r) => r.filename === 'stage_1_launch.png');
  assert.strictEqual(res1.status, 'IDENTICAL');
  assert.strictEqual(res1.differingPixels, 0);

  const res2 = comp.results.find((r) => r.filename === 'stage_2_playback.png');
  assert.strictEqual(res2.status, 'DIFFERENT');
  assert.ok(res2.differingPixels > 0);

  // Test empty branch dir fail-closed
  const emptyDir = path.join(tempDir, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  const emptyComp = compareScreenshots(emptyDir, baselineDir);
  assert.ok(emptyComp.error, 'Empty directory must return comparison error');

  console.log('Screenshot Comparison tests passed.');
}

function testEvidenceMutations(logs) {
  const check = (mutate, pattern) => {
    const p = new SimulatorLogParser();
    for (const line of mutate(logs)) p.processLine(line);
    assert.ok(p.validateAssertions().some(f => pattern.test(f)), `Expected ${pattern}`);
  };
  for (const mutate of [lines => lines.filter(l => !l.includes('HEARTBEAT_METRICS')), lines => lines.map(l => l.includes('HEARTBEAT_METRICS') ? '[KINESYNC_SIM] HEARTBEAT_METRICS invalid' : l)]) {
    const parser = new SimulatorLogParser(); for (const line of mutate(logs)) {
      if (line.includes('SCENARIO_COMPLETE')) parser.processLine('[KINESYNC_SIM] SCENARIO_COMPLETE ' + JSON.stringify({ success: true, stages: parser.stages, tracksLoaded: 2, renderersExercised: ['spicy', 'amll'], errors: [] }));
      else parser.processLine(line);
    }
    assert.deepEqual(parser.validateAssertions(), [], 'Telemetry is diagnostic only');
  }
  check(lines => lines.filter(l => !l.includes('STAGE_END stage_5')), /Stage stage_5.*failed|overlapping/);
  check(lines => lines.map(l => l.replace('STAGE_BEGIN stage_5_skip_song', 'STAGE_BEGIN stage_4_switch_amll')), /Incomplete scenario/);
  check(lines => lines.filter(l => !l.includes('RENDERER_ACTIVE style=amll generation=3')), /fresh per-track/);
  check(lines => lines.map(l => l.includes('generation=3') ? l.replace('sim_seesaw_track', 'sim_rewind_track') : l), /fresh per-track/);
  check(lines => lines.filter(l => !l.includes('TRIGGER_SIMULATOR_ROTATION')), /confirmed native landscape/);
  check(lines => lines.map(l => l.replace('windowWidth=844 windowHeight=390', 'windowWidth=390 windowHeight=844')), /confirmed native landscape/);
  check(lines => lines, /Summary contradicts/);
  check(lines => lines.map(l => l.includes('SCENARIO_COMPLETE') ? '[KINESYNC_SIM] SCENARIO_COMPLETE {\"success\":true,\"stages\":[null]}' : l), /Summary contradicts/);
  check(lines => lines.map(l => l.includes('stage_6_switch_spicy style=spicy') ? l.replace('style=spicy', 'style=amll') : l), /track\/style/);
  // Even mutually consistent load/readiness/screenshot identities must match the fixed scenario.
  check(lines => lines.map(l => l.replaceAll('spotify-connect:sim_rewind_track', 'arbitrary-song')), /track\/style/);
  check(lines => lines.map(l => l.includes('RENDERER_ACTIVE style=spicy generation=4') || l.includes('stage_6_switch_spicy style=spicy') ? l.replace('style=spicy', 'style=amll') : l), /track\/style/);
  const p = new SimulatorLogParser();
  p.processLine('[KINESYNC_SIM] VIEWPORT_LAYOUT width=844 height=390 windowWidth=844 windowHeight=390 orientation=landscape style=spicy');
  assert.equal(p.landscapeConfirmed, false, 'Startup layout is not rotation evidence');
}

function testRunnerCli(logs, parser) {
  const dir = path.join(tempDir, 'runner-cli');
  fs.mkdirSync(path.join(dir, 'Library/Caches'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'portrait.png'), createTextMockPng(100, 200));
  fs.writeFileSync(path.join(dir, 'landscape.png'), createTextMockPng(200, 100));
  fs.writeFileSync(path.join(dir, 'blank.png'), createSolidPng(100, 200, 0, 0, 0));
  const summary = JSON.stringify({ ...parser.summary, stages: parser.summary.stages.map(({ stage, status, durationMs }) => [stage, status, durationMs]), heartbeat: { samples: parser.heartbeat.samples } });
  const runLogs = logs.map(line => line === '[KINESYNC_SIM] SCENARIO_START' ? line + ' token=run' : line).map(line => line.includes('SCENARIO_COMPLETE') ? `[KINESYNC_SIM] SCENARIO_COMPLETE ${summary}` : line.replace(/READY_FOR_SCREENSHOT stage=(\w+)/, 'READY_FOR_SCREENSHOT stage=$1 token=run_$1'));
  const developer = path.join(dir, 'Xcode.app/Contents/Developer');
  fs.mkdirSync(path.join(developer, 'Applications/Simulator.app/Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(developer, 'Applications/Simulator.app/Contents/MacOS/Simulator'), 'fixture');
  const shim = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const dir = ${JSON.stringify(dir)};
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
if (name === 'node') {
 if (args.at(-1) === 'landscape' && process.env.SIM_CASE === 'rotation-failure') { console.log('native stdout before failure'); console.error('native stderr before failure'); process.exit(2); }
 if (process.env.SIM_CASE === 'rotation-hang') { setInterval(() => {}, 1000); return; }
 if (process.env.SIM_CASE === 'rotation-rejected') { console.log('KINESYNC_ROTATION_RESULT ' + JSON.stringify({ accepted: false })); process.exit(0); }
 console.log('native optional-symbol warning');
 console.log('KINESYNC_ROTATION_RESULT ' + JSON.stringify({ version: '0.13.0', udid: args.at(-2), orientation: args.at(-1), accepted: true })); process.exit(0);
}
if (name === 'xcodebuild') {
 if (args.includes('-version')) console.log('Xcode 26.6');
 if (args.includes('build-for-testing')) {
  const products = path.join(args[args.indexOf('-derivedDataPath') + 1], 'Build/Products');
  fs.mkdirSync(products, { recursive: true });
  const plist = require(${JSON.stringify(new URL(import.meta.resolve('plist')).pathname)});
  fs.writeFileSync(path.join(products, 'Capture.xctestrun'), plist.build({ Capture: { TestHostBundleIdentifier: 'dev.kineticron.simulator-capture.xctrunner', IsUITestBundle: true }, __xctestrun_metadata__: { FormatVersion: 1 } }));
  if (process.env.SIM_CASE === 'unified-log-slow-ready') { setTimeout(() => process.exit(0), 400); return; }
 }
 if (args.includes('test-without-building')) {
  const plist = require(${JSON.stringify(new URL(import.meta.resolve('plist')).pathname)});
  const env = plist.parse(fs.readFileSync(args[args.indexOf('-xctestrun') + 1], 'utf8')).Capture.EnvironmentVariables;
  const mailbox = env.KINESYNC_CAPTURE_MAILBOX;
  fs.mkdirSync(mailbox, { recursive: true });
  const writeReady = () => fs.writeFileSync(path.join(mailbox, 'ready.json'), JSON.stringify({ session: env.KINESYNC_CAPTURE_SESSION, mailbox }));
  if (process.env.SIM_CASE === 'unified-log-slow-ready') setTimeout(writeReady, 400);
  else writeReady();
  setInterval(() => {
   const file = path.join(mailbox, 'request.json');
   if (!fs.existsSync(file)) return;
   const request = JSON.parse(fs.readFileSync(file)); fs.unlinkSync(file);
   if (process.env.SIM_CASE === 'capture-failure') { fs.writeFileSync(path.join(dir, 'failed-capture-request.json'), JSON.stringify(request)); process.exit(7); }
   if (process.env.SIM_CASE === 'png-timeout') { fs.copyFileSync(path.join(dir, 'portrait.png'), path.join(mailbox, request.id + '.png')); return; }
   const landscape = request.orientation === 'landscape' && !['rotation-noop', 'native-portrait-output'].includes(process.env.SIM_CASE) || request.stage === 'stage_7_restore' && process.env.SIM_CASE === 'portrait-noop';
   const counter = path.join(mailbox, request.stage + '.count');
   const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter)) : 0;
   fs.writeFileSync(counter, String(count + 1));
   const source = process.env.SIM_CASE === 'blank' || process.env.SIM_CASE === 'unstable' && count % 2 ? 'blank.png' : landscape ? 'landscape.png' : 'portrait.png';
   fs.copyFileSync(path.join(dir, source), path.join(mailbox, request.id + '.png'));
   fs.writeFileSync(path.join(mailbox, request.id + '.png.source'), source);
   fs.writeFileSync(path.join(mailbox, request.id + '.json'), JSON.stringify({ ...request, observedUDID: request.udid, bundle: 'dev.kineticron.KineSync', foreground: 'true', deviceOrientation: request.orientation, captureSource: request.orientation === 'landscape' ? 'XCUIWindow' : 'XCUIScreen', windowWidth: request.orientation === 'landscape' ? '200' : '100', windowHeight: request.orientation === 'landscape' ? '100' : '200' }));
  }, 5);
  return;
 }
 process.exit(0);
}
if (name !== 'xcrun') process.exit(0);
if (args.includes('--show-sdk-version')) console.log('26.5');
if (args.includes('--show-sdk-path')) console.log(process.env.DEVELOPER_DIR + '/Platforms/iPhoneSimulator.platform/SDKs/iPhoneSimulator26.5.sdk');
if (args.includes('runtimes')) console.log(JSON.stringify({ runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', isAvailable: true }] }));
else if (args.includes('list')) console.log(JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ udid: 'test-udid', name: 'iPhone Test', state: 'Booted', isAvailable: true }] } }));
if (args.includes('install') && process.env.SIM_CASE === 'install-failure') process.exit(2);
if (args.includes('get_app_container')) {
 const container = args.includes('dev.kineticron.simulator-capture.xctrunner') ? path.join(dir, 'capture-runner') : dir;
 fs.mkdirSync(container, { recursive: true }); console.log(container);
}
if (args.includes('screenshot')) {
 const dest = args.at(-1);
 if (fs.existsSync(dest + '.source')) { fs.copyFileSync(path.join(dir, fs.readFileSync(dest + '.source', 'utf8')), dest); return; }
 if (dest.includes('restored-portrait') && process.env.SIM_CASE === 'portrait-noop') { fs.copyFileSync(path.join(dir, 'landscape.png'), dest); return; }
 if (dest.includes('initial-portrait') && process.env.SIM_CASE === 'initial-landscape') { fs.copyFileSync(path.join(dir, 'landscape.png'), dest); return; }
 if (process.env.SIM_CASE === 'unstable') {
  const counter = dest + '.count';
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(count + 1));
  fs.copyFileSync(path.join(dir, count % 2 ? 'blank.png' : 'portrait.png'), dest); return;
 }
 fs.copyFileSync(path.join(dir, process.env.SIM_CASE === 'blank' ? 'blank.png' : dest.includes('stage_7') && !['rotation-noop', 'native-framebuffer'].includes(process.env.SIM_CASE) ? 'landscape.png' : 'portrait.png'), dest);
}
if (args.includes('screenshot') && args.at(-1).includes('stage_') && process.env.SIM_CASE === 'png-timeout') { console.log('PNG written before timeout'); console.error('screenshot still running'); setInterval(() => {}, 1000); return; }
if (args.includes('stream')) {
 if (!args.includes('--level') || args[args.indexOf('--level') + 1] !== 'debug' || args[args.indexOf('--predicate') + 1] !== 'process == "KineSync"') process.exit(98);
 if (process.env.SIM_CASE === 'stream-eof-banner') { process.stdout.write('Filtering the log data using process == KineSync', () => process.exit(0)); return; }
 if (process.env.SIM_CASE === 'stream-exit') { console.error('unified subscription failed'); process.exit(2); }
 if (process.env.SIM_CASE === 'stream-not-ready') { setInterval(() => {}, 1000); return; }
 // Split the banner to exercise streaming line framing before launch.
 const banner = process.env.SIM_CASE === 'stderr-banner' ? process.stderr : process.stdout;
 banner.write('Filtering the log ');
 setTimeout(() => { fs.writeFileSync(path.join(dir, 'stream-ready'), '1'); banner.write('data using "process == KineSync"\\n'); }, process.env.SIM_CASE === 'unified-log-slow-ready' ? 1400 : 100);
 const timer = setInterval(() => {
  if (!fs.existsSync(path.join(dir, 'launched'))) return;
  clearInterval(timer);
  if (process.env.SIM_CASE === 'stream-dies') process.exit(2);
  if (process.env.SIM_CASE === 'stalled-startup') return;
  if (process.env.SIM_CASE === 'stalled-scenario') { console.log('[KINESYNC_SIM] INIT_READY'); console.log('[KINESYNC_SIM] SCENARIO_START token=run'); console.log('[KINESYNC_SIM] STAGE_BEGIN stage_1_launch timestamp=1'); return; }
  if (['early-exit', 'signal'].includes(process.env.SIM_CASE)) return;
  const logs = ${JSON.stringify(runLogs)}.filter(line => process.env.SIM_CASE !== 'missing-init' || !line.includes('INIT_READY')).map(line => process.env.SIM_CASE === 'bad-token' ? line.replace('token=run_stage_1_launch', 'token=invalid') : line).map(line => process.env.SIM_CASE === 'stale-run' ? line.replace('token=run_stage_1_launch', 'token=old_stage_1_launch') : line).map(line => process.env.SIM_CASE === 'stale-request' ? line.replace('READY_FOR_SCREENSHOT stage=stage_1_launch token=run_stage_1_launch', 'READY_FOR_SCREENSHOT stage=stage_2_playback token=run_stage_2_playback') : line).map(line => process.env.SIM_CASE === 'rotation-stale' && line.includes('TRIGGER_SIMULATOR_ROTATION') ? line.replace('token=run_', 'token=old_') : line).filter(line => process.env.SIM_CASE !== 'restore-missing' || !line.includes('READY_FOR_PORTRAIT_RESTORE')).map(line => process.env.SIM_CASE === 'restore-stale' ? line.replace('token=run_stage_7_restore', 'token=old_stage_7_restore') : process.env.SIM_CASE === 'restore-early' && line.includes('orientation=portrait style=spicy') ? line.replace('orientation=portrait', 'orientation=landscape') : line).map(line => '2026-11-01 00:00:00.000 Info KineSync[123:456] [com.facebook.react.log:javascript] ' + line).join('\\n') + '\\n';
  // Chunk boundary inside a protocol marker must not drop or duplicate it.
  const split = logs.indexOf('[KINESYNC_SIM]') + 6;
  if (process.env.SIM_CASE === 'console-duplicate') process.stderr.write(logs.trimEnd());
  process.stdout.write(logs.slice(0, split));
  setTimeout(() => {
   if (process.env.SIM_CASE === 'unterminated-complete') { process.stdout.write(logs.slice(split).trimEnd(), () => process.exit(0)); }
   else process.stdout.write(logs.slice(split));
  }, 10);
 }, 10);
 setInterval(() => {}, 1000);
}
if (args.includes('launch')) {
 if (!fs.existsSync(path.join(dir, 'stream-ready'))) process.exit(97);
 fs.writeFileSync(path.join(dir, 'launched'), '1');
 if (process.env.SIM_CASE === 'signal') { process.kill(process.ppid, 'SIGTERM'); setInterval(() => {}, 1000); return; }
 if (process.env.SIM_CASE === 'early-exit') process.exit(1);
 if (process.env.SIM_CASE === 'console-duplicate') {
  console.log('ordinary launch stdout');
  console.error('ordinary launch stderr');
  console.log(${JSON.stringify(runLogs.join('\n'))});
 }
 // Release launch may emit no protocol at all. Keep attached until cleanup.
 setInterval(() => {}, 1000);
}
`;
  for (const name of ['xcrun', 'xcodebuild', 'node']) {
    // Node resolves extensionless executable shims as CommonJS.
    fs.writeFileSync(path.join(dir, name), shim.replace("import fs from 'node:fs';", "const fs = require('node:fs');").replace("import path from 'node:path';", "const path = require('node:path');"), { mode: 0o755 });
  }
  for (const scenario of (process.env.SIM_TEST_CASES?.split(',') || ['native-framebuffer', 'pass', 'unified-log-slow-ready', 'rotation-stale', 'restore-stale', 'restore-early', 'restore-missing', 'native-portrait-output', 'unterminated-complete', 'console-duplicate', 'stderr-banner', 'png-timeout', 'missing-init', 'bad-token', 'stale-run', 'stale-request', 'blank', 'unstable', 'capture-failure', 'early-exit', 'rotation-failure', 'rotation-noop', 'portrait-noop', 'rotation-rejected', 'rotation-hang', 'initial-landscape', 'stalled-startup', 'stalled-scenario', 'signal', 'install-failure', 'stream-exit', 'stream-eof-banner', 'stream-not-ready', 'stream-dies'])) {
    console.log(`Runner CLI scenario: ${scenario}`);
    for (const file of ['launched', 'stream-ready', 'Library/Caches/kinesync_sim_ack_stage_7_restore.json', ...Array.from({ length: 7 }, (_, i) => `Library/Caches/kinesync_sim_ack_${['stage_1_launch', 'stage_2_playback', 'stage_3_seek', 'stage_4_switch_amll', 'stage_5_skip_song', 'stage_6_switch_spicy', 'stage_7_rotation'][i]}.json`)]) fs.rmSync(path.join(dir, file), { force: true });
    const output = path.join(dir, scenario);
    const shouldPass = ['unstable', 'native-framebuffer', 'pass', 'unified-log-slow-ready', 'unterminated-complete', 'console-duplicate', 'stderr-banner'].includes(scenario);
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(__dirname, 'run-ios-simulator-test.mjs'), '--app-path', '/mock.app', '--output-dir', output, '--startup-seconds', ['stalled-startup', 'stream-not-ready'].includes(scenario) ? '3' : '20', '--preflight-seconds', scenario === 'rotation-hang' ? '3' : '20', '--readiness-seconds', ['stalled-startup', 'stream-not-ready'].includes(scenario) ? '3' : scenario === 'unified-log-slow-ready' ? '2' : '20', '--stage-seconds', scenario === 'stalled-scenario' ? '1' : scenario === 'png-timeout' ? '3' : '15', '--timeout-minutes', '1'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, SIM_CASE: scenario, DEVELOPER_DIR: developer } });
    assert.equal(result.status, shouldPass ? 0 : 1, `${scenario}: ${result.stdout} ${result.stderr}`);
    if (!['rotation-hang', 'rotation-rejected', 'initial-landscape', 'signal', 'install-failure', 'stream-exit', 'stream-eof-banner', 'stream-not-ready'].includes(scenario)) assert.ok(fs.readFileSync(path.join(output, 'simulator-summary.md'), 'utf8').includes(`Status: ${shouldPass ? 'PASSED' : 'FAILED'}`));
    if (scenario === 'stale-request') {
      assert.ok(!fs.existsSync(path.join(output, 'stage_2_playback.png')), 'Stale request cannot start a capture');
      assert.ok(!fs.existsSync(path.join(dir, 'Library/Caches/kinesync_sim_ack_stage_2_playback.json')), 'Stale request cannot write an ACK');
    }
    if (scenario === 'capture-failure') {
      const request = JSON.parse(fs.readFileSync(path.join(dir, 'failed-capture-request.json')));
      assert.equal(request.stage, 'stage_1_launch');
      assert.equal(request.token, 'run_stage_1_launch');
      const ledger = fs.readFileSync(path.join(output, 'native-captures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(ledger.some(record => record.id === request.id && record.error === 'Native capture runner exited'));
      assert.match(JSON.parse(fs.readFileSync(path.join(output, 'runner-state.json'))).error, /Native capture runner exited/);
      assert.ok(!fs.existsSync(path.join(output, 'stage_1_launch.png')));
      assert.ok(!fs.existsSync(path.join(dir, 'Library/Caches/kinesync_sim_ack_stage_1_launch.json')), 'Failed native request must never be acknowledged');
    }
    if (scenario === 'png-timeout') {
      assert.ok(!fs.existsSync(path.join(output, 'stage_1_launch.png')), 'Unanswered native request cannot publish a capture');
      const ledger = fs.readFileSync(path.join(output, 'native-captures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(ledger.some(r => /timeout/.test(r.error) && fs.existsSync(r.rejectedPNG)), 'A native PNG written before timeout must survive as rejected evidence and never count as success');
      assert.ok(!fs.existsSync(path.join(dir, 'Library/Caches/kinesync_sim_ack_stage_1_launch.json')), 'Timed-out PNG must not be acknowledged');
    }
    if (shouldPass) {
      assert.equal(fs.readdirSync(output).filter(name => name.endsWith('.png')).length, 7);
      assert.ok(fs.existsSync(path.join(output, 'diagnostics/initial-portrait.png')));
      assert.ok(fs.existsSync(path.join(output, 'diagnostics/restored-portrait.png')));
      const rotationEvidence = fs.readFileSync(path.join(output, 'rotation-commands.jsonl'), 'utf8');
      assert.ok(rotationEvidence.includes('0.13.0'));
      assert.ok(rotationEvidence.includes('native optional-symbol warning'));
      const raw = fs.readFileSync(path.join(output, 'simulator-raw-log.txt'), 'utf8');
      assert.equal(raw.split('[KINESYNC_SIM] SCENARIO_START').length - 1, 1, 'Canonical stream must not merge launch-console duplicates');
      assert.ok(raw.includes('[com.facebook.react.log:javascript]'));
      if (scenario === 'console-duplicate') {
        const launch = fs.readFileSync(path.join(output, 'launch-console.log'), 'utf8');
        for (const message of ['ordinary launch stdout', 'ordinary launch stderr', '[KINESYNC_SIM] SCENARIO_START']) assert.ok(launch.includes(message), 'Launch diagnostics must be retained');
        assert.equal(fs.readFileSync(path.join(output, 'device-stream.log'), 'utf8').split('[KINESYNC_SIM] SCENARIO_START').length - 1, 2, 'stderr mirror must be retained as evidence but ignored as protocol');
      }
      if (scenario === 'pass') assert.equal(fs.readFileSync(path.join(output, 'launch-console.log'), 'utf8'), '', 'Silent Release launch must still pass');
      if (scenario === 'unified-log-slow-ready') {
        const startupLog = fs.readFileSync(path.join(output, 'startup-commands.jsonl'), 'utf8');
        assert.ok(startupLog.includes('startup:native-capture-build'));
        assert.ok(fs.existsSync(path.join(output, 'native-capture-ready.json')));
      }
    } else {
      const state = JSON.parse(fs.readFileSync(path.join(output, 'runner-state.json'), 'utf8'));
      assert.ok(state.error);
      for (const name of ['failure-screenshot.log', 'device-log.txt', 'metro-status.txt']) assert.ok(fs.existsSync(path.join(output, name)), `${scenario}: ${name}`);
      const screenshotLog = fs.readFileSync(path.join(output, 'failure-screenshot.log'), 'utf8');
      assert.ok(fs.existsSync(path.join(output, 'diagnostics/failure.png')) || /Command failed|Command exited|ETIMEDOUT|SIGKILL|Evidence deadline exhausted/.test(screenshotLog), `${scenario}: missing screenshot without capture failure evidence: ${screenshotLog}`);
      if (scenario === 'stalled-startup') assert.match(state.error, /Startup timeout/);
      if (scenario === 'stalled-scenario') assert.match(state.error, /Scenario stage timeout/);
      if (scenario === 'rotation-hang') { assert.ok(Date.now() - started < 25000); assert.ok(fs.readFileSync(path.join(output, 'rotation-commands.jsonl'), 'utf8').includes('error')); }
      if (scenario === 'rotation-failure') {
        assert.ok(fs.readFileSync(path.join(output, 'rotation-native-stdout.log'), 'utf8').includes('native stdout before failure'));
        assert.ok(fs.readdirSync(output).filter(n => n.endsWith('-stderr.log')).some(n => fs.readFileSync(path.join(output, n), 'utf8').includes('native stderr before failure')));
      }
      if (scenario === 'initial-landscape') assert.match(state.error, /Initial native portrait/);
      if (scenario === 'signal') assert.match(state.error, /SIGTERM/);
      if (['stream-exit', 'stream-eof-banner', 'stream-dies'].includes(scenario)) assert.match(state.error, /Unified log stream exited/);
      if (scenario === 'stream-exit') assert.ok(fs.readFileSync(path.join(output, 'device-stream.log'), 'utf8').includes('unified subscription failed'), 'Stream failure stderr must survive startup failure');
      if (['stream-exit', 'stream-eof-banner', 'stream-not-ready'].includes(scenario)) {
        assert.equal(state.stage, 'startup:unified-log-readiness');
        assert.ok(!fs.existsSync(path.join(dir, 'launched')), 'Readiness failure must prevent app launch');
      }
      if (scenario === 'stream-not-ready') {
        assert.match(state.error, /Startup timeout/);
        assert.ok(Date.now() - started < 20000, 'Readiness rejection plus bounded failure evidence must finish promptly');
      }
    }
  }
}

function testComparisonCli() {
  const branch = path.join(tempDir, 'cli-branch'), baseline = path.join(tempDir, 'cli-baseline');
  fs.mkdirSync(branch, { recursive: true }); fs.mkdirSync(baseline, { recursive: true });
  const names = ['stage_1_launch', 'stage_2_playback', 'stage_3_seek', 'stage_4_switch_amll', 'stage_5_skip_song', 'stage_6_switch_spicy', 'stage_7_rotation'].map(s => `${s}.png`);
  const img = createTextMockPng(100, 200);
  const validRun = path.join(tempDir, 'runner-cli', (process.env.SIM_TEST_CASES?.split(',') || ['pass'])[0]);
  const reset = () => { for (const dir of [branch, baseline]) { fs.rmSync(dir, { recursive: true }); fs.mkdirSync(dir); for (const name of names) fs.writeFileSync(path.join(dir, name), name.includes('stage_7') ? createTextMockPng(200, 100) : img);
    for (const file of ['simulator-perf.json', 'simulator-raw-log.txt', 'native-captures.jsonl', 'diagnostics/restored-portrait.png']) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.copyFileSync(path.join(validRun, file), path.join(dir, file)); } fs.cpSync(path.join(validRun, 'originals'), path.join(dir, 'originals'), { recursive: true }); } };
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'compare-simulator-screenshots.mjs'), '--branch-dir', branch, '--baseline-dir', baseline, ...args], { encoding: 'utf8' });
  reset();
  const nonceFile = path.join(branch, 'native-captures.jsonl');
  const fresh = fs.readFileSync(nonceFile, 'utf8').trim().split('\n').map(JSON.parse);
  const uuid = index => `12345678-1234-4234-8234-${index.toString(16).padStart(12, '0')}`;
  fresh.forEach((capture, index) => {
    capture.id = capture.before.id = uuid(index * 2 + 10);
    capture.after.id = uuid(index * 2 + 11);
  });
  const writeNonces = captures => fs.writeFileSync(nonceFile, captures.map(c => JSON.stringify(c)).join('\n') + '\n');
  writeNonces(fresh);
  assert.deepEqual(validateRunArtifacts(branch), [], 'All fresh UUID phases including restore must pass');
  const setBefore = (capture, id) => { capture.id = capture.before.id = id; };
  for (const [name, mutate] of [
    ['non-UUID post', captures => { captures[0].after.id = 'reused-after-nonce'; }],
    ['non-UUID before alias', captures => setBefore(captures[0], 'not-a-uuid')],
    ['duplicate post-post', captures => { captures[1].after.id = captures[0].after.id; }],
    ['duplicate before-before', captures => setBefore(captures[1], captures[0].id)],
    ['previous post reused as before', captures => setBefore(captures[1], captures[0].after.id)],
    ['previous before reused as post', captures => { captures[1].after.id = captures[0].id; }],
    ['future before reused as post', captures => { captures[0].after.id = captures[1].id; }],
    ['case-insensitive collision', captures => { captures[1].after.id = captures[0].after.id.toUpperCase(); }],
    ['restore post collision', captures => { captures.find(c => c.stage === 'stage_7_restore').after.id = captures[0].after.id; }],
  ]) {
    const captures = structuredClone(fresh); mutate(captures); writeNonces(captures);
    assert.ok(validateRunArtifacts(branch).some(failure => /nonce/.test(failure)), `Must reject ${name}`);
  }
  const brokenAlias = structuredClone(fresh); brokenAlias[0].before.id = 'not-a-uuid'; writeNonces(brokenAlias);
  assert.ok(validateRunArtifacts(branch).some(failure => /attestations/.test(failure)), 'Before ID must alias capture ID');
  console.log('Delivered nonce UUID format, alias, global phase uniqueness and restoration regressions passed.');
  reset(); assert.equal(run().status, 0);
  const changed = PNG.sync.read(img); changed.data[0] = 255;
  const changedBytes = PNG.sync.write(changed);
  fs.writeFileSync(path.join(branch, names[0]), changedBytes);
  const ledgerFile = path.join(branch, 'native-captures.jsonl');
  const ledger = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map(JSON.parse);
  const changedRecord = ledger.filter(r => r.stage === 'stage_1_launch').at(-1);
  changedRecord.sha256 = createHash('sha256').update(changedBytes).digest('hex');
  fs.writeFileSync(path.join(branch, changedRecord.originalFile), changedBytes);
  changedRecord.review = reviewPNG(changedBytes, 'portrait').conversion;
  fs.writeFileSync(ledgerFile, ledger.map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(run().status, 0, 'Differing valid screenshot artifacts pass without a visual verdict');
  assert.equal(run('--max-difference-ratio', '0.001').status, 0, 'Explicit threshold permits a bounded difference');
  for (const mutate of [
    () => fs.unlinkSync(path.join(baseline, 'simulator-perf.json')),
    () => fs.rmSync(path.join(branch, 'originals'), { recursive: true }),
    ...[
      records => { records[0].review.outputSHA256 = 'tampered'; },
      records => { records[0].sha256 = 'tampered'; },
      records => { records[0].before.foreground = 'false'; },
      records => { records[0].after.deviceOrientation = 'landscape'; },
      records => { records[6].after.windowWidth = '100'; records[6].after.windowHeight = '200'; },
      records => { records.find(r => r.stage === 'stage_7_restore').orientation = 'landscape'; },
    ].map(mutate => () => { const file = path.join(branch, 'native-captures.jsonl'); const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse); mutate(records); fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n')); }),
    () => { const file = path.join(branch, 'native-captures.jsonl'); const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse); delete records[0].review; fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n')); },
    () => fs.unlinkSync(path.join(branch, 'simulator-raw-log.txt')),
    () => fs.unlinkSync(path.join(branch, 'native-captures.jsonl')),
    () => fs.unlinkSync(path.join(branch, 'diagnostics/restored-portrait.png')),
    () => fs.writeFileSync(path.join(branch, names[6]), img),
    () => fs.unlinkSync(path.join(baseline, names[0])),
    () => fs.unlinkSync(path.join(branch, names[0])),
    () => fs.writeFileSync(path.join(baseline, names[0]), createSolidPng(100, 200, 0, 0, 0)),
    () => fs.writeFileSync(path.join(branch, names[0]), createSolidPng(100, 200, 0, 0, 0)),
    () => fs.writeFileSync(path.join(baseline, names[0]), 'corrupt'),
    () => fs.writeFileSync(path.join(branch, names[0]), 'corrupt'),
    () => fs.writeFileSync(path.join(baseline, names[0]), createTextMockPng(120, 200)),
    () => fs.writeFileSync(path.join(baseline, 'extra.png'), img),
  ]) { reset(); mutate(); assert.equal(run().status, 1); }
  // Mutate delivered files and refresh their declared hash to isolate shape/EXIF integrity.
  const withExif = (bytes, tag) => {
    const tiff = Buffer.alloc(26); tiff.write('MM'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(tag, 18);
    const chunk = Buffer.alloc(38); chunk.writeUInt32BE(26); chunk.write('eXIf', 4); tiff.copy(chunk, 8);
    chunk.writeInt32BE(CrcCalculator.crc32(chunk.subarray(4, -4)), 34);
    return Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]);
  };
  for (const [stage, file, mutation] of [
    ['stage_1_launch', names[0], 'reshape'],
    ['stage_7_rotation', names[6], 'reshape'],
    ['stage_7_restore', 'diagnostics/restored-portrait.png', 'reshape'],
    ['stage_1_launch', names[0], 'add-exif-1'],
    ['stage_7_rotation', names[6], 'add-exif-8'],
    ['stage_7_restore', 'diagnostics/restored-portrait.png', 'remove-exif'],
  ]) {
    reset();
    const records = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map(JSON.parse);
    const record = records.find(r => r.stage === stage);
    const delivered = path.join(branch, file);
    const nativeFile = path.join(branch, record.originalFile);
    if (mutation === 'remove-exif') {
      const tagged = withExif(fs.readFileSync(nativeFile), 1);
      fs.writeFileSync(nativeFile, tagged); fs.writeFileSync(delivered, tagged);
      record.sha256 = createHash('sha256').update(tagged).digest('hex'); record.exifOrientation = 1;
      record.review = reviewPNG(tagged, record.orientation).conversion;
    }
    const writeRecords = () => fs.writeFileSync(ledgerFile, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    writeRecords();
    assert.deepEqual(validateRunArtifacts(branch), [], `Valid initial fixture: ${stage}/${mutation}`);
    assert.equal(run().status, 0);
    const original = fs.readFileSync(nativeFile), before = PNG.sync.read(fs.readFileSync(delivered));
    let altered;
    if (mutation === 'reshape') {
      const width = before.width > before.height ? 250 : 80, height = before.width > before.height ? 80 : 250;
      altered = PNG.sync.write({ width, height, data: before.data });
      assert.notEqual(width, before.width); assert.notEqual(height, before.height);
    } else if (mutation === 'remove-exif') altered = PNG.sync.write(before);
    else altered = withExif(fs.readFileSync(delivered), mutation.endsWith('1') ? 1 : 8);
    const after = PNG.sync.read(altered);
    assert.deepEqual(after.data, before.data, 'Decoded RGBA equality alone is insufficient');
    assert.equal(after.width > after.height, before.width > before.height, 'Broad orientation classification stays identical');
    fs.writeFileSync(delivered, altered);
    record.review.outputSHA256 = createHash('sha256').update(altered).digest('hex'); writeRecords();
    assert.deepEqual(fs.readFileSync(nativeFile), original, 'Native original stays untouched by delivered mutation');
    assert.ok(validateRunArtifacts(branch).some(f => /native\/review conversion/.test(f)), `Reject delivered ${stage}/${mutation}`);
    assert.equal(run().status, 1, `CLI rejects delivered ${stage}/${mutation}`);
  }
  console.log('Delivered reshape and added/removed EXIF conversion-integrity regressions passed.');
  reset(); assert.equal(run('--max-difference-ratio', 'NaN').status, 0, 'Obsolete visual threshold cannot gate delivery');
  assert.equal(run('--max-difference-ratio', '-1').status, 0);
}

function cleanTemp() {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

try {
  await import('./test-simulator-budgets.mjs');
  testLogParser();
  testAdversarialLogParser();
  testScreenshotAnalysis();
  testScreenshotComparison();
  testComparisonCli();
  await testSimulatorProtocol();
  cleanTemp();
  console.log('\nAll simulator harness tests PASSED.');
} catch (err) {
  console.error(`Retained failing fixtures: ${tempDir}`);
  console.error(`Test failure: ${err.stack}`);
  process.exit(1);
}
