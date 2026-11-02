import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { PNG } from 'pngjs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const execute = promisify(execFile);
// Stable macos-26 image: Xcode 26.6 ships SDK/runtime 26.5.
export const SUPPORTED_RUNTIME_POLICY = Object.freeze({
  sdk: '26.5', runtimeVersion: '26.5',
  runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
});

export async function startupCommand(cmd, args, state, run = execute, cap = Infinity) {
  state.check();
  const started = state.now();
  const record = { stage: state.stage, cmd, args, started, timeout: Math.max(1, Math.min(cap, state.remaining())) };
  const id = state.commandSerial = (state.commandSerial || 0) + 1;
  const files = {};
  let stdout = '', stderr = '';
  for (const stream of ['stdout', 'stderr']) {
    record[stream] = `command-${id}-${stream}.log`;
    files[stream] = path.join(state.outputDir, record[stream]);
    fs.writeFileSync(files[stream], '');
  }
  fs.appendFileSync(path.join(state.outputDir, 'command-starts.jsonl'), JSON.stringify(record) + '\n');
  let streaming = false;
  try {
    if (args.includes('screenshot')) fs.rmSync(args.at(-1), { force: true });
    const pending = run(cmd, args, { encoding: 'buffer', timeout: record.timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
    if (pending.child) {
      state.children.push(pending.child); pending.child.stdin?.end();
      streaming = Boolean(pending.child.stdout && pending.child.stderr);
      if (streaming) for (const stream of ['stdout', 'stderr']) {
        let retained = 0;
        pending.child[stream].on('data', chunk => {
          const bytes = Buffer.from(chunk);
          const available = Math.max(0, 8 * 1024 * 1024 - retained);
          fs.appendFileSync(files[stream], bytes.subarray(0, available));
          retained += bytes.length;
          if (bytes.length > available) fs.writeFileSync(`${files[stream]}.truncated`, '8 MiB retention limit reached');
        });
      }
    }
    ({ stdout, stderr } = await pending);
    record.exitCode = 0;
    if (args.includes('screenshot')) {
      const image = PNG.sync.read(fs.readFileSync(args.at(-1)));
      record.png = { width: image.width, height: image.height };
    }
    state.check();
    return typeof stdout === 'string' ? stdout : stdout.toString('utf8');
  } catch (error) {
    stdout = error.stdout ?? stdout; stderr = error.stderr ?? stderr;
    record.error = { message: error.message, code: error.code, signal: error.signal, killed: error.killed };
    throw error;
  } finally {
    record.ended = state.now();
    record.exitCode ??= typeof record.error?.code === 'number' ? record.error.code : null;
    record.duration = record.ended - started;
    if (!streaming) {
      fs.writeFileSync(files.stdout, stdout || '');
      fs.writeFileSync(files.stderr, stderr || '');
    }
    fs.appendFileSync(path.join(state.outputDir, 'startup-commands.jsonl'), JSON.stringify(record) + '\n');
  }
}

export async function selectToolchain(state, run = execute, developer = process.env.DEVELOPER_DIR) {
  state.check();
  if (!developer) throw new Error('Explicit DEVELOPER_DIR required (Xcode 26)');
  const canonical = fs.realpathSync(developer);
  if (!canonical.endsWith('.app/Contents/Developer')) throw new Error('Invalid Xcode developer directory');
  process.env.DEVELOPER_DIR = canonical;
  const command = (cmd, args, cap) => startupCommand(cmd, args, state, run, cap);
  const version = await command('xcodebuild', ['-version']);
  if (!/^Xcode 26\.6(?:\s|$)/.test(version)) throw new Error('Xcode 26.6 required');
  const sdk = (await command('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'])).trim();
  const sdkPath = (await command('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'])).trim();
  if (sdk !== SUPPORTED_RUNTIME_POLICY.sdk || !sdkPath.startsWith(canonical + '/')) throw new Error('Wrong simulator SDK/toolchain');
  await command('xcodebuild', ['-checkFirstLaunchStatus']);
  const runtimes = JSON.parse(await enumerateRuntimes(state, run));
  if (!runtimes.runtimes?.some(runtime => runtime.identifier === SUPPORTED_RUNTIME_POLICY.runtime && runtime.isAvailable === true)) throw new Error('Configured iOS runtime unavailable');
  state.runtimePolicy = SUPPORTED_RUNTIME_POLICY;
  const info = { developer: canonical, version, sdk, sdkPath, runtimePolicy: SUPPORTED_RUNTIME_POLICY };
  fs.writeFileSync(path.join(state.outputDir, 'toolchain.json'), JSON.stringify(info, null, 2));
  return info;
}

// One uninterrupted inventory operation shares the boot deadline.
export async function enumerateRuntimes(state, run = execute) {
  return startupCommand('xcrun', ['simctl', 'list', 'runtimes', '-j'], state, run);
}

export function verifySelected(inventory, selected, ready = false) {
  const entries = Object.entries(inventory.devices || {}).flatMap(([runtime, devices]) => devices.map(device => ({ ...device, runtime })));
  const device = entries.find(device => device.udid === selected.udid);
  if (!device || selected.runtime !== SUPPORTED_RUNTIME_POLICY.runtime || device.runtime !== selected.runtime || !device.isAvailable || (ready && device.state !== 'Booted')) throw new Error('Selected UDID/runtime unavailable or mismatched');
  if (entries.some(device => ['Booted', 'Booting'].includes(device.state) && device.udid !== selected.udid)) throw new Error('Conflicting booted or booting simulator');
  return device;
}

export async function prepareSimulator(state, select, run = execute) {
  const command = args => startupCommand('xcrun', ['simctl', ...args], state, run);
  state.update('startup:inventory');
  const inventory = JSON.parse(await command(['list', 'devices', 'available', '-j']));
  const selected = select(inventory, state.runtimePolicy || SUPPORTED_RUNTIME_POLICY);
  const current = verifySelected(inventory, selected);
  if (!['Shutdown', 'Booting', 'Booted'].includes(current.state)) throw new Error('Selected simulator is in an unsafe transitional state');
  state.device = selected.udid;
  state.ownsDevice = current.state === 'Shutdown';
  fs.writeFileSync(path.join(state.outputDir, 'device-selection.json'), JSON.stringify(selected, null, 2));
  if (current.state === 'Shutdown') {
    state.update('startup:boot');
    await command(['boot', selected.udid]);
  }
  state.update('startup:bootstatus');
  await command(['bootstatus', selected.udid, '-b']);
  state.update('startup:post-boot-enumeration');
  state.readyInventory = JSON.parse(await command(['list', 'devices', 'available', '-j']));
  verifySelected(state.readyInventory, selected, true);
  return selected;
}

export async function startupDiagnostics(state, run = execute) {
  const deadline = Math.min(state.overallDeadline, state.now() + 180000);
  for (const [name, cmd, args] of [
    ['processes', '/bin/ps', ['-axo', 'pid,ppid,uid,state,%cpu,%mem,etime,comm']],
    ['memory', '/usr/bin/vm_stat', []],
    ['services', '/bin/launchctl', ['list']],
  ]) {
    const remaining = deadline - state.now();
    if (remaining <= 0) break;
    try {
      const stdout = await startupCommand(cmd, args, state, run, Math.min(60000, remaining));
      fs.writeFileSync(path.join(state.outputDir, `${name}.txt`), stdout);
    } catch (error) { fs.writeFileSync(path.join(state.outputDir, `${name}.txt`), `${error.stdout || ''}\n${error.stderr || ''}\n${error.code}: ${error.message}`); }
  }
}
