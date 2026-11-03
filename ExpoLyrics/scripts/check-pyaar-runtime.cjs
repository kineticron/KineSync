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
async function load(file, mocks = {}) {
  const code = (await build({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'platform-boundaries', setup(build) { build.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, external: true } : undefined); } }], external: Object.keys(mocks) })).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => name in mocks ? mocks[name] : require(name),
    __DEV__: false, process, console, setTimeout, clearTimeout, setInterval, clearInterval, performance });
  return module.exports;
}
(async () => {
  const parsed = parseTtmlToLyrics(fs.readFileSync(path.join(__dirname, 'fixtures/pyaar-runtime.ttml'), 'utf8'));
  const track = { id: 'pyaar', title: 'PYAAR HUMARA', artist: 'King', durationMs: 167764, spotifyTrackId: '1QZjPBac0NATr1Ujzn0wso' };
  assert.equal(parsed.lyrics.length, 32);
  assert.equal(parsed.lyrics.reduce((n,l) => n+l.syllables.length,0),223);
  const store = (await load('store/playback-store.ts', {
    'expo-constants': { default: {} }, '@/lib/artwork': {}, '@/lib/spotify-detector/timing-diagnostics': {}, '@/lib/bridge-settings': {}, '@/lib/network': {},
    'react-native': { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }, Platform: { OS: 'web' } },
    '@react-native-async-storage/async-storage': { getItem: async () => null, setItem: async () => {} },
  })).usePlaybackStore;
  const bridge = (await load('lib/bridge-client.ts', {
    '@/store/playback-store': { usePlaybackStore: store },
    '@/lib/network': {}, '@/lib/bridge-validation': {},
  })).bridgeClient;
  const model = await load('components/lyrics/native/native-lyrics-model.ts');
  const timing = await load('lib/lyrics-timing.ts');
  const { getGraphemes } = await load('lib/graphemes.ts');
  for (const unit of ['प्या', 'क्षि', 'फ़', 'क़', 'त्र', 'ज्ञ']) {
    assert.equal(getGraphemes(unit).length, 1, `${unit}: conjunct/matra/nukta stays one animation unit`);
  }
  for (const line of parsed.lyrics) {
    for (const syllable of line.syllables) {
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
      const stale = wire.lyrics.map(l => ({ ...l, syllables: [{ text: l.syllables.map(s=>s.text).join(''), startTime:l.lineStartTime,endTime:l.lineEndTime }] }));
      store.getState().setLyrics(stale, wire.source);
      bridge.applyLyricsPacket({ type: 'lyrics', ...wire });
      assert.equal(store.getState().lyrics.reduce((n,l)=>n+l.syllables.length,0),223,'bridge must replace stale whole-line packet');
      const accepted = store.getState().lyrics;
      bridge.applyLyricsPacket({ type: 'lyrics', ...wire });
      assert.equal(store.getState().lyrics, accepted, 'derived graphemes do not defeat deduplication');
      assert.equal(timing.detectLyricsTimingMode(store.getState().lyrics,wire.source),'interpolated');
      for(const style of ['amll','spicy']) {
        const rows = model.buildNativeRows(store.getState().lyrics,style);
        rows.forEach((r,i)=> {
          assert.equal(r.lead.paintText, parsed.lyrics[i].syllables.map(s=>s.text).join(''));
          assert.deepEqual(JSON.parse(JSON.stringify(r.lead.paintWords.map(w=>[w.start,w.end]))),parsed.lyrics[i].syllables.map(s=>[s.startTime,s.endTime]));
        });
      }
    }
    console.log('pyaar real packet vault/picker/bridge/store/native models passed');
  } finally { desktop.close(); mobile.close(); fs.rmSync(directory,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
