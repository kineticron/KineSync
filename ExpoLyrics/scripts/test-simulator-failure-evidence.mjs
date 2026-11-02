// Failure diagnostics must not become an eighth visual acceptance pair.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { SimulatorRunLifecycle } from './simulator-run-lifecycle.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-evidence-'));
try {
  const startupDir = path.join(dir, 'prelaunch');
  const startup = new SimulatorRunLifecycle(startupDir, { ciDeadlineMs: Infinity, command() { return { status: 0, stdout: '', stderr: '' }; } });
  startup.fail(Error('Startup timeout at startup:discovery')); startup.capture();
  const summary = fs.readFileSync(path.join(startupDir, 'simulator-summary.md'), 'utf8');
  assert.match(summary, /Status: FAILED/);
  assert.match(summary, /Startup timeout at startup:discovery/);
  assert.match(summary, /No complete scenario metrics/);
  const preservedDir = path.join(dir, 'existing-summary');
  const preserved = new SimulatorRunLifecycle(preservedDir, { ciDeadlineMs: Infinity, command() { return { status: 0, stdout: '', stderr: '' }; } });
  fs.writeFileSync(path.join(preservedDir, 'simulator-summary.md'), 'full scenario report');
  preserved.fail(Error('late failure')); preserved.capture();
  assert.equal(fs.readFileSync(path.join(preservedDir, 'simulator-summary.md'), 'utf8'), 'full scenario report');
  const calls = [];
  const lifecycle = new SimulatorRunLifecycle(dir, { ciDeadlineMs: Infinity, command(cmd, args) {
    calls.push({ cmd, args });
    if (args.includes('screenshot')) fs.writeFileSync(args.at(-1), PNG.sync.write(new PNG({ width: 3, height: 5 })));
    return { status: 0, stdout: '', stderr: '' };
  } });
  lifecycle.device = 'mock-device';
  lifecycle.fail(Error('Native landscape screenshot dimensions invalid'));
  lifecycle.capture(); lifecycle.capture();
  assert.equal(calls.filter(call => call.args.includes('screenshot')).length, 1, 'Failure collection stays idempotent');
  assert.ok(fs.existsSync(path.join(dir, 'diagnostics/failure.png')), 'Preserve failure screenshot under diagnostics');
  assert.ok(!fs.existsSync(path.join(dir, 'failure.png')), 'Diagnostic screenshot must not enter the seven-pair namespace');
  assert.match(fs.readFileSync(path.join(dir, 'runner-state.json'), 'utf8'), /Native landscape screenshot dimensions invalid/, 'The underlying failure remains fatal');
  const audit = fs.readFileSync(path.join(dir, 'startup-commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(audit.filter(command => command.png).length, 1, 'Keep screenshot dimensions and actual command evidence');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('Failure PNG is retained as diagnostics without polluting the seven required screenshot pairs.');
