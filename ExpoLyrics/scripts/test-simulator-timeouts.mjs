import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SimulatorRunLifecycle } from './simulator-run-lifecycle.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-deadlines-'));
try {
  let now = 1000;
  const lifecycle = new SimulatorRunLifecycle(dir, { startupMs: 100, stageMs: 50, overallMs: 200, now: () => now, command: () => { throw new Error('device unavailable'); } });
  now = 1100; assert.throws(() => lifecycle.check(), /Startup timeout/);
  now = 1050; lifecycle.line('[KINESYNC_SIM] STAGE_BEGIN stage_1_launch timestamp=1');
  now = 1090; lifecycle.line('[KINESYNC_SIM] STAGE_BEGIN stage_1_launch timestamp=1');
  now = 1100; assert.throws(() => lifecycle.check(), /Scenario stage timeout/);
  for (const [time, stage] of [[1100, 2], [1140, 3], [1180, 4]]) { now = time; lifecycle.line(`[KINESYNC_SIM] STAGE_BEGIN stage_${stage} timestamp=1`); }
  now = 1200; assert.throws(() => lifecycle.check(), /Overall timeout/);
  lifecycle.device = 'fake'; lifecycle.fail(new Error('stalled')); lifecycle.capture();
  assert.match(fs.readFileSync(path.join(dir, 'device-log.txt'), 'utf8'), /device unavailable/);
  assert.match(fs.readFileSync(path.join(dir, 'runner-failure.md'), 'utf8'), /stalled/);
  assert.match(fs.readFileSync(path.join(dir, 'failure-screenshot.log'), 'utf8'), /device unavailable/);
  const budget = spawnSync(process.execPath, [new URL('./run-with-ci-budget.mjs', import.meta.url).pathname, process.execPath, '-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, SIMULATOR_CI_DEADLINE_MS: String(Date.now() + 200) }, timeout: 8000, encoding: 'utf8' });
  assert.equal(budget.status, 1); assert.match(budget.stderr, /budget exhausted/);
  const workflow = fs.readFileSync(new URL('../../.github/workflows/ios-simulator-test.yml', import.meta.url), 'utf8');
  const artifactPaths = workflow.split('          path: |').at(-1).split('          include-hidden-files:')[0].trim().split('\n').map(p => p.trim());
  assert.ok(artifactPaths.includes('ExpoLyrics/.expo/baseline-test-output/'));
  for (const p of artifactPaths) assert.ok(!p.split('/').some(part => ['.', '..'].includes(part)) && !path.isAbsolute(p), p);
  assert.match(workflow, /--output-dir "\$\{GITHUB_WORKSPACE\}\/ExpoLyrics\/\.expo\/baseline-test-output"/);
  assert.match(workflow, /Upload Simulator Test Artifacts\n        timeout-minutes: 2\n        if: always\(\)/);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('Simulator deadline and artifact tests passed.');
