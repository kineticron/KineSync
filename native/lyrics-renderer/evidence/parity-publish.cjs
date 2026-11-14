// Publish only verified local raster artifacts; no network or native app operations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const out = path.resolve(process.argv[2] || '/tmp/rust-parity-verified');
const files = path.resolve(process.argv[3] || '/files');
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read = p => JSON.parse(fs.readFileSync(path.join(out, p)));
const { validateInputs } = require('./parity-integrity.cjs');
const capture = read('captures/capture-manifest.json');
const repeat = read('repeat/capture-manifest.json');
const verification = read('verification.json');
assert.ok(verification.checks.every(c => c.exit === 0));
assert.deepEqual(capture.records.map(r => r.pngHashes), repeat.records.map(r => r.pngHashes));
validateInputs(capture, repeat);
fs.mkdirSync(files, { recursive: true });
const published = new Map();
for (const record of capture.records) for (const [renderer, source] of Object.entries(record.pngs)) {
  assert.equal(hash(source), record.pngHashes[renderer]);
  const target = path.join(files, 'rust_parity_' + path.basename(source));
  fs.copyFileSync(source, target);
  published.set(target, { path: target, sha256: hash(target), role: renderer, source });
}
for (const item of read('captures/comparison-report.json').artifacts) {
  assert.equal(hash(item.path), item.sha256);
  published.set(item.path, { ...item, role: 'comparison' });
}
const reports = {
  'verification.json': 'parity-verification.json',
  'captures/capture-manifest.json': 'parity-capture-manifest.json',
  'captures/comparison-report.json': 'parity-comparison-report.json',
  'baseline-benchmark.json': 'parity-baseline-benchmark.json',
  'alpha1/alpha-proof.json': 'parity-alpha1.json',
  'alpha3/alpha-proof.json': 'parity-alpha3.json',
};
for (const [source, target] of Object.entries(reports)) fs.copyFileSync(path.join(out, source), path.join(__dirname, target));
const logs = [];
for (const name of fs.readdirSync(out).filter(n => n.endsWith('.log'))) {
  const target = path.join(__dirname, 'parity-' + name);
  const content = fs.readFileSync(path.join(out, name), 'utf8').trimEnd();
  fs.writeFileSync(target, content ? content + '\n' : '');
  logs.push({ path: target, sha256: hash(target) });
}
fs.writeFileSync(path.join(__dirname, 'parity-png-manifest.json'), JSON.stringify({
  scope: capture.scope, artifacts: [...published.values()], logs,
}, null, 2) + '\n');
console.log(JSON.stringify({ publishedPngs: published.size, hashesVerified: true, independentCaptureHashesIdentical: true }));
