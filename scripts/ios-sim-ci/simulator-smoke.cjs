// Boot a fresh simulator, install the Debug app, and prove real onboarding UI
// while no Metro listener exists. OCR evidence is uploaded even on failure.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./config.json');

const normalize = value => String(value).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
const REQUIRED = config.onboarding.required;
const EVIDENCE_TEXT = ['Skip', 'A modern, beautiful mobile app', 'syllable-synced lyrics', 'Spotify playback'];
const BOOT_TIMEOUT_MS = 5 * 60 * 1000;

function matchOnboarding(text, settings = config.onboarding) {
  const normalized = normalize(text);
  const missing = REQUIRED.filter(value => !normalized.includes(normalize(value)));
  const evidence = EVIDENCE_TEXT.filter(value => normalized.includes(normalize(value)));
  const forbidden = (settings.forbidden || []).filter(value => normalized.includes(normalize(value)));
  return { matched: missing.length === 0 && evidence.length > 0 && forbidden.length === 0, missing, evidence, forbidden };
}

function run(command, args, { timeout = 120000, stage = args[0] === 'simctl' ? `simctl ${args[1]}` : command, ...options } = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, ...options });
  if (result.error || result.status !== 0) {
    const timedOut = result.error?.code === 'ETIMEDOUT';
    const reason = timedOut ? `timed out after ${timeout} ms` : result.error?.message || `failed (${result.signal || result.status})`;
    const error = new Error(`${stage}: ${command} ${args.join(' ')} ${reason}`, { cause: result.error });
    error.commandFailure = {
      stage, command, args, timeout_ms: timeout, timed_out: timedOut, elapsed_ms: Date.now() - started,
      exit_code: result.status, signal: result.signal, error_code: result.error?.code || null,
      stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    };
    throw error;
  }
  return result.stdout;
}

function metroListeners() {
  const found = [];
  for (const port of [8081, 8082, 19000, 19001, 65534]) {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) found.push({ port, output: result.stdout.trim() });
    else if (result.error) throw result.error;
    else if (result.status !== 1) throw new Error(`Cannot inspect Metro port ${port}: ${result.stderr}`);
  }
  return found;
}

function selectSimulator(parsed, minimum = config.rust.iosDeploymentTarget) {
  const versionCode = value => {
    const parts = String(value).split('.').map(Number);
    return (parts[0] << 16) + ((parts[1] || 0) << 8) + (parts[2] || 0);
  };
  const runtimes = parsed.runtimes.filter(runtime => runtime.isAvailable && /\.iOS-/.test(runtime.identifier) && versionCode(runtime.version) >= versionCode(minimum))
    .sort((a, b) => versionCode(b.version) - versionCode(a.version));
  for (const runtime of runtimes) {
    const supported = runtime.supportedDeviceTypes?.map(type => typeof type === 'string' ? type : type.identifier);
    const devices = parsed.devicetypes.filter(type => /^iPhone/.test(type.name) && (supported?.length
      ? supported.includes(type.identifier)
      : Number.isFinite(type.minRuntimeVersion) && Number.isFinite(type.maxRuntimeVersion) && versionCode(runtime.version) >= type.minRuntimeVersion && versionCode(runtime.version) <= type.maxRuntimeVersion));
    if (devices.length) return { runtime: runtime.identifier, deviceType: devices[devices.length - 1].identifier };
  }
  throw new Error('No compatible available iPhone simulator runtime/device type');
}
function simulatorPair() {
  return selectSimulator(JSON.parse(run('xcrun', ['simctl', 'list', '-j'])));
}

