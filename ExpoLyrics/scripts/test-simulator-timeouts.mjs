import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runStartupCommand } from './run-ios-simulator-test.mjs';
import { SimulatorRunLifecycle } from './simulator-run-lifecycle.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-deadlines-'));
try {
  let now = 1000;
  const rejectedDir = path.join(dir, 'rejected-at-deadline');
  const rejected = new SimulatorRunLifecycle(rejectedDir, { startupMs: 100, now: () => now, ciDeadlineMs: Infinity });
  const commandError = Object.assign(Error('Command failed: xcrun'), { killed: true, signal: 'SIGKILL', stdout: 'partial output', stderr: 'native stderr' });
  await assert.rejects(runStartupCommand('xcrun', ['simctl', 'list'], rejected, async () => { now = 1100; throw commandError; }), error => /Startup timeout at startup:discovery/.test(error.message) && error.cause === commandError);
  const rejectedAudit = JSON.parse(fs.readFileSync(path.join(rejectedDir, 'startup-commands.jsonl'), 'utf8').trim());
  assert.equal(rejectedAudit.error.message, commandError.message);
  assert.equal(fs.readFileSync(path.join(rejectedDir, rejectedAudit.stdout), 'utf8'), 'partial output');
  assert.equal(fs.readFileSync(path.join(rejectedDir, rejectedAudit.stderr), 'utf8'), 'native stderr');
  now = 1000;
  const capped = new SimulatorRunLifecycle(path.join(dir, 'capped'), { now: () => now, ciDeadlineMs: 1150 });
  assert.equal(capped.overallDeadline, 1150);
  capped.line('[KINESYNC_SIM] STAGE_BEGIN stage_1_launch timestamp=1');
  now = 1150; assert.throws(() => capped.check(), /Overall timeout/);
  const expired = new SimulatorRunLifecycle(path.join(dir, 'expired'), { now: () => now, ciDeadlineMs: 1100 });
  assert.throws(() => expired.check(), /Overall timeout/);
  now = 1000;
  const startup = new SimulatorRunLifecycle(path.join(dir, 'install'), { now: () => now, ciDeadlineMs: Infinity });
  now += 40000;
  await runStartupCommand('xcrun', ['simctl', 'install', 'fake', '/mock.app'], startup, (_cmd, _args, options) => {
    assert.equal(options.timeout, 300000, 'Install has a separate bounded command deadline');
    const pending = Promise.resolve({ stdout: '' }); pending.child = { kill() {} }; return pending;
  });
  now = 1000;
  const lifecycle = new SimulatorRunLifecycle(dir, { startupMs: 100, stageMs: 50, overallMs: 200, now: () => now, command: () => { throw new Error('device unavailable'); } });
  now = 1100; assert.throws(() => lifecycle.check(), /Startup timeout/);
  now = 1050; lifecycle.line('[KINESYNC_SIM] STAGE_BEGIN stage_1_launch timestamp=1');
  now = 1090; lifecycle.line('[KINESYNC_SIM] STAGE_BEGIN stage_1_launch timestamp=1');
  now = 1100; assert.throws(() => lifecycle.check(), /Scenario stage timeout/);
  for (const [time, stage] of [[1099, 2], [1140, 3], [1180, 4]]) { now = time; lifecycle.line(`[KINESYNC_SIM] STAGE_BEGIN stage_${stage} timestamp=1`); }
  now = 1200; assert.throws(() => lifecycle.check(), /Overall timeout/);
  lifecycle.device = 'fake'; lifecycle.fail(new Error('stalled')); lifecycle.capture();
  assert.match(fs.readFileSync(path.join(dir, 'device-log.txt'), 'utf8'), /Evidence deadline exhausted/);
  assert.match(fs.readFileSync(path.join(dir, 'runner-failure.md'), 'utf8'), /stalled/);
  assert.match(fs.readFileSync(path.join(dir, 'failure-screenshot.log'), 'utf8'), /Evidence deadline exhausted/);
  const candidateOutput = path.join(dir, 'candidate-expired');
  const candidate = spawnSync(process.execPath, [new URL('./run-ios-simulator-test.mjs', import.meta.url).pathname, '--output-dir', candidateOutput, '--timeout-minutes', '6'], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, SIMULATOR_CI_DEADLINE_MS: String(Date.now() - 1000) },
  });
  assert.equal(candidate.status, 1, candidate.stderr);
  assert.match(JSON.parse(fs.readFileSync(path.join(candidateOutput, 'runner-state.json'), 'utf8')).error, /Overall timeout at startup:discovery/);
  assert.ok(fs.existsSync(path.join(candidateOutput, 'runner-failure.md')), 'Expired candidate must retain evidence without starting simulator work');
  const budget = spawnSync(process.execPath, [new URL('./run-with-ci-budget.mjs', import.meta.url).pathname, process.execPath, '-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, SIMULATOR_CI_DEADLINE_MS: String(Date.now() + 200) }, timeout: 8000, encoding: 'utf8' });
  assert.equal(budget.status, 1); assert.match(budget.stderr, /budget exhausted/);
  const workflow = fs.readFileSync(new URL('../../.github/workflows/ios-simulator-test.yml', import.meta.url), 'utf8');
  const artifactPaths = YAML.parse(workflow).jobs['ios-simulator-test'].steps.find(step => step.name === 'Upload Simulator Test Artifacts').with.path.trim().split('\n').map(p => p.trim());
  assert.ok(artifactPaths.includes('ExpoLyrics/.expo/cache-verification-*.json'));
  for (const p of artifactPaths) assert.ok(!p.split('/').some(part => ['.', '..'].includes(part)) && !path.isAbsolute(p), p);

  assert.match(workflow, /Upload Simulator Test Artifacts\n        timeout-minutes: 2\n        if: always\(\)/);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('Simulator deadline and artifact tests passed.');
