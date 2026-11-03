// iOS Simulator Test Runner for KineSync
// Boots simulator, installs Release app, streams logs, handles rotation, captures screenshots, and asserts results

import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { PNG } from 'pngjs';
import { StringDecoder } from 'node:string_decoder';
import { SimulatorRunLifecycle } from './simulator-run-lifecycle.mjs';
import path from 'node:path';
import { startupCommand, selectToolchain, prepareSimulator, startupDiagnostics, SUPPORTED_RUNTIME_POLICY } from './simulator-startup.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { SimulatorLogParser } from './parse-simulator-logs.mjs';
import { startNativeCapture } from './simulator-native-capture.mjs';
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
  lifecycle.check();
  const started = lifecycle.now();
  const timeout = Math.max(1, Math.min(options.timeout ?? 60000, lifecycle.remaining()));
  const record = { stage: lifecycle.stage, cmd, args, started, timeout };
  let stdout = '', stderr = '';
  fs.appendFileSync(path.join(lifecycle.outputDir, 'command-starts.jsonl'), JSON.stringify(record) + '\n');
  try {
    if (args.includes('screenshot')) fs.rmSync(args.at(-1), { force: true });
    const result = spawnSync(cmd, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
    stdout = result.stdout || ''; stderr = result.stderr || '';
    record.exitCode = result.status; record.signal = result.signal;
    if (result.error || result.status !== 0) throw Object.assign(new Error(result.error?.message || `Command exited ${result.status}: ${stderr}`), { stdout, stderr, code: result.error?.code ?? result.status, signal: result.signal });
    if (args.includes('screenshot')) {
      const image = PNG.sync.read(fs.readFileSync(args.at(-1)));
      record.png = { width: image.width, height: image.height };
    }
    lifecycle.check();
    return stdout.toString('utf8');
  } catch (error) {
    stdout = error.stdout ?? stdout; stderr = error.stderr ?? stderr;
    record.error = { message: error.message, code: error.code, signal: error.signal };
    throw error;
  } finally {
    const id = lifecycle.commandSerial = (lifecycle.commandSerial || 0) + 1;
    for (const [stream, data] of Object.entries({ stdout, stderr })) {
      record[stream] = `command-${id}-${stream}.log`;
      fs.writeFileSync(path.join(lifecycle.outputDir, record[stream]), data);
    }
    record.ended = lifecycle.now();
    record.exitCode ??= null;
    record.duration = record.ended - started;
    fs.appendFileSync(path.join(lifecycle.outputDir, 'startup-commands.jsonl'), JSON.stringify(record) + '\n');
  }
}

export async function runStartupCommand(cmd, args, state = lifecycle, execute) {
  return startupCommand(cmd, args, state, execute, args.includes('install') ? 300000 : 60000);
}

