const assert = require('node:assert/strict');
const { loadMobileVault } = require('./helpers/mobile-vault-harness.cjs');
const lyrics = [{ lineStartTime: 0, lineEndTime: 5000, syllables: [{ text: 'Sample', startTime: 0, endTime: 5000 }] }];
const track = { id: 'sample', title: 'Sample', artist: 'KineSync', durationMs: 5000 };
async function main() {
  const harness = loadMobileVault();
  const { vault } = harness;
  try {
    for (const artworkUrl of ['data:image/png;base64,' + 'A'.repeat(4096), 'file:///album.png', 'content://album/1', 'A'.repeat(4096)]) {
      await vault.saveMobileVaultLyrics({ track: { ...track, artworkUrl }, lyrics });
      const saved = (await vault.readVaultEntries())[0];
      assert.equal(saved.track.artworkUrl, undefined, 'Image bytes and local paths must never be saved');
      assert.ok(harness.database.prepare('SELECT length(track) AS size FROM vault_entries').get().size < 1024);
    }
    await vault.saveMobileVaultLyrics({ track: { ...track, artworkUrl: 'https://example.com/cover.jpg' }, lyrics });
    assert.equal((await vault.readVaultEntries())[0].track.artworkUrl, 'https://example.com/cover.jpg');
    const originalTtml = '<tt custom="keep"><head><metadata><!-- Preserve comments --></metadata></head><body><p begin="0" end="5">Sample</p></body></tt>';
    await vault.saveMobileVaultLyrics({ track, lyrics, metadata: { ttml: { content: originalTtml } } });
    const imported = (await vault.readVaultEntries())[0];
    const { lyricsToTtml } = require('../lib/lyrics-ttml-export');
    assert.equal(lyricsToTtml({ lyrics: imported.lyrics, metadata: imported.metadata }), originalTtml);
    await vault.renameMobileVaultEntry(imported.vaultId, 'New display name', 'New display artist');
    assert.equal((await vault.getMobileVaultEntry(imported.vaultId)).metadata.ttml.content, originalTtml);
    await vault.saveMobileVaultLyrics({ track, lyrics });
    assert.equal(await vault.lookupMobileVaultLyrics({ ...track, durationMs: 190000 }), null);
    await vault.saveMobileVaultLyrics({ track: { ...track, spotifyTrackId: 'same-id' }, lyrics });
    assert.ok(await vault.lookupMobileVaultLyrics({ ...track, title: 'Different display', spotifyTrackId: 'same-id' }));
    assert.equal(await vault.lookupMobileVaultLyrics({ ...track, spotifyTrackId: 'other-recording' }), null);
    console.log('Vault artwork passed: URL-only SQL storage, bounded metadata, original TTML preservation and recording matching.');
  } finally { harness.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
