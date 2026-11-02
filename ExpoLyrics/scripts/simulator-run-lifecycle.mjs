import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { spawnSync } from 'node:child_process';

// Deadlines are absolute: heartbeats and repeated stage markers cannot extend them.
export class SimulatorRunLifecycle {
  constructor(outputDir, { startupMs = 600000, stageMs = 120000, overallMs = 2400000, now = Date.now, command = (cmd, args, options) => {
    const result = spawnSync(cmd, args, options);
    if (result.error || result.status !== 0) throw Object.assign(new Error(result.error?.message || `Command exited ${result.status}`), result, { code: result.error?.code ?? result.status });
    return result;
  }, ciDeadlineMs = process.env.SIMULATOR_CI_DEADLINE_MS ? Number(process.env.SIMULATOR_CI_DEADLINE_MS) : Infinity } = {}) {
    for (const value of [startupMs, stageMs, overallMs]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('Timeouts must be finite positive numbers');
    }
    Object.assign(this, { outputDir, startupMs, stageMs, now, command });
    this.started = now();
    if (ciDeadlineMs !== Infinity && !Number.isFinite(ciDeadlineMs)) throw new Error('Invalid CI deadline');
    this.overallDeadline = Math.min(this.started + overallMs, ciDeadlineMs);
    this.deadline = this.started + startupMs;
    this.stage = 'startup:discovery';
    this.children = [];
    fs.mkdirSync(outputDir, { recursive: true });
    this.record();
  }
  record() {
    fs.writeFileSync(path.join(this.outputDir, 'runner-state.json'), JSON.stringify({ stage: this.stage, started: new Date(this.started).toISOString(), updated: new Date(this.now()).toISOString(), error: this.error, lastProtocolLine: this.lastProtocolLine }, null, 2));
  }
  enterPhase(stage, budget) {
    if (!Number.isFinite(budget) || budget <= 0) throw new Error('Phase timeout must be finite and positive');
    this.check();
    this.deadline = this.now() + budget;
    this.update(stage);
  }
  update(stage) { this.stage = stage; this.record(); }
  line(line) {
    if (line.includes('[KINESYNC_SIM]')) {
      this.lastProtocolLine = line;
      if (!this.seen?.size && /\[KINESYNC_SIM\] INIT_(BEGIN|READY)/.test(line)) this.stage = `startup:${line.match(/INIT_\w+/)[0]}`;
      this.record();
    }
    const match = line.match(/\[KINESYNC_SIM\] STAGE_BEGIN (\w+)/);
    if (match && !this.seen?.has(match[1])) {
      this.check();
      this.seen ??= new Set(); this.seen.add(match[1]);
      if (match[1] !== 'stage_8_complete') this.deadline = this.now() + this.stageMs;
      this.update(match[1]);
    }
  }
  remaining() { return Math.min(this.deadline, this.overallDeadline) - this.now(); }
  check() {
    if (this.remaining() <= 0) throw new Error(`${this.now() >= this.overallDeadline ? 'Overall' : this.seen?.size ? 'Scenario stage' : 'Startup'} timeout at ${this.stage}`);
  }
  fail(error) { this.error = String(error.message || error); this.record(); }
  evidenceCommand(name, cmd, args, deadline) {
    const started = this.now();
    const timeout = Math.min(60000, deadline - started);
    const record = { stage: this.stage, cmd, args, started, timeout, evidence: true };
    let stdout = '', stderr = '';
    fs.appendFileSync(path.join(this.outputDir, 'command-starts.jsonl'), JSON.stringify(record) + '\n');
    try {
      if (timeout <= 0) throw Error('Evidence deadline exhausted; command skipped');
      if (args.includes('screenshot')) fs.rmSync(args.at(-1), { force: true });
      const result = this.command(cmd, args, { encoding: 'buffer', timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      record.exitCode = typeof result === 'string' ? 0 : result.status;
      stdout = typeof result === 'string' ? result : result.stdout || '';
      stderr = typeof result === 'string' ? '' : result.stderr || '';
      if (args.includes('screenshot')) {
        const image = PNG.sync.read(fs.readFileSync(args.at(-1)));
        record.png = { width: image.width, height: image.height };
      }
    } catch (error) {
      stdout = error.stdout || stdout; stderr = error.stderr || stderr;
      record.error = { message: error.message, code: error.code, signal: error.signal };
    } finally {
      fs.writeFileSync(path.join(this.outputDir, name), `${stdout}\n${stderr}\n${record.error?.message || ''}`);
      const id = this.commandSerial = (this.commandSerial || 0) + 1;
      for (const [stream, data] of Object.entries({ stdout, stderr })) {
        record[stream] = `command-${id}-${stream}.log`;
        fs.writeFileSync(path.join(this.outputDir, record[stream]), data);
      }
      record.ended = this.now();
      record.exitCode ??= typeof record.error?.code === 'number' ? record.error.code : null;
      record.duration = record.ended - started;
      fs.appendFileSync(path.join(this.outputDir, 'startup-commands.jsonl'), JSON.stringify(record) + '\n');
    }
  }
  capture() {
    if (this.captured) return;
    this.captured = true;
    this.record();
    // Failure collection is capped at six minutes and the remaining overall budget.
    const deadline = Math.min(this.overallDeadline, this.now() + 360000);
    const evidence = (name, cmd, args) => this.evidenceCommand(name, cmd, args, deadline);
    evidence('failure-processes.txt', '/bin/ps', ['-axo', 'pid,ppid,uid,state,%cpu,%mem,etime,comm']);
    evidence('failure-memory.txt', '/usr/bin/vm_stat', []);
    evidence('failure-services.txt', '/bin/launchctl', ['list']);
    fs.writeFileSync(path.join(this.outputDir, 'failure-toolchain.json'), JSON.stringify({ developer: process.env.DEVELOPER_DIR || null }));
    if (this.device) {
      evidence('failure-screenshot.log', 'xcrun', ['simctl', 'io', this.device, 'screenshot', path.resolve(this.outputDir, 'failure.png')]);
      evidence('device-log.txt', 'xcrun', ['simctl', 'spawn', this.device, 'log', 'show', '--last', '3m', '--style', 'compact', '--predicate', 'process == "KineSync" OR process == "SpringBoard"']);
    }
    evidence('metro-status.txt', 'curl', ['--max-time', '60', '-sS', 'http://127.0.0.1:8081/status']);
    fs.writeFileSync(path.join(this.outputDir, 'runner-failure.md'), `# Simulator runner failure\n\nStage: ${this.stage}\n\n${this.error || 'Unknown failure'}\n`);
  }
  cleanup() {
    for (const child of this.children) { try { child.kill('SIGKILL'); } catch { /* best effort */ } }
    if (!this.device || this.cleaned) return;
    this.cleaned = true;
    const deadline = Math.min(this.overallDeadline, this.now() + 180000);
    for (const args of [
      ['terminate', this.device, 'dev.kineticron.KineSync'],
      ['status_bar', this.device, 'clear'],
      ...(this.ownsDevice ? [['shutdown', this.device]] : []),
    ]) {
      this.evidenceCommand(`cleanup-${args[0]}.log`, 'xcrun', ['simctl', ...args], deadline);
    }
  }
}
