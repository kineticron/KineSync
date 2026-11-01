import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const execute = promisify(execFile);

export async function startupCommand(cmd, args, state, run = execute, cap = 30000) {
  state.check();
  const started = state.now();
  const record = { stage: state.stage, cmd, args, started, timeout: Math.max(1, Math.min(cap, state.remaining())) };
  try {
    const pending = run(cmd, args, { encoding: 'utf8', timeout: record.timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
    if (pending.child) state.children.push(pending.child);
    const { stdout } = await pending;
    state.check();
    return stdout;
  } catch (error) {
    record.error = { message: error.message, code: error.code, signal: error.signal, killed: error.killed };
    throw error;
  } finally {
    record.duration = state.now() - started;
    fs.appendFileSync(path.join(state.outputDir, 'startup-commands.jsonl'), JSON.stringify(record) + '\n');
  }
}

export async function selectToolchain(state, run = execute, developer = process.env.DEVELOPER_DIR) {
  state.check();
  if (!developer) throw new Error('Explicit DEVELOPER_DIR required (Xcode 27)');
  const canonical = fs.realpathSync(developer);
  if (!canonical.endsWith('.app/Contents/Developer')) throw new Error('Invalid Xcode developer directory');
  process.env.DEVELOPER_DIR = canonical;
  const command = (cmd, args, cap) => startupCommand(cmd, args, state, run, cap);
  const version = await command('xcodebuild', ['-version']);
  if (!/^Xcode 27(?:\.|\s)/.test(version)) throw new Error('Xcode 27 required');
  const sdk = (await command('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'])).trim();
  const sdkPath = (await command('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'])).trim();
  if (!/^27(?:\.|$)/.test(sdk) || !sdkPath.startsWith(canonical + '/')) throw new Error('Wrong simulator SDK/toolchain');
  await command('xcodebuild', ['-checkFirstLaunchStatus']);
  const simulator = path.join(canonical, 'Applications/Simulator.app');
  if (!fs.existsSync(simulator)) throw new Error('Selected Xcode has no Simulator.app');
  const info = { developer: canonical, simulator, version, sdk, sdkPath };
  fs.writeFileSync(path.join(state.outputDir, 'toolchain.json'), JSON.stringify(info, null, 2));
  return info;
}

export function verifySelected(inventory, selected, ready = false) {
  const entries = Object.entries(inventory.devices || {}).flatMap(([runtime, devices]) => devices.map(device => ({ ...device, runtime })));
  const device = entries.find(device => device.udid === selected.udid);
  if (!device || device.runtime !== selected.runtime || !device.isAvailable || (ready && device.state !== 'Booted')) throw new Error('Selected UDID/runtime unavailable or mismatched');
  if (entries.some(device => device.state === 'Booted' && device.udid !== selected.udid)) throw new Error('Conflicting booted simulator');
  return device;
}

export async function prepareSimulator(state, select, run = execute, disposable = process.env.GITHUB_ACTIONS === 'true' && process.env.SIMULATOR_DISPOSABLE_CI === '1') {
  const command = (args, cap = 30000) => startupCommand('xcrun', ['simctl', ...args], state, run, cap);
  let selected;
  let recovery = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      state.update('startup:inventory');
      const inventory = JSON.parse(await command(['list', 'devices', 'available', '-j']));
      if (!selected) {
        selected = select(inventory);
        state.device = selected.udid;
        state.ownsDevice = selected.state === 'Shutdown';
        fs.writeFileSync(path.join(state.outputDir, 'device-selection.json'), JSON.stringify(selected, null, 2));
      }
      const current = verifySelected(inventory, selected);
      if (!['Shutdown', 'Booting', 'Booted'].includes(current.state)) throw new Error('Selected simulator is in an unsafe transitional state');
      if (current.state === 'Shutdown') {
        state.update('startup:boot');
        await command(['boot', selected.udid], 20000);
      }
      state.update('startup:bootstatus');
      await command(['bootstatus', selected.udid, '-b'], 75000);
      state.update('startup:post-boot-enumeration');
      const readyInventory = JSON.parse(await command(['list', 'devices', 'available', '-j'], 30000));
      verifySelected(readyInventory, selected, true);
      state.readyInventory = readyInventory;
      return selected;
    } catch (error) {
      // Only transport timeouts justify service recovery. Identity/safety errors fail closed.
      if (!(error.killed || error.code === 'ETIMEDOUT' || error.code === 'ERR_CHILD_PROCESS_TIMEOUT')) throw error;
      await startupDiagnostics(state, run);
      state.check();
      if (attempt === 2) throw error;
      // Never restart a user's service. CI opt-in asserts an isolated disposable account.
      if (attempt === 1 && disposable && state.ownsDevice && !recovery) {
        recovery = true;
        state.update('startup:service-recovery');
        try {
          await startupCommand('/usr/bin/killall', ['-u', String(process.getuid()), '-TERM', 'com.apple.CoreSimulator.CoreSimulatorService'], state, run, 5000);
        } catch (error) {
          if (error.code !== 1) throw error;
          // killall also returns 1 when no matching process exists. Confirm absence;
          // permission errors or a still-running service must not be hidden.
          const processes = await startupCommand('/bin/ps', ['-u', String(process.getuid()), '-o', 'comm='], state, run, 5000);
          if (processes.split('\n').some(line => path.basename(line.trim()) === 'com.apple.CoreSimulator.CoreSimulatorService')) throw error;
        }
        // simctl's next inventory request activates the launchd-managed service; no invented launchctl label.
      }
    }
  }
}

export async function startupDiagnostics(state, run = execute) {
  // Independent of simctl; a single aggregate deadline also bounds hung process creation.
  const deadline = Math.min(state.now() + 6000, state.now() + Math.max(0, state.remaining()));
  for (const [name, cmd, args] of [
    ['processes', '/bin/ps', ['-axo', 'pid,ppid,uid,state,%cpu,%mem,etime,comm']],
    ['memory', '/usr/bin/vm_stat', []],
    ['services', '/bin/launchctl', ['list']],
  ]) {
    const remaining = deadline - state.now();
    if (remaining <= 0) break;
    try {
      const { stdout } = await run(cmd, args, { encoding: 'utf8', timeout: Math.min(2000, remaining), killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
      fs.writeFileSync(path.join(state.outputDir, `${name}.txt`), stdout);
    } catch (error) { fs.writeFileSync(path.join(state.outputDir, `${name}.txt`), `${error.code}: ${error.message}`); }
  }
}
