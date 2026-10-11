const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const vault = require('../src/lyricsVault');
const ttml = require('../src/lyricsTtmlImport');
const spotifyId = '1QV6tiMFM6fSOKOGLMHYYg';
const document = '<tt><head><metadata><ttm:title>GERONIMO!</ttm:title><ttm:agent><ttm:name>DPR LIVE</ttm:name></ttm:agent></metadata></head><body><p begin="173.349" end="178.705">GERONIMO!</p></body></tt>';
const imported = { title: 'GERONIMO!', artist: 'DPR LIVE', durationMs: 178705 };

function load(mobile, behavior = 'match') {
  const calls = [];
  const saves = [];
  const src = path.resolve(__dirname, '../src');
  const srcRequire = createRequire(path.join(src, 'lyricsService.js'));
  const fakeStore = { save: input => { saves.push(input); return { ok: true, metadata: input.metadata }; } };
  const context = vm.createContext({
    AbortController, Buffer, TextDecoder, URL, URLSearchParams, setTimeout, clearTimeout,
    setInterval, clearInterval, console, global: {}, process: { env: {} }, module: { exports: {} },
    require: name => name === './lyricsVault' ? { ...vault, getLyricsVaultStore: () => fakeStore } : srcRequire(name),
    fetch: async url => {
      calls.push(String(url));
      assert.equal(new URL(url).hostname, 'api-partner.spotify.com', 'Imports must never request api.spotify.com');
      if (behavior === 'offline') throw new Error('Offline');
      if (behavior === 'expired') return new Response('{}', { status: 401 });
      const row = { id: spotifyId, name: 'GERONIMO!', artists: [{ name: behavior === 'wrong-artist' ? 'Someone else' : 'DPR LIVE' }], duration: { totalMilliseconds: 190000 }, album: { name: 'IS ANYBODY OUT THERE?' } };
      const items = behavior === 'empty' ? [] : behavior === 'ambiguous' ? [row, { ...row, id: '2QV6tiMFM6fSOKOGLMHYYg' }] : [row];
      return new Response(JSON.stringify({ data: { search: { tracks: { items } } } }));
    },
  });
  if (mobile) {
    let source = fs.readFileSync(path.resolve(src, '../../ExpoLyrics/lib/mobile-lyrics-service.js'), 'utf8');
    source = source.replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(source.slice(0, source.indexOf('export {')), context);
  } else {
    const index = fs.readFileSync(path.join(src, 'lyrics/index.js'), 'utf8');
    for (const match of index.match(/const partFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)) {
      vm.runInContext(fs.readFileSync(path.join(src, 'lyrics/parts', match[1]), 'utf8'), context);
    }
  }
  context.track = imported;
  return { context, calls, saves };
}

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} import search uses partner only and tolerates instrumental outro`, async () => {
    const { context, calls } = load(mobile);
    const result = await vm.runInContext('enrichTrackForVaultMatch(track, "free-account-web-token")', context);
    assert.equal(result.spotifyTrackId, spotifyId);
    assert.equal(result.title, imported.title);
    assert.equal(result.durationMs, imported.durationMs);
    assert.ok(calls.length > 0);
    context.track = { ...imported, spotifyTrackId: spotifyId };
    const count = calls.length;
    assert.equal((await vm.runInContext('enrichTrackForVaultMatch(track, "token")', context)).spotifyTrackId, spotifyId);
    assert.equal(calls.length, count, 'Embedded IDs bypass all network lookups');
  });
  for (const behavior of ['empty', 'ambiguous', 'wrong-artist', 'offline', 'expired']) {
    test(`${mobile ? 'mobile' : 'desktop'} ${behavior} imports retain metadata without an invented Spotify ID`, async () => {
      const { context } = load(mobile, behavior);
      const result = await vm.runInContext('enrichTrackForVaultMatch(track, "token")', context);
      assert.equal(result.spotifyTrackId, undefined);
      assert.equal(result.title, imported.title);
    });
  }
}

test('desktop import resolves the file rather than unrelated now-playing metadata', async () => {
  const { context, saves } = load(false);
  context.document = document;
  await vm.runInContext('createLyricsService({ getSpotifyAccessToken: () => "token" }).importLyricsFileToVault(document, "song.ttml", { title: "Unrelated", artist: "Other", album: "Unrelated album", spotifyTrackId: "wrong-playback-id" })', context);
  assert.equal(saves[0].track.title, imported.title);
  assert.equal(saves[0].track.spotifyTrackId, spotifyId);
  assert.equal(saves[0].metadata.ttml.content, document);
});

test('both TTML parsers recognize embedded Spotify IDs, URIs and URLs', () => {
  for (const parser of [ttml, require('../../ExpoLyrics/lib/lyrics-ttml-import')]) {
    for (const value of [spotifyId, `spotify:track:${spotifyId}`, `https://open.spotify.com/track/${spotifyId}?si=example`]) {
      const content = document.replace('</metadata>', `<amll:meta key="spotifyId" value="${value}"/></metadata>`);
      assert.equal(parser.extractTtmlMetadata(content).spotifyTrackId, spotifyId);
      assert.equal(vault.parseLyricsImportFile(content, 'song.ttml').spotifyTrackId, spotifyId);
    }
    assert.equal(parser.extractTtmlMetadata(document.replace('</metadata>', '<amll:meta key="spotifyId" value="invalid"/></metadata>')).spotifyTrackId, undefined);
  }
});
