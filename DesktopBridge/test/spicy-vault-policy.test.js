const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const vm = require('node:vm');
const { createLyricsVaultStore } = require('../src/lyricsVault');
const policy = require('../src/lyricsPolicy');
const track = { title: 'Song', artist: 'Artist', durationMs: 4000, spotifyTrackId: '1QV6tiMFM6fSOKOGLMHYYg' };
const lyrics = [{ lineStartTime: 0, lineEndTime: 4000, syllables: [{ text: 'Private sync', startTime: 0, endTime: 4000 }] }];
const attribution = { source: 'spicy_lyrics', provider: 'Spicy Lyrics', community: true };
const metadata = fetchedAt => ({ attribution, spicyApi: { fetchedAt, expiresAt: fetchedAt + policy.SPICY_MAX_AGE_MS }, ttml: { content: '<tt>Private sync</tt>' } });
const tick = () => new Promise(setImmediate);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesync-spicy-policy-'));
  const store = createLyricsVaultStore({ userDataPath: root });
  const db = new DatabaseSync(path.join(store.getVaultRoot(), 'vault.sqlite'));
  t.after(() => { db.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, db };
}

test('export restrictions follow Spicy provenance through vault labels and imports, leaving lrc.red unrestricted', () => {
  assert.equal(fs.readFileSync(path.resolve(__dirname, '../src/lyricsPolicy.js'), 'utf8'), fs.readFileSync(path.resolve(__dirname, '../../ExpoLyrics/lib/lyrics-policy.js'), 'utf8'));
  for (const originalSource of ['spicy-lyrics-syllable', 'spicy-lyrics-line', 'local-vault', 'ttml-import', 'desktop-vault']) {
    assert.throws(() => policy.assertLyricsExportAllowed({ originalSource, metadata: metadata(Date.now()) }), /cannot be exported/);
  }
  policy.assertLyricsExportAllowed({ originalSource: 'lrc-red-karaoke', metadata: { attribution } });
  for (const provider of ['Apple Music', 'Spotify']) policy.assertLyricsExportAllowed({ originalSource: 'spicy-lyrics-line', metadata: { attribution: { provider } } });
  assert.equal(policy.isSpicyCommunityLyrics({ originalSource: 'spicy-lyrics-line', metadata: null }), true);
});

test('expiry is capped at original retrieval, never renewed by a save or device transfer', t => {
  const { store, db } = fixture(t);
  const fetchedAt = Date.now() - 29 * 86400000;
  const entry = store.save({ track, lyrics, originalSource: 'spicy-lyrics-syllable', metadata: { ...metadata(fetchedAt), spicyApi: { fetchedAt, expiresAt: Date.now() + 365 * 86400000 } } });
  assert.equal(store.listEntries()[0].exportRestricted, true);
  assert.equal(db.prepare('SELECT expires_at FROM vault_entries').get().expires_at, fetchedAt + policy.SPICY_MAX_AGE_MS);
  const saved = store.getEntry(entry.vaultId);
  store.save({ track, lyrics: saved.lyrics, originalSource: 'local-vault', metadata: saved.metadata });
  assert.equal(db.prepare('SELECT expires_at FROM vault_entries').get().expires_at, fetchedAt + policy.SPICY_MAX_AGE_MS);
  assert.equal(policy.spicyLyricsExpiresAt({ metadata: policy.withSpicyFreshness({ originalSource: 'spicy-lyrics-line', metadata: { attribution } }), savedAt: Date.now() }), 0, 'Unknown retrieval dates cannot acquire a new lease');
});

test('expired payloads are physically deleted, failed refreshes retain only identifiers, and successful refreshes replace them', async t => {
  const { store, db } = fixture(t);
  store.save({ track, lyrics, originalSource: 'spicy-lyrics-syllable', metadata: metadata(Date.now() - 31 * 86400000) });
  assert.equal(store.lookup(track), null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM vault_entries').get().n, 0);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM vault_refresh').all()), /Private sync|<tt>|attribution/);
  let calls = 0;
  let stop = store.startRefresh(async input => { calls++; assert.equal(input.spotifyTrackId, track.spotifyTrackId); throw Error('Offline'); });
  await tick();
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM vault_refresh').get().n, 1);
  assert.equal(store.lookup(track), null);
  stop();
  const fresh = metadata(Date.now());
  stop = store.startRefresh(async () => ({ lyrics, source: 'spicy-lyrics-syllable', metadata: fresh }));
  await tick();
  assert.deepEqual(store.lookup(track).metadata, fresh);
  assert.equal(db.prepare('SELECT count(*) AS n FROM vault_refresh').get().n, 0);
  stop();
});

