"use strict";
// Independent regression coverage for mobile policy plus desktop, mobile
// native, and mobile web vault provenance merges. These tests execute the real
// modules. They are intentionally separate from the author's test files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const { stripTypeScriptTypes } = require("node:module");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const mobilePolicy = require(path.join(repoRoot, "ExpoLyrics/lib/lyrics-policy"));
const desktopPolicy = require("../src/lyricsPolicy");
const { createLyricsVaultStore } = require("../src/lyricsVault");

const ISRC = "US5TA1500050";
const NOW = Date.now();
const lyrics = [{ lineStartTime: 0, lineEndTime: 4000, syllables: [{ text: "Private sync", startTime: 0, endTime: 4000 }] }];
const track = { id: "track-1", title: "Rewind", artist: "Wonder Girls", album: "Reboot", durationMs: 213000, spotifyTrackId: "1QV6tiMFM6fSOKOGLMHYYg" };
const spoofVariants = [
  { name: "fetchOrigin.source=lrc-red", fetchOrigin: { source: "lrc-red" } },
  { name: "fetchOrigin.host=lrc.red", fetchOrigin: { host: "lrc.red" } },
];
const independentContentSpoof = { independentContent: { source: "lrc-red", verified: true, isrc: "ZZZZZ0000000" } };
const independentTrack = { id: "track-independent", title: "Independent Song", artist: "Independent Artist", album: "Independent Album", durationMs: 180000, spotifyTrackId: "4uLU6hMCjMI75M1A2tKUQC" };
const independentMetadata = { attribution: { source: "lrc-red", provider: "lrc.red" }, independentContent: { source: "lrc-red", verified: true, isrc: "ZZZZZ0000000" } };
const spicyMetadata = (overrides = {}) => ({
  fetchOrigin: {
    provider: "Spicy Lyrics",
    source: "spicy-lyrics-api",
    host: "api.spicylyrics.org",
    url: `https://api.spicylyrics.org/v1/lyrics/${track.spotifyTrackId}`,
    spotifyTrackId: track.spotifyTrackId,
    isrc: ISRC,
  },
  spicyApi: { fetchedAt: NOW, expiresAt: NOW + 30 * 24 * 60 * 60 * 1000 },
  attribution: { source: "spicy_lyrics", provider: "Spicy Lyrics", community: true },
  ...overrides,
});

function memoryAsyncStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async getItem(key) { return data.has(key) ? data.get(key) : null; },
    async setItem(key, value) { data.set(key, String(value)); },
    async removeItem(key) { data.delete(key); },
  };
}

function sqliteModuleShim() {
  const opened = [];
  return {
    opened,
    openDatabaseAsync: async () => {
      const db = new DatabaseSync(":memory:");
      opened.push(db);
      return {
        execAsync: async sql => db.exec(sql),
        runAsync: async (sql, ...params) => db.prepare(sql).run(...params),
        getFirstAsync: async (sql, ...params) => db.prepare(sql).get(...params) ?? null,
        getAllAsync: async (sql, ...params) => db.prepare(sql).all(...params),
        closeAsync: async () => db.close(),
      };
    },
  };
}

function loadMobileVault(kind, { storage = memoryAsyncStorage() } = {}) {
  const filename = kind === "web"
    ? path.join(repoRoot, "ExpoLyrics/lib/mobile-lyrics-vault.web.ts")
    : path.join(repoRoot, "ExpoLyrics/lib/mobile-lyrics-vault.ts");
  let source = fs.readFileSync(filename, "utf8").replace(/^import .*;\r?\n/gm, "");
  source = stripTypeScriptTypes(source, { mode: "transform" }).replace(/^export\s+/gm, "");
  source += `\nglobalThis.__vaultApi = { readVaultEntries, readVaultCatalog, saveMobileVaultLyrics, getMobileVaultEntry, deleteMobileVaultEntry, renameMobileVaultEntry, lookupMobileVaultLyrics, startMobileVaultRefresh, refreshMobileVault };\n`;
  const sqlite = sqliteModuleShim();
  const context = vm.createContext({
    AsyncStorage: storage,
    console,
    Date,
    JSON,
    Math,
    Promise,
    Set,
    Map,
    Number,
    String,
    Object,
    Array,
    Error,
    RegExp,
    setTimeout,
    clearTimeout,
    openDatabaseAsync: sqlite.openDatabaseAsync,
    resolveImportedVaultTrack: async value => value,
    isSpicyCommunityLyrics: mobilePolicy.isSpicyCommunityLyrics,
    spicyLyricsExpiresAt: mobilePolicy.spicyLyricsExpiresAt,
    withSpicyFreshness: mobilePolicy.withSpicyFreshness,
  });
  vm.runInContext(source, context, { filename });
  return { api: context.__vaultApi, storage, sqlite };
}

