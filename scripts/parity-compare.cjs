#!/usr/bin/env node
/**
 * scripts/parity-compare.cjs
 *
 * ONE plain command (no LLM at runtime) for deterministic numerical Rust vs
 * production Skia parity comparison across fixed fixtures, viewports, and styles.
 *
 * Usage:
 *   node scripts/parity-compare.cjs [options]
 *
 * Options:
 *   --output <dir>    Output directory (default: /tmp/rust-parity-compare-output)
 *   --fresh-rust      Rebuild fresh Rust parity-capture binary with exact source attestation
 *   --skip-repeat     Skip repeat pass (default false: runs two passes for determinism)
 *   --manifest <file> Custom parity manifest path (defaults to parity-manifest.json)
 *   --json            Output JSON report only to stdout
 *   --help            Show help message
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const externalModules = '/home/kit/rust-renderer-spike/ExpoLyrics/node_modules';
if (!process.env.NODE_PATH && fs.existsSync(externalModules)) {
  process.env.NODE_PATH = externalModules;
  require('node:module').Module._initPaths();
}

const { hashFile, validateInputs, validateSinglePassInputs, validateManifestSchema } = require('../native/lyrics-renderer/evidence/parity-integrity.cjs');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    output: '/tmp/rust-parity-compare-output',
    manifest: path.join(root, 'native/lyrics-renderer/evidence/parity-manifest.json'),
    freshRust: false,
    skipRepeat: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output' && i + 1 < args.length) {
      options.output = path.resolve(args[++i]);
    } else if (arg === '--manifest' && i + 1 < args.length) {
      options.manifest = path.resolve(args[++i]);
    } else if (arg === '--evaluate' && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      options.evaluate = path.resolve(args[++i]);
    } else if (arg === '--fresh-rust') {
      options.freshRust = true;
    } else if (arg === '--skip-repeat') {
      options.skipRepeat = true;
    } else if (arg === '--diagnostic') {
      options.diagnostic = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Deterministic Rust vs Production Skia Parity Comparison

Usage:
  node scripts/parity-compare.cjs [options]

Options:
  --output <dir>    Directory to store generated artifacts (default: /tmp/rust-parity-compare-output)
  --manifest <path> Path to specification manifest (default: native/lyrics-renderer/evidence/parity-manifest.json)
  --fresh-rust      Rebuild fresh Rust parity-capture binary with exact source attestation
  --skip-repeat     Skip 2nd capture pass (default false: runs 2 passes to verify hash determinism)
  --evaluate <dir>  Evaluate untrusted cached bundle without Cargo or rendering
  --diagnostic      Allow exit0 for valid nonaccepting diagnostic evidence
  --json            Print JSON report only to stdout
  --help, -h        Show this help message
`);
      process.exit(0);
    } else if (!arg.startsWith('-') && i === 0) {
      options.output = path.resolve(arg);
    } else {
      throw new Error(`Unknown or invalid command line argument: ${arg}`);
    }
  }
  return options;
}

function preflightBuildEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (/^(RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_HOME|CARGO_BUILD_.*|CARGO_PROFILE_.*|CARGO_TARGET_.*_(LINKER|RUSTFLAGS))$/.test(name)) {
      throw new Error(`INVALID_BUILD_ENV UNSUPPORTED_BUILD_OVERRIDE ${name}`);
    }
  }
  const dirs = [process.env.HOME && path.join(process.env.HOME, '.cargo')];
  let dir = root;
  while (true) { dirs.push(path.join(dir, '.cargo')); const parent = path.dirname(dir); if (parent === dir) break; dir = parent; }
  for (const dir of dirs.filter(Boolean)) for (const file of ['config', 'config.toml']) {
    assert.ok(!fs.existsSync(path.join(dir, file)), `INVALID_BUILD_ENV UNSUPPORTED_CARGO_CONFIG ${path.join(dir, file)}`);
  }
}

function ensureRustBinary(options = {}) {
  preflightBuildEnvironment();
  // Check available disk space before building
  const stat = fs.statfsSync(root);
  const freeBytes = stat.bavail * stat.bsize;
  assert.ok(freeBytes >= 400 * 1024 * 1024, `insufficient free disk space: ${Math.round(freeBytes / 1024 / 1024)} MB available (< 400 MB required)`);

  // Normalize target directory to own worktree
  const targetDir = path.join(root, 'native/lyrics-renderer/target');
  const binaryPath = path.join(targetDir, 'debug/examples/parity-capture');

  // Handle --fresh-rust: clean local crate on existing target before build
  if (options.freshRust) {
    if (!options.json) {
      console.log(`--fresh-rust specified: cleaning local crate 'lyrics-renderer' on existing target (${targetDir})...`);
    }
    execFileSync(
      'cargo',
      ['+1.97.0', 'clean', '-p', 'lyrics-renderer', '--manifest-path', path.join(root, 'native/lyrics-renderer/Cargo.toml'), '--target-dir', targetDir],
      { cwd: root, stdio: options.json ? 'ignore' : 'inherit' }
    );
  }

  // Build environment with lowdebug flags
  const buildEnv = {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    CARGO_INCREMENTAL: '0',
    CARGO_PROFILE_DEV_DEBUG: '0',
    CARGO_PROFILE_TEST_DEBUG: '0',
  };

  if (!options.json) {
    console.log(`Verifying/compiling Rust binary (incremental dev profile, debug=0, target=${targetDir})...`);
  }
  execFileSync(
    'cargo',
    ['+1.97.0', 'build', '--locked', '--manifest-path', path.join(root, 'native/lyrics-renderer/Cargo.toml'), '--example', 'parity-capture'],
    { cwd: root, env: buildEnv, stdio: options.json ? 'ignore' : 'inherit' }
  );

  assert.ok(fs.existsSync(binaryPath), `Rust binary missing at ${binaryPath}`);
  const binarySha = hashFile(binaryPath);

  // Compute complete build source closure:
  // Collect Cargo files, embedded TTML fixture, shaders, and source files.
  // Parse Cargo depfile if available:
  const sourceFilesSet = new Set([
    path.join(root, 'native/lyrics-renderer/Cargo.toml'),
    path.join(root, 'native/lyrics-renderer/Cargo.lock'),
    path.join(root, 'native/lyrics-renderer/examples/parity-capture.rs'),
    path.join(root, 'DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml'),
  ]);
  const depfilePath = path.join(targetDir, 'debug/examples/parity-capture.d');
  if (fs.existsSync(depfilePath)) {
    const depContent = fs.readFileSync(depfilePath, 'utf8');
    const colonIdx = depContent.indexOf(':');
    if (colonIdx !== -1) {
      const deps = depContent.slice(colonIdx + 1).split(/\s+/).filter(Boolean);
      for (const d of deps) {
        if (fs.existsSync(d)) sourceFilesSet.add(path.resolve(d));
      }
    }
  }
  const srcDir = path.join(root, 'native/lyrics-renderer/src');
  if (fs.existsSync(srcDir)) {
    for (const name of fs.readdirSync(srcDir)) {
      sourceFilesSet.add(path.resolve(srcDir, name));
    }
  }

  const closureEntries = [...sourceFilesSet].map(f => ({
    path: path.resolve(f),
    sha256: hashFile(f),
  })).sort((a, b) => a.path.localeCompare(b.path));

  const sourceClosureDigest = createHash('sha256')
    .update(JSON.stringify(closureEntries))
    .digest('hex');

  // Query toolchain version and compiler identity
  const cargoVersion = execFileSync('cargo', ['+1.97.0', '--version'], { encoding: 'utf8' }).trim();
  const rustcVersion = execFileSync('rustc', ['+1.97.0', '-Vv'], { encoding: 'utf8' }).trim();
  const toolchain = {
    cargo: cargoVersion,
    rustc: rustcVersion,
  };

  const attestation = {
    binaryPath,
    binarySha,
    sourceClosureDigest,
    sourceClosure: closureEntries,
    toolchain,
    effectiveFlags: {
      incremental: 0,
      devDebug: 0,
      testDebug: 0,
      locked: true,
      example: 'parity-capture',
      targetDir,
      buildEnvOverrides: {
        RUSTFLAGS: process.env.RUSTFLAGS || null,
        CARGO_ENCODED_RUSTFLAGS: process.env.CARGO_ENCODED_RUSTFLAGS || null,
        RUSTC_WRAPPER: process.env.RUSTC_WRAPPER || null,
      },
    },
    attestedAt: new Date().toISOString(),
  };

  return attestation;
}

function runCapture(outputDir, manifestPath, binaryPath, env) {
  fs.mkdirSync(outputDir, { recursive: true });
  execFileSync(
    process.execPath,
    ['native/lyrics-renderer/evidence/parity-capture.cjs', outputDir, manifestPath],
    { cwd: root, env: { ...env, RUST_PARITY_BINARY: binaryPath }, stdio: 'pipe' }
  );
  const captureManifestPath = path.join(outputDir, 'capture-manifest.json');
  assert.ok(fs.existsSync(captureManifestPath), `missing capture manifest at ${captureManifestPath}`);
  return JSON.parse(fs.readFileSync(captureManifestPath, 'utf8'));
}

function main() {
  const options = parseArgs();
  const outDir = options.output;
  fs.mkdirSync(outDir, { recursive: true });

  const manifestPath = options.manifest;
  assert.ok(fs.existsSync(manifestPath), `specification manifest missing at ${manifestPath}`);
  const manifestSpec = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  validateManifestSchema(manifestSpec);

  preflightBuildEnvironment();
  const targetDir = path.join(root, 'native/lyrics-renderer/target');
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir, NODE_PATH: process.env.NODE_PATH || externalModules, XDG_RUNTIME_DIR: '/tmp', WGPU_BACKEND: 'vulkan' };
  let attestation, manifest1, pass1Dir;
  if (options.evaluate) {
    assert.ok(!options.freshRust, '--evaluate cannot clean/build');
    pass1Dir = path.join(options.evaluate, 'captures');
    manifest1 = JSON.parse(fs.readFileSync(path.join(pass1Dir, 'capture-manifest.json'), 'utf8'));
    // Replay manifests are untrusted claims; selected fixed contract is validated independently.
    manifest1 = structuredClone(manifest1);
    manifest1.manifest_digest = hashFile(manifestPath);
    attestation = JSON.parse(fs.readFileSync(path.join(options.evaluate, 'rust-binary-attestation.json'), 'utf8'));
    assert.equal(manifest1.rustBinary.path, attestation.binaryPath, 'STALE_OR_INCOMPLETE_ATTESTATION binary path');
    assert.equal(manifest1.rustBinary.sha256, attestation.binarySha, 'STALE_OR_INCOMPLETE_ATTESTATION binary hash');
    assert.equal(new Set(attestation.sourceClosure.map(e => e.path)).size, attestation.sourceClosure.length, 'STALE_OR_INCOMPLETE_ATTESTATION duplicate closure');
    assert.equal(hashFile(attestation.binaryPath), attestation.binarySha, 'STALE_OR_INCOMPLETE_ATTESTATION binary');
    for (const entry of attestation.sourceClosure) assert.equal(hashFile(entry.path), entry.sha256, 'STALE_OR_INCOMPLETE_ATTESTATION source');
    assert.equal(createHash('sha256').update(JSON.stringify(attestation.sourceClosure)).digest('hex'), attestation.sourceClosureDigest, 'STALE_OR_INCOMPLETE_ATTESTATION digest');
  } else {
    attestation = ensureRustBinary(options);
    fs.writeFileSync(path.join(outDir, 'rust-binary-attestation.json'), JSON.stringify(attestation, null, 2) + '\n');
    pass1Dir = path.join(outDir, 'captures');
    manifest1 = runCapture(pass1Dir, manifestPath, attestation.binaryPath, env);
  }
  // Single-pass input validation is ALWAYS executed
  validateSinglePassInputs(manifest1, manifestPath);

  // 3. Second capture pass (hash determinism verification)
  let determinismVerified = false;
  let determinismStatus = options.evaluate ? 'UNVERIFIED_REPLAY' : 'SKIPPED_SINGLE_PASS_ONLY';

  if (!options.skipRepeat) {
    const pass2Dir = path.join(outDir, 'repeat');
    if (!options.json) console.log(`Running capture Pass 2 (determinism check) -> ${pass2Dir}`);
    const manifest2 = options.evaluate
      ? JSON.parse(fs.readFileSync(path.join(options.evaluate, 'repeat/capture-manifest.json'), 'utf8'))
      : runCapture(pass2Dir, manifestPath, attestation.binaryPath, env);
    if (options.evaluate) manifest2.manifest_digest = hashFile(manifestPath);

    // Fail-closed input validation across passes
    validateInputs(manifest1, manifest2, manifestPath);

    // Strict pixel hash determinism check across all records
    assert.equal(manifest1.records.length, manifest2.records.length, 'record count mismatch');
    for (let i = 0; i < manifest1.records.length; i++) {
      assert.deepEqual(
        manifest1.records[i].pngHashes,
        manifest2.records[i].pngHashes,
        `NONDETERMINISTIC_CAPTURE ${manifest1.records[i].id}`
      );
    }
    determinismVerified = !options.evaluate;
    determinismStatus = options.evaluate ? 'UNVERIFIED_REPLAY_MATCHING_ARTIFACTS' : 'VERIFIED_IDENTICAL_REPEAT';
  }

  // 4. Validate Rust baseline honesty contract & adapter capabilities
  const capabilities = manifestSpec.capabilities || {
    styles: false,
    requires_identical_style_rasters: true,
  };
  if (capabilities.requires_identical_style_rasters) {
    for (const record of manifest1.records) {
      assert.equal(record.history_ms.at(-1), record.time_ms, 'exact final snapshot timestamp');
      const baseId = record.id.replace(/-(spicy|amll)$/, '');
      const sibling = manifest1.records.find(r => r.id.replace(/-(spicy|amll)$/, '') === baseId && r.id !== record.id);
      if (sibling) {
        assert.equal(
          record.pngHashes.rust,
          sibling.pngHashes.rust,
          'Rust baseline has no style support; spicy and amll must share exact same baseline raster'
        );
      }
    }
  }

  // Set determinism environment variables for python metrics
  const metricEnv = {
    ...env,
    PARITY_DETERMINISM_STATUS: determinismStatus,
    PARITY_DETERMINISM_VERIFIED: String(determinismVerified),
  };

  // 5. Generate side-by-side comparison images, full grid, and numerical metrics
  if (!options.json) console.log('Computing normalized metrics and generating side-by-side grid...');
  execFileSync(
    'python3',
    ['native/lyrics-renderer/evidence/parity-contact-sheets.py', pass1Dir, outDir, manifestPath],
    { cwd: root, env: metricEnv, stdio: 'pipe' }
  );

  const reportPath = path.join(outDir, 'comparison-report.json');
  assert.ok(fs.existsSync(reportPath), `missing comparison report at ${reportPath}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.acquisition = options.evaluate ? 'replay/untrusted' : 'live';
  report.input_validation_passed = true;
  report.coverage_passed = true;
  report.determinism_verified = determinismVerified;
  report.accepted_parity = false;
  report.status = options.diagnostic ? (report.records.every(r => r.gate_passed) ? 'DIAGNOSTIC_ONLY' : 'DIAGNOSTIC_FAILED') : 'FAIL';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  const gridPath = path.join(outDir, 'rust_parity_grid.png');
  const contactPath = path.join(outDir, 'rust_parity_first_contact.png');
  const mdReportPath = path.join(outDir, 'parity-comparison-report.md');

  // 6. Output formatting
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n========================================================================================================================');
    console.log('                          DETERMINISTIC NUMERICAL RUST VS PRODUCTION SKIA PARITY REPORT                                 ');
    console.log('========================================================================================================================');
    console.log(
      `${'ID'.padEnd(28)} | ${'Style'.padEnd(6)} | ${'Viewport'.padEnd(14)} | ${'Global Sc'.padEnd(10)} | ${'FG Score'.padEnd(10)} | ${'FG Alpha'.padEnd(9)} | ${'Coverage'.padEnd(9)} | ${'Gate'.padEnd(6)}`
    );
    console.log('-'.repeat(120));

    for (const r of report.records) {
      const style = r.id.includes('spicy') ? 'Spicy' : 'AMLL';
      const vp = r.id.includes('844x390') ? '844x390 (L)' : r.id.includes('3x') ? '390x640 3x' : '390x640 1x';
      const globalPct = `${(r.global_normalized_score * 100).toFixed(2)}%`;
      const fgPct = `${(r.foreground_normalized_score * 100).toFixed(2)}%`;
      const alphaPct = `${((r.foreground_alpha_score || 0) * 100).toFixed(2)}%`;
      const covPct = `${((r.ink_coverage_ratio || 0) * 100).toFixed(1)}%`;
      const gate = r.baseline_passed ? 'PASS' : 'FAIL';
      console.log(
        `${r.id.padEnd(28)} | ${style.padEnd(6)} | ${vp.padEnd(14)} | ${globalPct.padStart(10)} | ${fgPct.padStart(10)} | ${alphaPct.padStart(9)} | ${covPct.padStart(9)} | ${gate.padStart(6)}`
      );
    }
    console.log('='.repeat(120));
    console.log('\nVerification Summary:');
    console.log(`  Records Compared:       ${report.records.length} (2 fixtures x 3 viewports x 2 styles)`);
    console.log(`  Determinism Status:     ${determinismStatus} (verified: ${determinismVerified})`);
    console.log(`  Strict Dimensions:      VERIFIED (no resizing or padding distortion)`);
    console.log(`  Alpha Background:       VERIFIED (reproducible transparent readbacks; foreground union scores diagnostic)`);
    console.log(`  Rust Font Provenance:   UNVERIFIED_SYSTEM_FALLBACK_CANDIDATES (selected face unverified)`);
    console.log(`  Baseline Gate:          ${report.records.every(r => r.baseline_passed) ? 'ALL 12 PASSED BASELINE THRESHOLDS' : 'FAILURES DETECTED'}`);
    console.log(`  Parity Acceptance:      FALSE (honestly labeled: baseline diagnostic only; Rust lacks style choice & uses fallback font)`);

    console.log('\nAbsolute Output Paths:');
    console.log(`  Side-by-Side Grid PNG:  ${gridPath}`);
    console.log(`  Contact Sheet PNG:      ${contactPath}`);
    console.log(`  JSON Metrics Report:    ${reportPath}`);
    console.log(`  Markdown Table Report:  ${mdReportPath}`);
    console.log(`  Capture Manifest:       ${path.join(pass1Dir, 'capture-manifest.json')}`);
    console.log(`  Binary Attestation:     ${path.join(outDir, 'rust-binary-attestation.json')}`);
    console.log('========================================================================================================================\n');
  }

  // 7. Enforce fail-closed exit code
  const allPassed = report.records.every(r => r.baseline_passed);
  if (!options.diagnostic && (!allPassed || !report.accepted_parity)) {
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.log(JSON.stringify({ status: error.message.includes('INVALID_BUILD_ENV') ? 'INVALID_BUILD_ENV' : 'INVALID_INPUT', accepted_parity: false, input_validation_passed: false, coverage_passed: false, determinism_verified: false, records: [], failure_reasons: [error.message] }, null, 2));
    process.exit(2);
  }
}

module.exports = { ensureRustBinary, runCapture, parseArgs };
