const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { createLyricsVaultStore, compactLyricsForStorage, gzipJsonPayload, buildTrackFingerprint } = require('../src/lyricsVault');

const lyrics = [{ lineStartTime: 0, lineEndTime: 4000,
  syllables: [{ text: 'Hello', startTime: 0, endTime: 4000 }], translatedText: 'Hola', oppositeAligned: true }];
const track = { title: 'Hello', artist: 'Artist', durationMs: 4000, spotifyTrackId: '1QV6tiMFM6fSOKOGLMHYYg' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesync-sqlite-'));
  let store;
  t.after(() => { store?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, open() { store = createLyricsVaultStore({ userDataPath: root }); return store; },
    close() { store.close(); store = undefined; } };
}

for (const compressed of [false, true]) test(`migrates ${compressed ? 'gzip v2' : 'JSON v1'} once and retains recovery files`, t => {
  const f = fixture(t);
  const vaultId = `fp_${buildTrackFingerprint(track).slice(0, 20)}`;
  const dir = path.join(f.root, 'lyrics-vault', vaultId);
  fs.mkdirSync(dir, { recursive: true });
  const content = '<tt custom="keep"><body><p begin="0" end="4">Hello</p></body></tt>';
  const manifest = { ...track, savedAt: 123, lineCount: 1, metadata: { ttml: { content } } };
  const manifestText = JSON.stringify(manifest);
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestText);
  const file = path.join(dir, compressed ? 'lyrics.json.gz' : 'lyrics.json');
  const payload = compressed ? gzipJsonPayload(compactLyricsForStorage(lyrics)) : Buffer.from(JSON.stringify(lyrics));
  fs.writeFileSync(file, payload);
  let store = f.open();
  assert.equal(store.listEntryCount(), 1);
  assert.equal(store.lookup(track).vaultId, vaultId);
  assert.equal(store.getEntry(vaultId).metadata.ttml.content, content);
  assert.deepEqual(store.getEntry(vaultId).lyrics, lyrics);
  assert.deepEqual(fs.readFileSync(file), payload);
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), manifestText);
  // The marker prevents stale backup files from overwriting SQLite changes.
  store.save({ track: { ...track, spotifyTrackId: '' }, lyrics: [{ ...lyrics[0], translatedText: 'Updated' }] });
  f.close(); store = f.open();
  assert.equal(store.getEntry(vaultId).lyrics[0].translatedText, 'Updated');
});

test('save is atomic, restart preserves documents, expiry and catalog stay consistent', t => {
  const f = fixture(t);
  let store = f.open();
  const metadata = { ttml: { content: '<tt untouched="yes"/>' }, credits: { songwriters: ['Writer'] } };
  const saved = store.save({ track, lyrics, metadata });
  assert.equal(store.lookup(track).vaultId, saved.vaultId);
  assert.equal(store.lookup({ ...track, spotifyTrackId: "different-recording" }), null);
  const db = new DatabaseSync(path.join(store.getVaultRoot(), 'vault.sqlite'));
  db.exec("CREATE TRIGGER reject_keys BEFORE INSERT ON vault_keys BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  assert.throws(() => store.save({ track, lyrics: [{ ...lyrics[0], translatedText: 'Lost update' }] }), /injected failure/);
  assert.equal(store.getEntry(saved.vaultId).lyrics[0].translatedText, 'Hola');
  db.exec('DROP TRIGGER reject_keys');
  db.close();
  f.close(); store = f.open();
  assert.deepEqual(store.getEntry(saved.vaultId).metadata, metadata);
  assert.equal(store.listEntries()[0].lineCount, 1);
  assert.equal(store.listEntries()[0].lyrics, undefined);
  store.save({ track: { ...track, title: 'Expired', spotifyTrackId: 'expired' }, lyrics,
    metadata: { spicyApi: { expiresAt: Date.now() - 1 } } });
  assert.equal(store.listEntryCount(), 1);
  assert.equal(store.getEntry('spotify_expired'), null);
  assert.throws(() => store.getEntry('../outside'), /Invalid vault/);
});

test('failed legacy migration rolls back and can be retried without losing backups', t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'lyrics-vault', 'fp_01234567890123456789');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lyrics.json'), JSON.stringify(lyrics));
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{broken');
  assert.throws(() => f.open(), /JSON/);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(track));
  const store = f.open();
  assert.equal(store.listEntryCount(), 1);
  assert.ok(fs.existsSync(path.join(dir, 'lyrics.json')));
});

test('entry replacement and expiry cascade use the vault ID index', t => {
  const f = fixture(t);
  const store = f.open();
  const db = new DatabaseSync(path.join(store.getVaultRoot(), 'vault.sqlite'));
  try {
    const plan = db.prepare('EXPLAIN QUERY PLAN DELETE FROM vault_keys WHERE vault_id = ?').all('spotify_example');
    assert.ok(plan.some(row => row.detail.includes('vault_keys_entry')), JSON.stringify(plan));
    assert.ok(plan.every(row => !row.detail.includes('SCAN vault_keys')), JSON.stringify(plan));
  } finally { db.close(); }
});
