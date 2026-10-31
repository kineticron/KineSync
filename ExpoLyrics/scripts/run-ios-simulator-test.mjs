// iOS Simulator Test Runner for KineSync
// Boots simulator, installs debug app, streams logs, handles rotation, captures screenshots, and asserts results

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SimulatorLogParser } from './parse-simulator-logs.mjs';
import { analyzeScreenshotContent } from './compare-simulator-screenshots.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function runCommand(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr || err.message}`);
  }
}

function getAvailableSimulatorDevice() {
  const jsonStr = runCommand('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
  const data = JSON.parse(jsonStr);
  const devices = data.devices || {};

  let candidate = null;
  for (const [runtime, list] of Object.entries(devices)) {
    if (!runtime.includes('iOS')) continue;
    for (const dev of list) {
      if (dev.isAvailable && dev.name.includes('iPhone')) {
        if (dev.state === 'Booted') return dev;
        if (!candidate) candidate = dev;
      }
    }
  }
  return candidate;
}

function rotateSimulator(targetOrientation) {
  const menuItem = targetOrientation === 'landscape' ? 'Landscape Right' : 'Portrait';
  const script = `
tell application "Simulator" to activate
tell application "System Events"
  tell process "Simulator"
    tell menu bar 1
      tell menu bar item "Device"
        tell menu 1
          tell menu item "Orientation"
            tell menu 1
              click menu item "${menuItem}"
            end tell
          end tell
        end tell
      end tell
    end tell
  end tell
end tell
`;
  try {
    runCommand('osascript', ['-e', script]);
    console.log(`[RUNNER] Triggered simulator rotation to ${targetOrientation}`);
  } catch (err) {
    console.warn(`[RUNNER] Warning: Failed to trigger AppleScript rotation: ${err.message}`);
  }
}

async function main() {
  const appPathIndex = process.argv.indexOf('--app-path');
  const outputDirIndex = process.argv.indexOf('--output-dir');
  const timeoutIndex = process.argv.indexOf('--timeout-minutes');

  const appPath = appPathIndex >= 0 ? process.argv[appPathIndex + 1] : 'ios/build/Build/Products/Debug-iphonesimulator/KineSync.app';
  const outputDir = outputDirIndex >= 0 ? process.argv[outputDirIndex + 1] : '.expo/simulator-test-output';
  const timeoutMinutes = timeoutIndex >= 0 ? Number(process.argv[timeoutIndex + 1]) : 15;

  fs.mkdirSync(outputDir, { recursive: true });
  const rawLogFile = path.join(outputDir, 'simulator-raw-log.txt');
  const summaryReportFile = path.join(outputDir, 'simulator-summary.md');
  const perfJsonFile = path.join(outputDir, 'simulator-perf.json');

  console.log('[RUNNER] Locating iOS Simulator...');
  const device = getAvailableSimulatorDevice();
  if (!device) {
    throw new Error('No available iOS simulator device found');
  }
  console.log(`[RUNNER] Using device: ${device.name} (${device.udid}) - state: ${device.state}`);

  if (device.state !== 'Booted') {
    console.log(`[RUNNER] Booting simulator ${device.udid}...`);
    runCommand('xcrun', ['simctl', 'boot', device.udid]);
    runCommand('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
    console.log('[RUNNER] Simulator booted successfully.');
  }

  // Ensure Simulator.app is open for GUI events like rotation
  try {
    runCommand('open', ['-a', 'Simulator']);
  } catch {
    // Simulator app launch optional in headless environments
  }

  console.log(`[RUNNER] Installing app bundle: ${appPath}...`);
  runCommand('xcrun', ['simctl', 'install', device.udid, appPath]);
  console.log('[RUNNER] App installed.');

  const parser = new SimulatorLogParser();
  const rawLogStream = fs.createWriteStream(rawLogFile, { flags: 'a' });

  console.log('[RUNNER] Starting unified log stream...');
  const logProcess = spawn('xcrun', [
    'simctl',
    'spawn',
    device.udid,
    'log',
    'stream',
    '--style',
    'compact',
    '--predicate',
    'processImagePath ENDSWITH "KineSync"',
  ]);

  let scenarioFinished = false;
  let scenarioResolve = null;
  const scenarioPromise = new Promise((res) => {
    scenarioResolve = res;
  });

  const verifiedScreenshots = new Map();

  logProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    rawLogStream.write(text);
    const lines = text.split('\n');

    for (const line of lines) {
      parser.processLine(line);

      // Handle simulator rotation trigger
      const rotMatch = line.match(/\[KINESYNC_SIM\] TRIGGER_SIMULATOR_ROTATION\s+orientation=(\w+)/);
      if (rotMatch) {
        rotateSimulator(rotMatch[1]);
      }

      // Handle screenshot request
      const shotMatch = line.match(/\[KINESYNC_SIM\] READY_FOR_SCREENSHOT\s+stage=(\w+)/);
      if (shotMatch) {
        const stage = shotMatch[1];
        const shotPath = path.join(outputDir, `${stage}.png`);
        try {
          runCommand('xcrun', ['simctl', 'io', device.udid, 'screenshot', shotPath]);
          const buf = fs.readFileSync(shotPath);
          const analysis = analyzeScreenshotContent(buf);

          let valid = analysis.nonBlank;
          let notes = `dims=${analysis.width}x${analysis.height} stdDev=${analysis.stdDev} nonBlank=${analysis.nonBlank}`;

          if (stage === 'stage_7_rotation') {
            if (analysis.width <= analysis.height) {
              valid = false;
              notes += ' (FAIL: expected landscape width > height)';
            }
          }

          verifiedScreenshots.set(stage, { valid, analysis, shotPath });
          console.log(`[RUNNER] Captured screenshot for ${stage}: ${notes}`);
        } catch (err) {
          console.error(`[RUNNER] Failed to capture screenshot for ${stage}: ${err.message}`);
          verifiedScreenshots.set(stage, { valid: false, error: err.message });
        }
      }

      if (line.includes('[KINESYNC_SIM] SCENARIO_COMPLETE')) {
        scenarioFinished = true;
        scenarioResolve();
      }
    }
  });

  logProcess.stderr.on('data', (chunk) => {
    rawLogStream.write(chunk.toString());
  });

  console.log('[RUNNER] Launching app dev.kineticron.KineSync with EXPO_PUBLIC_SIMULATOR_TEST=1...');
  runCommand('xcrun', ['simctl', 'launch', device.udid, 'dev.kineticron.KineSync']);

  console.log(`[RUNNER] Waiting for scenario completion (timeout: ${timeoutMinutes}m)...`);
  const timeoutHandle = setTimeout(() => {
    if (!scenarioFinished) {
      console.error('[RUNNER] Hard timeout reached waiting for test scenario!');
      logProcess.kill();
      scenarioResolve();
    }
  }, timeoutMinutes * 60 * 1000);

  await scenarioPromise;
  clearTimeout(timeoutHandle);
  logProcess.kill();
  rawLogStream.end();

  console.log('[RUNNER] Test scenario completed. Validating assertions...');

  const assertionFailures = parser.validateAssertions();

  // Validate screenshots
  const requiredScreenshots = [
    'stage_1_launch',
    'stage_2_playback',
    'stage_3_seek',
    'stage_4_switch_amll',
    'stage_5_skip_song',
    'stage_6_switch_spicy',
    'stage_7_rotation',
  ];

  for (const stage of requiredScreenshots) {
    const record = verifiedScreenshots.get(stage);
    if (!record) {
      assertionFailures.push(`Missing screenshot capture for ${stage}`);
    } else if (!record.valid) {
      assertionFailures.push(`Invalid/blank screenshot for ${stage}: ${JSON.stringify(record.analysis || record.error)}`);
    }
  }

  const markdownReport = parser.generateMarkdownReport();
  fs.writeFileSync(summaryReportFile, markdownReport, 'utf8');

  const perfData = {
    summary: parser.summary,
    heartbeat: parser.heartbeat,
    stages: parser.stages,
    renderers: Array.from(parser.renderers),
    landscapeConfirmed: parser.landscapeConfirmed,
    assertionFailures,
  };
  fs.writeFileSync(perfJsonFile, JSON.stringify(perfData, null, 2), 'utf8');

  console.log('\n--- Simulator Test Summary ---');
  console.log(markdownReport);
  console.log('-------------------------------\n');

  if (assertionFailures.length > 0) {
    console.error(`[RUNNER] Test FAILED with ${assertionFailures.length} assertion failures:`);
    for (const f of assertionFailures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  console.log('[RUNNER] All simulator test assertions PASSED successfully.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error(`[RUNNER] Fatal runner error: ${err.message}`);
    process.exit(1);
  });
}
