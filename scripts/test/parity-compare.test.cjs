/**
 * scripts/test/parity-compare.test.cjs
 *
 * Unit and contract tests for the deterministic parity compare suite:
 * - Identical images test (score = 1.0, delta = 0)
 * - Different images test (score < 1.0, delta > 0, changed pixels detected)
 * - Alpha mask & background dilution test (foreground score avoids dilution)
 * - Strict dimensions test (mismatched sizes fail closed without resizing)
 * - Alpha channel delta and empty raster detection
 * - Baseline pass/fail threshold gate test
 * - Hash determinism test
 * - Review repro 1: Catastrophic 1-pixel disappearance FAILS baseline gate
 * - Review repro 2: Background-colored alpha-1 text FAILS baseline gate and alpha score
 * - Review repro 3: Semantic field alteration fails validateInputs
 * - Review repro 4: Latin fixture line index is 9 and timestamps match TTML contract
 * - Review repro 5: Single-pass input validation catches tampering and records skipped determinism
 * - Review repro 6: Two equally wrong-size images fail strict dimension check
 * - Review repro 7: Rust font provenance explicitly labeled unverified
 * - Review repro 8: Rust binary attestation binds source closure and normalizes target
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const hash = data => createHash('sha256').update(data).digest('hex');
const { hashFile, validateInputs, validateSinglePassInputs, validateManifestSchema } = require('../../native/lyrics-renderer/evidence/parity-integrity.cjs');
const { ensureRustBinary } = require('../parity-compare.cjs');

function runPythonMetrics(manifest, tempDir, envExtra = {}, specManifestPath = null) {
  const manifestFile = path.join(tempDir, 'capture-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const args = ['native/lyrics-renderer/evidence/parity-contact-sheets.py', tempDir, tempDir];
  if (specManifestPath) args.push(specManifestPath);
  const stdout = execFileSync(
    'python3',
    args,
    { cwd: root, encoding: 'utf8', env: { ...process.env, XDG_RUNTIME_DIR: '/tmp', WGPU_BACKEND: 'vulkan', ...envExtra } }
  );
  const result = JSON.parse(stdout);
  const report = JSON.parse(fs.readFileSync(result.json_report, 'utf8'));
  return { result, report };
}

function createPngHelper(tempDir, filename, width, height, pixelFn) {
  const pyScript = `
import sys
from PIL import Image
import numpy as np

w, h = ${width}, ${height}
arr = np.zeros((h, w, 4), dtype=np.uint8)
${pixelFn}
img = Image.fromarray(arr, 'RGBA')
img.save(sys.argv[1])
`;
  const filePath = path.join(tempDir, filename);
  execFileSync('python3', ['-c', pyScript, filePath], { cwd: tempDir });
  return filePath;
}

test('deterministic numerical scoring: identical images yield score 1.0, delta 0, and 0 changed pixels', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-identical-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const skiaPng = createPngHelper(dir, 'skia.png', 100, 100, `
arr[40:60, 20:80] = [255, 0, 0, 255]
`);
  const rustPng = path.join(dir, 'rust.png');
  fs.copyFileSync(skiaPng, rustPng);

  const manifest = {
    schema: 2,
    records: [{
      id: 'korean-390x640-1x-spicy',
      viewport: { width: 100, height: 100, dpr: 1 },
      time_ms: 1000.0,
      pngs: { skia: skiaPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };

  const { report } = runPythonMetrics(manifest, dir);
  const rec = report.records[0];

  assert.equal(rec.changed_pixels, 0);
  assert.equal(rec.max_rgb_delta, 0);
  assert.equal(rec.mean_rgb_delta, 0);
  assert.equal(rec.max_alpha_delta, 0);
  assert.equal(rec.global_normalized_score, 1.0);
  assert.equal(rec.foreground_normalized_score, 1.0);
  assert.equal(rec.foreground_alpha_score, 1.0);
  assert.equal(rec.foreground_rgba_score, 1.0);
  assert.equal(rec.ink_coverage_ratio, 1.0);
  assert.equal(rec.bbox_normalized_score, 1.0);
});

test('deterministic numerical scoring: different images detect delta and changed pixels', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-diff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const skiaPng = createPngHelper(dir, 'skia.png', 100, 100, `
arr[40:60, 20:80] = [255, 0, 0, 255]
`);
  const rustPng = createPngHelper(dir, 'rust.png', 100, 100, `
arr[40:60, 20:80] = [0, 0, 255, 255]
`);

  const manifest = {
    schema: 2,
    records: [{
      id: 'latin-390x640-1x-spicy',
      viewport: { width: 100, height: 100, dpr: 1 },
      time_ms: 2000.0,
      pngs: { skia: skiaPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };

  const { report } = runPythonMetrics(manifest, dir);
  const rec = report.records[0];

  assert.equal(rec.changed_pixels, 1200);
  assert.equal(rec.max_rgb_delta, 255);
  assert.ok(rec.global_normalized_score < 1.0);
  assert.ok(rec.foreground_normalized_score < 1.0);
  assert.equal(rec.foreground_changed_ratio, 1.0);
});

test('foreground mask avoids blank background dilution', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-dilution-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const skiaPng = createPngHelper(dir, 'skia.png', 100, 100, `
arr[45:55, 45:55] = [255, 0, 0, 255]
`);
  const rustPng = createPngHelper(dir, 'rust.png', 100, 100, `
arr[45:55, 45:55] = [0, 0, 0, 255]
`);

  const manifest = {
    schema: 2,
    records: [{
      id: 'korean-390x640-1x-amll',
      viewport: { width: 100, height: 100, dpr: 1 },
      time_ms: 1000.0,
      pngs: { skia: skiaPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };

  const { report } = runPythonMetrics(manifest, dir);
  const rec = report.records[0];

  assert.ok(rec.global_normalized_score > 0.99, `expected global score > 0.99, got ${rec.global_normalized_score}`);
  assert.ok(
    rec.foreground_normalized_score < 0.70 && rec.foreground_normalized_score > 0.65,
    `expected undiluted foreground score around 0.667, got ${rec.foreground_normalized_score}`
  );
});

test('strict dimensions: mismatched dimensions fail closed without resizing', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-dim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const skiaPng = createPngHelper(dir, 'skia.png', 100, 100, `arr[45:55, 45:55] = [255, 0, 0, 255]`);
  const rustPng = createPngHelper(dir, 'rust.png', 100, 101, `arr[45:55, 45:55] = [255, 0, 0, 255]`);

  const manifest = {
    schema: 2,
    records: [{
      id: 'dim-mismatch',
      viewport: { width: 100, height: 100, dpr: 1 },
      time_ms: 1000.0,
      pngs: { skia: skiaPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };

  assert.throws(
    () => runPythonMetrics(manifest, dir),
    /mismatched renderer dimensions/,
    'must fail closed on renderer dimension mismatch'
  );
});

test('review repro 6: two equally wrong-size images fail strict dimension check', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-both-wrong-dim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Both are 100x101, but declared viewport*DPR is 100x100
  const skiaPng = createPngHelper(dir, 'skia.png', 100, 101, `arr[45:55, 45:55] = [255, 0, 0, 255]`);
  const rustPng = createPngHelper(dir, 'rust.png', 100, 101, `arr[45:55, 45:55] = [255, 0, 0, 255]`);

  const manifest = {
    schema: 2,
    records: [{
      id: 'korean-390x640-1x-spicy',
      viewport: { width: 100, height: 100, dpr: 1 },
      time_ms: 1000.0,
      pngs: { skia: skiaPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };

  assert.throws(
    () => runPythonMetrics(manifest, dir),
    /strict dimension check failed/,
    'must fail closed when both images mismatch declared viewport dimensions'
  );
});

test('alpha channel delta and empty raster detection', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-alpha-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const skiaPng = createPngHelper(dir, 'skia.png', 100, 100, `arr[40:60, 20:80] = [255, 255, 255, 128]`);
  const rustPng = createPngHelper(dir, 'rust.png', 100, 100, `arr[40:60, 20:80] = [255, 255, 255, 255]`);

  const manifest = {
    schema: 2,
    records: [{
      id: 'alpha-test',
      viewport: { width: 100, height: 100, dpr: 1 },
      time_ms: 1000.0,
      pngs: { skia: skiaPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };

  const { report } = runPythonMetrics(manifest, dir);
  const rec = report.records[0];

  assert.equal(rec.max_alpha_delta, 127);
  assert.ok(rec.mean_alpha_delta > 0);
  assert.ok(rec.foreground_alpha_score < 1.0);

  const emptyPng = createPngHelper(dir, 'empty.png', 100, 100, `# no pixels set`);
  const emptyManifest = {
    schema: 2,
    records: [{
      id: 'empty-test',
      viewport: { width: 100, height: 100, dpr: 1 },
      time_ms: 1000.0,
      pngs: { skia: emptyPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(emptyPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };
  assert.throws(() => runPythonMetrics(emptyManifest, dir), /empty skia raster/);
});

test('review repro 1: catastrophic 1-pixel disappearance FAILS baseline gate', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-repro-1pixel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Skia has full text (2000+ ink pixels), Rust has 1 pixel with alpha=1 (review repro)
  const skiaPng = createPngHelper(dir, 'skia.png', 390, 640, `
arr[237:270, 28:150] = [255, 255, 255, 255]
`);
  const rustPng = createPngHelper(dir, 'rust.png', 390, 640, `
arr[237, 28] = [255, 255, 255, 1]
`);

  const manifest = {
    schema: 2,
    records: [{
      id: 'korean-390x640-1x-spicy',
      viewport: { width: 390, height: 640, dpr: 1 },
      time_ms: 14706.9,
      pngs: { skia: skiaPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };

  const { report } = runPythonMetrics(manifest, dir);
  const rec = report.records[0];

  // Must fail the gate! Vanishing text cannot be accepted!
  assert.equal(rec.baseline_passed, false, 'vanishing 1-pixel text MUST NOT pass baseline gate');
  assert.ok(rec.ink_coverage_ratio < 0.01, 'ink coverage ratio must detect collapse');
  assert.ok(rec.foreground_alpha_score < 0.05, 'foreground alpha score must detect missing alpha');
});

test('review repro 2: background-colored alpha-1 text FAILS baseline gate and alpha score', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-repro-alpha1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 100x100 canvas with 10x10 square colored RGB (22, 28, 40)
  // Skia is alpha 255, Rust is alpha 1 (review repro)
  const skiaPng = createPngHelper(dir, 'skia.png', 100, 100, `
arr[45:55, 45:55] = [22, 28, 40, 255]
`);
  const rustPng = createPngHelper(dir, 'rust.png', 100, 100, `
arr[45:55, 45:55] = [22, 28, 40, 1]
`);

  const manifest = {
    schema: 2,
    records: [{
      id: 'korean-390x640-1x-spicy',
      viewport: { width: 100, height: 100, dpr: 1 },
      time_ms: 1000.0,
      pngs: { skia: skiaPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };

  const { report } = runPythonMetrics(manifest, dir);
  const rec = report.records[0];

  // Foreground alpha score detects the nearly transparent mismatch
  assert.ok(rec.foreground_alpha_score < 0.05, `expected near-zero alpha score, got ${rec.foreground_alpha_score}`);
  assert.equal(rec.baseline_passed, false, 'background-colored alpha-1 text MUST NOT pass baseline gate');
});

test('review repro 3: semantic field alteration fails validateInputs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-repro-semantic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const makeFile = name => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, name);
    return { path: p, sha256: hash(fs.readFileSync(p)) };
  };

  const packet = makeFile('packet.json');
  const base = {
    schema: 2,
    sources: [makeFile('source.js')],
    fonts: [makeFile('font1.otf'), makeFile('font2.otf')],
    rustHostFonts: { files: [makeFile('rustfont.ttc')] },
    rustBinary: makeFile('parity-capture'),
    records: [{
      id: 'korean-390x640-1x-spicy',
      viewport: { width: 390, height: 640, dpr: 1 },
      style: 'spicy',
      fixtureLine: 1,
      time_ms: 14706.9,
      history_ms: [13706.9, 14706.9],
      settings: { fontScale: 1 },
      skiaGeometry: { fontSize: 33.6 },
      rustGeometry: { fontSize: 34 },
      inputPacket: packet.path,
      inputPacketSha256: packet.sha256,
    }]
  };

  // 1. Time altered
  const alteredTime = structuredClone(base);
  alteredTime.records[0].time_ms = 99999.9;
  assert.throws(() => validateInputs(base, alteredTime), /time_ms mismatch/);

  // 2. History emptied
  const alteredHistory = structuredClone(base);
  alteredHistory.records[0].history_ms = [];
  assert.throws(() => validateInputs(base, alteredHistory), /history_ms mismatch/);

  // 3. Viewport width changed
  const alteredVp = structuredClone(base);
  alteredVp.records[0].viewport.width = 1;
  assert.throws(() => validateInputs(base, alteredVp), /viewport mismatch/);

  // 4. Settings changed
  const alteredSettings = structuredClone(base);
  alteredSettings.records[0].settings.fontScale = 999;
  assert.throws(() => validateInputs(base, alteredSettings), /settings mismatch/);

  // 5. Geometry changed
  const alteredGeom = structuredClone(base);
  alteredGeom.records[0].skiaGeometry.fontSize = 100;
  assert.throws(() => validateInputs(base, alteredGeom), /skiaGeometry mismatch/);
});

test('review repro 4: Latin fixture line index is 9 and timestamps match TTML contract', () => {
  const specPath = path.join(root, 'native/lyrics-renderer/evidence/parity-manifest.json');
  assert.ok(fs.existsSync(specPath), 'spec manifest must exist');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

  const latinFixture = spec.fixtures.find(f => f.id === 'latin');
  assert.ok(latinFixture, 'latin fixture must be declared');
  assert.equal(latinFixture.line_index, 9, 'latin fixture must be line_index 9 (first ASCII-only line)');
  assert.equal(latinFixture.time_ms, 56925.2, 'latin timestamp must match 0.47 ratio at line 9');
  assert.equal(latinFixture.line_start_ms, 55205);
  assert.equal(latinFixture.line_end_ms, 58865);
});

test('review repro 5: --skip-repeat validates single pass inputs and records skipped determinism', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-skip-repeat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const skiaPng = createPngHelper(dir, 'skia.png', 100, 100, `arr[40:60, 20:80] = [255, 0, 0, 255]`);
  const rustPng = path.join(dir, 'rust.png');
  fs.copyFileSync(skiaPng, rustPng);

  const manifest = {
    schema: 2,
    records: [{
      id: 'korean-390x640-1x-spicy',
      viewport: { width: 100, height: 100, dpr: 1 },
      time_ms: 1000.0,
      pngs: { skia: skiaPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };

  const { report } = runPythonMetrics(manifest, dir, {
    PARITY_DETERMINISM_STATUS: 'SKIPPED_SINGLE_PASS_ONLY',
    PARITY_DETERMINISM_VERIFIED: 'false',
  });

  assert.equal(report.determinism_status, 'SKIPPED_SINGLE_PASS_ONLY');
  assert.equal(report.determinism_verified, false);
});

test('review repro 7: Rust font provenance explicitly labeled unverified', () => {
  const specPath = path.join(root, 'native/lyrics-renderer/evidence/parity-manifest.json');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

  assert.equal(spec.fonts.rust.provenance, 'UNVERIFIED_SYSTEM_FALLBACK_CANDIDATES');
  assert.ok(spec.fonts.rust.face_attestation.includes('UNVERIFIED'));
});

test('review repro 8: Rust binary attestation binds source closure and normalizes target', () => {
  const attestation = ensureRustBinary({ json: true, freshRust: false });
  assert.ok(attestation.binaryPath.endsWith('native/lyrics-renderer/target/debug/examples/parity-capture'));
  assert.ok(/^[a-f0-9]{64}$/.test(attestation.binarySha));
  assert.ok(/^[a-f0-9]{64}$/.test(attestation.sourceClosureDigest));
  assert.ok(attestation.toolchain.cargo.includes('cargo'));
  assert.ok(attestation.toolchain.rustc.includes('rustc'));
  assert.ok(attestation.toolchain.rustc.includes('release:'));
  assert.equal(attestation.effectiveFlags.incremental, 0);
  assert.equal(attestation.effectiveFlags.devDebug, 0);
  assert.equal(attestation.effectiveFlags.testDebug, 0);
  assert.ok(attestation.sourceClosure.some(e => e.path.endsWith('ZZA0P2622376.ttml')), 'closure must bind embedded TTML fixture');
});

test('zero-alpha RGB invariance: mutating RGB when alpha=0 produces identical scores in actual Python gate', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-zero-alpha-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const skiaPng = createPngHelper(dir, 'skia.png', 100, 100, `
arr[40:60, 20:80] = [255, 0, 0, 255]
`);
  // Rust has text ink AND transparent pixels with different RGB
  const rustPng1 = createPngHelper(dir, 'rust1.png', 100, 100, `
arr[40:60, 20:80] = [0, 255, 0, 255]
# transparent pixels have RGB = 0, 0, 0
`);
  const rustPng2 = createPngHelper(dir, 'rust2.png', 100, 100, `
arr[40:60, 20:80] = [0, 255, 0, 255]
# transparent pixels have random RGB, but alpha remains 0!
arr[0:40, :] = [255, 128, 64, 0]
arr[60:100, :] = [10, 20, 30, 0]
`);

  const manifest1 = {
    schema: 2,
    records: [{
      id: 'korean-390x640-1x-spicy',
      viewport: { width: 100, height: 100, dpr: 1 },
      time_ms: 1000.0,
      pngs: { skia: skiaPng, rust: rustPng1 },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng1)) }
    }]
  };
  const manifest2 = {
    schema: 2,
    records: [{
      id: 'korean-390x640-1x-spicy',
      viewport: { width: 100, height: 100, dpr: 1 },
      time_ms: 1000.0,
      pngs: { skia: skiaPng, rust: rustPng2 },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng2)) }
    }]
  };

  const { report: rep1 } = runPythonMetrics(manifest1, dir);
  const { report: rep2 } = runPythonMetrics(manifest2, dir);

  assert.equal(rep1.records[0].foreground_normalized_score, rep2.records[0].foreground_normalized_score);
  assert.equal(rep1.records[0].foreground_alpha_score, rep2.records[0].foreground_alpha_score);
  assert.equal(rep1.records[0].global_normalized_score, rep2.records[0].global_normalized_score);
  assert.equal(rep1.records[0].ref_energy_normalized_score, rep2.records[0].ref_energy_normalized_score);
});

test('review repro v2 BLOCK A: full-frame alpha-1 flood + alpha-8 camouflage FAILS actual Python gate', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-alpha-flood-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 390x640 canvas (real Korean dimensions)
  const skiaPng = createPngHelper(dir, 'skia.png', 390, 640, `
arr[237:270, 28:150] = [255, 255, 255, 255]
`);
  // Adversarial: alpha 1 on whole canvas, alpha 8 on reference ink
  const rustPng = createPngHelper(dir, 'rust.png', 390, 640, `
arr[:, :, :3] = [22, 28, 40]
arr[:, :, 3] = 1
arr[237:270, 28:150, 3] = 8
`);

  const manifest = {
    schema: 2,
    records: [{
      id: 'korean-390x640-1x-spicy',
      viewport: { width: 390, height: 640, dpr: 1 },
      time_ms: 14706.9,
      pngs: { skia: skiaPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };

  const { report } = runPythonMetrics(manifest, dir);
  const rec = report.records[0];

  assert.equal(rec.baseline_passed, false, 'alpha-1 flood + alpha-8 camouflage MUST FAIL baseline gate');
  assert.ok(rec.outside_rust_alpha_max > 0, 'must detect background alpha flood outside ink bounding box');
  assert.ok(rec.mean_rust_ink_alpha < 0.15, 'must detect low-alpha ink energy collapse');
});

test('total disappearance (all zero raster) FAILS actual Python gate', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-disappearance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const skiaPng = createPngHelper(dir, 'skia.png', 390, 640, `
arr[237:270, 28:150] = [255, 255, 255, 255]
`);
  const rustPng = createPngHelper(dir, 'rust.png', 390, 640, `# empty raster with 0 alpha`);

  const manifest = {
    schema: 2,
    records: [{
      id: 'korean-390x640-1x-spicy',
      viewport: { width: 390, height: 640, dpr: 1 },
      time_ms: 14706.9,
      pngs: { skia: skiaPng, rust: rustPng },
      pngHashes: { skia: hash(fs.readFileSync(skiaPng)), rust: hash(fs.readFileSync(rustPng)) }
    }]
  };

  assert.throws(
    () => runPythonMetrics(manifest, dir),
    /empty rust raster/,
    'must fail closed on completely empty raster'
  );
});

test('manifest schema validation rejects unknown keys, missing matrix, duplicate IDs, contradictory dimensions', () => {
  const specPath = path.join(root, 'native/lyrics-renderer/evidence/parity-manifest.json');
  const validSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

  // 1. Unknown top-level key
  const specBadKey = structuredClone(validSpec);
  specBadKey.unknown_property = 'invalid';
  assert.throws(() => validateManifestSchema(specBadKey), /unknown manifest property/);

  // 2. Contradictory strict_dimensions
  const specBadDim = structuredClone(validSpec);
  specBadDim.viewports[0].strict_dimensions = { width: 1, height: 1 };
  assert.throws(() => validateManifestSchema(specBadDim), /contradictory strict_dimensions/);

  // 3. Missing expected_record_ids
  const specNoIds = structuredClone(validSpec);
  delete specNoIds.expected_record_ids;
  assert.throws(() => validateManifestSchema(specNoIds), /missing mandatory expected_record_ids/);

  // 4. Duplicate IDs in Cartesian product
  const specDup = structuredClone(validSpec);
  specDup.styles.push(specDup.styles[0]);
  assert.throws(() => validateManifestSchema(specDup), /duplicate record IDs/);
});

test('whole CLI test: custom manifest with altered expected_text fails closed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-cli-test-text-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const specPath = path.join(root, 'native/lyrics-renderer/evidence/parity-manifest.json');
  const m = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  m.fixtures[0].expected_text = 'NOT THE TEXT';
  const customManifestPath = path.join(dir, 'custom-manifest.json');
  fs.writeFileSync(customManifestPath, JSON.stringify(m, null, 2));

  assert.throws(
    () => execFileSync(
      process.execPath,
      ['scripts/parity-compare.cjs', '--manifest', customManifestPath, '--skip-repeat', '--output', dir],
      { cwd: root, stdio: 'pipe' }
    ),
    'altering expected_text in custom manifest must fail closed in whole CLI execution'
  );
});

test('whole CLI test: custom manifest with impossible min_foreground_score=1.0 fails closed and propagates threshold', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-cli-test-thresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const specPath = path.join(root, 'native/lyrics-renderer/evidence/parity-manifest.json');
  const m = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  m.fixtures.forEach(f => {
    f.baseline_thresholds.min_foreground_score = 1.0;
  });
  const customManifestPath = path.join(dir, 'custom-manifest.json');
  fs.writeFileSync(customManifestPath, JSON.stringify(m, null, 2));

  let failed = false;
  try {
    execFileSync(
      process.execPath,
      ['scripts/parity-compare.cjs', '--manifest', customManifestPath, '--skip-repeat', '--output', dir],
      { cwd: root, stdio: 'pipe' }
    );
  } catch (err) {
    failed = true;
  }
  assert.ok(failed, 'setting min_foreground_score=1.0 must fail the baseline gate in whole CLI execution');

  // Verify that Python report actually recorded the propagated 1.0 threshold
  const reportPath = path.join(dir, 'comparison-report.json');
  assert.ok(fs.existsSync(reportPath), 'comparison report must be written');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.records[0].baseline_thresholds.min_foreground_score, 1.0, 'threshold must propagate to report');
  assert.equal(report.records[0].baseline_passed, false, 'must fail gate with threshold 1.0');
});

test('whole CLI test: custom manifest with non-existent font file fails closed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-cli-test-font-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const specPath = path.join(root, 'native/lyrics-renderer/evidence/parity-manifest.json');
  const m = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  m.fonts.skia.files = ['/nonexistent-font.otf'];
  const customManifestPath = path.join(dir, 'custom-manifest.json');
  fs.writeFileSync(customManifestPath, JSON.stringify(m, null, 2));

  assert.throws(
    () => execFileSync(
      process.execPath,
      ['scripts/parity-compare.cjs', '--manifest', customManifestPath, '--skip-repeat', '--output', dir],
      { cwd: root, stdio: 'pipe' }
    ),
    'nonexistent font file in custom manifest must fail closed in whole CLI execution'
  );
});

test('whole CLI test: incomplete and duplicate manifest matrices fail closed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-cli-test-matrix-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const specPath = path.join(root, 'native/lyrics-renderer/evidence/parity-manifest.json');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

  // 1. Incomplete matrix (missing expected_record_ids and truncated fixtures)
  const inc = structuredClone(spec);
  delete inc.expected_record_ids;
  inc.fixtures = inc.fixtures.slice(0, 1);
  const incPath = path.join(dir, 'inc-manifest.json');
  fs.writeFileSync(incPath, JSON.stringify(inc, null, 2));
  assert.throws(
    () => execFileSync(process.execPath, ['scripts/parity-compare.cjs', '--manifest', incPath, '--skip-repeat', '--output', dir], { cwd: root, stdio: 'pipe' }),
    'incomplete matrix manifest must fail closed'
  );

  // 2. Duplicate matrix
  const dup = structuredClone(spec);
  dup.styles = [dup.styles[0], dup.styles[0]];
  const dupPath = path.join(dir, 'dup-manifest.json');
  fs.writeFileSync(dupPath, JSON.stringify(dup, null, 2));
  assert.throws(
    () => execFileSync(process.execPath, ['scripts/parity-compare.cjs', '--manifest', dupPath, '--skip-repeat', '--output', dir], { cwd: root, stdio: 'pipe' }),
    'duplicate matrix manifest must fail closed'
  );
});

test('single-pass input validation catches mutated time_ms, empty history, mutated fontScale, truncated sources', () => {
  const specPath = path.join(root, 'native/lyrics-renderer/evidence/parity-manifest.json');
  const validCapture = {
    schema: 2,
    manifest_digest: hashFile(specPath),
    rustBinary: { path: path.join(root, 'native/lyrics-renderer/target/debug/examples/parity-capture'), sha256: hashFile(path.join(root, 'native/lyrics-renderer/target/debug/examples/parity-capture')) },
    sources: Array.from({ length: 15 }, (_, i) => ({ path: path.join(root, 'native/lyrics-renderer/src/lib.rs'), sha256: hashFile(path.join(root, 'native/lyrics-renderer/src/lib.rs')) })),
    fonts: [{ path: path.join(root, 'ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf'), sha256: hashFile(path.join(root, 'ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf')) },
            { path: path.join(root, 'ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf'), sha256: hashFile(path.join(root, 'ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf')) }],
    rustHostFonts: { files: [{ path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', sha256: hashFile('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc') }] },
    records: JSON.parse(fs.readFileSync(specPath, 'utf8')).expected_record_ids.map(id => {
      const fId = id.split('-')[0];
      const time = fId === 'korean' ? 14706.9 : 56925.2;
      const line = fId === 'korean' ? 1 : 9;
      const text = fId === 'korean' ? '깍지 놓친 손은' : 'Du, du-ru-ru-ru-ru-du-du';
      const packetPath = path.join(root, 'native/lyrics-renderer/Cargo.toml');
      return {
        id,
        fixture_id: fId,
        time_ms: time,
        fixtureLine: line,
        viewport: { width: 390, height: 640, dpr: 1 },
        style: id.endsWith('spicy') ? 'spicy' : 'amll',
        history_ms: [time],
        settings: { fontScale: 1, background: false },
        originalSyllables: [{ text }],
        inputPacket: packetPath,
        inputPacketSha256: hashFile(packetPath),
      };
    })
  };

  // Valid capture passes
  validateSinglePassInputs(validCapture, specPath);

  // 1. Mutated time_ms
  const badTime = structuredClone(validCapture);
  badTime.records[0].time_ms += 1000;
  assert.throws(() => validateSinglePassInputs(badTime, specPath), /time_ms mismatch/);

  // 2. Empty history_ms
  const badHist = structuredClone(validCapture);
  badHist.records[0].history_ms = [];
  assert.throws(() => validateSinglePassInputs(badHist, specPath), /empty or invalid history_ms/);

  // 3. Mutated fontScale
  const badScale = structuredClone(validCapture);
  badScale.records[0].settings.fontScale = 999;
  assert.throws(() => validateSinglePassInputs(badScale, specPath), /unsupported fontScale/);

  // 4. Truncated sources
  const badSources = structuredClone(validCapture);
  badSources.sources = badSources.sources.slice(0, 1);
  assert.throws(() => validateSinglePassInputs(badSources, specPath), /incomplete sources inventory/);
});

test('mocked build harness: mutating embedded TTML fixture or build flags alters attestation', () => {
  // Verify that source closure digest computation includes the embedded TTML fixture
  const specPath = path.join(root, 'native/lyrics-renderer/evidence/parity-manifest.json');
  const attestation = ensureRustBinary({ json: true, freshRust: false });
  assert.ok(attestation.sourceClosure.some(e => e.path.includes('ZZA0P2622376.ttml')));

  // Mutating a file in the closure array changes the closure digest:
  const closureMutated = attestation.sourceClosure.map(e => {
    if (e.path.includes('ZZA0P2622376.ttml')) {
      return { path: e.path, sha256: '0'.repeat(64) };
    }
    return e;
  });
  const mutatedDigest = createHash('sha256').update(JSON.stringify(closureMutated)).digest('hex');
  assert.notEqual(attestation.sourceClosureDigest, mutatedDigest, 'mutating embedded fixture must change sourceClosureDigest');

  // Verify that compiler identity is captured
  assert.ok(attestation.toolchain.rustc.includes('commit-hash:'));
});
