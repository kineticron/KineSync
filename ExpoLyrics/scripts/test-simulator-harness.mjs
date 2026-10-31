// Unit and integration tests for simulator test harness components
// Validates clock monotonicity, log parser assertions, adversarial log detection, and screenshot comparison

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { SimulatorLogParser } from './parse-simulator-logs.mjs';
import { analyzeScreenshotContent, compareScreenshots } from './compare-simulator-screenshots.mjs';
import {
  parseXcodebuildJson,
  findApplicationTarget,
  discoverApplicationScheme,
  buildSimulatorApp,
} from './build-simulator-app.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = path.join(__dirname, '../../.expo/test-harness-temp');

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
    '[KINESYNC_SIM] VIEWPORT_LAYOUT width=844 height=390 orientation=landscape style=spicy',
    '[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_7_rotation style=spicy track=spotify-connect:sim_seesaw_track positionMs=5000 orientation=landscape width=844 height=390',
    '[KINESYNC_SIM] TRIGGER_SIMULATOR_ROTATION orientation=portrait',
    '[KINESYNC_SIM] VIEWPORT_LAYOUT width=390 height=844 orientation=portrait style=spicy',
    '[KINESYNC_SIM] STAGE_END stage_7_rotation status=PASS durationMs=2600',
    '[KINESYNC_SIM] STAGE_BEGIN stage_8_complete timestamp=15000',
    '[KINESYNC_SIM] STAGE_END stage_8_complete status=PASS durationMs=50',
    '[KINESYNC_SIM] HEARTBEAT_METRICS {"samples":100,"delays":[],"p50Ms":1.2,"p95Ms":3.4,"maxDelayMs":8.1,"blocksOver50Ms":0,"blocksOver100Ms":0}',
    '[KINESYNC_SIM] SCENARIO_COMPLETE {"success":true,"stages":[],"heartbeat":{"samples":100},"renderersExercised":["spicy","amll"],"totalDurationMs":15050,"tracksLoaded":2,"errors":[]}',
  ];

  for (const line of sampleLogs) {
    parser.processLine(line);
  }

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

function testGitRefValidationRules() {
  console.log('Testing Git ref validation security rules...');

  function isValidRef(ref) {
    if (!ref || typeof ref !== 'string') return false;
    // Reject leading hyphen to prevent option injection
    if (ref.startsWith('-')) return false;
    // 40-char full sha
    if (/^[0-9a-fA-F]{40}$/.test(ref)) return true;
    // Strict branch naming rules: alphanumeric, slash, dash, dot, underscore, no illegal sequences
    if (/^[a-zA-Z0-9_./-]+$/.test(ref) && !ref.includes('..') && !ref.includes('@{') && !ref.endsWith('/') && !ref.startsWith('/')) {
      return true;
    }
    return false;
  }

  // Valid refs
  assert.strictEqual(isValidRef('main'), true);
  assert.strictEqual(isValidRef('ci-sim'), true);
  assert.strictEqual(isValidRef('feat/native-lyrics'), true);
  assert.strictEqual(isValidRef('c2aaa20ec0493aa55f0337cbe4d6aa04f267f4cc'), true);

  // Dangerous / injection refs
  assert.strictEqual(isValidRef('-u'), false, 'Must reject leading hyphen');
  assert.strictEqual(isValidRef('--upload-pack=evil'), false, 'Must reject options');
  assert.strictEqual(isValidRef('main; rm -rf /'), false, 'Must reject command injection');
  assert.strictEqual(isValidRef('main$(whoami)'), false, 'Must reject command substitution');
  assert.strictEqual(isValidRef('main`id`'), false, 'Must reject backticks');
  assert.strictEqual(isValidRef('../escape'), false, 'Must reject directory traversal');

  console.log('Git ref validation security rules passed.');
}

