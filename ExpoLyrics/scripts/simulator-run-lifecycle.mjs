import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Deadlines are absolute: heartbeats and repeated stage markers cannot extend them.
export class SimulatorRunLifecycle {
  constructor(outputDir, { startupMs = 180000, stageMs = 60000, overallMs = 360000, now = Date.now, command = execFileSync } = {}) {
    for (const value of [startupMs, stageMs, overallMs]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('Timeouts must be finite positive numbers');
    }
    Object.assign(this, { outputDir, startupMs, stageMs, now, command });
    this.started = now();
    this.overallDeadline = this.started + overallMs;
    this.deadline = this.started + startupMs;
    this.stage = 'startup:discovery';
    this.children = [];
    fs.mkdirSync(outputDir, { recursive: true });
    this.record();
  }
  record() {
    fs.writeFileSync(path.join(this.outputDir, 'runner-state.json'), JSON.stringify({ stage: this.stage, started: new Date(this.started).toISOString(), updated: new Date(this.now()).toISOString(), error: this.error, lastProtocolLine: this.lastProtocolLine }, null, 2));
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
      this.seen ??= new Set(); this.seen.add(match[1]);
      this.deadline = this.now() + this.stageMs;
      this.update(match[1]);
    }
  }
  remaining() { return Math.min(this.deadline, this.overallDeadline) - this.now(); }
  check() {
    if (this.remaining() <= 0) throw new Error(`${this.now() >= this.overallDeadline ? 'Overall' : this.seen?.size ? 'Scenario stage' : 'Startup'} timeout at ${this.stage}`);
  }
  fail(error) { this.error = String(error.message || error); this.record(); }
  capture(signal = false) {
    if (this.captured) return;
    this.captured = true;
    this.record();
    // Synchronous, bounded evidence survives process.exit and signal handlers.
    const evidence = (name, cmd, args) => {
      try {
        const output = this.command(cmd, args, { encoding: 'utf8', timeout: signal ? 750 : 2500, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
        fs.writeFileSync(path.join(this.outputDir, name), output || '');
      } catch (err) {
        fs.writeFileSync(path.join(this.outputDir, name), `${err.stdout || ''}\n${err.stderr || ''}\n${err.message}`);
      }
    };
    if (this.device) {
      evidence('failure-screenshot.log', 'xcrun', ['simctl', 'io', this.device, 'screenshot', path.resolve(this.outputDir, 'failure.png')]);
      evidence('device-log.txt', 'xcrun', ['simctl', 'spawn', this.device, 'log', 'show', '--last', '3m', '--style', 'compact', '--predicate', 'process == "KineSync" OR process == "SpringBoard"']);
    }
    evidence('metro-status.txt', 'curl', ['--max-time', '1', '-sS', 'http://127.0.0.1:8081/status']);
    fs.writeFileSync(path.join(this.outputDir, 'runner-failure.md'), `# Simulator runner failure\n\nStage: ${this.stage}\n\n${this.error || 'Unknown failure'}\n`);
  }
  cleanup() { for (const child of this.children) { try { child.kill('SIGKILL'); } catch { /* best effort */ } } }
}
