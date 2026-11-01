// iOS Simulator Test Runner for KineSync
// Boots simulator, installs Release app, streams logs, handles rotation, captures screenshots, and asserts results

import fs from 'node:fs';
import { PNG } from 'pngjs';
import { StringDecoder } from 'node:string_decoder';
import { SimulatorRunLifecycle } from './simulator-run-lifecycle.mjs';
import path from 'node:path';
import { startupCommand, selectToolchain, prepareSimulator, startupDiagnostics, SUPPORTED_RUNTIME_POLICY } from './simulator-startup.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { SimulatorLogParser } from './parse-simulator-logs.mjs';
import { analyzeScreenshotContent } from './compare-simulator-screenshots.mjs';

let lifecycle;

// One decoder per transport preserves UTF-8 across byte chunks. Flush only once
// at pipe EOF so an unterminated final protocol record is neither lost nor repeated.
export function createLineBufferConsumer(onLine, onChunk = () => {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let ended = false;
  const consumeText = text => {
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  };
  const consume = chunk => {
    if (ended) return;
    onChunk(chunk);
    consumeText(decoder.write(chunk));
  };
  consume.flush = () => {
    if (ended) return;
    ended = true;
    consumeText(decoder.end());
    if (buffer) onLine(buffer);
    buffer = '';
  };
  return consume;
}


function runCommand(cmd, args, options = {}) {
  try {
    lifecycle?.check();
    return execFileSync(cmd, args, { ...options, timeout: Math.max(1, Math.min(options.timeout ?? 5000, lifecycle?.remaining() ?? 5000)), killSignal: 'SIGKILL', encoding: 'utf8', stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const failure = new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr || err.message}`);
    failure.stdout = err.stdout?.toString();
    throw failure;
  }
}

export async function runStartupCommand(cmd, args, state = lifecycle, execute) {
  return startupCommand(cmd, args, state, execute, args.includes('install') ? 90000 : 30000);
}

export function selectSimulatorDevice(data, policy = SUPPORTED_RUNTIME_POLICY) {
  const devices = data.devices || {};

  const booted = Object.values(devices).flat().filter(dev => ['Booted', 'Booting'].includes(dev.state));
  const candidates = Object.entries(devices)
    .filter(([runtime]) => runtime === policy.runtime)
    .flatMap(([runtime, list]) => list.filter(dev => dev.isAvailable && dev.name.includes('iPhone')).map(dev => ({ ...dev, runtime })))
    .sort((a, b) => a.runtime.localeCompare(b.runtime) || a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid));
  const candidate = candidates.find(dev => ['Booted', 'Booting'].includes(dev.state)) || candidates[0];
  if (!candidate) throw new Error('No available iOS 27.0 iPhone simulator (supported runtime policy)');
  if (booted.some(dev => dev.udid !== candidate.udid)) throw new Error('Conflicting booted or booting simulator; refusing GUI automation');
  return candidate;
}

export function rotateSimulator(targetOrientation, udid, command = runCommand) {
  if (!process.env.DEVELOPER_DIR) throw new Error('Explicit DEVELOPER_DIR required for Simulator GUI');
  if (!['portrait', 'landscape'].includes(targetOrientation)) throw new Error('Invalid rotation orientation');
  const inventory = JSON.parse(command('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
  const booted = Object.values(inventory.devices || {}).flat().filter(d => ['Booted', 'Booting'].includes(d.state));
  if (booted.length !== 1 || booted[0].udid !== udid) throw new Error('Rotation requires the selected device to be the only booted simulator');
  const started = Date.now();
  let output, failure;
  const stderrFd = lifecycle ? fs.openSync(path.join(lifecycle.outputDir, 'rotation-native-stderr.log'), 'a') : undefined;
  try {
    output = command('node', [new URL('./simulator-rotation-worker.mjs', import.meta.url).pathname, udid, targetOrientation], { timeout: 15000, ...(stderrFd === undefined ? {} : { stdio: ['pipe', 'pipe', stderrFd] }) });
    const prefix = 'KINESYNC_ROTATION_RESULT ';
    const acknowledgments = output.split(/\r?\n/).filter(line => line.startsWith(prefix));
    if (acknowledgments.length !== 1) throw Error('Expected one native rotation acknowledgment');
    const result = JSON.parse(acknowledgments[0].slice(prefix.length));
    if (result.accepted !== true || result.udid !== udid || result.orientation !== targetOrientation || result.version !== '0.13.0') throw Error('Invalid native rotation acknowledgment');
  } catch (error) { output ??= error.stdout; failure = error.message; throw error; }
  finally {
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
    if (lifecycle && output !== undefined) fs.appendFileSync(path.join(lifecycle.outputDir, 'rotation-native-stdout.log'), output + '\n');
    if (lifecycle) fs.appendFileSync(path.join(lifecycle.outputDir, 'rotation-commands.jsonl'), JSON.stringify({ udid, orientation: targetOrientation, started, duration: Date.now() - started, output, error: failure }) + '\n');
  }
  console.log(`[RUNNER] Requested native rotation to ${targetOrientation}; awaiting rendered orientation evidence`);
}

async function main() {
  const appPathIndex = process.argv.indexOf('--app-path');
  const outputDirIndex = process.argv.indexOf('--output-dir');
  const timeoutIndex = process.argv.indexOf('--timeout-minutes');

  const appPath = appPathIndex >= 0 ? process.argv[appPathIndex + 1] : 'ios/build/Build/Products/Release-iphonesimulator/KineSync.app';
  const outputDir = outputDirIndex >= 0 ? process.argv[outputDirIndex + 1] : '.expo/simulator-test-output';
  const timeoutMinutes = timeoutIndex >= 0 ? Number(process.argv[timeoutIndex + 1]) : 6;
  const seconds = (flag, fallback) => { const i = process.argv.indexOf(flag); return i < 0 ? fallback : Number(process.argv[i + 1]) * 1000; };
  lifecycle = new SimulatorRunLifecycle(outputDir, { startupMs: seconds('--startup-seconds', 300000), stageMs: seconds('--stage-seconds', 60000), overallMs: timeoutMinutes * 60000 });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    lifecycle.fail(new Error(`Received ${signal}`)); lifecycle.capture(true); lifecycle.cleanup(); process.exit(1);
  });

  fs.mkdirSync(outputDir, { recursive: true });
  const rawLogFile = path.join(outputDir, 'simulator-raw-log.txt');
  const summaryReportFile = path.join(outputDir, 'simulator-summary.md');
  const perfJsonFile = path.join(outputDir, 'simulator-perf.json');

  if (process.env.SIMULATOR_ROTATION_TOOL_DIR) fs.copyFileSync(path.join(process.env.SIMULATOR_ROTATION_TOOL_DIR, 'provenance.json'), path.join(outputDir, 'rotation-tool-provenance.json'));
  await selectToolchain(lifecycle);
  const device = await prepareSimulator(lifecycle, selectSimulatorDevice);
  lifecycle.update('startup:rotation-preflight');
  // Startup enumeration is async with a 30s command cap and absolute lifecycle deadline.
  const inventory = JSON.stringify(lifecycle.readyInventory);
  rotateSimulator('portrait', device.udid, (cmd, args, options) => cmd === 'xcrun' ? inventory : runCommand(cmd, args, options));
  fs.mkdirSync(path.join(outputDir, 'diagnostics'), { recursive: true });
  const portraitPath = path.join(outputDir, 'diagnostics/initial-portrait.png');
  let portraitReady = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    await startupCommand('xcrun', ['simctl', 'io', device.udid, 'screenshot', portraitPath], lifecycle, undefined, 5000);
    const image = PNG.sync.read(fs.readFileSync(portraitPath));
    if (image.height > image.width) { portraitReady = true; break; }
    await runStartupCommand('/bin/sleep', ['0.25']);
  }
  if (!portraitReady) throw Error('Initial native portrait orientation not observed');
  await runStartupCommand('xcrun', ['simctl', 'status_bar', device.udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--batteryState', 'charged', '--batteryLevel', '100']);

  try { runCommand('xcrun', ['simctl', 'terminate', device.udid, 'dev.kineticron.KineSync']); }
  catch (error) { fs.writeFileSync(path.join(outputDir, 'preinstall-terminate.log'), error.message); }
  lifecycle.update('startup:install');
  console.log(`[RUNNER] Installing app bundle: ${appPath}...`);
  await runStartupCommand('xcrun', ['simctl', 'install', device.udid, appPath]);
  console.log('[RUNNER] App installed.');

  const parser = new SimulatorLogParser();
  fs.writeFileSync(rawLogFile, '');

  let scenarioFinished = false;
  let transportStopping = false;
  let scenarioResolve = null;
  const scenarioPromise = new Promise((res) => {
    scenarioResolve = res;
  });

  const verifiedScreenshots = new Map();
  const processedScreenshotStages = new Set();

  function processIncomingLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    lifecycle.line(trimmed);
    if (trimmed.includes('[KINESYNC_SIM]')) console.log(trimmed);
    parser.processLine(trimmed);

    // Handle simulator rotation trigger
    const rotMatch = trimmed.match(/\[KINESYNC_SIM\] TRIGGER_SIMULATOR_ROTATION\s+orientation=(\w+)/);
    if (rotMatch) {
      try {
        rotateSimulator(rotMatch[1], device.udid);
        if (rotMatch[1] === 'portrait') {
          const restored = path.join(outputDir, 'diagnostics/restored-portrait.png');
          let observed = false;
          for (let attempt = 0; attempt < 8; attempt++) {
            runCommand('xcrun', ['simctl', 'io', device.udid, 'screenshot', restored], { timeout: 1500 });
            const image = PNG.sync.read(fs.readFileSync(restored));
            if (image.height > image.width) { observed = true; break; }
            runCommand('/bin/sleep', ['0.25']);
          }
          if (!observed) throw Error('Restored native portrait orientation not observed');
        }
      }
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
          let buf = fs.readFileSync(shotPath);
          let settled = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            runCommand('sleep', ['0.25']);
            runCommand('xcrun', ['simctl', 'io', device.udid, 'screenshot', shotPath], { timeout: 1500 });
            const next = fs.readFileSync(shotPath);
            const before = PNG.sync.read(buf), after = PNG.sync.read(next);
            settled = before.width === after.width && before.height === after.height && before.data.equals(after.data);
            buf = next;
            if (settled) break;
          }
          if (!settled) throw new Error('Native snapshot did not settle to identical consecutive frames');
          const analysis = analyzeScreenshotContent(buf);

          let valid = analysis.nonBlank;
          let notes = `dims=${analysis.width}x${analysis.height} stdDev=${analysis.stdDev} nonBlank=${analysis.nonBlank}`;

          if (stage !== 'stage_7_rotation' && analysis.height <= analysis.width) { valid = false; notes += ' (FAIL: expected portrait height > width)'; }
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

  lifecycle.update('startup:unified-log-readiness');
  const deviceLog = path.join(outputDir, 'device-stream.log');
  fs.writeFileSync(deviceLog, '');
  // RN Release's default JS logger uses os_log, not the launch console. Parse
  // exactly one source so a console mirror cannot duplicate stages or ACKs.
  const deviceProcess = spawn('xcrun', ['simctl', 'spawn', device.udid, 'log', 'stream', '--style', 'compact', '--level', 'debug', '--predicate', 'process == "KineSync"'], { stdio: ['ignore', 'pipe', 'pipe'] });
  lifecycle.children.push(deviceProcess);
  let streamReady = false;
  let protocolArmed = false;
  let readyResolve, readyReject;
  const streamReadyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const failStream = message => {
    parser.errors.push(message);
    readyReject(new Error(message));
    scenarioResolve();
  };
  const observeReadiness = line => {
    if (line.startsWith('Filtering the log data using ') || /^Timestamp\s+/.test(line)) {
      streamReady = true;
      readyResolve();
    }
  };
  const streamConsumer = createLineBufferConsumer(line => {
    observeReadiness(line);
    if (protocolArmed) processIncomingLine(line);
  }, chunk => fs.appendFileSync(rawLogFile, chunk));
  const stderrConsumer = createLineBufferConsumer(observeReadiness);
  deviceProcess.stdout.on('data', chunk => { fs.appendFileSync(deviceLog, chunk); streamConsumer(chunk); });
  // stderr is evidence only, never an alternate protocol source.
  deviceProcess.stderr.on('data', chunk => { fs.appendFileSync(deviceLog, chunk); stderrConsumer(chunk); });
  deviceProcess.on('error', err => failStream(`Unified log stream failed: ${err.message}`));
  deviceProcess.on('close', (code, signal) => {
    streamConsumer.flush();
    stderrConsumer.flush();
    if (!scenarioFinished && !transportStopping) failStream(`Unified log stream exited before completion: ${code ?? signal}`);
  });
  const readinessTimeout = setInterval(() => {
    try { lifecycle.check(); }
    catch (err) { readyReject(err); }
  }, 100);
  try {
    // Fail closed if log's subscription/banner never arrives; don't race app init.
    await streamReadyPromise;
    if (!streamReady || parser.errors.length) throw new Error(parser.errors.join('; ') || 'Unified log stream not ready');
  } finally { clearInterval(readinessTimeout); }
  lifecycle.update('startup:launch/awaiting-STAGE_BEGIN');
  protocolArmed = true;
  console.log('[RUNNER] Launching app dev.kineticron.KineSync via console-pty with EXPO_PUBLIC_SIMULATOR_TEST=1...');
  const appProcess = spawn('xcrun', [
    'simctl',
    'launch',
    '--terminate-running-process',
    '--console-pty',
    device.udid,
    'dev.kineticron.KineSync',
  ], {
    env: {
      ...process.env,
      SIMCTL_CHILD_EXPO_PUBLIC_SIMULATOR_TEST: '1',
    },
  });

  lifecycle.children.push(appProcess);
  const launchLog = path.join(outputDir, 'launch-console.log');
  fs.writeFileSync(launchLog, '');
  const saveLaunchOutput = chunk => fs.appendFileSync(launchLog, chunk);
  appProcess.stdout.on('data', saveLaunchOutput);
  appProcess.stderr.on('data', saveLaunchOutput);
  appProcess.on('error', err => { parser.errors.push(`Launch failed: ${err.message}`); scenarioResolve(); });
  appProcess.on('close', code => { if (!scenarioFinished && !transportStopping) { parser.errors.push(`App console exited before completion: ${code}`); scenarioResolve(); } });

  console.log(`[RUNNER] Waiting for scenario completion (timeout: ${timeoutMinutes}m)...`);
  const timeoutHandle = setInterval(() => {
    try { lifecycle.check(); }
    catch (err) { parser.errors.push(err.message); lifecycle.fail(err); scenarioResolve(); }
  }, 100);

  await scenarioPromise;
  clearInterval(timeoutHandle);
  // A completion record can arrive before queued console/stderr data callbacks.
  // Drain both child pipes before process.exit so ordinary diagnostics survive.
  transportStopping = true;
  await Promise.all([appProcess, deviceProcess].map(child => new Promise(resolve => {
    const timeout = setTimeout(resolve, 1000);
    child.once('close', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGKILL');
  })));

  if (parser.errors.length || !scenarioFinished) {
    lifecycle.fail(new Error(parser.errors.join('; ') || 'Scenario did not complete'));
    lifecycle.capture();
  }

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
    lifecycle.fail(new Error(assertionFailures.join('; '))); lifecycle.capture();
    lifecycle.cleanup();
    console.error(`[RUNNER] Test FAILED with ${assertionFailures.length} assertion failures:`);
    for (const f of assertionFailures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  lifecycle.cleanup();
  console.log('[RUNNER] All simulator test assertions PASSED successfully.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(async (err) => {
    console.error(`[RUNNER] Fatal runner error: ${err.message}`);
    if (lifecycle) { await startupDiagnostics(lifecycle); lifecycle.fail(err); lifecycle.capture(); lifecycle.cleanup(); }
    process.exit(1);
  });
}
