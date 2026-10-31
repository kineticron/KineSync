// Prepares baseline worktree for simulator testing
// Copies standalone harness protocol files and applies minimal integration patch
// Fails clearly if baseline codebase is incompatible rather than producing invalid comparisons
// NEVER copies candidate renderer source wholesale

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

export function prepareBaselineHarness(options = {}) {
  const candidateDir = path.resolve(options.candidateDir || repoRoot);
  const baselineDir = path.resolve(options.baselineDir);

  if (!options.baselineDir) {
    throw new Error('Missing required argument: --baseline-dir');
  }

  if (!fs.existsSync(baselineDir)) {
    throw new Error(`Baseline directory does not exist: ${baselineDir}`);
  }

  console.log(`[PREPARE_BASELINE] Candidate directory: ${candidateDir}`);
  console.log(`[PREPARE_BASELINE] Baseline directory: ${baselineDir}`);

  // 1. Copy standalone harness protocol files from candidate to baseline
  const standaloneFiles = [
    'ExpoLyrics/lib/fixtures/simulator-test-fixtures.ts',
    'ExpoLyrics/lib/simulator-playback-clock.ts',
    'ExpoLyrics/lib/simulator-test-bridge.ts',
    'ExpoLyrics/lib/simulator-test-harness.ts',
    'ExpoLyrics/components/simulator-test-controller.tsx',
    'ExpoLyrics/scripts/run-ios-simulator-test.mjs',
    'ExpoLyrics/scripts/parse-simulator-logs.mjs',
    'ExpoLyrics/scripts/compare-simulator-screenshots.mjs',
    'ExpoLyrics/scripts/test-simulator-harness.mjs',
    'ExpoLyrics/scripts/verify-simulator-fixtures.mjs',
    'ExpoLyrics/scripts/build-simulator-app.mjs',
    'ExpoLyrics/scripts/prepare-baseline-harness.mjs',
    'ExpoLyrics/scripts/patches/harness-integration.patch',
  ];

  console.log('[PREPARE_BASELINE] Copying standalone harness protocol files...');
  for (const relPath of standaloneFiles) {
    const srcPath = path.join(candidateDir, relPath);
    const destPath = path.join(baselineDir, relPath);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Candidate harness file missing: ${srcPath}`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
  }
  console.log(`[PREPARE_BASELINE] Successfully copied ${standaloneFiles.length} harness files.`);

  // 2. Check and apply minimal harness integration patch
  const patchPath = path.join(candidateDir, 'ExpoLyrics/scripts/patches/harness-integration.patch');
  if (!fs.existsSync(patchPath)) {
    throw new Error(`Harness integration patch not found at ${patchPath}`);
  }

  // Check if patch is already applied in baseline
  let alreadyApplied = false;
  try {
    execFileSync('git', ['apply', '--reverse', '--check', patchPath], {
      cwd: baselineDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    alreadyApplied = true;
  } catch {
    alreadyApplied = false;
  }

  if (alreadyApplied) {
    console.log('[PREPARE_BASELINE] Harness integration patch is already applied in baseline.');
  } else {
    console.log('[PREPARE_BASELINE] Testing harness integration patch compatibility with git apply --check...');
    try {
      execFileSync('git', ['apply', '--check', patchPath], {
        cwd: baselineDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (checkErr) {
      const errOut = checkErr.stderr ? checkErr.stderr.toString() : checkErr.message;
      throw new Error(
        `Baseline codebase is incompatible with harness integration patch.\n` +
        `git apply --check failed with:\n${errOut}\n` +
        `Failing closed rather than producing a silently invalid comparison.`
      );
    }

    console.log('[PREPARE_BASELINE] Applying minimal harness integration patch...');
    try {
      execFileSync('git', ['apply', patchPath], {
        cwd: baselineDir,
        stdio: 'inherit',
      });
      console.log('[PREPARE_BASELINE] Harness integration patch applied successfully.');
    } catch (applyErr) {
      throw new Error(`Failed to apply harness integration patch: ${applyErr.message}`);
    }
  }

  console.log('[PREPARE_BASELINE] Baseline harness preparation COMPLETE.');
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const baseDirIdx = process.argv.indexOf('--baseline-dir');
  const candDirIdx = process.argv.indexOf('--candidate-dir');

  const baselineDir = baseDirIdx >= 0 ? process.argv[baseDirIdx + 1] : null;
  const candidateDir = candDirIdx >= 0 ? process.argv[candDirIdx + 1] : repoRoot;

  if (!baselineDir) {
    console.error('Usage: node prepare-baseline-harness.mjs --baseline-dir <path> [--candidate-dir <path>]');
    process.exit(1);
  }

  try {
    prepareBaselineHarness({ baselineDir, candidateDir });
    process.exit(0);
  } catch (err) {
    console.error(`[PREPARE_BASELINE] ERROR: ${err.message}`);
    process.exit(1);
  }
}
