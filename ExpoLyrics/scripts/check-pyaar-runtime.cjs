const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { build } = require('esbuild');
const { loadMobileVault } = require('./helpers/mobile-vault-harness.cjs');
const { createLyricsVaultStore } = require('../../DesktopBridge/src/lyricsVault');
const { parseTtmlToLyrics } = require('../lib/lyrics-ttml-import');
const root = path.resolve(__dirname, '..');
const lane = atoms => Array.from(atoms ?? [], atom => [atom.text.trim(), atom.startTime, atom.endTime]);
const lanes = lyrics => Array.from(lyrics, line => ({
  lead: lane(line.syllables),
  background: lane(line.backgroundSyllables),
}));
const totalAtoms = rows => rows.reduce((total, row) => total + row.lead.length + row.background.length, 0);
const paintAtoms = words => Array.from(words, word => [word.text.trim(), word.start, word.end]);

async function load(file, mocks = {}) {
  const code = (await build({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'platform-boundaries', setup(build) { build.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, external: true } : undefined); } }], external: Object.keys(mocks) })).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => name in mocks ? mocks[name] : require(name),
    __DEV__: false, process, console, setTimeout, clearTimeout, setInterval, clearInterval, performance });
  return module.exports;
}
(async () => {
  const content = fs.readFileSync(path.join(__dirname, 'fixtures/pyaar-runtime.ttml'), 'utf8');
  const parsed = parseTtmlToLyrics(content);
  const original = parseTtmlToLyrics(content.replace('http://lrc.red/lyric-ttml-internal', 'urn:pyaar-unresolved'));
  const track = { id: 'pyaar', title: 'PYAAR HUMARA', artist: 'King', durationMs: 167764, spotifyTrackId: '1QZjPBac0NATr1Ujzn0wso' };
  assert.equal(parsed.lyrics.length, 32);
  const expected = lanes(original.lyrics);
  assert.equal(totalAtoms(expected), 223);
  for (const [lineNumber, count] of [[6, 2], [8, 2], [18, 2], [20, 1], [30, 2]]) {
    const row = expected[lineNumber - 1];
    row.background = row.lead.splice(-count).map(([text, start, end]) => [
      text.replace(/^\(|\)$/g, ''), start, end,
    ]);
  }
  assert.deepEqual(lanes(parsed.lyrics), expected, 'all source atoms retain their timing in the expected vocal lane');
  const store = (await load('store/playback-store.ts', {
    'expo-constants': { default: {} }, '@/lib/artwork': {}, '@/lib/spotify-detector/timing-diagnostics': {}, '@/lib/bridge-settings': {}, '@/lib/network': {},
    'react-native': { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }, Platform: { OS: 'web' } },
    '@react-native-async-storage/async-storage': { getItem: async () => null, setItem: async () => {} },
  })).usePlaybackStore;
  const bridge = (await load('lib/bridge-client.ts', {
    '@/store/playback-store': { usePlaybackStore: store },
    '@/lib/optimistic-playback': { registerPlaybackCommandTransport() {} },
    '@/lib/network': {}, '@/lib/bridge-validation': {},
  })).bridgeClient;
  const model = await load('components/lyrics/native/native-lyrics-model.ts');
  const timing = await load('lib/lyrics-timing.ts');
  const { prepareRustTrack } = await load('lib/rust-lyrics-preparation.ts');
  const { getGraphemes } = await load('lib/graphemes.ts');
  for (const unit of ['प्या', 'क्षि', 'फ़', 'क़', 'त्र', 'ज्ञ']) {
    assert.equal(getGraphemes(unit).length, 1, `${unit}: conjunct/matra/nukta stays one animation unit`);
  }
  for (const line of parsed.lyrics) {
    for (const syllable of [...line.syllables, ...(line.backgroundSyllables ?? [])]) {
      assert.equal(Array.from(getGraphemes(syllable.text)).join(''), syllable.text);
    }
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'pyaar-runtime-'));
  const desktop = createLyricsVaultStore({ userDataPath: directory });
  const mobile = loadMobileVault();
  try {
    const id = desktop.save({ track, lyrics: parsed.lyrics, originalSource: 'lrc-red-line', metadata: parsed.metadata }).vaultId;
    const mid = (await mobile.vault.saveMobileVaultLyrics({ track, lyrics: parsed.lyrics, originalSource: 'lrc-red-line', metadata: parsed.metadata })).vaultId;
    const entries = [desktop.getEntry(id), await mobile.vault.getMobileVaultEntry(mid)];
    const picked = require('../../DesktopBridge/src/lyricsAutoPicker').pickAutoLyrics({ lyrics: parsed.lyrics, source: 'lrc-red-line' }, null).result;
    const service = require('../../DesktopBridge/src/lyrics').createLyricsService();
    service.rememberPublishedLyrics(track.id, picked);
    const cached = service.getPublishedLyrics(track.id);
    service.dispose?.();
    for (const packet of [cached, picked, ...entries.map(e => ({ lyrics: e.lyrics, source: e.sourceLabel }))]) {
      const wire = JSON.parse(JSON.stringify(packet)); // cache/wire round trip
      assert.deepEqual(wire.lyrics, parsed.lyrics);
      const stale = wire.lyrics.map(line => ({
        ...line,
        syllables: [{ text: [...line.syllables, ...(line.backgroundSyllables ?? [])].map(atom => atom.text).join(''),
          startTime: line.lineStartTime, endTime: line.lineEndTime }],
        backgroundSyllables: undefined,
      }));
      store.getState().setLyrics(stale, wire.source);
      bridge.applyLyricsPacket({ type: 'lyrics', ...wire });
      assert.deepEqual(lanes(store.getState().lyrics), expected, 'bridge replaces stale whole-line packets across both lanes');
      const accepted = store.getState().lyrics;
      bridge.applyLyricsPacket({ type: 'lyrics', ...wire });
      assert.equal(store.getState().lyrics, accepted, 'derived graphemes do not defeat deduplication');
      assert.equal(timing.detectLyricsTimingMode(store.getState().lyrics,wire.source),'interpolated');
      for(const style of ['amll','spicy']) {
        const rows = model.buildNativeRows(store.getState().lyrics,style);
        rows.forEach((r,i)=> {
          const line = parsed.lyrics[i];
          assert.equal(r.lead.paintText, line.syllables.map(atom => atom.text).join(''));
          assert.deepEqual(paintAtoms(r.lead.paintWords), expected[i].lead);
          assert.equal(r.backgrounds.length, expected[i].background.length ? 1 : 0);
          if (r.backgrounds.length) {
            assert.equal(r.backgrounds[0].paintText, line.backgroundSyllables.map(atom => atom.text).join(''));
            assert.deepEqual(paintAtoms(r.backgrounds[0].paintWords), expected[i].background);
          }
        });
      }
    }

    const capturePath = path.join(root, '../DesktopBridge/test/fixtures/lrc-red/KRA381702796.ttml');
    const capture = parseTtmlToLyrics(fs.readFileSync(capturePath, 'utf8'));
    const capturedRow = capture.lyrics.find(line => line.lineStartTime === 136147);
    assert.ok(capturedRow);
    const backgroundOnly = { ...capturedRow, backgroundTranslatedText: "I've been waiting for this" };
    const expectedBackground = lane(backgroundOnly.backgroundSyllables);
    const backgroundText = backgroundOnly.backgroundSyllables.map(atom => atom.text).join('');
    const captureTrack = { id: 'martini-blue', title: 'Martini Blue', artist: 'DPR LIVE', durationMs: 195205 };
    const saved = { track: captureTrack, lyrics: [backgroundOnly], originalSource: 'lrc-red-karaoke' };
    const desktopSave = desktop.save(saved);
    const mobileSave = await mobile.vault.saveMobileVaultLyrics(saved);
    assert.equal(desktopSave.translatedLineCount, 1);
    assert.equal(mobileSave.translatedLineCount, 1);
    const desktopEntry = desktop.getEntry(desktopSave.vaultId);
    const mobileEntry = await mobile.vault.getMobileVaultEntry(mobileSave.vaultId);
    for (const entry of [desktopEntry, mobileEntry]) {
      const wire = JSON.parse(JSON.stringify({ lyrics: entry.lyrics, source: saved.originalSource }));
      assert.deepEqual(wire.lyrics, [backgroundOnly]);
      assert.doesNotMatch(JSON.stringify(wire), /\u200c/u);
      bridge.applyLyricsPacket({ type: 'lyrics', ...wire });
      const selected = timing.selectTimedLyricLines(store.getState().lyrics);
      assert.deepEqual(lanes(selected), [{ lead: [], background: expectedBackground }]);
      for (const style of ['amll', 'spicy']) {
        const packet = JSON.parse(prepareRustTrack(captureTrack.id, 1, selected, style));
        assert.equal(packet.lines.length, 1);
        const [row] = packet.lines;
        assert.deepEqual(row.atoms, [{ text: '\u200c', start: 136147, end: 138354 }]);
        assert.equal(row.paint.translation, undefined);
        assert.equal(row.backgrounds.length, 1);
        const [background] = row.backgrounds;
        assert.equal(background.translation, backgroundOnly.backgroundTranslatedText);
        assert.equal(background.text, backgroundText);
        assert.deepEqual(paintAtoms(background.words), expectedBackground);
        assert.deepEqual(lanes(selected), [{ lead: [], background: expectedBackground }]);
      }
    }
    console.log('pyaar real packet vault/picker/bridge/store/native models passed');
  } finally { desktop.close(); mobile.close(); fs.rmSync(directory,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
