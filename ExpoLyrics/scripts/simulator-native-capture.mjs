import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { startupCommand } from './simulator-startup.mjs';

export const CAPTURE_BUNDLE = 'dev.kineticron.simulator-capture.xctrunner';

// One XCTest process owns the native capture mailbox for this simulator run.
export async function startNativeCapture(state, udid, startTransport) {
  const project = new URL('./native-simulator-capture/Capture.xcodeproj', import.meta.url).pathname;
  const derived = path.resolve(state.outputDir, 'diagnostics/native-capture-build');
  const args = ['-project', project, '-scheme', 'Capture', '-configuration', 'Release', '-destination', `platform=iOS Simulator,id=${udid}`, '-derivedDataPath', derived, '-parallel-testing-enabled', 'NO', 'CODE_SIGNING_ALLOWED=NO'];
  state.update('startup:native-capture-build');
  await startupCommand('xcodebuild', [...args, 'build-for-testing'], state);
  const runner = path.join(derived, 'Build/Products/Release-iphonesimulator/Capture-Runner.app');
  await startupCommand('xcrun', ['simctl', 'install', udid, runner], state);
  const container = (await startupCommand('xcrun', ['simctl', 'get_app_container', udid, CAPTURE_BUNDLE, 'data'], state)).trim();
  if (!container || !fs.existsSync(container)) throw Error('Native capture container unavailable');
  const mailbox = path.join(container, 'Library/Caches/kinesync-capture');
  fs.rmSync(mailbox, { recursive: true, force: true });
  const child = startTransport('xcodebuild', [...args, 'test-without-building'], { stdio: ['ignore', 'pipe', 'pipe'] });
  state.children.push(child);
  let stopped = false;
  child.once('error', () => { stopped = true; });
  child.once('close', () => { stopped = true; });
  state.update('startup:native-capture-readiness');
  while (!fs.existsSync(path.join(mailbox, 'ready.json'))) {
    state.check();
    if (stopped) throw Error('Native capture runner exited before readiness');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const { session } = JSON.parse(fs.readFileSync(path.join(mailbox, 'ready.json')));
  return new NativeCapture({ mailbox, session, udid, state, alive: () => !stopped });
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
