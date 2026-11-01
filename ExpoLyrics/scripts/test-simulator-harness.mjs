// Unit and integration tests for simulator test harness components
// Validates clock monotonicity, log parser assertions, adversarial log detection, and screenshot comparison

import assert from 'node:assert';
import { Buffer } from 'node:buffer';
import { testSimulatorProtocol } from './test-simulator-protocol.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { SimulatorLogParser } from './parse-simulator-logs.mjs';
import { analyzeScreenshotContent, compareScreenshots } from './compare-simulator-screenshots.mjs';
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
    '[KINESYNC_SIM] TRIGGER_SIMULATOR_ROTATION orientation=landscape',
    '[KINESYNC_SIM] VIEWPORT_LAYOUT width=844 height=390 windowWidth=844 windowHeight=390 orientation=landscape style=spicy',
    '[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_7_rotation style=spicy track=spotify-connect:sim_seesaw_track positionMs=5000 orientation=landscape width=844 height=390',
    '[KINESYNC_SIM] TRIGGER_SIMULATOR_ROTATION orientation=portrait',
    '[KINESYNC_SIM] VIEWPORT_LAYOUT width=390 height=844 windowWidth=390 windowHeight=844 orientation=portrait style=spicy',
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
    assert.ok(failures.some((f) => f.includes('heartbeat')), 'Must fail if heartbeat metrics are missing');
  }

  // Case 4: Zero samples in heartbeat
  {
    const parser = new SimulatorLogParser();
    parser.processLine('[KINESYNC_SIM] HEARTBEAT_METRICS {"samples":0}');
    const failures = parser.validateAssertions();
    assert.ok(failures.some((f) => f.includes('heartbeat')), 'Must fail if heartbeat has 0 samples');
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
  const runLogs = logs.map(line => line.includes('SCENARIO_COMPLETE') ? `[KINESYNC_SIM] SCENARIO_COMPLETE ${summary}` : line.replace(/READY_FOR_SCREENSHOT stage=(\w+)/, 'READY_FOR_SCREENSHOT stage=$1 token=run_$1'));
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
if (name === 'xcodebuild') { if (args.includes('-version')) console.log('Xcode 26.6'); process.exit(0); }
if (name !== 'xcrun') process.exit(0);
if (args.includes('--show-sdk-version')) console.log('26.5');
if (args.includes('--show-sdk-path')) console.log(process.env.DEVELOPER_DIR + '/Platforms/iPhoneSimulator.platform/SDKs/iPhoneSimulator26.5.sdk');
if (args.includes('runtimes')) console.log(JSON.stringify({ runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', isAvailable: true }] }));
else if (args.includes('list')) console.log(JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ udid: 'test-udid', name: 'iPhone Test', state: 'Booted', isAvailable: true }] } }));
if (args.includes('install') && process.env.SIM_CASE === 'install-failure') process.exit(2);
if (args.includes('get_app_container')) console.log(dir);
if (args.includes('screenshot')) {
 const dest = args.at(-1);
 if (process.env.SIM_CASE === 'capture-failure' && dest.endsWith('failure.png')) process.exit(2);
 if (dest.includes('restored-portrait') && process.env.SIM_CASE === 'portrait-noop') { fs.copyFileSync(path.join(dir, 'landscape.png'), dest); return; }
 if (dest.includes('initial-portrait') && process.env.SIM_CASE === 'initial-landscape') { fs.copyFileSync(path.join(dir, 'landscape.png'), dest); return; }
 if (process.env.SIM_CASE === 'unstable') {
  const counter = dest + '.count';
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(count + 1));
  fs.copyFileSync(path.join(dir, count % 2 ? 'blank.png' : 'portrait.png'), dest); return;
 }
 fs.copyFileSync(path.join(dir, process.env.SIM_CASE === 'blank' ? 'blank.png' : dest.includes('stage_7') && process.env.SIM_CASE !== 'rotation-noop' ? 'landscape.png' : 'portrait.png'), dest);
}
if (args.includes('stream')) {
 if (!args.includes('--level') || args[args.indexOf('--level') + 1] !== 'debug' || args[args.indexOf('--predicate') + 1] !== 'process == "KineSync"') process.exit(98);
 if (process.env.SIM_CASE === 'stream-eof-banner') { process.stdout.write('Filtering the log data using process == KineSync', () => process.exit(0)); return; }
 if (process.env.SIM_CASE === 'stream-exit') { console.error('unified subscription failed'); process.exit(2); }
 if (process.env.SIM_CASE === 'stream-not-ready') { setInterval(() => {}, 1000); return; }
 // Split the banner to exercise streaming line framing before launch.
 const banner = process.env.SIM_CASE === 'stderr-banner' ? process.stderr : process.stdout;
 banner.write('Filtering the log ');
 setTimeout(() => { fs.writeFileSync(path.join(dir, 'stream-ready'), '1'); banner.write('data using "process == KineSync"\\n'); }, 100);
 const timer = setInterval(() => {
  if (!fs.existsSync(path.join(dir, 'launched'))) return;
  clearInterval(timer);
  if (process.env.SIM_CASE === 'stream-dies') process.exit(2);
  if (process.env.SIM_CASE === 'stalled-startup') return;
  if (process.env.SIM_CASE === 'stalled-scenario') { console.log('[KINESYNC_SIM] STAGE_BEGIN stage_1_launch timestamp=1'); return; }
  if (['early-exit', 'capture-failure', 'signal'].includes(process.env.SIM_CASE)) return;
  const logs = ${JSON.stringify(runLogs)}.map(line => '2026-11-01 00:00:00.000 Info KineSync[123:456] [com.facebook.react.log:javascript] ' + line).join('\\n') + '\\n';
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
 if (['early-exit', 'capture-failure'].includes(process.env.SIM_CASE)) process.exit(1);
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
  for (const scenario of ['pass', 'unterminated-complete', 'console-duplicate', 'stderr-banner', 'blank', 'unstable', 'capture-failure', 'early-exit', 'rotation-failure', 'rotation-noop', 'portrait-noop', 'rotation-rejected', 'rotation-hang', 'initial-landscape', 'stalled-startup', 'stalled-scenario', 'signal', 'install-failure', 'stream-exit', 'stream-eof-banner', 'stream-not-ready', 'stream-dies']) {
    for (const file of ['launched', 'stream-ready']) fs.rmSync(path.join(dir, file), { force: true });
    const output = path.join(dir, scenario);
    const shouldPass = ['pass', 'unterminated-complete', 'console-duplicate', 'stderr-banner'].includes(scenario);
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(__dirname, 'run-ios-simulator-test.mjs'), '--app-path', '/mock.app', '--output-dir', output, '--startup-seconds', ['stalled-startup', 'stream-not-ready'].includes(scenario) ? '3' : '20', '--stage-seconds', scenario === 'stalled-scenario' ? '1' : '15', '--timeout-minutes', '1'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, SIM_CASE: scenario, DEVELOPER_DIR: developer } });
    assert.equal(result.status, shouldPass ? 0 : 1, `${scenario}: ${result.stdout} ${result.stderr}`);
    if (!['rotation-hang', 'rotation-rejected', 'initial-landscape', 'signal', 'install-failure', 'stream-exit', 'stream-eof-banner', 'stream-not-ready'].includes(scenario)) assert.ok(fs.readFileSync(path.join(output, 'simulator-summary.md'), 'utf8').includes(`Status: ${shouldPass ? 'PASSED' : 'FAILED'}`));
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
    } else {
      const state = JSON.parse(fs.readFileSync(path.join(output, 'runner-state.json'), 'utf8'));
      assert.ok(state.error);
      for (const name of ['failure-screenshot.log', 'device-log.txt', 'metro-status.txt']) assert.ok(fs.existsSync(path.join(output, name)), `${scenario}: ${name}`);
      const screenshotLog = fs.readFileSync(path.join(output, 'failure-screenshot.log'), 'utf8');
      assert.ok(fs.existsSync(path.join(output, 'failure.png')) || /Command failed|ETIMEDOUT|SIGKILL/.test(screenshotLog), `${scenario}: missing screenshot without capture failure evidence: ${screenshotLog}`);
      if (scenario === 'stalled-startup') assert.match(state.error, /Startup timeout/);
      if (scenario === 'stalled-scenario') assert.match(state.error, /Scenario stage timeout/);
      if (scenario === 'rotation-hang') { assert.ok(Date.now() - started < 25000); assert.ok(fs.readFileSync(path.join(output, 'rotation-commands.jsonl'), 'utf8').includes('error')); }
      if (scenario === 'rotation-failure') {
        assert.ok(fs.readFileSync(path.join(output, 'rotation-native-stdout.log'), 'utf8').includes('native stdout before failure'));
        assert.ok(fs.readFileSync(path.join(output, 'rotation-native-stderr.log'), 'utf8').includes('native stderr before failure'));
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
  const reset = () => { for (const dir of [branch, baseline]) { fs.rmSync(dir, { recursive: true }); fs.mkdirSync(dir); for (const name of names) fs.writeFileSync(path.join(dir, name), img); } };
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'compare-simulator-screenshots.mjs'), '--branch-dir', branch, '--baseline-dir', baseline, ...args], { encoding: 'utf8' });
  reset(); assert.equal(run().status, 0);
  const changed = PNG.sync.read(img); changed.data[0] = 255;
  fs.writeFileSync(path.join(branch, names[0]), PNG.sync.write(changed));
  assert.equal(run().status, 1, 'One differing pixel fails strict default');
  assert.equal(run('--max-difference-ratio', '0.001').status, 0, 'Explicit threshold permits a bounded difference');
  for (const mutate of [
    () => fs.unlinkSync(path.join(baseline, names[0])),
    () => fs.unlinkSync(path.join(branch, names[0])),
    () => fs.writeFileSync(path.join(baseline, names[0]), createSolidPng(100, 200, 0, 0, 0)),
    () => fs.writeFileSync(path.join(branch, names[0]), createSolidPng(100, 200, 0, 0, 0)),
    () => fs.writeFileSync(path.join(baseline, names[0]), 'corrupt'),
    () => fs.writeFileSync(path.join(branch, names[0]), 'corrupt'),
    () => fs.writeFileSync(path.join(baseline, names[0]), createTextMockPng(120, 200)),
    () => fs.writeFileSync(path.join(baseline, 'extra.png'), img),
  ]) { reset(); mutate(); assert.equal(run().status, 1); }
  reset(); assert.equal(run('--max-difference-ratio', 'NaN').status, 1);
  assert.equal(run('--max-difference-ratio', '-1').status, 1);
}

function cleanTemp() {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

try {
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
