// Local checks/capture only; never builds the app or invokes CI/Metro.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const out = path.resolve(process.argv[2] || '/tmp/rust-parity-verified');
fs.mkdirSync(out, { recursive: true });
const cargo = ['+1.97.0'];
const manifest = ['--manifest-path', 'native/lyrics-renderer/Cargo.toml'];
const commands = [
  ['integrity-tests', 'node', ['--test', 'native/lyrics-renderer/evidence/parity-integrity.test.cjs']],
  ['fmt', 'cargo', [...cargo, 'fmt', '--check', ...manifest]],
  ['rust-tests', 'cargo', [...cargo, 'test', '--locked', ...manifest, '--', '--include-ignored']],
  ['clippy-host', 'cargo', [...cargo, 'clippy', '--locked', ...manifest, '--all-targets', '--', '-D', 'warnings']],
  ['clippy-ios', 'cargo', [...cargo, 'clippy', '--locked', ...manifest, '--lib', '--target', 'aarch64-apple-ios', '--', '-D', 'warnings']],
  ['typescript', 'npm', ['--prefix', 'ExpoLyrics', 'run', 'typecheck']],
  ['eslint', './node_modules/.bin/eslint', ['components/lyrics/rust/rust-lyrics-view.tsx'], path.join(root, 'ExpoLyrics')],
  ['node-tests', 'node', ['--test', 'scripts/test/ios-dev-ci.test.cjs']],
  ['actionlint', '/tmp/rust-spike-actionlint/actionlint', ['.github/workflows/ios-development-build.yml']],
  ['repository', 'node', ['scripts/check-repository.cjs']],
  ['alpha1', 'cargo', [...cargo, 'run', '--locked', ...manifest, '--', 'alpha-proof', path.join(out, 'alpha1'), '1']],
  ['alpha3', 'cargo', [...cargo, 'run', '--locked', ...manifest, '--', 'alpha-proof', path.join(out, 'alpha3'), '3']],
  ['baseline-benchmark', 'cargo', [...cargo, 'run', '--locked', ...manifest, '--', 'bench', path.join(out, 'baseline-benchmark.json'), '30', '6', path.join(out, 'bench-png')]],
  ['capture-build', 'cargo', [...cargo, 'build', '--locked', ...manifest, '--example', 'parity-capture']],
  ['capture', 'node', ['native/lyrics-renderer/evidence/parity-capture.cjs', path.join(out, 'captures')]],
  ['capture-repeat', 'node', ['native/lyrics-renderer/evidence/parity-capture.cjs', path.join(out, 'repeat')]],
  ['sheets', 'python3', ['native/lyrics-renderer/evidence/parity-contact-sheets.py', path.join(out, 'captures'), '/files']],
  ['diff', 'git', ['diff', '--check']],
  ['runtime-unchanged', 'git', ['diff', '--exit-code', 'a9b6398', '--', 'native/lyrics-renderer/src', 'native/lyrics-renderer/Cargo.lock', 'native/lyrics-renderer/Cargo.toml', 'native/lyrics-renderer/include', 'ExpoLyrics/components/lyrics', 'ExpoLyrics/lib/rust-lyrics-protocol.js', 'ExpoLyrics/modules/kinesync-rust-lyrics', 'ExpoLyrics/app/(tabs)/index.tsx']],
];
const report = { out, note: 'Audit/capture milestone only. Linux llvmpipe baseline proxy, no runtime edit or phone speed claim.', checks: [] };
for (const [name, command, args, cwd = root] of commands) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, BASH32: '/tmp/rust-bash32-src/bash-3.2.57/bash', XDG_RUNTIME_DIR: '/tmp', WGPU_BACKEND: 'vulkan' } });
  fs.writeFileSync(path.join(out, name + '.log'), (result.stdout || '') + (result.stderr || '') + (result.error ? String(result.error) : ''));
  report.checks.push({ name, command, args, cwd, exit: result.status, signal: result.signal });
  fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${name}: ${result.status}`);
  if (result.status !== 0) process.exit(1);
}
const first = JSON.parse(fs.readFileSync(path.join(out, 'captures/capture-manifest.json')));
const second = JSON.parse(fs.readFileSync(path.join(out, 'repeat/capture-manifest.json')));
const assert = require('node:assert/strict');
require('./parity-integrity.cjs').validateInputs(first, second);
assert.deepEqual(first.records.map(r => r.pngHashes), second.records.map(r => r.pngHashes), 'independent captures must reproduce identical actual renderer PNGs');
assert.equal(first.records.length, 12);
for (const record of first.records) {
  assert.equal(record.history_ms.at(-1), record.time_ms, 'exact final snapshot timestamp');
  assert.equal(record.pngHashes.rust, first.records.find(r => r.id.replace(/-(spicy|amll)$/, '') === record.id.replace(/-(spicy|amll)$/, '')).pngHashes.rust,
    'ABI3 baseline has no style; do not fabricate a second Rust style');
}
report.repeatPixelHashesIdentical = true;
report.captureRecords = first.records.length;
fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log('independent capture byte hashes: identical');
