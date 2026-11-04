import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import plist from 'plist';
import { randomUUID, createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { startupCommand } from './simulator-startup.mjs';
import { reviewPNG } from './simulator-review-png.mjs';
import { nativePNGMetadata } from './simulator-png-metadata.mjs';

const execute = promisify(execFile);

export const APP_BUNDLE = 'dev.kineticron.KineSync';
export function validateCaptureAttestation(response, request, udid) {
  if (Object.entries(request).some(([key, value]) => response[key] !== value) || response.observedUDID !== udid || response.bundle !== APP_BUNDLE || response.foreground !== 'true' || response.deviceOrientation !== request.orientation || response.captureSource !== (request.orientation === 'landscape' ? 'XCUIWindow' : 'XCUIScreen')) throw Error('Native capture attestation ownership/foreground mismatch');
  const width = Number(response.windowWidth), height = Number(response.windowHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || (request.orientation === 'landscape' ? width <= height : height <= width)) throw Error('Native capture attestation window geometry mismatch');
}

export const CAPTURE_BUNDLE = 'dev.kineticron.simulator-capture.xctrunner';

// One XCTest process owns the native capture mailbox for this simulator run.
export async function startNativeCapture(state, udid, startTransport, { command = startupCommand, pause = () => new Promise(resolve => setTimeout(resolve, 50)), readinessBudget = 240000, diagnosticRun = execute } = {}) {
  const project = new URL('./native-simulator-capture/Capture.xcodeproj', import.meta.url).pathname;
  const derived = path.resolve(state.outputDir, 'diagnostics/native-capture-build');
  const args = ['-project', project, '-scheme', 'Capture', '-configuration', 'Release', '-destination', `platform=iOS Simulator,id=${udid}`, '-derivedDataPath', derived, '-parallel-testing-enabled', 'NO', 'CODE_SIGNING_ALLOWED=NO'];
  state.update('startup:native-capture-build');
  await command('xcodebuild', [...args, 'build-for-testing'], state);
  for (let attempt = 1; attempt <= 2; attempt++) {
  // XCTest reinstalls its runner. Do not bind transport to a pre-launch container.
  const mailbox = path.resolve(state.outputDir, `diagnostics/native-capture-mailbox${attempt === 1 ? '' : '-retry'}`);
  fs.rmSync(mailbox, { recursive: true, force: true });
  fs.mkdirSync(mailbox, { recursive: true });
  const session = randomUUID();
  const products = path.join(derived, 'Build/Products');
  const manifests = fs.readdirSync(products).filter(name => name.endsWith('.xctestrun') && name !== 'Capture-mailbox.xctestrun');
  if (manifests.length !== 1) throw Error('Expected one native capture xctestrun manifest');
  const manifest = path.join(products, manifests[0]);
  const configuration = plist.parse(fs.readFileSync(manifest, 'utf8'));
  configureCaptureTransport(configuration, mailbox, session);
  // Preserve __TESTROOT__ resolution by writing beside the generated manifest.
  const configured = path.join(products, 'Capture-mailbox.xctestrun');
  fs.writeFileSync(configured, plist.build(configuration));
  fs.writeFileSync(path.join(state.outputDir, 'native-capture-startup.json'), JSON.stringify({ mailbox, session, manifest, configured }));
  if (typeof state.enterPhase === 'function') state.enterPhase('startup:native-capture-readiness', readinessBudget);
  else state.update('startup:native-capture-readiness');
  const started = Date.now();
  const now = state.now || Date.now;
  const readinessDeadline = state.deadline ?? now() + readinessBudget;
  const evidence = path.join(state.outputDir, `diagnostics/capture-startup-${attempt}`);
  fs.mkdirSync(evidence, { recursive: true });
  const child = startTransport('xcodebuild', ['-resultBundlePath', path.join(evidence, 'runner.xcresult'), '-xctestrun', configured, '-destination', `platform=iOS Simulator,id=${udid}`, '-parallel-testing-enabled', 'NO', 'test-without-building'], { stdio: ['ignore', 'pipe', 'pipe'] });
  state.children.push(child);
  for (const stream of ['stdout', 'stderr']) {
    let retained = 0;
    child[stream]?.on('data', chunk => {
      if (retained < 8 * 1024 * 1024) fs.appendFileSync(path.join(evidence, `xcodebuild-${stream}.log`), chunk.subarray(0, 8 * 1024 * 1024 - retained));
      retained += chunk.length;
    });
  }
  const event = (status, details = {}) => fs.appendFileSync(path.join(evidence, 'timeline.jsonl'), JSON.stringify({ status, at: new Date().toISOString(), session, mailbox, pid: child.pid, ...details }) + '\n');
  event('transport-started');
  let stopped = false;
  child.once('error', error => { stopped = true; event('transport-error', { message: error.message, code: error.code }); });
  child.once('close', (code, signal) => { stopped = true; event('transport-close', { code, signal }); });
  while (!fs.existsSync(path.join(mailbox, 'ready.json'))) {
    if (stopped) throw Error('Native capture runner exited before readiness');
    if (now() >= readinessDeadline) break;
    try { state.check(); }
    catch (error) {
      if (state.stage !== 'startup:native-capture-readiness' || now() < readinessDeadline) throw error;
      break;
    }
    if (stopped) throw Error('Native capture runner exited before readiness');
    await pause();
  }
  if (!fs.existsSync(path.join(mailbox, 'ready.json'))) {
    event('readiness-timeout');
    // Reset only the phase ceiling; the lifecycle retains its overall deadline.
    if (state.recoverNativeCaptureReadiness) state.recoverNativeCaptureReadiness();
    else state.check();
    const bounded = async (name, cmd, args) => {
      state.check();
      try {
        const result = await diagnosticRun(cmd, args, { timeout: Math.max(1, Math.min(4000, state.remaining?.() ?? 4000)), killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
        fs.writeFileSync(path.join(evidence, name), result.stdout + result.stderr);
      } catch (error) { fs.writeFileSync(path.join(evidence, name), `${error.stdout || ''}\n${error.stderr || ''}\n${error.message} code=${error.code} signal=${error.signal}`); }
    };
    await bounded('processes.log', '/bin/ps', ['-axo', 'pid,ppid,state,etime,command']);
    child.kill?.('SIGTERM');
    const cleanupEnd = Date.now() + 2000;
    while (!stopped && Date.now() < cleanupEnd) await new Promise(resolve => setTimeout(resolve, 50));
    if (!stopped) child.kill?.('SIGKILL');
    await bounded('runner-terminate.log', 'xcrun', ['simctl', 'terminate', udid, CAPTURE_BUNDLE]);
    await bounded('simulator-state.json', 'xcrun', ['simctl', 'list', 'devices', '-j']);
    await bounded('runner-testmanager.log', 'xcrun', ['simctl', 'spawn', udid, 'log', 'show', '--last', '5m', '--style', 'compact', '--predicate', 'process CONTAINS "Capture" OR process CONTAINS "testmanager"']);
    const crashDir = path.join(os.homedir(), 'Library/Logs/DiagnosticReports');
    for (const entry of fs.existsSync(crashDir) ? fs.readdirSync(crashDir) : []) {
      const source = path.join(crashDir, entry);
      if (/Capture|testmanager|xcodebuild/i.test(entry) && fs.statSync(source).isFile() && fs.statSync(source).mtimeMs >= started && fs.statSync(source).size <= 8 * 1024 * 1024) fs.copyFileSync(source, path.join(evidence, entry));
    }
    event('cleanup-finished');
    state.check();
    if (!stopped) throw Error('Native capture runner cleanup did not complete');
    if (attempt === 2) throw Error('Native capture readiness timeout after two attempts');
    continue;
  }
  state.check();
  if (stopped) throw Error('Native capture runner exited before readiness');
  const ready = JSON.parse(fs.readFileSync(path.join(mailbox, 'ready.json')));
  if (ready.session !== session || ready.mailbox !== mailbox) throw Error('Native capture readiness ownership mismatch');
  fs.writeFileSync(path.join(state.outputDir, 'native-capture-ready.json'), JSON.stringify(ready));
  event('ready');
  return new NativeCapture({ mailbox, session, udid, state, alive: () => !stopped });
  }
}

export function configureCaptureTransport(configuration, mailbox, session) {
  const target = configuration.Capture;
  if (configuration.__xctestrun_metadata__?.FormatVersion !== 1 ||
      target?.TestHostBundleIdentifier !== CAPTURE_BUNDLE || !target.IsUITestBundle) {
    throw Error('Unexpected native capture xctestrun configuration');
  }
  target.EnvironmentVariables = { ...target.EnvironmentVariables,
    KINESYNC_CAPTURE_MAILBOX: mailbox, KINESYNC_CAPTURE_SESSION: session };
}

export class NativeCapture {
  constructor({ mailbox, session, udid, state, alive = () => true, pause = () => new Promise(resolve => setTimeout(resolve, 20)) }) {
    if (typeof session !== 'string' || !/^[a-f0-9-]{36}$/i.test(session)) throw Error('Invalid native capture session');
    Object.assign(this, { mailbox, session, udid, state, alive, pause });
  }
  async capture(destination, { run, stage, token, orientation }) {
    if (!run || !stage || token !== `${run}_${stage}` || !['portrait', 'landscape'].includes(orientation)) throw Error('Invalid native capture request ownership');
    this.state.check();
    if (!this.alive()) throw Error('Native capture runner exited');
    const request = { session: this.session, id: randomUUID(), run, stage, token, orientation, udid: this.udid, phase: 'before' };
    const responseFile = path.join(this.mailbox, `${request.id}.json`);
    const pngFile = path.join(this.mailbox, `${request.id}.png`);
    fs.rmSync(destination, { force: true });
    fs.writeFileSync(path.join(this.mailbox, 'request.json.tmp'), JSON.stringify(request));
    fs.renameSync(path.join(this.mailbox, 'request.json.tmp'), path.join(this.mailbox, 'request.json'));
    const record = { ...request, udid: this.udid, destination, started: this.state.now() };
    try {
      const attestationDeadline = this.state.now() + 30000;
      while (!fs.existsSync(responseFile)) {
        this.state.check();
        if (this.state.now() >= attestationDeadline) throw Error('Native capture attestation timeout');
        if (!this.alive()) throw Error('Native capture runner exited');
        await this.pause();
      }
      this.state.check();
      if (!this.alive()) throw Error('Native capture runner exited');
      const response = JSON.parse(fs.readFileSync(responseFile));
      if (Object.entries(request).some(([key, value]) => response[key] !== value)) throw Error('Stale native capture response ownership');
      validateCaptureAttestation(response, request, this.udid);
      record.before = response;
      const after = { ...request, id: randomUUID(), phase: 'after' };
      const afterFile = path.join(this.mailbox, `${after.id}.json`);
      fs.writeFileSync(path.join(this.mailbox, 'request.json.tmp'), JSON.stringify(after));
      fs.renameSync(path.join(this.mailbox, 'request.json.tmp'), path.join(this.mailbox, 'request.json'));
      const afterDeadline = this.state.now() + 30000;
      while (!fs.existsSync(afterFile)) {
        this.state.check();
        if (this.state.now() >= afterDeadline) throw Error('Native capture attestation timeout');
        if (!this.alive()) throw Error('Native capture runner exited');
        await this.pause();
      }
      const observedAfter = JSON.parse(fs.readFileSync(afterFile));
      validateCaptureAttestation(observedAfter, after, this.udid);
      record.after = observedAfter;
      fs.rmSync(afterFile);
      record.source = response.captureSource;
      const bytes = fs.readFileSync(pngFile);
      // Retain the untouched API output even when decoding or orientation validation fails.
      fs.writeFileSync(destination, bytes);
      const image = PNG.sync.read(bytes);
      record.width = image.width; record.height = image.height;
      record.exifOrientation = nativePNGMetadata(bytes).exifOrientation;
      record.sha256 = createHash('sha256').update(bytes).digest('hex');
      const originalFile = `originals/${request.id}.png`;
      fs.mkdirSync(path.join(this.state.outputDir, 'originals'), { recursive: true });
      fs.writeFileSync(path.join(this.state.outputDir, originalFile), bytes);
      record.originalFile = originalFile;
      const review = reviewPNG(bytes, orientation);
      record.review = review.conversion;
      fs.writeFileSync(destination, review.bytes);
      this.state.check();
      return review.bytes;
    } catch (error) {
      record.error = error.message;
      if (fs.existsSync(pngFile)) {
        const rejected = path.join(this.state.outputDir, 'diagnostics', `unacknowledged-${request.id}.png`);
        fs.mkdirSync(path.dirname(rejected), { recursive: true });
        fs.copyFileSync(pngFile, rejected);
        record.rejectedPNG = rejected;
      }
      throw error;
    }
    finally {
      record.ended = this.state.now();
      fs.appendFileSync(path.join(this.state.outputDir, 'native-captures.jsonl'), JSON.stringify(record) + '\n');
      for (const file of [responseFile, pngFile]) fs.rmSync(file, { force: true });
    }
  }
}