function tmpVault(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kinesync-independent-vault-"));
  const store = createLyricsVaultStore({ userDataPath: root });
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store;
}

for (const [label, policy] of [["desktop", desktopPolicy], ["mobile", mobilePolicy]]) {
  test(`${label} policy keeps relabeled Spicy provenance restricted for Apple, Musixmatch, and unknown providers`, () => {
    const relabels = [
      { originalSource: "lrc-red-karaoke", sourceLabel: "local-vault-karaoke", attribution: { source: "lrc-red", provider: "lrc.red" } },
      { originalSource: "lrc-red-line", sourceLabel: "lrc.red", attribution: { source: "apple-music", provider: "Apple Music" } },
      { originalSource: "local-vault-line", sourceLabel: "lrc.red", attribution: { source: "musixmatch", provider: "Musixmatch" } },
      { originalSource: "unknown-origin", sourceLabel: "unrelated", attribution: { source: "other", provider: "Other" } },
    ];
    for (const relabel of relabels) {
      const entry = {
        originalSource: relabel.originalSource,
        sourceLabel: relabel.sourceLabel,
        metadata: spicyMetadata({ attribution: relabel.attribution }),
      };
      assert.equal(policy.isSpicyLyricsResponse(entry), true, `${relabel.sourceLabel} must retain Spicy origin evidence`);
      assert.equal(policy.isSpicyCommunityLyrics(entry), true);
      assert.throws(() => policy.assertLyricsExportAllowed(entry), /cannot be exported/);
    }
    // A Spicy API lease survives an outer lrc.red or unrelated current label.
    for (const originalSource of ["lrc-red-line", "local-vault-line", "unknown-origin"]) {
      const entry = { originalSource, sourceLabel: "lrc.red", metadata: { spicyApi: { fetchedAt: NOW, expiresAt: NOW + 1000 }, attribution: { source: "lrc-red", provider: "lrc.red" } } };
      assert.throws(() => policy.assertLyricsExportAllowed(entry), /cannot be exported/);
    }
  });

  test(`${label} policy retains previously Spicy vault originalSource when the current label is unrelated`, () => {
    const entry = {
      originalSource: "local-vault-line",
      sourceLabel: "local-vault-line",
      metadata: { vault: { originalSource: "spicy-lyrics-syllable", savedAt: NOW }, attribution: { provider: "Apple Music" } },
    };
    assert.throws(() => policy.assertLyricsExportAllowed(entry), /cannot be exported/);
  });

  test(`${label} policy allows genuinely independent lrc.red content and rejects only Spicy evidence`, () => {
    const independent = {
      originalSource: "lrc-red-line",
      sourceLabel: "local-vault-line",
      metadata: { attribution: { source: "lrc-red", provider: "lrc.red", url: `https://lrc.red/s/${ISRC}` } },
    };
    policy.assertLyricsExportAllowed(independent);
    assert.equal(policy.isSpicyLyricsResponse(independent), false);
    const importedTtml = { originalSource: "ttml-import", metadata: { attribution: { provider: "Apple Music", source: "apple-music" } } };
    policy.assertLyricsExportAllowed(importedTtml);
  });
}

