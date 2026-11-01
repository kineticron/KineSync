import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SimulatorRunLifecycle } from './simulator-run-lifecycle.mjs';
import { startupCommand, prepareSimulator, verifySelected, startupDiagnostics, selectToolchain, SUPPORTED_RUNTIME_POLICY } from './simulator-startup.mjs';
import { selectSimulatorDevice, rotateSimulator } from './run-ios-simulator-test.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-test-'));
const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';
const phone = { udid: 'known', name: 'iPhone 17', state: 'Shutdown', isAvailable: true };
const inventory = device => JSON.stringify({ devices: { [runtime]: [device] } });
const timeout = () => Object.assign(new Error('fake timeout'), { code: 'ETIMEDOUT', killed: true });
let serial = 0;
const make = (budget = 300000) => {
  let time = 0;
  const state = new SimulatorRunLifecycle(path.join(dir, String(serial++)), { now: () => time, startupMs: budget, overallMs: budget, ciDeadlineMs: Infinity });
  return { state, advance: ms => { time += ms; } };
};
try {
  for (const failure of ['list', 'boot', 'bootstatus', 'postboot', 'none', 'exhausted']) {
    const { state, advance } = make();
    const calls = [];
    let booted = false, failed = false, recovered = false;
    const run = async (cmd, args, options) => {
      calls.push([cmd, args]);
      assert.ok(options.timeout <= state.remaining());
      if (cmd !== 'xcrun') { recovered ||= cmd === '/usr/bin/killall'; return { stdout: '' }; }
      const verb = args[1];
      const hit = failure === 'exhausted' || (!failed && (verb === failure || (failure === 'postboot' && verb === 'list' && booted)));
      if (hit) { failed = true; advance(options.timeout); throw timeout(); }
      advance(verb === 'list' ? 12000 : 1000); // successful enumeration exceeds old 5s cap
      if (verb === 'boot') booted = true;
      return { stdout: inventory({ ...phone, state: booted ? 'Booted' : 'Shutdown' }) };
    };
    if (failure === 'exhausted') await assert.rejects(prepareSimulator(state, selectSimulatorDevice, run, true), /timeout/);
    else assert.equal((await prepareSimulator(state, selectSimulatorDevice, run, true)).udid, 'known');
    assert.equal(recovered, false, 'Discovery failure has no ownership; single timeout only retries');
    assert.ok(calls.filter(([cmd]) => cmd === 'xcrun').every(([, args]) => !args.includes('erase') && !args.includes('shutdown')));
  }
  for (const disposable of [false, true]) {
    const { state } = make(); let lists = 0, restarted = false;
    const run = async (cmd, args) => {
      if (cmd === '/usr/bin/killall') { restarted = true; return { stdout: '' }; }
      if (cmd !== 'xcrun') return { stdout: '' };
      if (args[1] === 'list') {
        lists++;
        if (lists === 2 || lists === 3) throw timeout();
        return { stdout: inventory({ ...phone, state: lists > 1 ? 'Booted' : 'Shutdown' }) };
      }
      return { stdout: '' };
    };
    assert.equal((await prepareSimulator(state, selectSimulatorDevice, run, disposable)).udid, 'known');
    assert.equal(restarted, disposable);
  }
  for (const mode of ['preexisting', 'conflict', 'stale', 'exhausted-owned']) {
    const { state } = make(); let lists = 0;
    const mutations = [];
    const run = async (cmd, args) => {
      if (cmd !== 'xcrun') { if (cmd.includes('killall')) mutations.push('restart'); return { stdout: '' }; }
      if (['boot', 'shutdown', 'erase'].includes(args[1])) mutations.push(args[1]);
      if (args[1] === 'list') {
        lists++;
        if (mode === 'conflict') return { stdout: JSON.stringify({ devices: { [runtime]: [{ ...phone, state: 'Booted' }, { ...phone, udid: 'other', state: 'Booted' }] } }) };
        if (mode === 'stale' && lists > 1) return { stdout: inventory({ ...phone, udid: 'replacement' }) };
        if (lists > 1 && ['preexisting', 'exhausted-owned'].includes(mode)) throw timeout();
        return { stdout: inventory({ ...phone, state: mode === 'preexisting' ? 'Booted' : 'Shutdown' }) };
      }
      return { stdout: '' };
    };
    await assert.rejects(prepareSimulator(state, selectSimulatorDevice, run, true));
    assert.ok(!mutations.includes('shutdown') && !mutations.includes('erase'));
    if (mode === 'preexisting' || mode === 'conflict') assert.deepEqual(mutations, []);
    if (mode === 'exhausted-owned') assert.deepEqual(mutations, ['boot', 'restart']);
  }
  // Timed-out boot may have taken effect: never boot a Booting device twice.
  {
    const { state, advance } = make(300000); let lists = 0, boots = 0, restarts = 0;
    const run = async (cmd, args, options) => {
      if (cmd === '/usr/bin/killall') { restarts++; throw Object.assign(new Error('no process'), { code: 1 }); }
      if (cmd !== 'xcrun') return { stdout: '' };
      if (args[1] === 'list') {
        lists++;
        if (lists === 3) { advance(30000); throw timeout(); }
        advance(12000);
        return { stdout: inventory({ ...phone, state: lists === 1 ? 'Shutdown' : lists === 2 ? 'Booting' : 'Booted' }) };
      }
      if (args[1] === 'boot') { boots++; advance(options.timeout); throw timeout(); }
      if (args[1] === 'bootstatus') advance(55000);
      return { stdout: '' };
    };
    assert.equal((await prepareSimulator(state, selectSimulatorDevice, run, true)).udid, phone.udid);
    assert.equal(boots, 1);
    assert.equal(restarts, 1);
    assert.equal(state.deadline, 300000);
    assert.ok(state.remaining() > 60000, 'Representative slow recovery retains useful startup time');
  }
  for (const service of ['present', 'kill-timeout']) {
    const { state } = make(); let lists = 0;
    const run = async (cmd, args) => {
      if (cmd === '/usr/bin/killall') throw service === 'kill-timeout' ? timeout() : Object.assign(new Error('denied'), { code: 1 });
      if (cmd === '/bin/ps') return { stdout: '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/com.apple.CoreSimulator.CoreSimulatorService' };
      if (cmd !== 'xcrun') return { stdout: '' };
      if (args[1] === 'list') { if (++lists > 1) throw timeout(); return { stdout: inventory(phone) }; }
      return { stdout: '' };
    };
    await assert.rejects(prepareSimulator(state, selectSimulatorDevice, run, true), service === 'present' ? /denied/ : /timeout/);
    assert.equal(lists, 3, 'Failed service recovery must not begin another inventory attempt');
  }
  const otherRuntime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-1';
  const mixed = { devices: { [otherRuntime]: [{ ...phone, udid: 'newer' }], [runtime]: [phone] } };
  assert.equal(selectSimulatorDevice(mixed).udid, phone.udid, 'Explicit policy selects 27.0 even with 27.1 installed');
  assert.throws(() => selectSimulatorDevice({ devices: { [otherRuntime]: [phone] } }), /supported runtime policy/);
  for (const active of ['Booted', 'Booting']) {
    assert.throws(() => selectSimulatorDevice({ devices: { [otherRuntime]: [{ ...phone, udid: 'wrong-os', state: active }], [runtime]: [phone] } }), /Conflicting/);
    assert.throws(() => verifySelected({ devices: { [otherRuntime]: [{ ...phone, state: active }] } }, { ...phone, runtime: otherRuntime }), /UDID\/runtime/);
    for (const conflictAt of [1, 2, 3, 4]) {
      const { state } = make(); let lists = 0;
      const calls = [];
      const record = (cmd, args) => { calls.push([cmd, args]); return ''; };
      state.command = record;
      const run = async (cmd, args) => {
        record(cmd, args);
        if (cmd !== 'xcrun') return { stdout: '' };
        if (args[1] === 'list') {
          lists++;
          if (lists === conflictAt) return { stdout: JSON.stringify({ devices: { [runtime]: [{ ...phone, state: lists > 1 ? 'Booted' : 'Shutdown' }], [otherRuntime]: [{ ...phone, udid: 'unrelated', state: active }] } }) };
          if (lists > 1) throw timeout();
          return { stdout: inventory(phone) };
        }
        return { stdout: '' };
      };
      await assert.rejects(prepareSimulator(state, selectSimulatorDevice, run, true), /Conflicting/);
      const beforeCleanup = calls.length;
      state.cleanup();
      assert.equal(calls.filter(([cmd]) => cmd.includes('killall')).length, conflictAt === 4 ? 1 : 0, 'No restart after observing a conflict; fourth inventory follows the earlier recovery');
      assert.ok(!calls.some(([, args]) => args.includes('unrelated')), 'No command may address unrelated device');
      if (conflictAt === 1) {
        assert.equal(state.device, undefined, 'Initial conflict must not assign ownership');
        assert.equal(calls.length, beforeCleanup, 'Initial conflict cleanup must not mutate any device');
        assert.ok(!calls.some(([, args]) => args.includes('boot')));
      } else {
        assert.ok(calls.slice(beforeCleanup).every(([, args]) => args.includes(phone.udid)), 'Cleanup addresses selected device only');
      }
    }
  }
  // Exercise a real asynchronous child timeout as well as deterministic fake clocks.
  const real = new SimulatorRunLifecycle(path.join(dir, 'real'), { startupMs: 1000, overallMs: 1000, ciDeadlineMs: Infinity });
  await assert.rejects(startupCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], real, undefined, 100), error => error.killed);
  const chosen = { ...phone, runtime };
  for (const inv of [{ devices: {} }, { devices: { wrong: [phone] } }, { devices: { [runtime]: [{ ...phone, isAvailable: false }] } }]) assert.throws(() => verifySelected(inv, chosen), /UDID\/runtime/);
  assert.throws(() => verifySelected({ devices: { [runtime]: [{ ...phone, state: 'Booted' }, { ...phone, udid: 'other', state: 'Booted' }] } }, chosen), /Conflicting/);
  const { state, advance } = make(100);
  await assert.rejects(startupCommand('fake', [], state, async (_cmd, _args, options) => { assert.equal(options.timeout, 100); advance(100); return { stdout: '' }; }), /timeout/);
  await assert.rejects(startupCommand('fake', [], state, () => { throw Error('must not run'); }), /timeout/);
  assert.equal(state.deadline, 100);
  const diag = make(); let total = 0;
  await startupDiagnostics(diag.state, async (_cmd, _args, options) => { total += options.timeout; diag.advance(options.timeout); throw timeout(); });
  assert.equal(total, 6000);
  assert.ok(fs.readFileSync(path.join(diag.state.outputDir, 'processes.txt'), 'utf8').includes('ETIMEDOUT'));
  const developer = path.join(dir, 'Xcode.app/Contents/Developer');
  fs.mkdirSync(path.join(developer, 'Applications/Simulator.app'), { recursive: true });
  const tool = make();
  const fake = version => async (cmd, args) => ({ stdout: cmd === 'xcodebuild' ? (args.includes('-version') ? version : '') : args.includes('--show-sdk-path') ? developer + '/Platforms/iPhoneSimulator.platform/SDKs/iPhoneSimulator27.1.sdk' : '27.1' });
  await assert.rejects(selectToolchain(tool.state, fake('Xcode 26.1'), developer), /Xcode 27/);
  await assert.rejects(selectToolchain(tool.state, async (cmd) => ({ stdout: cmd === 'xcodebuild' ? 'Xcode 27.1' : '26.0' }), developer), /SDK/);
  for (const sdk of ['27.0', '27.2']) {
    await assert.rejects(selectToolchain(tool.state, async (cmd, args, options) => cmd === 'xcrun' && args.includes('--show-sdk-version') ? { stdout: sdk } : fake('Xcode 27.1')(cmd, args, options), developer), /SDK/);
  }
  const selected = await selectToolchain(tool.state, fake('Xcode 27.1'), developer);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tool.state.outputDir, 'toolchain.json'), 'utf8')).runtimePolicy, SUPPORTED_RUNTIME_POLICY);
  const calls = [];
  rotateSimulator('portrait', phone.udid, (cmd, args) => { calls.push([cmd, args]); return inventory({ ...phone, state: 'Booted' }); });
  assert.equal(calls[1][1][1], selected.simulator);
  console.log('Simulator startup fake-command tests passed.');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