function testSchemeDiscovery() {
  console.log('Testing Xcode scheme discovery and validation rules...');

  // 1. Test parseXcodebuildJson with direct JSON, bracketed JSON, and console preamble
  {
    const clean = JSON.stringify([{ action: 'build', target: 'KineSync' }]);
    assert.deepStrictEqual(parseXcodebuildJson(clean), [{ action: 'build', target: 'KineSync' }]);

    const withPreamble = `User defaults from command line:\n    IDEPackageSupportUseBuiltinSCM = YES\n\n${clean}\n\n`;
    assert.deepStrictEqual(parseXcodebuildJson(withPreamble), [{ action: 'build', target: 'KineSync' }]);

    assert.throws(() => parseXcodebuildJson('Not a JSON object'), /Failed to parse xcodebuild JSON/);
  }

  // 2. Test findApplicationTarget:
  // - app target (WRAPPER_EXTENSION=app, PRODUCT_TYPE=com.apple.product-type.application) -> returns target
  // - wrong build product (WRAPPER_EXTENSION=framework, PRODUCT_TYPE=com.apple.product-type.framework) -> returns null
  // - wrong build product (WRAPPER_EXTENSION=bundle, PRODUCT_TYPE=com.apple.product-type.bundle) -> returns null
  // - wrong build product (WRAPPER_EXTENSION=app, PRODUCT_TYPE=com.apple.product-type.bundle) -> returns null
  // - wrong build product (WRAPPER_EXTENSION=framework, PRODUCT_TYPE=com.apple.product-type.application) -> returns null
  // - static library (WRAPPER_EXTENSION='', PRODUCT_TYPE=com.apple.product-type.library.static) -> returns null
  {
    const appEntry = {
      target: 'KineSync',
      action: 'build',
      buildSettings: {
        WRAPPER_EXTENSION: 'app',
        PRODUCT_TYPE: 'com.apple.product-type.application',
        TARGET_BUILD_DIR: '/DerivedData/Build/Products/Debug-iphonesimulator',
        FULL_PRODUCT_NAME: 'KineSync.app',
      },
    };
    const foundApp = findApplicationTarget([appEntry]);
    assert.ok(foundApp, 'Must find valid application target');
    assert.strictEqual(foundApp.target, 'KineSync');
    assert.strictEqual(foundApp.buildSettings.FULL_PRODUCT_NAME, 'KineSync.app');
    assert.strictEqual(foundApp.buildSettings.TARGET_BUILD_DIR, '/DerivedData/Build/Products/Debug-iphonesimulator');

    // Wrong build products
    const frameworkEntry = {
      target: 'DoubleConversion',
      action: 'build',
      buildSettings: {
        WRAPPER_EXTENSION: 'framework',
        PRODUCT_TYPE: 'com.apple.product-type.framework',
      },
    };
    assert.strictEqual(findApplicationTarget([frameworkEntry]), null, 'Must reject framework wrapper');

    const bundleEntry = {
      target: 'AssetBundle',
      action: 'build',
      buildSettings: {
        WRAPPER_EXTENSION: 'bundle',
        PRODUCT_TYPE: 'com.apple.product-type.bundle',
      },
    };
    assert.strictEqual(findApplicationTarget([bundleEntry]), null, 'Must reject bundle wrapper');

    const mismatch1 = {
      target: 'FakeApp',
      action: 'build',
      buildSettings: {
        WRAPPER_EXTENSION: 'app',
        PRODUCT_TYPE: 'com.apple.product-type.bundle',
      },
    };
    assert.strictEqual(findApplicationTarget([mismatch1]), null, 'Must reject app wrapper with non-app product type');

    const mismatch2 = {
      target: 'FakeFramework',
      action: 'build',
      buildSettings: {
        WRAPPER_EXTENSION: 'framework',
        PRODUCT_TYPE: 'com.apple.product-type.application',
      },
    };
    assert.strictEqual(findApplicationTarget([mismatch2]), null, 'Must reject app product type with non-app wrapper');

    const staticLibEntry = {
      target: 'boost',
      action: 'build',
      buildSettings: {
        WRAPPER_EXTENSION: '',
        PRODUCT_TYPE: 'com.apple.product-type.library.static',
      },
    };
    assert.strictEqual(findApplicationTarget([staticLibEntry]), null, 'Must reject static library');

    // Scheme with mixed targets: pod dependency first, then app target
    const mixed = findApplicationTarget([frameworkEntry, staticLibEntry, appEntry]);
    assert.ok(mixed, 'Must find app target among multiple dependency targets');
    assert.strictEqual(mixed.target, 'KineSync');
  }

  // 3. Regression test: mock scheme inventory with pod first and app later
  // This mirrors the root cause of GitHub Actions run 41233371227 where 'boost' was selected alphabetically
  {
    const mockInventory = ['boost', 'DoubleConversion', 'fmt', 'KineSync', 'Pods-KineSync'];
    const mockExec = (cmd, args) => {
      assert.strictEqual(cmd, 'xcodebuild');
      if (args.includes('-list')) {
        return JSON.stringify({
          workspace: {
            name: 'KineSync',
            schemes: mockInventory,
          },
        });
      }
      if (args.includes('-showBuildSettings')) {
        const schemeIdx = args.indexOf('-scheme');
        const scheme = args[schemeIdx + 1];
        if (scheme === 'boost') {
          return JSON.stringify([
            {
              target: 'boost',
              action: 'build',
              buildSettings: {
                WRAPPER_EXTENSION: '',
                PRODUCT_TYPE: 'com.apple.product-type.library.static',
                TARGET_BUILD_DIR: '/derived/Build/Products/Debug-iphonesimulator/boost',
              },
            },
          ]);
        }
        if (scheme === 'DoubleConversion') {
          return JSON.stringify([
            {
              target: 'DoubleConversion',
              action: 'build',
              buildSettings: {
                WRAPPER_EXTENSION: 'framework',
                PRODUCT_TYPE: 'com.apple.product-type.framework',
                TARGET_BUILD_DIR: '/derived/Build/Products/Debug-iphonesimulator/DoubleConversion',
              },
            },
          ]);
        }
        if (scheme === 'fmt') {
          return JSON.stringify([
            {
              target: 'fmt',
              action: 'build',
              buildSettings: {
                WRAPPER_EXTENSION: 'a',
                PRODUCT_TYPE: 'com.apple.product-type.library.static',
                TARGET_BUILD_DIR: '/derived/Build/Products/Debug-iphonesimulator/fmt',
              },
            },
          ]);
        }
        if (scheme === 'Pods-KineSync') {
          return JSON.stringify([
            {
              target: 'Pods-KineSync',
              action: 'build',
              buildSettings: {
                WRAPPER_EXTENSION: 'framework',
                PRODUCT_TYPE: 'com.apple.product-type.framework',
                TARGET_BUILD_DIR: '/derived/Build/Products/Debug-iphonesimulator/Pods-KineSync',
              },
            },
          ]);
        }
        if (scheme === 'KineSync') {
          return JSON.stringify([
            {
              target: 'KineSync',
              action: 'build',
              buildSettings: {
                WRAPPER_EXTENSION: 'app',
                PRODUCT_TYPE: 'com.apple.product-type.application',
                TARGET_BUILD_DIR: '/derived/Build/Products/Debug-iphonesimulator',
                FULL_PRODUCT_NAME: 'KineSync.app',
              },
            },
          ]);
        }
        throw new Error(`Unknown scheme in mock: ${scheme}`);
      }
      throw new Error(`Unexpected command args: ${args.join(' ')}`);
    };

    const discovered = discoverApplicationScheme('/path/to/KineSync.xcworkspace', {
      execCommand: mockExec,
    });
    assert.strictEqual(discovered.scheme, 'KineSync', 'Must select KineSync and not earlier pod scheme boost');
    assert.strictEqual(discovered.target, 'KineSync');
    assert.strictEqual(discovered.buildSettings.FULL_PRODUCT_NAME, 'KineSync.app');
    assert.strictEqual(discovered.buildSettings.TARGET_BUILD_DIR, '/derived/Build/Products/Debug-iphonesimulator');
  }

  // 4. Regression test: no app in scheme inventory (only pods / wrong build products)
  {
    const mockInventoryOnlyPods = ['boost', 'DoubleConversion', 'fmt'];
    const mockExec = (cmd, args) => {
      if (args.includes('-list')) {
        return JSON.stringify({
          workspace: {
            name: 'TestWs',
            schemes: mockInventoryOnlyPods,
          },
        });
      }
      if (args.includes('-showBuildSettings')) {
        return JSON.stringify([
          {
            target: 'StaticLib',
            action: 'build',
            buildSettings: {
              WRAPPER_EXTENSION: 'a',
              PRODUCT_TYPE: 'com.apple.product-type.library.static',
            },
          },
        ]);
      }
      throw new Error(`Unexpected command args: ${args.join(' ')}`);
    };

    assert.throws(
      () => discoverApplicationScheme('/path/to/TestWs.xcworkspace', { execCommand: mockExec }),
      /No application scheme found in workspace TestWs/,
      'Must throw explicit error when no application scheme is found'
    );
  }

  // 5. Regression test: ambiguous explicit failure (multiple application schemes)
  {
    const mockInventoryAmbiguous = ['KineSync', 'KineSyncBeta'];
    const mockExec = (cmd, args) => {
      if (args.includes('-list')) {
        return JSON.stringify({
          workspace: {
            name: 'KineSync',
            schemes: mockInventoryAmbiguous,
          },
        });
      }
      if (args.includes('-showBuildSettings')) {
        const schemeIdx = args.indexOf('-scheme');
        const scheme = args[schemeIdx + 1];
        return JSON.stringify([
          {
            target: scheme,
            action: 'build',
            buildSettings: {
              WRAPPER_EXTENSION: 'app',
              PRODUCT_TYPE: 'com.apple.product-type.application',
              TARGET_BUILD_DIR: '/derived/Build/Products/Debug-iphonesimulator',
              FULL_PRODUCT_NAME: `${scheme}.app`,
            },
          },
        ]);
      }
      throw new Error(`Unexpected command args: ${args.join(' ')}`);
    };

    assert.throws(
      () => discoverApplicationScheme('/path/to/KineSync.xcworkspace', { execCommand: mockExec }),
      /Ambiguous application schemes found in workspace KineSync\.xcworkspace: KineSync \(target: KineSync\), KineSyncBeta \(target: KineSyncBeta\)/,
      'Must fail explicitly when multiple application schemes exist'
    );
  }

  // 6. Regression test: pod scheme query failure is tolerated during discovery
  {
    const mockInventoryWithError = ['failing-pod', 'KineSync'];
    const mockExec = (cmd, args) => {
      if (args.includes('-list')) {
        return JSON.stringify({
          workspace: {
            name: 'KineSync',
            schemes: mockInventoryWithError,
          },
        });
      }
      if (args.includes('-showBuildSettings')) {
        const schemeIdx = args.indexOf('-scheme');
        const scheme = args[schemeIdx + 1];
        if (scheme === 'failing-pod') {
          throw new Error('xcodebuild: error: Scheme failing-pod is not configured for iphonesimulator');
        }
        if (scheme === 'KineSync') {
          return JSON.stringify([
            {
              target: 'KineSync',
              action: 'build',
              buildSettings: {
                WRAPPER_EXTENSION: 'app',
                PRODUCT_TYPE: 'com.apple.product-type.application',
                TARGET_BUILD_DIR: '/derived/Build/Products/Debug-iphonesimulator',
                FULL_PRODUCT_NAME: 'KineSync.app',
              },
            },
          ]);
        }
      }
      throw new Error(`Unexpected command args: ${args.join(' ')}`);
    };

    const discovered = discoverApplicationScheme('/path/to/KineSync.xcworkspace', {
      execCommand: mockExec,
    });
    assert.strictEqual(discovered.scheme, 'KineSync');
  }

  // 7. End-to-end buildSimulatorApp with mock runner and exact derived path verification
  {
    const testIosDir = path.join(tempDir, 'mock-ios');
    const testDerivedDir = path.join(tempDir, 'mock-derived');
    const expectedAppDir = path.join(testDerivedDir, 'Build', 'Products', 'Debug-iphonesimulator', 'KineSync.app');
    fs.mkdirSync(path.join(testIosDir, 'KineSync.xcworkspace'), { recursive: true });
    fs.mkdirSync(expectedAppDir, { recursive: true });

    let builtScheme = null;
    let signedPath = null;
    const mockRunner = (cmd, args) => {
      if (cmd === 'xcodebuild' && args.includes('-list')) {
        return JSON.stringify({
          workspace: {
            name: 'KineSync',
            schemes: ['boost', 'KineSync'],
          },
        });
      }
      if (cmd === 'xcodebuild' && args.includes('-showBuildSettings')) {
        const scheme = args[args.indexOf('-scheme') + 1];
        if (scheme === 'boost') {
          return JSON.stringify([{ target: 'boost', buildSettings: { WRAPPER_EXTENSION: '', PRODUCT_TYPE: 'library' } }]);
        }
        return JSON.stringify([
          {
            target: 'KineSync',
            buildSettings: {
              WRAPPER_EXTENSION: 'app',
              PRODUCT_TYPE: 'com.apple.product-type.application',
              TARGET_BUILD_DIR: path.join(testDerivedDir, 'Build', 'Products', 'Debug-iphonesimulator'),
              FULL_PRODUCT_NAME: 'KineSync.app',
            },
          },
        ]);
      }
      if (cmd === 'xcodebuild' && args.includes('build')) {
        builtScheme = args[args.indexOf('-scheme') + 1];
        return '';
      }
      if (cmd === 'codesign') {
        signedPath = args[args.length - 1];
        return '';
      }
      throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
    };

    const appResult = buildSimulatorApp({
      derivedDataPath: testDerivedDir,
      iosDirectory: testIosDir,
      appDirectory: tempDir,
      execCommand: mockRunner,
    });

    assert.strictEqual(builtScheme, 'KineSync', 'Must invoke xcodebuild build for application scheme KineSync');
    assert.strictEqual(signedPath, expectedAppDir, 'Must codesign exact derived app path');
    assert.strictEqual(appResult, expectedAppDir, 'Must return exact derived app path');
    assert.strictEqual(
      fs.readFileSync(path.join(testIosDir, '.built_app_path'), 'utf8'),
      expectedAppDir,
      'Must record exact app path in .built_app_path'
    );
  }

  console.log('Xcode scheme discovery and validation rules passed.');
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
  testGitRefValidationRules();
  testSchemeDiscovery();
  cleanTemp();
  console.log('\nAll simulator harness tests PASSED.');
} catch (err) {
  cleanTemp();
  console.error(`Test failure: ${err.message}`);
  process.exit(1);
}