async function main() {
  const app = path.resolve(process.argv[2] || '');
  const bundleId = process.argv[3] || config.expectedBundleIdentifier;
  const evidence = path.resolve(process.argv[4] || process.env.CI_EVIDENCE_DIR || 'simulator-smoke-evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const name = `KineSync Revyl CI ${process.env.GITHUB_RUN_ID || Date.now()}`;
  const result = { app, bundleId, name, attempts: [] };
  try {
    if (!fs.existsSync(app) || !app.endsWith('.app')) throw new Error(`Missing .app: ${app}`);
    result.metro_listeners = metroListeners();
    if (result.metro_listeners.length) throw new Error(`Metro-like listener present before smoke: ${JSON.stringify(result.metro_listeners)}`);
    const pair = simulatorPair();
    Object.assign(result, pair);
    const udid = run('xcrun', ['simctl', 'create', name, pair.deviceType, pair.runtime]).trim();
    result.udid = udid;
    run('xcrun', ['simctl', 'boot', udid]);
    run('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeout: BOOT_TIMEOUT_MS, killSignal: 'SIGKILL' });
    spawnSync('xcrun', ['simctl', 'uninstall', udid, bundleId], { encoding: 'utf8' });
    run('xcrun', ['simctl', 'install', udid, app]);
    const childEnv = { ...process.env, SIMCTL_CHILD_RCT_METRO_PORT: '65534', SIMCTL_CHILD_EXPO_PUBLIC_BRIDGE_WS_URL: '',
      SIMCTL_CHILD_EXPO_PUBLIC_PERFORMANCE_SCENARIO: '', SIMCTL_CHILD_KINESYNC_ISOLATED_LYRICS_LAB: '' };
    const launched = run('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, bundleId], { env: childEnv });
    result.launch = launched.trim();
    result.pid = launched.match(/:\s*(\d+)\s*$/)?.[1] || null;
    const started = Date.now();
    let last = null;
    for (let attempt = 1; attempt <= 18 && Date.now() - started < 90000; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const shot = path.join(evidence, `simulator-${String(attempt).padStart(2, '0')}.png`);
      run('xcrun', ['simctl', 'io', udid, 'screenshot', shot]);
      const ocr = JSON.parse(run('xcrun', ['swift', path.join(__dirname, 'ocr.swift'), shot], { stage: 'ocr', timeout: 30000 }));
      const text = ocr.lines.join('\n');
      const match = matchOnboarding(text);
      last = { attempt, screenshot: shot, text, ocr, ...match };
      result.attempts.push(last);
      fs.writeFileSync(path.join(evidence, 'ocr.json'), JSON.stringify(result, null, 2) + '\n');
      if (match.matched) break;
    }
    const log = spawnSync('xcrun', ['simctl', 'spawn', udid, 'log', 'show', '--last', '5m', '--style', 'compact', '--predicate', `process == "KineSync"`], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
    if (log.stdout) fs.writeFileSync(path.join(evidence, 'simulator-app.log'), log.stdout);
    if (!last?.matched) throw new Error(`No KineSync onboarding UI after bounded retries. Last OCR: ${JSON.stringify(last?.text || '')}`);
    result.metro_listeners_after = metroListeners();
    if (result.metro_listeners_after.length) throw new Error('Metro-like listener appeared during smoke');
    result.smoke_passed = true;
    result.proof = 'KineSync onboarding title and Start Setup rendered with no local Metro listener';
    result.limitation = 'Onboarding proves app startup with no local Metro listener. It does not prove Rust renderer presentation or network isolation.';
  } catch (error) {
    result.smoke_passed = false;
    result.error = error.message;
    if (error.commandFailure) result.command_failure = error.commandFailure;
    throw error;
  } finally {
    fs.writeFileSync(path.join(evidence, 'smoke.json'), JSON.stringify(result, null, 2) + '\n');
    if (result.udid) {
      spawnSync('xcrun', ['simctl', 'shutdown', result.udid], { encoding: 'utf8', timeout: 15000 });
      spawnSync('xcrun', ['simctl', 'delete', result.udid], { encoding: 'utf8', timeout: 15000 });
    }
  }
  console.log(JSON.stringify({ passed: true, udid: result.udid, attempts: result.attempts.length, proof: result.proof }));
}

if (require.main === module) {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { matchOnboarding, normalize, metroListeners, REQUIRED, EVIDENCE_TEXT, selectSimulator };
