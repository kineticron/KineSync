/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

let raw = null;
const storage = { getItem: async () => raw, setItem: async (_, value) => { raw = value; } };
const source = fs.readFileSync(path.join(__dirname, '../lib/mobile-lyrics-vault.ts'), 'utf8');
const context = { exports: {}, require: name => {
  assert.equal(name, '@react-native-async-storage/async-storage');
  return storage;
}, Date, URL };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const vault = context.exports;
const lyrics = [{ lineStartTime: 0, lineEndTime: 5000, syllables: [{ text: 'Sample', startTime: 0, endTime: 5000 }] }];
const track = { id: 'sample', title: 'Sample', artist: 'KineSync', durationMs: 5000 };
async function main() {
  for (const artworkUrl of ['data:image/png;base64,' + 'A'.repeat(4096), 'file:///album.png', 'content://album/1', 'A'.repeat(4096)]) {
    await vault.saveMobileVaultLyrics({ track: { ...track, artworkUrl }, lyrics });
    const saved = JSON.parse(raw)[0];
    assert.equal(saved.track.artworkUrl, undefined, 'image bytes and local image paths must never be saved');
    assert.ok(raw.length < 1024, 'inline image size cannot inflate saved-song size');
  }
  await vault.saveMobileVaultLyrics({ track: { ...track, artworkUrl: 'https://example.com/cover.jpg' }, lyrics });
  assert.equal(JSON.parse(raw)[0].track.artworkUrl, 'https://example.com/cover.jpg');
  raw = JSON.stringify([{ ...JSON.parse(raw)[0], track: { ...track, artworkUrl: 'data:image/png;base64,AAAA' } }]);
  const migrated = await vault.readVaultEntries();
  assert.equal(migrated[0].track.artworkUrl, undefined);
  // A subsequent queued save must win over migration of older data.
  await vault.saveMobileVaultLyrics({ track: { ...track, title: 'New song' }, lyrics });
  assert.equal(JSON.parse(raw)[0].track.title, 'New song');
  assert.ok(!raw.includes('data:image'));
  console.log('Vault artwork checks passed: URL-only storage, no image bytes/local files, bounded song size, and safe migration alongside saves.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
