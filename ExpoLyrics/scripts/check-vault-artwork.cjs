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
  const originalTtml = '<tt custom="keep"><head><metadata><!-- Preserve comments --></metadata></head><body><p begin="0" end="5">Sample</p></body></tt>';
  await vault.saveMobileVaultLyrics({ track, lyrics, metadata: { ttml: { content: originalTtml } } });
  const imported = (await vault.readVaultEntries()).find(entry => entry.track.id === track.id);
  assert.equal(imported.metadata.ttml.content, originalTtml);
  const { lyricsToTtml } = require('../lib/lyrics-ttml-export');
  assert.equal(lyricsToTtml({ lyrics: imported.lyrics, metadata: imported.metadata }), originalTtml);
  await vault.renameMobileVaultEntry(imported.vaultId, 'New display name', 'New display artist');
  assert.equal((await vault.readVaultEntries()).find(entry => entry.vaultId === imported.vaultId).metadata.ttml.content, originalTtml,
    'Renaming a vault entry must not modify its original document');
  // TTML timing ends at the last vocal, which can precede the audio outro.
  // Seed persisted data directly to cover imports saved before this fix too.
  const { parseTtmlToLyrics } = require('../lib/lyrics-ttml-import');
  const geronimoTtml = '<tt><body><p begin="173.349" end="178.705">GERONIMO!</p></body></tt>';
  const geronimo = parseTtmlToLyrics(geronimoTtml);
  const playbackTrack = { id: 'playing-geronimo', title: 'GERONIMO!', artist: 'DPR LIVE', durationMs: 190000 };
  raw = JSON.stringify([{
    vaultId: 'existing-import', savedAt: 1,
    track: { ...playbackTrack, id: 'import-old', durationMs: geronimo.durationMs },
    lyrics: geronimo.lyrics, metadata: geronimo.metadata, originalSource: 'ttml-import',
  }]);
  const match = await vault.lookupMobileVaultLyrics(playbackTrack);
  assert.ok(match, 'Existing TTML imports must match despite an instrumental outro');
  assert.equal(match.trackId, playbackTrack.id);
  assert.equal(match.metadata.ttml.content, geronimoTtml);
  assert.equal(await vault.lookupMobileVaultLyrics({ ...playbackTrack, artist: 'Someone else' }), null);
  assert.equal(await vault.lookupMobileVaultLyrics({ ...playbackTrack, title: 'Another song' }), null);
  await vault.saveMobileVaultLyrics({
    track: { ...playbackTrack, id: 'import-new', durationMs: geronimo.durationMs },
    lyrics: geronimo.lyrics, metadata: geronimo.metadata, originalSource: 'ttml-import',
  });
  assert.ok(await vault.lookupMobileVaultLyrics({ ...playbackTrack, title: 'Geronimo', artist: 'dpr live' }),
    'New TTML imports must retain normalized title and artist matching');
  raw = JSON.stringify(JSON.parse(raw).map(entry => ({ ...entry, originalSource: 'lrclib' })));
  assert.equal(await vault.lookupMobileVaultLyrics(playbackTrack), null,
    'Saved playback lyrics must retain duration checks for different recordings');
  raw = JSON.stringify(JSON.parse(raw).map(entry => ({ ...entry, track: { ...entry.track, spotifyTrackId: 'same-id' } })));
  assert.ok(await vault.lookupMobileVaultLyrics({ ...playbackTrack, spotifyTrackId: 'same-id' }),
    'Exact Spotify IDs must still take priority');
  console.log('Vault artwork checks passed: URL-only storage, no image bytes/local files, bounded song size, and safe migration alongside saves.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
