import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SimulatorRunLifecycle } from './simulator-run-lifecycle.mjs';
import { enumerateRuntimes, startupCommand, prepareSimulator, verifySelected, startupDiagnostics, selectToolchain, SUPPORTED_RUNTIME_POLICY } from './simulator-startup.mjs';
import { preflightNative, verifyArchive, verifyNative, verifyFramework } from './prepare-simulator-rotation.mjs';
import { selectSimulatorDevice, rotateSimulator } from './run-ios-simulator-test.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-test-'));
const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
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
  // Real child processes test the load boundary, without claiming Mach-O loads on Linux.
  const probeFixture = path.join(dir, 'probe.cjs');
  fs.writeFileSync(probeFixture, "console.error('fixture optional-symbol warning'); exports.SimHID = class {};");
  const probe = preflightNative(probeFixture);
  assert.ok(probe.includes('SimHID export verified'));
  assert.ok(probe.includes('fixture optional-symbol warning'));
  assert.equal(JSON.parse(probe.split('\n')[0]).arch, process.arch);
  assert.ok(probe.includes(process.versions.napi));
  fs.writeFileSync(probeFixture, 'module.exports = {};');
  assert.throws(() => preflightNative(probeFixture), /SimHID constructor/);
  fs.writeFileSync(probeFixture, "throw Error('fixture dyld error');");
  assert.throws(() => preflightNative(probeFixture), /fixture dyld error/);
  fs.writeFileSync(probeFixture, 'while (true) {}');
  assert.throws(() => preflightNative(probeFixture, 100), error => error.signal === 'SIGKILL');
  const tampered = path.join(dir, 'tampered.node');
  fs.writeFileSync(tampered, 'untrusted');
  assert.throws(() => verifyArchive(fs.readFileSync(tampered)), /integrity mismatch/);
  assert.throws(() => verifyNative(tampered), /hash mismatch/);
  assert.throws(() => verifyFramework(tampered), /hash mismatch/);
  for (const failure of ['list', 'boot', 'bootstatus', 'postboot', 'none']) {
    const { state, advance } = make(600000);
    let booted = false;
    const calls = [];
    const run = async (cmd, args, options) => {
      calls.push([cmd, args]);
      assert.equal(cmd, 'xcrun');
      assert.equal(options.timeout, state.remaining());
      const verb = args[1];
      if (verb === failure || (failure === 'postboot' && verb === 'list' && booted)) throw timeout();
      advance(verb === 'bootstatus' ? 175440 : verb === 'list' ? 70673 : 3564);
      if (verb === 'boot') booted = true;
      return { stdout: inventory({ ...phone, state: booted ? 'Booted' : 'Shutdown' }) };
    };
    if (failure === 'none') assert.equal((await prepareSimulator(state, selectSimulatorDevice, run)).udid, phone.udid);
    else await assert.rejects(prepareSimulator(state, selectSimulatorDevice, run), /timeout/);
    assert.ok(calls.every(([cmd, args]) => cmd !== '/usr/bin/killall' && !args.includes('erase') && !args.includes('shutdown')));
    if (failure === 'bootstatus') assert.equal(calls.filter(([, args]) => args[1] === 'bootstatus').length, 1);
  }
  for (const failure of [false, true]) {
    const { state } = make(600000);
    let attempts = 0;
    const run = async (_cmd, _args, options) => {
      attempts++;
      assert.equal(options.timeout, 600000);
      if (failure) throw timeout();
      return { stdout: 'inventory', stderr: 'raw warning' };
    };
    if (failure) await assert.rejects(enumerateRuntimes(state, run), /timeout/);
    else assert.equal(await enumerateRuntimes(state, run), 'inventory');
    assert.equal(attempts, 1);
  }
  for (const initial of ['Shutdown', 'Booting', 'Booted']) {
    const { state } = make(600000);
    const calls = [];
    let lists = 0;
    const run = async (cmd, args) => {
      calls.push([cmd, args]);
      if (args[1] === 'list') return { stdout: inventory({ ...phone, state: ++lists === 1 ? initial : 'Booted' }) };
      return { stdout: '' };
    };
    await prepareSimulator(state, selectSimulatorDevice, run);
    assert.equal(calls.filter(([, args]) => args[1] === 'boot').length, initial === 'Shutdown' ? 1 : 0);
    assert.equal(state.ownsDevice, initial === 'Shutdown');
  }
  for (const unsafe of ['conflict', 'replacement', 'wrong-runtime']) {
    const { state } = make(); let lists = 0;
    const run = async (_cmd, args) => {
      if (args[1] !== 'list') return { stdout: '' };
      lists++;
      return { stdout: unsafe === 'conflict' ? JSON.stringify({ devices: { [runtime]: [{ ...phone, state: 'Booted' }, { ...phone, udid: 'unrelated', state: 'Booting' }] } }) : lists === 1 ? inventory(phone) : unsafe === 'replacement' ? inventory({ ...phone, udid: 'replacement' }) : JSON.stringify({ devices: { wrong: [phone] } }) };
    };
    await assert.rejects(prepareSimulator(state, selectSimulatorDevice, run), /Conflicting|UDID/);
    if (unsafe === 'conflict') assert.equal(state.device, undefined);
  }
  const otherRuntime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';
  const mixed = { devices: { [otherRuntime]: [{ ...phone, udid: 'newer' }], [runtime]: [phone] } };
  assert.equal(selectSimulatorDevice(mixed).udid, phone.udid, 'Explicit policy selects 26.5 even with 26.4 installed');
  assert.throws(() => selectSimulatorDevice({ devices: { [otherRuntime]: [phone] } }), /supported runtime policy/);
  for (const active of ['Booted', 'Booting']) {
    assert.throws(() => selectSimulatorDevice({ devices: { [otherRuntime]: [{ ...phone, udid: 'wrong-os', state: active }], [runtime]: [phone] } }), /Conflicting/);
    assert.throws(() => verifySelected({ devices: { [otherRuntime]: [{ ...phone, state: active }] } }, { ...phone, runtime: otherRuntime }), /UDID\/runtime/);
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
  assert.equal(total, 180000);
  assert.ok(fs.readFileSync(path.join(diag.state.outputDir, 'processes.txt'), 'utf8').includes('ETIMEDOUT'));
  const developer = path.join(dir, 'Xcode.app/Contents/Developer');
  fs.mkdirSync(path.join(developer, 'Applications/Simulator.app'), { recursive: true });
  const tool = make();
  const fake = version => async (cmd, args) => ({ stdout: cmd === 'xcodebuild' ? (args.includes('-version') ? version : '') : args.includes('--show-sdk-path') ? developer + '/Platforms/iPhoneSimulator.platform/SDKs/iPhoneSimulator26.5.sdk' : args.includes('runtimes') ? JSON.stringify({ runtimes: [{ identifier: runtime, isAvailable: true }] }) : '26.5' });
  for (const version of ['Xcode 26.1', 'Xcode 26.5', 'Xcode 26.2']) await assert.rejects(selectToolchain(tool.state, fake(version), developer), /Xcode 26/);
  await assert.rejects(selectToolchain(tool.state, async (cmd) => ({ stdout: cmd === 'xcodebuild' ? 'Xcode 26.6' : '26.0' }), developer), /SDK/);
  for (const sdk of ['26.4', '26.6']) {
    await assert.rejects(selectToolchain(tool.state, async (cmd, args, options) => cmd === 'xcrun' && args.includes('--show-sdk-version') ? { stdout: sdk } : fake('Xcode 26.6')(cmd, args, options), developer), /SDK/);
  }
  fs.mkdirSync(path.join(developer, 'Applications/Simulator.app/Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(developer, 'Applications/Simulator.app/Contents/MacOS/Simulator'), 'fixture');
  await assert.rejects(selectToolchain(make().state, async (cmd, args, options) => args.includes('runtimes') ? { stdout: JSON.stringify({ runtimes: [] }) } : fake('Xcode 26.6')(cmd, args, options), developer), /runtime unavailable/);
  await selectToolchain(tool.state, fake('Xcode 26.6'), developer);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tool.state.outputDir, 'toolchain.json'), 'utf8')).runtimePolicy, SUPPORTED_RUNTIME_POLICY);
  const calls = [];
  rotateSimulator('portrait', phone.udid, (cmd, args) => {
    calls.push([cmd, args]);
    return cmd === 'xcrun' ? inventory({ ...phone, state: 'Booted' }) : 'native optional-symbol warning\nKINESYNC_ROTATION_RESULT ' + JSON.stringify({ version: '0.13.0', udid: phone.udid, orientation: 'portrait', accepted: true });
  });
  assert.equal(calls[1][0], 'node');
  assert.deepEqual(calls[1][1].slice(1), [phone.udid, 'portrait']);
  assert.ok(calls.every(([cmd]) => !['open', 'osascript', '/usr/bin/find'].includes(cmd)));
  for (const result of [{ accepted: false }, { version: '0.13.0', udid: 'wrong', orientation: 'portrait', accepted: true }]) {
    assert.throws(() => rotateSimulator('portrait', phone.udid, cmd => cmd === 'xcrun' ? inventory({ ...phone, state: 'Booted' }) : 'KINESYNC_ROTATION_RESULT ' + JSON.stringify(result)), /acknowledgment/);
  }
  const acknowledgment = 'KINESYNC_ROTATION_RESULT ' + JSON.stringify({ version: '0.13.0', udid: phone.udid, orientation: 'portrait', accepted: true });
  for (const output of ['native warnings only', acknowledgment + '\n' + acknowledgment, 'KINESYNC_ROTATION_RESULT invalid-json']) {
    assert.throws(() => rotateSimulator('portrait', phone.udid, cmd => cmd === 'xcrun' ? inventory({ ...phone, state: 'Booted' }) : output));
  }
  fs.rmSync(path.join(developer, 'Applications'), { recursive: true });
  await selectToolchain(make().state, fake('Xcode 26.6'), developer);
  console.log('Simulator startup fake-command tests passed.');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
