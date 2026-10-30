/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { loadMobileVault } = require('./helpers/mobile-vault-harness.cjs');
const { createLyricsVaultStore } = require('../../DesktopBridge/src/lyricsVault');
const { parseTtmlToLyrics } = require('../lib/lyrics-ttml-import');
const { selectTtmlTranslationTracks } = require('../../DesktopBridge/src/lyricsTtmlTranslations');

const model = buildSync({ entryPoints: [path.join(__dirname, '../components/lyrics/native/native-lyrics-model.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const moduleObject = { exports: {} };
vm.runInNewContext(model, { module: moduleObject, exports: moduleObject.exports, require });

async function check() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesync-subtitle-vault-'));
  let desktop;
  let mobile;
  try {
    desktop = createLyricsVaultStore({ userDataPath: path.join(directory, 'desktop') });
    mobile = loadMobileVault({ filename: path.join(directory, 'mobile.sqlite') });
    const saved = [];
    for (const [id, count] of [['US5TA1500050', 54], ['ZZA0P2622376', 42], ['KRMIM2652961', 12]]) {
      const content = fs.readFileSync(path.join(__dirname, '../../DesktopBridge/test/fixtures/lrc-red', `${id}.ttml`), 'utf8');
      const parsed = parseTtmlToLyrics(content);
      const track = { id, title: id, artist: 'Fixture', durationMs: parsed.durationMs };
      const desktopId = desktop.save({ track, lyrics: parsed.lyrics, metadata: parsed.metadata,
        includeTranslations: true, originalSource: 'lrc-red' }).vaultId;
      const mobileId = (await mobile.vault.saveMobileVaultLyrics({ track, lyrics: parsed.lyrics,
        metadata: parsed.metadata, originalSource: 'lrc-red' })).vaultId;
      saved.push({ count, parsed, desktopId, mobileId });
    }
    // Close/reopen the real SQLite stores, exercising serialization and compact
    // desktop storage rather than relying on original XML or in-memory objects.
    desktop.close();
    mobile.close();
    desktop = createLyricsVaultStore({ userDataPath: path.join(directory, 'desktop') });
    mobile = loadMobileVault({ filename: path.join(directory, 'mobile.sqlite') });
    for (const { count, parsed, desktopId, mobileId } of saved) {
      const entries = [desktop.getEntry(desktopId), await mobile.vault.getMobileVaultEntry(mobileId)];
      for (const entry of entries) {
        assert.deepEqual(JSON.parse(JSON.stringify(entry.lyrics)), parsed.lyrics);
        assert.deepEqual(JSON.parse(JSON.stringify(entry.metadata.ttml)), parsed.metadata.ttml);
        assert.equal(entry.lyrics.filter(line => line.translatedText).length, count);
        for (const style of ['amll', 'spicy']) {
          const rows = moduleObject.exports.buildNativeRows(entry.lyrics, style);
          assert.equal(rows.filter(row => row.lead?.translation).length, count,
            'Reloaded subtitle text reaches the existing native UI voice field');
        }
        assert.deepEqual(JSON.parse(JSON.stringify(selectTtmlTranslationTracks(entry).lyrics)), parsed.lyrics);
      }
    }
    // Alternates remain selectable by key after the compact/SQL round trip.
    const bilingual = parseTtmlToLyrics(saved[0].parsed.metadata.ttml.content.replace('</translations>',
      '<translation xml:lang="es" type="subtitle"><text for="L1">Otra perspectiva</text></translation></translations>'));
    const alternateTrack = { id: 'alternates', title: 'Alternates', artist: 'Fixture' };
    const alternateDesktopId = desktop.save({ track: alternateTrack, lyrics: bilingual.lyrics, metadata: bilingual.metadata }).vaultId;
    const alternateMobileId = (await mobile.vault.saveMobileVaultLyrics({ track: alternateTrack, lyrics: bilingual.lyrics, metadata: bilingual.metadata })).vaultId;
    for (const entry of [desktop.getEntry(alternateDesktopId), await mobile.vault.getMobileVaultEntry(alternateMobileId)]) {
      assert.equal(entry.metadata.ttml.translationTracks.length, 2);
      const spanish = selectTtmlTranslationTracks(entry, 'Spanish');
      assert.equal(spanish.lyrics[0].translatedText, 'Otra perspectiva');
      assert.equal(spanish.lyrics.filter(line => line.translatedText).length, 1);
    }
    // A completed AI translation remains authoritative even if it happens to
    // equal the source subtitle text; do not mistake it for an applied source.
    const parsed = saved[0].parsed;
    const metadata = { ...parsed.metadata, translation: { provider: 'Gemini', translatedLineCount: 54 } };
    const aiId = desktop.save({ track: { title: 'Enriched', artist: 'Fixture' }, lyrics: parsed.lyrics, metadata }).vaultId;
    const ai = desktop.getEntry(aiId);
    const mobileAiId = (await mobile.vault.saveMobileVaultLyrics({ track: { id: 'enriched', title: 'Enriched', artist: 'Fixture' },
      lyrics: parsed.lyrics, metadata })).vaultId;
    for (const entry of [ai, await mobile.vault.getMobileVaultEntry(mobileAiId)]) {
      assert.equal(entry.metadata.translation.provider, 'Gemini');
      assert.equal(selectTtmlTranslationTracks(entry, 'Spanish'), entry);
    }
  } finally {
    desktop?.close();
    mobile?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('lrc.red vault checks passed: 54/42/12 subtitles, compact/save/restart/load parity, provenance, both native voice styles and AI precedence.');
}
check().catch(error => { console.error(error); process.exitCode = 1; });