test("desktop vault merge does not let an lrc.red relabel erase prior Spicy origin", t => {
  const store = tmpVault(t);
  store.save({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
  assert.equal(store.listEntries()[0].exportRestricted, true, "initial Spicy save is restricted");
  store.save({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "lrc-red-line", metadata: { attribution: { source: "lrc-red", provider: "lrc.red" } } });
  const entry = store.getEntry(`spotify_${track.spotifyTrackId}`);
  assert.equal(entry.manifest.metadata.fetchOrigin?.isrc, ISRC, "persisted Spicy ISRC must survive the relabel");
  assert.equal(store.listEntries()[0].exportRestricted, true, "lrc.red relabel must not clear the restriction");
  assert.throws(() => desktopPolicy.assertLyricsExportAllowed(entry.manifest), /cannot be exported/);
});

for (const spoof of spoofVariants) {
  test(`desktop vault keeps Spicy restriction and ISRC against ${spoof.name} spoofing`, t => {
    const store = tmpVault(t);
    store.save({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
    store.save({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "lrc-red-line", metadata: { fetchOrigin: spoof.fetchOrigin, attribution: { source: "lrc-red", provider: "lrc.red" } } });
    const entry = store.getEntry(`spotify_${track.spotifyTrackId}`);
    assert.deepEqual({
      exportRestricted: store.listEntries()[0].exportRestricted,
      isrc: entry.manifest.metadata.fetchOrigin?.isrc,
    }, { exportRestricted: true, isrc: ISRC }, "spoofed origin must retain the Spicy restriction and ISRC");
    assert.throws(() => desktopPolicy.assertLyricsExportAllowed(entry.manifest), /cannot be exported/);
  });
}

test("desktop vault keeps Spicy restriction and ISRC against an independentContent marker spoof", t => {
  const store = tmpVault(t);
  store.save({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
  store.save({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "lrc-red-line", metadata: independentContentSpoof });
  const entry = store.getEntry(`spotify_${track.spotifyTrackId}`);
  assert.deepEqual({
    exportRestricted: store.listEntries().find(item => item.vaultId === `spotify_${track.spotifyTrackId}`).exportRestricted,
    isrc: entry.manifest.metadata.fetchOrigin?.isrc,
  }, { exportRestricted: true, isrc: ISRC }, "no metadata marker may replace persisted Spicy origin");
  assert.throws(() => desktopPolicy.assertLyricsExportAllowed(entry.manifest), /cannot be exported/);
});

test("desktop vault keeps a separate genuinely new lrc.red entry exportable", t => {
  const store = tmpVault(t);
  store.save({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
  store.save({ track: independentTrack, lyrics, sourceLabel: "local-vault-line", originalSource: "lrc-red-line", metadata: independentMetadata });
  const [spicyEntry, lrcRedEntry] = store.listEntries().sort((left, right) => left.vaultId.localeCompare(right.vaultId));
  assert.equal(spicyEntry.exportRestricted, true);
  assert.equal(lrcRedEntry.exportRestricted, false);
  const saved = store.getEntry(`spotify_${independentTrack.spotifyTrackId}`);
  desktopPolicy.assertLyricsExportAllowed(saved.manifest);
});

test("desktop vault merge preserves unrelated-origin Spicy provenance", t => {
  const store = tmpVault(t);
  store.save({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
  store.save({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "local-vault-line", metadata: { attribution: { provider: "Unknown" } } });
  const merged = store.getEntry(`spotify_${track.spotifyTrackId}`);
  assert.equal(merged.manifest.metadata.fetchOrigin?.host, "api.spicylyrics.org");
  assert.throws(() => desktopPolicy.assertLyricsExportAllowed(merged.manifest), /cannot be exported/);
});

for (const kind of ["native", "web"]) {
  test(`mobile ${kind} vault merge does not let an lrc.red relabel erase prior Spicy origin`, async () => {
    const { api } = loadMobileVault(kind);
    await api.saveMobileVaultLyrics({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
    assert.equal((await api.readVaultCatalog())[0].exportRestricted, true, "initial Spicy save is restricted");
    await api.saveMobileVaultLyrics({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "lrc-red-line", metadata: { attribution: { source: "lrc-red", provider: "lrc.red" } } });
    const [entry] = await api.readVaultEntries();
    assert.equal(entry.metadata?.fetchOrigin?.isrc, ISRC, "persisted Spicy ISRC must survive the relabel");
    assert.equal((await api.readVaultCatalog())[0].exportRestricted, true, "lrc.red relabel must not clear the restriction");
    assert.throws(() => mobilePolicy.assertLyricsExportAllowed(entry), /cannot be exported/);
  });

  for (const spoof of spoofVariants) {
    test(`mobile ${kind} vault keeps Spicy restriction and ISRC against ${spoof.name} spoofing`, async () => {
      const { api } = loadMobileVault(kind);
      await api.saveMobileVaultLyrics({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
      await api.saveMobileVaultLyrics({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "lrc-red-line", metadata: { fetchOrigin: spoof.fetchOrigin, attribution: { source: "lrc-red", provider: "lrc.red" } } });
      const [entry] = await api.readVaultEntries();
      assert.deepEqual({
        exportRestricted: (await api.readVaultCatalog())[0].exportRestricted,
        isrc: entry.metadata?.fetchOrigin?.isrc,
      }, { exportRestricted: true, isrc: ISRC }, "spoofed origin must retain the Spicy restriction and ISRC");
      assert.throws(() => mobilePolicy.assertLyricsExportAllowed(entry), /cannot be exported/);
    });
  }

  test(`mobile ${kind} vault keeps Spicy restriction and ISRC against an independentContent marker spoof`, async () => {
    const { api } = loadMobileVault(kind);
    await api.saveMobileVaultLyrics({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
    await api.saveMobileVaultLyrics({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "lrc-red-line", metadata: independentContentSpoof });
    const catalog = await api.readVaultCatalog();
    const [entry] = await api.readVaultEntries();
    assert.deepEqual({
      exportRestricted: catalog.find(item => item.vaultId === entry.vaultId).exportRestricted,
      isrc: entry.metadata?.fetchOrigin?.isrc,
    }, { exportRestricted: true, isrc: ISRC }, "no metadata marker may replace persisted Spicy origin");
    assert.throws(() => mobilePolicy.assertLyricsExportAllowed(entry), /cannot be exported/);
  });

  test(`mobile ${kind} vault keeps a separate genuinely new lrc.red entry exportable`, async () => {
    const { api } = loadMobileVault(kind);
    await api.saveMobileVaultLyrics({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
    await api.saveMobileVaultLyrics({ track: independentTrack, lyrics, sourceLabel: "local-vault-line", originalSource: "lrc-red-line", metadata: independentMetadata });
    const catalog = await api.readVaultCatalog();
    const independent = catalog.find(item => item.track.spotifyTrackId === independentTrack.spotifyTrackId);
    const spicy = catalog.find(item => item.track.spotifyTrackId === track.spotifyTrackId);
    assert.equal(spicy.exportRestricted, true);
    assert.equal(independent.exportRestricted, false);
    const saved = await api.getMobileVaultEntry(independent.vaultId);
    mobilePolicy.assertLyricsExportAllowed(saved);
  });

  test(`mobile ${kind} vault merge preserves unrelated-origin Spicy provenance`, async () => {
    const { api } = loadMobileVault(kind);
    await api.saveMobileVaultLyrics({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
    await api.saveMobileVaultLyrics({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "local-vault-line", metadata: { attribution: { provider: "Unknown" } } });
    const [entry] = await api.readVaultEntries();
    assert.equal(entry.metadata?.fetchOrigin?.host, "api.spicylyrics.org");
    assert.equal((await api.readVaultCatalog())[0].exportRestricted, true);
    assert.throws(() => mobilePolicy.assertLyricsExportAllowed(entry), /cannot be exported/);
  });

  test(`mobile ${kind} vault persists fetchOrigin.isrc across reads`, async () => {
    const { api } = loadMobileVault(kind);
    await api.saveMobileVaultLyrics({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
    const [entry] = await api.readVaultEntries();
    assert.equal(entry.metadata.fetchOrigin.isrc, ISRC);
    assert.equal(entry.metadata.fetchOrigin.host, "api.spicylyrics.org");
    assert.equal((await api.readVaultCatalog())[0].exportRestricted, true);
  });

  test(`mobile ${kind} vault clears prior Spicy provenance only for verified independent content`, {
    skip: "No trusted independent-content marker exists in the production vault contract. attribution.source/provider lrc.red is only a label, and a label must never clear persisted Spicy provenance.",
  }, async () => {});
}

test("desktop vault persists fetchOrigin.isrc for Spicy and keeps it on unrelated relabel", t => {
  const store = tmpVault(t);
  store.save({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata: spicyMetadata() });
  store.save({ track, lyrics, sourceLabel: "local-vault-line", originalSource: "local-vault-line", metadata: { attribution: { provider: "Apple Music" } } });
  const entry = store.getEntry(`spotify_${track.spotifyTrackId}`);
  assert.equal(entry.manifest.metadata.fetchOrigin.isrc, ISRC);
  assert.equal(entry.manifest.metadata.fetchOrigin.host, "api.spicylyrics.org");
  assert.throws(() => desktopPolicy.assertLyricsExportAllowed(entry.manifest), /cannot be exported/);
});