test('withdrawn syncs are discarded', async t => {
  const { store, db } = fixture(t);
  store.save({ track, lyrics, originalSource: 'spicy-lyrics-line', metadata: metadata(Date.now() - 31 * 86400000) });
  const stop = store.startRefresh(async () => null);
  await tick();
  assert.equal(db.prepare('SELECT count(*) AS n FROM vault_refresh').get().n, 0);
  assert.equal(store.listEntryCount(), 0);
  stop();
});

test('SQLite policy upgrade runs once and restarts do not rewrite every catalog row', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesync-spicy-upgrade-'));
  let store = createLyricsVaultStore({ userDataPath: root });
  const filename = path.join(store.getVaultRoot(), 'vault.sqlite');
  const fetchedAt = Date.now() - 86400000;
  const saved = store.save({ track, lyrics, originalSource: 'spicy-lyrics-line', metadata: metadata(fetchedAt) });
  store.close();
  const db = new DatabaseSync(filename);
  try {
    db.exec("DELETE FROM vault_migrations WHERE name = 'spicy-policy-v1'; UPDATE vault_entries SET expires_at = NULL, catalog = '{}';");
    store = createLyricsVaultStore({ userDataPath: root });
    assert.equal(db.prepare('SELECT expires_at FROM vault_entries').get().expires_at, fetchedAt + policy.SPICY_MAX_AGE_MS);
    assert.equal(store.listEntries()[0].exportRestricted, true);
    store.close();
    db.exec("CREATE TRIGGER reject_reindex BEFORE UPDATE ON vault_entries BEGIN SELECT RAISE(ABORT, 'unexpected startup rewrite'); END;");
    store = createLyricsVaultStore({ userDataPath: root });
    assert.equal(store.getEntry(saved.vaultId).lyrics.length, 1);
  } finally { store.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy Spicy recovery files are removed after migration while the fresh database copy survives', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesync-spicy-recovery-'));
  const vaultId = `spotify_${track.spotifyTrackId}`;
  const dir = path.join(root, 'lyrics-vault', vaultId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...track, savedAt: Date.now(), originalSource: 'spicy-lyrics-line', metadata: metadata(Date.now()) }));
  fs.writeFileSync(path.join(dir, 'lyrics.json'), JSON.stringify(lyrics));
  fs.writeFileSync(path.join(dir, 'lyrics.ttml'), '<tt>Private sync</tt>');
  const store = createLyricsVaultStore({ userDataPath: root });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(store.getEntry(vaultId).lyrics.length, 1);
  for (const name of ['manifest.json', 'lyrics.json', 'lyrics.ttml']) assert.equal(fs.existsSync(path.join(dir, name)), false);
});

test('an on-screen expired copy is cleared and refreshed once, without an empty-packet refresh loop', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');
  const start = source.indexOf('  const statusTimer = setInterval(');
  const end = source.indexOf('  const runLyricsSync =', start);
  let tick, refreshes = 0, clears = 0;
  const context = vm.createContext({
    require: name => { assert.equal(name, './lyricsPolicy'); return policy; },
    latestLyricsPacket: { lyrics, source: 'spicy-lyrics-line', metadata: metadata(Date.now() - 31 * 86400000) },
    latestSnapshot: { trackId: 'song' }, latestPlaybackStatus: {}, latestLyricsStatus: {}, latestCommandStatus: '',
    lyricsRequestVersion: 0, activeLyricsRequest: {}, STATUS_PUSH_INTERVAL_MS: 250,
    lyricsService: { clearCache() { clears++; } },
    setInterval(callback) { tick = callback; }, pushStatus() {},
    publishLyricsPacket(packet) { context.latestLyricsPacket = packet; }, runLyricsSync() { refreshes++; },
  });
  vm.runInContext(source.slice(start, end), context);
  tick(); tick();
  assert.equal(clears, 1);
  assert.equal(refreshes, 1);
  assert.equal(context.latestLyricsPacket.lyrics.length, 0);
});
