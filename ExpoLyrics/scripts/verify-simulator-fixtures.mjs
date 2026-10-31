// Verifies that simulator test fixtures match existing repository TTML fixtures bit-for-bit
// Validates provenance and SHA-256 digests without modifying files

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const REWIND_FIXTURE_PATH = path.join(repoRoot, 'DesktopBridge/test/fixtures/lrc-red/US5TA1500050.ttml');
const SEESAW_FIXTURE_PATH = path.join(repoRoot, 'DesktopBridge/test/fixtures/crush-seesaw.ttml');
const SIMULATOR_FIXTURES_PATH = path.join(repoRoot, 'ExpoLyrics/lib/fixtures/simulator-test-fixtures.ts');

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function verifyFixtures() {
  if (!fs.existsSync(REWIND_FIXTURE_PATH)) {
    throw new Error(`Missing source fixture: ${REWIND_FIXTURE_PATH}`);
  }
  if (!fs.existsSync(SEESAW_FIXTURE_PATH)) {
    throw new Error(`Missing source fixture: ${SEESAW_FIXTURE_PATH}`);
  }
  if (!fs.existsSync(SIMULATOR_FIXTURES_PATH)) {
    throw new Error(`Missing simulator fixtures file: ${SIMULATOR_FIXTURES_PATH}`);
  }

  const rewindExpected = fs.readFileSync(REWIND_FIXTURE_PATH, 'utf8');
  const seesawExpected = fs.readFileSync(SEESAW_FIXTURE_PATH, 'utf8');

  const rewindExpectedHash = sha256(rewindExpected);
  const seesawExpectedHash = sha256(seesawExpected);

  const fixtureModuleContent = fs.readFileSync(SIMULATOR_FIXTURES_PATH, 'utf8');

  const rewindMatch = fixtureModuleContent.match(/export const REWIND_FIXTURE_TTML =\s*("(?:[^"\\]|\\.)*");/);
  const seesawMatch = fixtureModuleContent.match(/export const SEESAW_FIXTURE_TTML =\s*("(?:[^"\\]|\\.)*");/);

  if (!rewindMatch) {
    throw new Error('Could not find REWIND_FIXTURE_TTML in simulator-test-fixtures.ts');
  }
  if (!seesawMatch) {
    throw new Error('Could not find SEESAW_FIXTURE_TTML in simulator-test-fixtures.ts');
  }

  const rewindActual = JSON.parse(rewindMatch[1]);
  const seesawActual = JSON.parse(seesawMatch[1]);

  const rewindActualHash = sha256(rewindActual);
  const seesawActualHash = sha256(seesawActual);

  if (rewindActualHash !== rewindExpectedHash) {
    throw new Error(`Rewind fixture hash mismatch: actual ${rewindActualHash} !== expected ${rewindExpectedHash}`);
  }
  if (seesawActualHash !== seesawExpectedHash) {
    throw new Error(`Seesaw fixture hash mismatch: actual ${seesawActualHash} !== expected ${seesawExpectedHash}`);
  }

  console.log('Simulator fixtures verified against existing repository TTML files:');
  console.log(`- Rewind (US5TA1500050.ttml): sha256=${rewindActualHash} (${rewindActual.length} bytes)`);
  console.log(`- Seesaw (crush-seesaw.ttml): sha256=${seesawActualHash} (${seesawActual.length} bytes)`);
  return true;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  try {
    verifyFixtures();
    console.log('All fixture provenance checks passed.');
  } catch (err) {
    console.error(`Fixture verification failed: ${err.message}`);
    process.exit(1);
  }
}
