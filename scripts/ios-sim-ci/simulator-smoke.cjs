// Boot a fresh simulator, install the Debug app, and prove real onboarding UI
// while no Metro listener exists. OCR evidence is uploaded even on failure.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./config.json');

const normalize = value => String(value).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
const REQUIRED = ['KineSync', 'Start Setup'];
const EVIDENCE_TEXT = ['Skip', 'A modern, beautiful mobile app', 'syllable-synced lyrics', 'Spotify playback'];

function matchOnboarding(text, settings = config.onboarding) {
  const normalized = normalize(text);
  const missing = REQUIRED.filter(value => !normalized.includes(normalize(value)));
  const evidence = EVIDENCE_TEXT.filter(value => normalized.includes(normalize(value)));
  const forbidden = (settings.forbidden || []).filter(value => normalized.includes(normalize(value)));
  return { matched: missing.length === 0 && evidence.length > 0 && forbidden.length === 0, missing, evidence, forbidden };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

function metroListeners() {
  const found = [];
  for (const port of [8081, 8082, 19000, 19001, 65534]) {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) found.push({ port, output: result.stdout.trim() });
    else if (result.error) throw result.error;
  }
  return found;
}

function simulatorPair() {
  const parsed = JSON.parse(run('xcrun', ['simctl', 'list', '-j']));
  const runtimes = parsed.runtimes.filter(runtime => runtime.isAvailable && /ios/i.test(runtime.identifier));
  const deviceTypes = parsed.devicetypes.filter(type => /^iPhone/.test(type.name));
  if (!runtimes.length || !deviceTypes.length) throw new Error('No available iPhone simulator runtime/device type');
  return { runtime: runtimes[0].identifier, deviceType: deviceTypes[0].identifier };
}

async function main() {
  const app = path.resolve(process.argv[2] || '');
  const bundleId = process.argv[3] || config.expectedBundleIdentifier;
  const evidence = path.resolve(process.argv[4] || process.env.CI_EVIDENCE_DIR || 'simulator-smoke-evidence');
  fs.mkdirSync(evidence, { recursive: true });
  if (!fs.existsSync(app) || !app.endsWith('.app')) throw new Error(`Missing .app: ${app}`);
  const listeners = metroListeners();
  if (listeners.length) throw new Error(`Metro-like listener present before smoke: ${JSON.stringify(listeners)}`);
  const pair = simulatorPair();
  const name = `KineSync Revyl CI ${process.env.GITHUB_RUN_ID || Date.now()}`;
  const udid = run('xcrun', ['simctl', 'create', name, pair.deviceType, pair.runtime]).trim();
  const result = { app, bundleId, name, udid, runtime: pair.runtime, deviceType: pair.deviceType, attempts: [], metro_listeners: listeners };
  try {
    run('xcrun', ['simctl', 'boot', udid]);
    run('xcrun', ['simctl', 'bootstatus', udid, '-b']);
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
      await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 5000 : 5000));
      const shot = path.join(evidence, `simulator-${String(attempt).padStart(2, '0')}.png`);
      run('xcrun', ['simctl', 'io', udid, 'screenshot', shot]);
      const ocr = spawnSync('xcrun', ['swift', path.join(__dirname, 'ocr.swift'), shot], { encoding: 'utf8' });
      if (ocr.status !== 0) throw new Error(`OCR failed: ${ocr.stderr || ocr.stdout}`);
      const text = JSON.parse(ocr.stdout).lines.join('\n');
      const match = matchOnboarding(text);
      last = { attempt, screenshot: shot, text, ocr: JSON.parse(ocr.stdout), ...match };
      result.attempts.push(last);
      fs.writeFileSync(path.join(evidence, 'ocr.json'), JSON.stringify(result, null, 2) + '\n');
      if (match.matched) break;
    }
    const log = spawnSync('xcrun', ['simctl', 'spawn', udid, 'log', 'show', '--last', '5m', '--style', 'compact', '--predicate', `process == "KineSync"`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (log.stdout) fs.writeFileSync(path.join(evidence, 'simulator-app.log'), log.stdout);
    if (!last?.matched) throw new Error(`No KineSync onboarding UI after bounded retries. Last OCR: ${JSON.stringify(last?.text || '')}`);
    result.smoke_passed = true;
    result.proof = 'KineSync onboarding title and Start Setup rendered with no local Metro listener';
    result.limitation = 'Onboarding proves app startup with no local Metro listener. It does not prove Rust renderer presentation or network isolation.';
    fs.writeFileSync(path.join(evidence, 'smoke.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ passed: true, udid, attempts: result.attempts.length, proof: result.proof }));
  } finally {
    spawnSync('xcrun', ['simctl', 'shutdown', udid], { encoding: 'utf8' });
    spawnSync('xcrun', ['simctl', 'delete', udid], { encoding: 'utf8' });
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { matchOnboarding, normalize, metroListeners, REQUIRED, EVIDENCE_TEXT };