export function selectSimulatorDevice(data, policy = SUPPORTED_RUNTIME_POLICY) {
  const devices = data.devices || {};

  const booted = Object.values(devices).flat().filter(dev => ['Booted', 'Booting'].includes(dev.state));
  const candidates = Object.entries(devices)
    .filter(([runtime]) => runtime === policy.runtime)
    .flatMap(([runtime, list]) => list.filter(dev => dev.isAvailable && dev.name.includes('iPhone')).map(dev => ({ ...dev, runtime })))
    .sort((a, b) => a.runtime.localeCompare(b.runtime) || a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid));
  const candidate = candidates.find(dev => ['Booted', 'Booting'].includes(dev.state)) || candidates[0];
  if (!candidate) throw new Error('No available iOS 26.5 iPhone simulator (supported runtime policy)');
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
  try {
    output = command('node', [new URL('./simulator-rotation-worker.mjs', import.meta.url).pathname, udid, targetOrientation], { timeout: 60000 });
    const prefix = 'KINESYNC_ROTATION_RESULT ';
    const acknowledgments = output.split(/\r?\n/).filter(line => line.startsWith(prefix));
    if (acknowledgments.length !== 1) throw Error('Expected one native rotation acknowledgment');
    const result = JSON.parse(acknowledgments[0].slice(prefix.length));
    if (result.accepted !== true || result.udid !== udid || result.orientation !== targetOrientation || result.version !== '0.13.0') throw Error('Invalid native rotation acknowledgment');
  } catch (error) { output ??= error.stdout; failure = error.message; throw error; }
  finally {
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
  const timeoutMinutes = timeoutIndex >= 0 ? Number(process.argv[timeoutIndex + 1]) : 40;
  const seconds = (flag, fallback) => { const i = process.argv.indexOf(flag); return i < 0 ? fallback : Number(process.argv[i + 1]) * 1000; };
  lifecycle = new SimulatorRunLifecycle(outputDir, { startupMs: seconds('--startup-seconds', 600000), stageMs: seconds('--stage-seconds', 120000), overallMs: timeoutMinutes * 60000 });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    lifecycle.fail(new Error(`Received ${signal}`)); lifecycle.capture(true); lifecycle.cleanup(); process.exit(1);
  });

  fs.mkdirSync(outputDir, { recursive: true });
  let transportStopping = false;
  const logBytes = new Map();
  const appendLog = (file, chunk) => {
    const bytes = Buffer.from(chunk);
    const used = logBytes.get(file) || 0;
    const available = Math.max(0, 32 * 1024 * 1024 - used);
    fs.appendFileSync(file, bytes.subarray(0, available));
    logBytes.set(file, used + bytes.length);
    if (bytes.length > available) fs.writeFileSync(`${file}.truncated`, '32 MiB retention limit reached; subsequent bytes drained');
  };
  const startTransport = (cmd, args, options) => {
    lifecycle.check();
    const started = lifecycle.now();
    const id = lifecycle.commandSerial = (lifecycle.commandSerial || 0) + 1;
    const record = { cmd, args, stage: lifecycle.stage, started, deadline: lifecycle.overallDeadline,
      stdout: `command-${id}-stdout.log`, stderr: `command-${id}-stderr.log` };
    fs.appendFileSync(path.join(outputDir, 'command-starts.jsonl'), JSON.stringify(record) + '\n');
    const child = spawn(cmd, args, options);
    for (const stream of ['stdout', 'stderr']) {
      const file = path.join(outputDir, record[stream]);
      fs.writeFileSync(file, '');
      child[stream].on('data', chunk => appendLog(file, chunk));
    }
    child.once('error', error => { record.error = error.message; });
    child.once('close', (code, signal) => {
      record.ended = lifecycle.now(); record.duration = record.ended - started;
      record.exitCode = code; record.signal = signal; record.stopped = transportStopping;
      fs.appendFileSync(path.join(outputDir, 'startup-commands.jsonl'), JSON.stringify(record) + '\n');
    });
    return child;
  };
  const rawLogFile = path.join(outputDir, 'simulator-raw-log.txt');
  const summaryReportFile = path.join(outputDir, 'simulator-summary.md');
  const perfJsonFile = path.join(outputDir, 'simulator-perf.json');

  if (process.env.SIMULATOR_ROTATION_TOOL_DIR) fs.copyFileSync(path.join(process.env.SIMULATOR_ROTATION_TOOL_DIR, 'provenance.json'), path.join(outputDir, 'rotation-tool-provenance.json'));
  await selectToolchain(lifecycle);
  const device = await prepareSimulator(lifecycle, selectSimulatorDevice);
  lifecycle.enterPhase('startup:rotation-preflight', seconds('--preflight-seconds', 120000));
  // Reuse the verified inventory; preflight has its own bounded allowance.
  const inventory = JSON.stringify(lifecycle.readyInventory);
  rotateSimulator('portrait', device.udid, (cmd, args, options) => cmd === 'xcrun' ? inventory : runCommand(cmd, args, options));
  fs.mkdirSync(path.join(outputDir, 'diagnostics'), { recursive: true });
  const portraitPath = path.join(outputDir, 'diagnostics/initial-portrait.png');
  let portraitReady = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    await startupCommand('xcrun', ['simctl', 'io', device.udid, 'screenshot', portraitPath], lifecycle, undefined, 60000);
    const image = PNG.sync.read(fs.readFileSync(portraitPath));
    if (image.height > image.width) { portraitReady = true; break; }
    await runStartupCommand('/bin/sleep', ['0.25']);
  }
  if (!portraitReady) throw Error('Initial native portrait orientation not observed');
  await runStartupCommand('xcrun', ['simctl', 'status_bar', device.udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--batteryState', 'charged', '--batteryLevel', '100']);

  lifecycle.enterPhase('startup:install', 300000);
  console.log(`[RUNNER] Installing app bundle: ${appPath}...`);
  await runStartupCommand('xcrun', ['simctl', 'install', device.udid, appPath]);
  console.log('[RUNNER] App installed.');

  const parser = new SimulatorLogParser();
  fs.writeFileSync(rawLogFile, '');

  let scenarioFinished = false;
  let scenarioResolve = null;
  const scenarioPromise = new Promise((res) => {
    scenarioResolve = res;
  });

  const verifiedScreenshots = new Map();
  const processedScreenshotStages = new Set();
  let screenshotRunToken;
  let nativePortraitRestored = false;

  async function processIncomingLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    if (/\[KINESYNC_SIM\] STAGE_BEGIN/.test(trimmed) && !parser.appLaunched) { parser.errors.push('Scenario began before app/bridge INIT_READY'); scenarioResolve(); return; }
    try { lifecycle.check(); lifecycle.line(trimmed); }
    catch (error) { parser.errors.push(error.message); scenarioResolve(); return; }
    if (trimmed.includes('[KINESYNC_SIM]')) console.log(trimmed);
    if (trimmed.includes('[KINESYNC_SIM] SCENARIO_START')) {
      const match = trimmed.match(/\[KINESYNC_SIM\] SCENARIO_START\s+token=([\w]+)/);
      if (!match || screenshotRunToken) { parser.errors.push('Missing or duplicate scenario request identity'); scenarioResolve(); return; }
      screenshotRunToken = match[1];
    }
    parser.processLine(trimmed);

    // Handle simulator rotation trigger
    const rotMatch = trimmed.match(/\[KINESYNC_SIM\] TRIGGER_SIMULATOR_ROTATION\s+orientation=(\w+)/);
    if (rotMatch) {
      try {
        const orientation = rotMatch[1];
        const owner = trimmed.match(/stage=stage_7_rotation token=([\w]+)/)?.[1];
        const captureStage = orientation === 'landscape' ? 'stage_7_rotation' : 'stage_7_restore';
        if (!screenshotRunToken || owner !== `${screenshotRunToken}_${captureStage}` || parser.activeStage !== 'stage_7_rotation' || parser.errors.length ||
            parser.rotationTriggers.join(',') !== (orientation === 'landscape' ? 'landscape' : 'landscape,portrait') ||
            orientation === 'portrait' && !verifiedScreenshots.get('stage_7_rotation')?.valid) throw Error('Invalid rotation request ownership/order');
        rotateSimulator(orientation, device.udid);
      }
      catch (err) { parser.errors.push(`Rotation command failed: ${err.message}`); scenarioResolve(); }
    }

    // Handle screenshot request with authentic bidirectional handshake
    const shotMatch = trimmed.match(/\[KINESYNC_SIM\] READY_FOR_SCREENSHOT\s+stage=(\w+)\s+token=([\w]+)/);
    if (shotMatch) {
      if (!parser.appLaunched || !parser.scenarioStarted || parser.errors.length) { parser.errors.push('Screenshot requires app/bridge readiness and valid scenario protocol'); scenarioResolve(); return; }
      const stage = shotMatch[1];
      if (parser.activeStage !== stage) { parser.errors.push('Stale screenshot request stage'); scenarioResolve(); return; }
      const suffix = `_${stage}`;
      const token = shotMatch[2];
      const runToken = token.endsWith(suffix) ? token.slice(0, -suffix.length) : '';
      if (!runToken || !screenshotRunToken || screenshotRunToken !== runToken) { parser.errors.push('Invalid or stale screenshot token'); scenarioResolve(); return; }
      screenshotRunToken = runToken;
      if (stage === 'stage_7_rotation' && !parser.landscapeConfirmed) { parser.errors.push('Landscape capture requires fresh native layout'); scenarioResolve(); return; }
      if (!processedScreenshotStages.has(stage)) {
        processedScreenshotStages.add(stage);
        const shotPath = path.join(outputDir, `${stage}.png`);
        try {
          const capture = () => nativeCapture.capture(shotPath, { run: screenshotRunToken, stage, token, orientation: stage === 'stage_7_rotation' ? 'landscape' : 'portrait' });
          await capture();
          const attemptsDir = path.join(outputDir, 'diagnostics', stage);
          fs.mkdirSync(attemptsDir, { recursive: true });
          const buf = fs.readFileSync(shotPath);
          fs.writeFileSync(path.join(attemptsDir, 'frame-0.png'), buf);
          const analysis = analyzeScreenshotContent(buf);

          let valid = analysis.nonBlank && parser.appLaunched && parser.scenarioStarted && parser.activeStage === stage && !parser.errors.length;
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

          if (!valid) throw new Error(`Invalid screenshot: ${notes}`);

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
              if (!containerPath || !fs.existsSync(containerPath)) throw Error('Missing app container');
              if (containerPath && fs.existsSync(containerPath)) {
                const cachesDir = path.join(containerPath, 'Library', 'Caches');
                if (!fs.existsSync(cachesDir)) throw Error('Missing app cache directory');
                if (fs.existsSync(cachesDir)) {
                  const ackFile = path.join(cachesDir, `kinesync_sim_ack_${stage}.json`);
                  fs.writeFileSync(`${ackFile}.tmp`, JSON.stringify({ stage, token: shotMatch[2], timestamp: Date.now() }), 'utf8');
                  fs.renameSync(`${ackFile}.tmp`, ackFile);
                  console.log(`[RUNNER] Wrote screenshot ACK for ${stage}`);
                }
              }
            } catch (ackErr) {
              throw new Error(`Failed screenshot ACK: ${ackErr.message}`);
            }
          }
        } catch (err) {
          console.error(`[RUNNER] Failed to capture screenshot for ${stage}: ${err.message}`);
          verifiedScreenshots.set(stage, { valid: false, error: err.message });
          parser.errors.push(`Screenshot ${stage}: ${err.message}`);
          scenarioResolve();
        }
      }
    }

    const restore = trimmed.match(/\[KINESYNC_SIM\] READY_FOR_PORTRAIT_RESTORE stage=(\w+) token=([\w]+)/);
    if (restore) {
      try {
        const stage = 'stage_7_restore';
        if (restore[1] !== 'stage_7_rotation' || parser.activeStage !== 'stage_7_rotation' ||
            restore[2] !== `${screenshotRunToken}_${stage}` || !verifiedScreenshots.get('stage_7_rotation')?.valid ||
            !parser.portraitConfirmed || parser.errors.length || processedScreenshotStages.has(stage)) throw Error('Invalid portrait restoration ownership/order');
        processedScreenshotStages.add(stage);
        const restored = path.join(outputDir, 'diagnostics/restored-portrait.png');
        const bytes = await nativeCapture.capture(restored, { run: screenshotRunToken, stage, token: restore[2], orientation: 'portrait' });
        if (!analyzeScreenshotContent(bytes).nonBlank) throw Error('Blank native portrait restoration');
        nativePortraitRestored = true;
        const container = runCommand('xcrun', ['simctl', 'get_app_container', device.udid, 'dev.kineticron.KineSync', 'data']).trim();
        const ack = path.join(container, 'Library/Caches', `kinesync_sim_ack_${stage}.json`);
        fs.writeFileSync(`${ack}.tmp`, JSON.stringify({ stage, token: restore[2], timestamp: Date.now() }));
        fs.renameSync(`${ack}.tmp`, ack);
      } catch (error) { parser.errors.push(`Portrait restoration: ${error.message}`); scenarioResolve(); }
    }

    if (trimmed.includes('[KINESYNC_SIM] SCENARIO_COMPLETE')) {
      scenarioFinished = true;
      scenarioResolve();
    }
  }

  lifecycle.enterPhase('startup:unified-log-readiness', seconds('--stream-readiness-seconds', seconds('--readiness-seconds', 120000)));
  const deviceLog = path.join(outputDir, 'device-stream.log');
  fs.writeFileSync(deviceLog, '');
  // RN Release's default JS logger uses os_log, not the launch console. Parse
  // exactly one source so a console mirror cannot duplicate stages or ACKs.
  const deviceProcess = startTransport('xcrun', ['simctl', 'spawn', device.udid, 'log', 'stream', '--style', 'compact', '--level', 'debug', '--predicate', 'process == "KineSync"'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  // Yield during native capture without allowing later protocol lines to overtake its ACK.
  let protocolQueue = Promise.resolve();
  const streamConsumer = createLineBufferConsumer(line => {
    observeReadiness(line);
    if (protocolArmed) protocolQueue = protocolQueue.then(() => processIncomingLine(line)).catch(error => failStream(error.message));
  }, chunk => appendLog(rawLogFile, chunk));
  const stderrConsumer = createLineBufferConsumer(observeReadiness);
  deviceProcess.stdout.on('data', chunk => { appendLog(deviceLog, chunk); streamConsumer(chunk); });
  // stderr is evidence only, never an alternate protocol source.
  deviceProcess.stderr.on('data', chunk => { appendLog(deviceLog, chunk); stderrConsumer(chunk); });
  deviceProcess.on('error', err => failStream(`Unified log stream failed: ${err.message}`));
  deviceProcess.on('close', async (code, signal) => {
    streamConsumer.flush();
    stderrConsumer.flush();
    if (protocolArmed) await protocolQueue;
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
  lifecycle.enterPhase('startup:native-capture-build', seconds('--build-seconds', 120000));
  const nativeCapture = await startNativeCapture(lifecycle, device.udid, startTransport, { readinessBudget: seconds('--readiness-seconds', 240000) });
  if (parser.errors.length) throw new Error(parser.errors.join('; '));
  lifecycle.update('startup:launch/awaiting-STAGE_BEGIN');
  protocolArmed = true;
  console.log('[RUNNER] Launching app dev.kineticron.KineSync via console-pty with EXPO_PUBLIC_SIMULATOR_TEST=1...');
  const appProcess = startTransport('xcrun', [
    'simctl',
    'launch',
    '--terminate-running-process',
    '--console-pty',
    device.udid,
    'dev.kineticron.KineSync',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SIMCTL_CHILD_EXPO_PUBLIC_SIMULATOR_TEST: '1',
    },
  });

  lifecycle.children.push(appProcess);
  const launchLog = path.join(outputDir, 'launch-console.log');
  fs.writeFileSync(launchLog, '');
  const saveLaunchOutput = chunk => appendLog(launchLog, chunk);
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
  if (!nativePortraitRestored) assertionFailures.push('Missing native portrait restoration capture');

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

  parser.errors.push(...assertionFailures.filter(f => f.startsWith('Missing native portrait restoration') || f.startsWith('Missing screenshot capture') || f.startsWith('Invalid/blank screenshot')));
  const markdownReport = parser.generateMarkdownReport();
  fs.writeFileSync(summaryReportFile, markdownReport, 'utf8');

  const perfData = {
    summary: parser.summary,
    heartbeat: parser.heartbeat,
    stages: parser.stages,
    renderers: Array.from(parser.renderers),
    landscapeConfirmed: parser.landscapeConfirmed,
    portraitConfirmed: parser.portraitConfirmed,
    nativePortraitRestored,
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
