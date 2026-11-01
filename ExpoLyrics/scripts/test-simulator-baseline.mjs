import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTrustedBaseline } from './resolve-trusted-simulator-baseline.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function testTrustedBaseline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-baseline-'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
    git(['commit', '--allow-empty', '-m', 'trusted']);
    const trusted = git(['rev-parse', 'HEAD']);
    git(['remote', 'add', 'origin', dir]);
    git(['switch', '-c', 'untrusted']); git(['commit', '--allow-empty', '-m', 'untrusted']);
    const untrusted = git(['rev-parse', 'HEAD']);
    assert.equal(resolveTrustedBaseline('main', dir), trusted);
    assert.equal(resolveTrustedBaseline(trusted, dir), trusted);
    assert.throws(() => resolveTrustedBaseline('untrusted', dir), /Untrusted baseline/);
    const script = path.join(root, 'scripts/resolve-trusted-simulator-baseline.mjs');
    for (const ref of ['main', trusted, 'untrusted', untrusted, '--upload-pack=evil', 'main$(id)', 'main;id', '../escape']) {
      const result = spawnSync(process.execPath, [script, ref], { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, ['main', trusted].includes(ref) ? 0 : 1, ref);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

testTrustedBaseline();
console.log('Trusted simulator baseline tests passed.');
