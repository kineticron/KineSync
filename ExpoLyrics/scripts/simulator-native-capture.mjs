import fs from 'node:fs';
import path from 'node:path';
import plist from 'plist';
import { randomUUID, createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { startupCommand } from './simulator-startup.mjs';

export const CAPTURE_BUNDLE = 'dev.kineticron.simulator-capture.xctrunner';

// One XCTest process owns the native capture mailbox for this simulator run.
export async function startNativeCapture(state, udid, startTransport, { command = startupCommand, pause = () => new Promise(resolve => setTimeout(resolve, 50)) } = {}) {
  const project = new URL('./native-simulator-capture/Capture.xcodeproj', import.meta.url).pathname;
  const derived = path.resolve(state.outputDir, 'diagnostics/native-capture-build');
  const args = ['-project', project, '-scheme', 'Capture', '-configuration', 'Release', '-destination', `platform=iOS Simulator,id=${udid}`, '-derivedDataPath', derived, '-parallel-testing-enabled', 'NO', 'CODE_SIGNING_ALLOWED=NO'];
  state.update('startup:native-capture-build');
  await command('xcodebuild', [...args, 'build-for-testing'], state);
  // XCTest reinstalls its runner. Do not bind transport to a pre-launch container.
  const mailbox = path.resolve(state.outputDir, 'diagnostics/native-capture-mailbox');
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
  const child = startTransport('xcodebuild', ['-xctestrun', configured, '-destination', `platform=iOS Simulator,id=${udid}`, '-parallel-testing-enabled', 'NO', 'test-without-building'], { stdio: ['ignore', 'pipe', 'pipe'] });
  state.children.push(child);
  let stopped = false;
  child.once('error', () => { stopped = true; });
  child.once('close', () => { stopped = true; });
  state.update('startup:native-capture-readiness');
  while (!fs.existsSync(path.join(mailbox, 'ready.json'))) {
    state.check();
    if (stopped) throw Error('Native capture runner exited before readiness');
    await pause();
  }
  state.check();
  if (stopped) throw Error('Native capture runner exited before readiness');
  const ready = JSON.parse(fs.readFileSync(path.join(mailbox, 'ready.json')));
  if (ready.session !== session || ready.mailbox !== mailbox) throw Error('Native capture readiness ownership mismatch');
  fs.writeFileSync(path.join(state.outputDir, 'native-capture-ready.json'), JSON.stringify(ready));
  return new NativeCapture({ mailbox, session, udid, state, alive: () => !stopped });
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
    const request = { session: this.session, id: randomUUID(), run, stage, token, orientation };
    const responseFile = path.join(this.mailbox, `${request.id}.json`);
    const pngFile = path.join(this.mailbox, `${request.id}.png`);
    fs.rmSync(destination, { force: true });
    fs.writeFileSync(path.join(this.mailbox, 'request.json.tmp'), JSON.stringify(request));
    fs.renameSync(path.join(this.mailbox, 'request.json.tmp'), path.join(this.mailbox, 'request.json'));
    const record = { ...request, udid: this.udid, destination, started: this.state.now() };
    try {
      while (!fs.existsSync(responseFile)) {
        this.state.check();
        if (!this.alive()) throw Error('Native capture runner exited');
        await this.pause();
      }
      this.state.check();
      if (!this.alive()) throw Error('Native capture runner exited');
      const response = JSON.parse(fs.readFileSync(responseFile));
      if (Object.entries(request).some(([key, value]) => response[key] !== value)) throw Error('Stale native capture response ownership');
      const bytes = fs.readFileSync(pngFile);
      // Retain the untouched API output even when decoding or orientation validation fails.
      fs.writeFileSync(destination, bytes);
      const image = PNG.sync.read(bytes);
      record.width = image.width; record.height = image.height;
      record.sha256 = createHash('sha256').update(bytes).digest('hex');
      if (orientation === 'landscape' ? image.width <= image.height : image.height <= image.width) throw Error(`Native ${orientation} screenshot dimensions invalid: ${image.width}x${image.height}`);
      this.state.check();
      return bytes;
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
