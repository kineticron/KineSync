const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { loadMobileVault } = require('./helpers/mobile-vault-harness.cjs');

const lyrics = [{ lineStartTime: 0, lineEndTime: 5000, translatedText: 'Translation',
  backgroundTranslatedText: 'Background', syllables: [{ text: 'Song', startTime: 0, endTime: 5000 }] }];
const track = { id: 'sample', title: 'Sample', artist: 'Artist', durationMs: 190000 };
const original = '<tt custom="keep"><!-- Preserve --><body><p begin="0" end="5">Song</p></body></tt>';
const legacy = JSON.stringify([{ vaultId: 'legacy-id', savedAt: 1,
  track: { ...track, durationMs: 5000, artworkUrl: 'data:image/png;base64,AAAA' },
  lyrics, metadata: { ttml: { content: original } }, originalSource: 'ttml-import' }]);

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesync-mobile-sqlite-'));
  const filename = path.join(root, 'vault.sqlite');
  let harness = loadMobileVault({ legacy, filename });
  try {
    let { vault } = harness;
    let saved = await vault.getMobileVaultEntry('legacy-id');
    assert.equal(saved.metadata.ttml.content, original);
    assert.equal(saved.track.artworkUrl, undefined);
    assert.equal(harness.backup, legacy, 'Migration must preserve the recovery value');
    assert.ok(await vault.lookupMobileVaultLyrics(track), 'TTML imports match despite an instrumental outro');
    assert.equal(await vault.lookupMobileVaultLyrics({ ...track, artist: 'Unrelated' }), null);
    harness.queries.length = 0;
    const catalog = await vault.readVaultCatalog();
    assert.equal(catalog[0].lineCount, 1);
    assert.equal(catalog[0].hasTranslations, true);
    assert.equal(catalog[0].lyrics, undefined);
    assert.ok(harness.queries.every(sql => !/SELECT \*/.test(sql)), 'Catalog must not load lyric payloads');
    await vault.renameMobileVaultEntry('legacy-id', 'Renamed', 'New artist');
    saved = await vault.getMobileVaultEntry('legacy-id');
    assert.equal(saved.metadata.ttml.content, original);
    harness.close();
    harness = loadMobileVault({ legacy, filename });
    vault = harness.vault;
    assert.equal((await vault.getMobileVaultEntry('legacy-id')).track.title, 'Renamed', 'Restart must not reimport stale backups');

    // A failure after deleting the previous song must roll back the entire save.
    await vault.saveMobileVaultLyrics({ track, lyrics });
    harness.database.exec("CREATE TRIGGER reject_song BEFORE INSERT ON vault_entries BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    await assert.rejects(vault.saveMobileVaultLyrics({ track, lyrics: [{ ...lyrics[0], translatedText: 'Lost update' }] }), /injected failure/);
    assert.equal((await vault.lookupMobileVaultLyrics(track)).lyrics[0].translatedText, 'Translation');
    harness.database.exec('DROP TRIGGER reject_song');
    await Promise.all(Array.from({ length: 105 }, (_, i) => vault.saveMobileVaultLyrics({ track: { ...track, title: `Song ${i}` }, lyrics })));
    assert.equal((await vault.readVaultCatalog()).length, 107, 'Native SQLite vault has no 100-song cap');
    const found = await vault.lookupMobileVaultLyrics(track);
    await vault.deleteMobileVaultEntry(found.metadata.vault.vaultId);
    assert.equal(await vault.lookupMobileVaultLyrics(track), null);
    await vault.saveMobileVaultLyrics({ track: { ...track, title: 'Expired' }, lyrics, metadata: { spicyApi: { expiresAt: 1 } } });
    assert.equal(await vault.lookupMobileVaultLyrics({ ...track, title: 'Expired' }), null);
    assert.ok((await vault.readVaultCatalog()).every(entry => entry.track.title !== 'Expired'));
  } finally {
    harness.close();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('kinesync-mobile-sqlite-'));
    fs.rmSync(root, { recursive: true, force: true });
  }

  const broken = loadMobileVault({ legacy: '{broken' });
  await assert.rejects(broken.vault.readVaultEntries(), /JSON/);
  assert.equal(broken.backup, '{broken');
  broken.backup = legacy;
  assert.equal((await broken.vault.readVaultEntries()).length, 1, 'Failed initialization can retry');
  broken.close();

  let searches = 0;
  const imports = loadMobileVault({ resolveImportedTrack: async input => { searches++; return { ...input, spotifyTrackId: 'resolved-id' }; } });
  await imports.vault.saveMobileVaultLyrics({ track, lyrics, originalSource: 'ttml-import' });
  assert.equal((await imports.vault.readVaultEntries())[0].track.spotifyTrackId, 'resolved-id');
  assert.equal(searches, 1);
  imports.close();

  // Exercise the actual native import hook, including its lazy client boundary.
  let clientSearches = 0;
  let searchFails = false;
  const context = { exports: {}, require(name) {
    assert.equal(name, '@/lib/mobile-lyrics-client');
    return { resolveSpotifyImportMatch: async input => {
      clientSearches++;
      assert.equal(input.title, track.title);
      if (searchFails) throw new Error('Expired session');
      return { id: 'partner-id' };
    } };
  } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../lib/vault-spotify-match.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  const { resolveImportedVaultTrack } = context.exports;
  assert.equal((await resolveImportedVaultTrack(track)).spotifyTrackId, 'partner-id');
  assert.equal((await resolveImportedVaultTrack({ ...track, spotifyTrackId: 'embedded-id' })).spotifyTrackId, 'embedded-id');
  assert.equal(clientSearches, 1, 'Embedded IDs must bypass partner search');
  searchFails = true;
  assert.equal(await resolveImportedVaultTrack(track), track, 'Provider failures must preserve imports');
  console.log('SQLite mobile vault passed: migration/restart, rollback/retry, catalog, expiry, matching, concurrent saves and >100 songs.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
