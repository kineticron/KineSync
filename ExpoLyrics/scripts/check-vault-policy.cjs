const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { loadMobileVault } = require('./helpers/mobile-vault-harness.cjs');
const policy = require('../lib/lyrics-policy');
const track = { id: 'song', title: 'Song', artist: 'Artist', durationMs: 4000, spotifyTrackId: '1QV6tiMFM6fSOKOGLMHYYg' };
const lyrics = [{ lineStartTime: 0, lineEndTime: 4000, syllables: [{ text: 'Private sync', startTime: 0, endTime: 4000 }] }];
const attribution = { source: 'spicy_lyrics', provider: 'Spicy Lyrics', community: true };
const metadata = fetchedAt => ({ attribution, spicyApi: { fetchedAt, expiresAt: fetchedAt + policy.SPICY_MAX_AGE_MS }, ttml: { content: '<tt>Private sync</tt>' } });
const tick = () => new Promise(setImmediate);

function loadWebVault({ now = Date.now } = {}) {
  const storage = new Map();
  let payloadSerializations = 0;
  const context = { exports: {}, setTimeout, clearTimeout, Date: { now }, JSON: { parse: JSON.parse, stringify(value) {
    if (Array.isArray(value) && value.some(entry => Array.isArray(entry?.lyrics))) payloadSerializations++;
    return JSON.stringify(value);
  } }, require(name) {
    if (name === '@/lib/lyrics-policy') return policy;
    if (name === '@/lib/vault-spotify-match') return { resolveImportedVaultTrack: async track => track };
    assert.equal(name, '@react-native-async-storage/async-storage');
    return { getItem: async key => storage.get(key) || null, setItem: async (key, value) => storage.set(key, value) };
  } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../lib/mobile-lyrics-vault.web.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { vault: context.exports, storage, get payloadSerializations() { return payloadSerializations; }, close() {} };
}

async function checkRefreshSupersession(harness) {
  const { vault } = harness;
  let stop, finish;
  try {
    await vault.saveMobileVaultLyrics({ track, lyrics, originalSource: 'spicy-lyrics-line', metadata: metadata(Date.now() - 31 * 86400000) });
    assert.equal(await vault.lookupMobileVaultLyrics(track), null);
    let started;
    const requestStarted = new Promise(resolve => { started = resolve; });
    stop = vault.startMobileVaultRefresh(() => new Promise(resolve => { finish = resolve; started(); }));
    await requestStarted;
    await vault.saveMobileVaultLyrics({ track, lyrics, originalSource: 'lrc-red-karaoke' });
    finish({ lyrics, source: 'spicy-lyrics-line', metadata: metadata(Date.now()) });
    await tick();
    const entries = await vault.readVaultEntries();
    assert.equal(entries.length, 1, 'A delayed refresh must not recreate an expired copy after a manual save');
    assert.equal(entries[0].originalSource, 'lrc-red-karaoke');
  } finally { stop?.(); finish?.(null); await tick(); harness.close(); }
}

async function checkRecordingMatching(harness) {
  const { vault } = harness;
  try {
    await vault.saveMobileVaultLyrics({ track, lyrics });
    const other = { ...track, spotifyTrackId: 'different-recording' };
    assert.equal(await vault.lookupMobileVaultLyrics(other), null, 'Conflicting Spotify IDs must not fall back to title');
    await vault.saveMobileVaultLyrics({ track: other, lyrics: [{ ...lyrics[0], translatedText: 'Other recording' }] });
    const catalog = await vault.readVaultCatalog();
    assert.equal(catalog.length, 2, 'Saving another recording must preserve the first');
    assert.equal(new Set(catalog.map(entry => entry.vaultId)).size, 2, 'Saves in one clock tick must have distinct IDs');
    assert.equal((await vault.lookupMobileVaultLyrics(track)).lyrics[0].translatedText, undefined);
    const imported = { ...track, title: 'Import', spotifyTrackId: undefined };
    await vault.saveMobileVaultLyrics({ track: imported, lyrics, originalSource: 'file-import' });
    assert.ok(await vault.lookupMobileVaultLyrics({ ...imported, durationMs: 190000 }), 'File imports may end before the recording does');
  } finally { harness.close(); }
}

async function checkWebExpiryDuringRefresh() {
  let now = Date.now();
  const harness = loadWebVault({ now: () => now });
  const { vault } = harness;
  let stop, finish;
  try {
    await vault.saveMobileVaultLyrics({ track, lyrics, originalSource: 'spicy-lyrics-line', metadata: metadata(now - 31 * 86400000) });
    const other = { ...track, title: 'Second song', spotifyTrackId: 'second-song' };
    await vault.saveMobileVaultLyrics({ track: other, lyrics, originalSource: 'spicy-lyrics-line', metadata: { ...metadata(now), spicyApi: { fetchedAt: now, expiresAt: now + 1000 } } });
    let started;
    const requestStarted = new Promise(resolve => { started = resolve; });
    stop = vault.startMobileVaultRefresh(() => new Promise(resolve => { finish = resolve; started(); }));
    await requestStarted;
    now += 2000;
    finish(null);
    await tick();
    assert.equal((await vault.readVaultEntries()).length, 0);
    const jobs = JSON.parse(harness.storage.get('kinesync_mobile_lyrics_vault_refresh_v1'));
    assert.equal(jobs.length, 1, 'Expiring a second song while refresh is pending must retain its retry job');
    assert.equal(jobs[0].track.spotifyTrackId, other.spotifyTrackId);
  } finally { stop?.(); finish?.(null); await tick(); harness.close(); }
}

async function checkWebReadSerialization() {
  const harness = loadWebVault();
  const { vault } = harness;
  try {
    const entries = Array.from({ length: 100 }, (_, i) => ({ vaultId: `large-${i}`, savedAt: i,
      track: { ...track, title: `Song ${i}` }, lyrics, sourceLabel: 'local-vault', metadata: { ttml: { content: 'x'.repeat(16000) } } }));
    harness.storage.set('kinesync_mobile_lyrics_vault_v1', JSON.stringify(entries));
    await vault.readVaultEntries();
    await vault.readVaultCatalog();
    assert.equal(harness.payloadSerializations, 0, 'Unchanged reads must not serialize all saved lyrics and XML');
  } finally { harness.close(); }
}

async function checkWebExactMatch() {
  const harness = loadWebVault();
  try {
    harness.storage.set('kinesync_mobile_lyrics_vault_v1', JSON.stringify([
      { vaultId: 'exact', savedAt: 1, track, lyrics, sourceLabel: 'exact-recording' },
      { vaultId: 'generic', savedAt: 2, track: { ...track, spotifyTrackId: undefined }, lyrics, sourceLabel: 'metadata-match' },
    ]));
    assert.equal((await harness.vault.lookupMobileVaultLyrics(track)).source, 'exact-recording', 'An exact Spotify ID must outrank a newer metadata-only match');
  } finally { harness.close(); }
}

async function check(harness, native) {
  const { vault } = harness;
  let stop;
  try {
    const fetchedAt = Date.now() - 29 * 86400000;
    await vault.saveMobileVaultLyrics({ track, lyrics, originalSource: 'spicy-lyrics-syllable', metadata: metadata(fetchedAt) });
    let entry = (await vault.readVaultEntries())[0];
    assert.equal((await vault.readVaultCatalog())[0].exportRestricted, true);
    assert.throws(() => policy.assertLyricsExportAllowed(entry), /cannot be exported/);
    await vault.saveMobileVaultLyrics({ track, lyrics, originalSource: 'desktop-vault', metadata: entry.metadata });
    entry = (await vault.readVaultEntries())[0];
    assert.equal(entry.metadata.spicyApi.expiresAt, fetchedAt + policy.SPICY_MAX_AGE_MS, 'Transfers cannot renew retrieval time');
    await vault.saveMobileVaultLyrics({ track, lyrics, originalSource: 'spicy-lyrics-syllable', metadata: metadata(Date.now() - 31 * 86400000) });
    assert.equal(await vault.lookupMobileVaultLyrics(track), null);
    assert.equal((await vault.readVaultEntries()).length, 0);
    if (native) {
      assert.equal(harness.database.prepare('SELECT count(*) AS n FROM vault_entries').get().n, 0);
      assert.doesNotMatch(JSON.stringify(harness.database.prepare('SELECT * FROM vault_refresh').all()), /Private sync|<tt>|attribution/);
    } else assert.doesNotMatch(JSON.stringify([...harness.storage]), /Private sync|<tt>|attribution/);
    let calls = 0;
    stop = vault.startMobileVaultRefresh(async () => { calls++; throw Error('Offline'); });
    await tick();
    assert.equal(calls, 1);
    assert.equal(await vault.lookupMobileVaultLyrics(track), null);
    stop();
    const fresh = metadata(Date.now());
    stop = vault.startMobileVaultRefresh(async () => ({ lyrics, source: 'spicy-lyrics-syllable', metadata: fresh }));
    await tick();
    entry = (await vault.readVaultEntries())[0];
    assert.equal(entry.metadata.spicyApi.fetchedAt, fresh.spicyApi.fetchedAt);
    stop();
    await vault.saveMobileVaultLyrics({ track, lyrics, originalSource: 'spicy-lyrics-line', metadata: metadata(Date.now() - 31 * 86400000) });
    stop = vault.startMobileVaultRefresh(async () => null);
    await tick();
    assert.equal(await vault.lookupMobileVaultLyrics(track), null);
    stop();
    await vault.saveMobileVaultLyrics({ track, lyrics, originalSource: 'lrc-red-karaoke', metadata: { attribution: { provider: 'lrc.red', source: 'lrc-red' } } });
    assert.equal((await vault.readVaultCatalog())[0].exportRestricted, false);
    policy.assertLyricsExportAllowed((await vault.readVaultEntries())[0]);
  } finally { stop?.(); await tick(); harness.close(); }
}

async function main() {
  await check(loadMobileVault(), true);
  await check(loadWebVault(), false);
  await checkRefreshSupersession(loadMobileVault());
  await checkRefreshSupersession(loadWebVault());
  await checkRecordingMatching(loadMobileVault());
  const sameTick = Date.now();
  await checkRecordingMatching(loadWebVault({ now: () => sameTick }));
  await checkWebReadSerialization();
  await checkWebExactMatch();
  await checkWebExpiryDuringRefresh();
  const legacy = JSON.stringify([{ vaultId: 'legacy-spicy', savedAt: Date.now(), track, lyrics, originalSource: 'spicy-lyrics-line', metadata: metadata(Date.now()) }]);
  const migration = loadMobileVault({ legacy });
  try {
    assert.equal((await migration.vault.readVaultEntries()).length, 1);
    assert.doesNotMatch(migration.backup, /Private sync|spicyApi/, 'Recovery backups must not retain unmanaged API data');
  } finally { migration.close(); }
  for (const source of ['lrc-red-karaoke', 'qq-musicu-qrc', 'netease-yrc', 'musixmatch-richsync', 'lrclib']) {
    assert.equal(policy.isSpicyLyricsResponse({ source, metadata: { attribution: { provider: source } } }), false, 'New attribution is limited to Spicy responses');
  }
  console.log('Spicy vault policy passed on native and web: provenance, expiry, refresh races, recording matching, unique IDs, unchanged read serialization, recovery cleanup and lrc.red exemption.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
