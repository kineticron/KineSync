const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readReleaseNotes } = require('../release-notes.cjs');

test('publishing requires real notes for a valid version', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesync-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'RELEASE_NOTES'));
  assert.throws(() => readReleaseNotes(root, '../private'), /three numeric/);
  assert.throws(() => readReleaseNotes(root, '2.0.0'), /Add RELEASE_NOTES/);
  fs.writeFileSync(path.join(root, 'RELEASE_NOTES/v2.0.0.md'), '  \n');
  assert.throws(() => readReleaseNotes(root, '2.0.0'), /empty/);
  fs.writeFileSync(path.join(root, 'RELEASE_NOTES/v2.0.0.md'), 'A tested change.\n');
  assert.equal(readReleaseNotes(root, '2.0.0'), 'A tested change.');
});
