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
    'ExpoLyrics/scripts/simulator-run-lifecycle.mjs',
    'ExpoLyrics/scripts/simulator-startup.mjs',
    'ExpoLyrics/scripts/test-simulator-startup.mjs',
    'ExpoLyrics/scripts/run-with-ci-budget.mjs',
    'ExpoLyrics/scripts/verify-ci-cache.mjs',
    'ExpoLyrics/scripts/test-ci-cache.mjs',
    'ExpoLyrics/scripts/test-simulator-timeouts.mjs',
    'ExpoLyrics/scripts/parse-simulator-logs.mjs',
    'ExpoLyrics/scripts/compare-simulator-screenshots.mjs',
    'ExpoLyrics/scripts/test-simulator-harness.mjs',
    'ExpoLyrics/scripts/test-simulator-protocol.mjs',
    'ExpoLyrics/scripts/test-simulator-build.mjs',
    'ExpoLyrics/scripts/test-simulator-baseline.mjs',
    'ExpoLyrics/scripts/resolve-trusted-simulator-baseline.mjs',
    'ExpoLyrics/scripts/verify-simulator-fixtures.mjs',
    'ExpoLyrics/scripts/build-simulator-app.mjs',
    'ExpoLyrics/scripts/prepare-baseline-harness.mjs',
    'ExpoLyrics/scripts/patches/harness-integration.patch',
    'ExpoLyrics/scripts/patches/harness-integration-main.patch',
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

  // Select an observation-only adapter for either the newer ready gate or main's older native host.
  // Check the entire patch before applying any integration changes. Unsupported baselines fail closed.
  const patches = ['harness-integration.patch', 'harness-integration-main.patch'].map(name =>
    path.join(candidateDir, 'ExpoLyrics/scripts/patches', name));
  const compatible = reverse => patches.filter(patch => {
    try {
      execFileSync('git', ['apply', ...(reverse ? ['--reverse'] : []), '--check', patch], {
        cwd: baselineDir, stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch { return false; }
  });
  const applied = compatible(true);
  const matches = applied.length ? applied : compatible(false);
  if (matches.length !== 1) throw new Error(`Baseline codebase is incompatible or ambiguous with harness integration patches (${matches.length} matches). Failing closed.`);
  if (!applied.length) execFileSync('git', ['apply', matches[0]], { cwd: baselineDir, stdio: 'inherit' });
  console.log(`[PREPARE_BASELINE] Integration adapter: ${path.basename(matches[0])}${applied.length ? ' (already applied)' : ''}`);

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
