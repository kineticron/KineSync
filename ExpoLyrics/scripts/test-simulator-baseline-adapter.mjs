// Verify the exact prepared baseline retains its original production source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = path.resolve(process.argv[2]);
const patch = path.join(root, 'ExpoLyrics/scripts/patches/harness-integration-main.patch');
const git = args => execFileSync('git', args, { cwd: baseline, encoding: 'utf8' });
assert.equal(git(['rev-parse', 'HEAD']).trim(), 'e9abf50510b84db9f9f3a20c6f45ceb11685771f');
const provider = fs.readFileSync(path.join(baseline, 'ExpoLyrics/providers/bridge-provider.tsx'), 'utf8');
assert.match(provider, /if \(!initialized\) return;/);
assert.match(provider, /notifySimulatorAppInitialized\(\)/);
const native = fs.readFileSync(path.join(baseline, 'ExpoLyrics/components/lyrics/native/native-lyrics-view.tsx'), 'utf8');
assert.match(native, /notifySimulatorRendererReady/);
git(['apply', '--reverse', '--check', patch]);
git(['apply', '--reverse', patch]);
try {
  const tracked = git(['diff', '--name-only']).trim();
  assert.equal(tracked, '', 'removing test-only adapter must restore every tracked baseline source exactly');
} finally { git(['apply', patch]); }
console.log('Exact trusted baseline adapter restores original production sources byte-for-byte.');
