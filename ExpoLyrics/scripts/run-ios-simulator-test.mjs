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

export function rotateSimulator(targetOrientation, udid, command = runCommand) {
  if (!['portrait', 'landscape'].includes(targetOrientation)) throw new Error('Invalid rotation orientation');
  const inventory = JSON.parse(command('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
  const booted = Object.values(inventory.devices || {}).flat().filter(d => d.state === 'Booted');
  if (booted.length !== 1 || booted[0].udid !== udid) throw new Error('Rotation requires the selected device to be the only booted simulator');
  command('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid]);
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
  command('osascript', ['-e', script]);
  console.log(`[RUNNER] Triggered simulator rotation to ${targetOrientation}`);
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
  const rawLogStream = fs.createWriteStream(rawLogFile, { flags: 'w' });

  let scenarioFinished = false;
  let scenarioResolve = null;
  const scenarioPromise = new Promise((res) => {
    scenarioResolve = res;
  });

  const verifiedScreenshots = new Map();
  const processedScreenshotStages = new Set();

  function processIncomingLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    rawLogStream.write(trimmed + '\n');
    parser.processLine(trimmed);

    // Handle simulator rotation trigger
    const rotMatch = trimmed.match(/\[KINESYNC_SIM\] TRIGGER_SIMULATOR_ROTATION\s+orientation=(\w+)/);
    if (rotMatch) {
      try { rotateSimulator(rotMatch[1], device.udid); }
      catch (err) { parser.errors.push(`Rotation command failed: ${err.message}`); scenarioResolve(); }
    }

    // Handle screenshot request with authentic bidirectional handshake
    const shotMatch = trimmed.match(/\[KINESYNC_SIM\] READY_FOR_SCREENSHOT\s+stage=(\w+)\s+token=([\w]+)/);
    if (shotMatch) {
      const stage = shotMatch[1];
      if (!processedScreenshotStages.has(stage)) {
        processedScreenshotStages.add(stage);
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

          // Send screenshot acknowledgement file into app container if screenshot is valid
          if (valid) {
            try {
              const containerPath = runCommand('xcrun', [
                'simctl',
                'get_app_container',
                device.udid,
                'dev.kineticron.KineSync',
                'data',
              ]).trim();
              if (containerPath && fs.existsSync(containerPath)) {
                const cachesDir = path.join(containerPath, 'Library', 'Caches');
                if (fs.existsSync(cachesDir)) {
                  const ackFile = path.join(cachesDir, `kinesync_sim_ack_${stage}.json`);
                  fs.writeFileSync(ackFile, JSON.stringify({ stage, token: shotMatch[2], timestamp: Date.now() }), 'utf8');
                  console.log(`[RUNNER] Wrote screenshot ACK for ${stage}`);
                }
              }
            } catch (ackErr) {
              console.warn(`[RUNNER] Warning: Failed to write screenshot ACK to app container: ${ackErr.message}`);
            }
          }
        } catch (err) {
          console.error(`[RUNNER] Failed to capture screenshot for ${stage}: ${err.message}`);
          verifiedScreenshots.set(stage, { valid: false, error: err.message });
        }
      }
    }

    if (trimmed.includes('[KINESYNC_SIM] SCENARIO_COMPLETE')) {
      scenarioFinished = true;
      scenarioResolve();
    }
  }

  function createLineBufferConsumer() {
    let buffer = '';
    return (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        processIncomingLine(line);
      }
    };
  }

  console.log('[RUNNER] Launching app dev.kineticron.KineSync via console-pty with EXPO_PUBLIC_SIMULATOR_TEST=1...');
  const appProcess = spawn('xcrun', [
    'simctl',
    'launch',
    '--console-pty',
    device.udid,
    'dev.kineticron.KineSync',
  ], {
    env: {
      ...process.env,
      SIMCTL_CHILD_EXPO_PUBLIC_SIMULATOR_TEST: '1',
    },
  });

  const appConsumer = createLineBufferConsumer();
  appProcess.stdout.on('data', appConsumer);
  appProcess.stderr.on('data', createLineBufferConsumer());
  appProcess.on('error', err => { parser.errors.push(`Launch failed: ${err.message}`); scenarioResolve(); });
  appProcess.on('exit', code => { if (!scenarioFinished) { parser.errors.push(`App console exited before completion: ${code}`); scenarioResolve(); } });

  console.log(`[RUNNER] Waiting for scenario completion (timeout: ${timeoutMinutes}m)...`);
  const timeoutHandle = setTimeout(() => {
    if (!scenarioFinished) {
      console.error('[RUNNER] Hard timeout reached waiting for test scenario!');
      parser.errors.push('Hard timeout waiting for scenario completion');
      appProcess.kill();
      scenarioResolve();
    }
  }, timeoutMinutes * 60 * 1000);

  await scenarioPromise;
  clearTimeout(timeoutHandle);
  appProcess.kill();
  await new Promise((resolve, reject) => {
    rawLogStream.on('error', reject);
    rawLogStream.end(resolve);
  });

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

  parser.errors.push(...assertionFailures.filter(f => f.startsWith('Missing screenshot capture') || f.startsWith('Invalid/blank screenshot')));
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
