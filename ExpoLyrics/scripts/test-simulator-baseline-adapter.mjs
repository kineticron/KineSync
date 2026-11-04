// Verify the exact prepared baseline retains its original production source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = path.resolve(process.argv[2]);
const patches = ['harness-integration.patch', 'harness-integration-main.patch'].map(name => path.join(root, 'ExpoLyrics/scripts/patches', name));
const patch = patches.find(patch => {
  try { execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: baseline, stdio: 'pipe' }); return true; } catch { return false; }
});
assert.ok(patch, 'Prepared source has a supported observation adapter');
const git = args => execFileSync('git', args, { cwd: baseline, encoding: 'utf8' });
assert.equal(git(['rev-parse', 'HEAD']).trim(), git(['rev-parse', '--verify', process.env.BASELINE_SHA || 'main']).trim());
const provider = fs.readFileSync(path.join(baseline, 'ExpoLyrics/providers/bridge-provider.tsx'), 'utf8');

assert.match(provider, /notifySimulatorAppInitialized\(\)/);
const native = fs.readFileSync(path.join(baseline, 'ExpoLyrics/components/lyrics/native/native-lyrics-view.tsx'), 'utf8');
assert.match(native, /notifySimulatorRendererReady/);
git(['apply', '--reverse', '--check', patch]);
git(['apply', '--reverse', patch]);
try {
  const overlay = fs.readFileSync(path.join(root, 'ExpoLyrics/scripts/prepare-baseline-harness.mjs'), 'utf8');
  const allowed = new Set([...overlay.matchAll(/'(ExpoLyrics\/[^']+)'/g)].map(match => match[1]));
  const changed = git(['diff', '--name-only']).trim().split('\n').filter(Boolean);
  assert.deepEqual(changed.filter(file => !allowed.has(file)), [], 'Removing observation adapter restores all production source outside standalone harness files');
  assert.equal(git(['diff', '--', 'ExpoLyrics/components/lyrics/native']), '', 'Renderer source restored byte-for-byte');
} finally { git(['apply', patch]); }
console.log('Exact trusted baseline adapter restores original production sources byte-for-byte.');
