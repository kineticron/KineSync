"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");

const trackId = "1QV6tiMFM6fSOKOGLMHYYg";
const key = "sl_pk_test_client";
const profile = { username: "creator", id: "123", url: "https://spicylyrics.org/uid/123" };
const body = {
  id: trackId, source: "spicy_lyrics", Type: "Syllable", StartTime: 1, EndTime: 4,
  UploadAttribution: { Maker: profile, Uploader: profile },
  SongWriters: ["Writer"],
  Content: [{ Type: "Vocal", Lead: { StartTime: 1, EndTime: 4,
    Syllables: [{ Text: "Hello", StartTime: 1, EndTime: 4, IsPartOfWord: false }] } }],
};

function load(fetch, mobile = false) {
  const src = path.resolve(__dirname, "../src");
  const module = { exports: {} };
  const context = vm.createContext({
    AbortController, Buffer, clearTimeout, setTimeout, clearInterval, setInterval,
    TextDecoder, URL, URLSearchParams, console, fetch, global: {}, module,
    exports: module.exports, process: { env: {} },
    require: createRequire(path.join(src, "lyricsService.js")),
  });
  if (mobile) {
    let source = fs.readFileSync(path.resolve(src, "../../ExpoLyrics/lib/mobile-lyrics-service.js"), "utf8");
    source = source.replace(/^import .*;\r?\n/gm, "");
    source = source.slice(0, source.indexOf("export {"));
    vm.runInContext(source, context);
  } else {
    const index = fs.readFileSync(path.join(src, "lyrics/index.js"), "utf8");
    const partList = index.match(/const partFiles = \[([\s\S]*?)\];/)[1];
    for (const match of partList.matchAll(/"([^"]+)"/g)) {
      vm.runInContext(fs.readFileSync(path.join(src, "lyrics/parts", match[1]), "utf8"), context);
    }
  }
  return context;
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} keeps fresh Spicy lyrics valid through publication and source-cache reuse`, async () => {
    let requests = 0;
    const context = load(async () => {
      requests++;
      return new Response(JSON.stringify({ Body: body, Status: 200 }));
    }, mobile);
    context.track = { trackId: "promise-by-slayr", spotifyTrackId: trackId, title: "promise", artist: "slayr", durationMs: 4000 };
    const packets = [];
    context.onPacket = packet => packets.push(packet);
    const result = await vm.runInContext(`
      const freshnessService = createLyricsService({ getSpicyLyricsPublishableKey: () => "${key}" });
      freshnessService.fetchSyncedLyrics(track, { preferredSource: "spicy-lyrics", onSyncedLyrics: onPacket });
    `, context);
    const { spicyLyricsExpiresAt } = require("../src/lyricsPolicy");
    assert.ok(packets.length > 0, "The test must exercise the actual publication path");
    for (const packet of [...packets, result]) {
      assert.ok(packet.metadata.spicyApi?.fetchedAt > 0, "Publication must retain the original retrieval time");
      assert.ok(spicyLyricsExpiresAt(packet) > Date.now(), "Fresh lyrics must not trigger an expiry refetch");
      assert.equal(packet.metadata.attribution.provider, "Spicy Lyrics");
    }
    const cached = await vm.runInContext('freshnessService.fetchSyncedLyrics(track, { preferredSource: "spicy-lyrics" })', context);
    assert.equal(requests, 1, "A fresh source-cache hit must not request the API again");
    assert.equal(cached.metadata.spicyApi.fetchedAt, result.metadata.spicyApi.fetchedAt);
    assert.equal(cached.metadata.spicyApi.expiresAt, result.metadata.spicyApi.expiresAt);
    context.packet = result;
    vm.runInContext('freshnessService.rememberPublishedLyrics(track.trackId, packet)', context);
    const published = vm.runInContext('freshnessService.getPublishedLyrics(track.trackId)', context);
    assert.equal(published.metadata.spicyApi.expiresAt, result.metadata.spicyApi.expiresAt);
  });

  test(`${mobile ? "mobile" : "desktop"} discards expired in-memory copies without waiting for another lookup`, () => {
    const context = load(() => { throw Error('Unexpected request'); }, mobile);
    let now = 1000;
    let scheduled;
    context.Date = { now: () => now };
    context.setTimeout = callback => { scheduled = callback; return { unref() {} }; };
    context.clearTimeout = () => {};
    vm.runInContext(`const expiryService = createLyricsService(); expiryService.rememberPublishedLyrics('song', {
      lyrics: [{}], source: 'spicy-lyrics-syllable', metadata: { spicyApi: { fetchedAt: 1000, expiresAt: 1010 } }
    });`, context);
    assert.equal(vm.runInContext('expiryService.getMusixmatchRuntimeStatus().publishedLyricsCacheEntries', context), 1);
    now = 1011;
    scheduled();
    assert.equal(vm.runInContext('expiryService.getMusixmatchRuntimeStatus().publishedLyricsCacheEntries', context), 0);
  });

  test(`${mobile ? "mobile" : "desktop"} rejects non-community replies instead of caching commercial Spicy copies`, async () => {
    for (const source of ['apple_music', 'spotify', 'unknown']) {
      const context = load(async () => new Response(JSON.stringify({ Body: { ...body, source }, Status: 200 })), mobile);
      context.track = { spotifyTrackId: trackId, title: 'Hello', artist: 'Artist', durationMs: 4000 };
      context.key = key;
      await assert.rejects(vm.runInContext('fetchFromSpicyLyrics(track, { spicyLyricsPublishableKey: key })', context), error => error.sourceFailureReason?.endsWith('-no-match'));
    }
  });

  test(`${mobile ? "mobile" : "desktop"} uses official GET with only publishable authentication`, async () => {
    const calls = [];
    const context = load(async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ Body: body, Status: 200, Type: "object" }), { status: 200 });
    }, mobile);
    context.track = { trackId: "test", spotifyTrackId: trackId, title: "Hello", artist: "Artist", durationMs: 4000 };
    context.key = key;
    const result = await vm.runInContext('fetchFromSpicyLyrics(track, { spicyLyricsPublishableKey: key })', context);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.spicylyrics.org/v1/lyrics/${trackId}`);
    assert.equal(calls[0].options.method, "GET");
    assert.deepEqual(Object.keys(calls[0].options.headers).sort(), ["Accept", "Authorization"]);
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${key}`);
    assert.equal(result.lyrics[0].lineStartTime, 1000);
    assert.equal(result.metadata.attribution.provider, "Spicy Lyrics");
    assert.equal(result.metadata.attribution.maker.url, profile.url);
    assert(result.metadata.spicyApi.expiresAt - result.metadata.spicyApi.fetchedAt <= 30 * 86400000 + 1);
  });
}

test("missing and secret keys are rejected before making any request", async () => {
  const context = load(() => { throw Error("Unexpected network request"); });
  context.trackId = trackId;
  for (const invalid of ["", "sl_sk_secret", "spotify-token"]) {
    context.key = invalid;
    await assert.rejects(vm.runInContext('fetchSpicyLyricsByTrackId(trackId, key)', context), /publishable client key/);
  }
});

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} reports an empty client key as missing configuration`, async () => {
    const context = load(() => { throw Error("Unexpected network request"); }, mobile);
    context.track = { trackId: "test", spotifyTrackId: trackId, title: "Hello", artist: "Artist", durationMs: 4000 };
    await assert.rejects(
      vm.runInContext('fetchFromSpicyLyrics(track, { spicyLyricsPublishableKey: "" })', context),
      (error) => error.sourceFailureReason === "spicy:backend-missing-config",
    );
  });
}

test("404 is a source miss; auth, rate-limit and malformed replies remain errors", async () => {
  for (const status of [401, 403, 429, 503]) {
    const context = load(async () => new Response("{}", { status, headers: { "Retry-After": "60" } }));
    context.trackId = trackId; context.key = key;
    await assert.rejects(vm.runInContext('fetchSpicyLyricsByTrackId(trackId, key)', context), new RegExp(`HTTP ${status}`));
  }
  const missing = load(async () => new Response("{}", { status: 404 }));
  missing.trackId = trackId; missing.key = key;
  assert.equal(await vm.runInContext('fetchSpicyLyricsByTrackId(trackId, key)', missing), null);
  const malformed = load(async () => new Response(JSON.stringify({ Status: 200 })));
  malformed.trackId = trackId; malformed.key = key;
  await assert.rejects(vm.runInContext('fetchSpicyLyricsByTrackId(trackId, key)', malformed), /invalid API response/);
});

test("TTML export and import preserve provider, contributor links and API freshness", () => {
  const { lyricsToTtml } = require("../src/lyricsTtmlExport");
  const { parseTtmlToLyrics } = require("../src/lyricsTtmlImport");
  const metadata = {
    attribution: { source: "spicy_lyrics", provider: "Spicy Lyrics", community: true, maker: profile, uploader: profile },
    spicyApi: { fetchedAt: 100, expiresAt: 200 },
  };
  const xml = lyricsToTtml({ lyrics: [{ lineStartTime: 1000, lineEndTime: 4000, syllables: [{ text: "Hello", startTime: 1000, endTime: 4000 }] }], metadata });
  assert.match(xml, /Provided by: Spicy Lyrics/);
  assert.match(xml, /Made by: creator/);
  assert.deepEqual(parseTtmlToLyrics(xml).metadata.attribution, metadata.attribution);
  assert.deepEqual(parseTtmlToLyrics(xml).metadata.spicyApi, metadata.spicyApi);
});

test("each lyrics service keeps its own client key", async () => {
  const calls = [];
  const context = load(async (url, options) => {
    calls.push(options.headers.Authorization);
    return new Response(JSON.stringify({ Body: body, Status: 200 }));
  });
  context.track = { trackId: "test", spotifyTrackId: trackId, title: "Hello", artist: "Artist", durationMs: 4000 };
  await vm.runInContext(`
    const first = createLyricsService({ getSpicyLyricsPublishableKey: () => "sl_pk_first" });
    const second = createLyricsService({ getSpicyLyricsPublishableKey: () => "sl_pk_second" });
    (async () => {
      await first.fetchSyncedLyrics(track, { preferredSource: "spicy-lyrics" });
      await second.fetchSyncedLyrics(track, { preferredSource: "spicy-lyrics" });
    })();
  `, context);
  assert.deepEqual(calls, ["Bearer sl_pk_first", "Bearer sl_pk_second"]);
});

test("vault metadata and memory caches retain credits and reject expired API responses", () => {
  const { pickVaultPersistedMetadata } = require("../src/lyricsVault");
  const attribution = { source: "spicy_lyrics", provider: "Spicy Lyrics", community: true, maker: profile, uploader: profile };
  const metadata = { attribution, spicyApi: { fetchedAt: 1, expiresAt: 2 } };
  assert.deepEqual(pickVaultPersistedMetadata(metadata), metadata);
  const context = load(() => { throw Error("Unexpected request"); });
  context.metadata = metadata;
  assert.equal(vm.runInContext(`
    const service = createLyricsService();
    service.rememberPublishedLyrics("expired", { source: "spicy-lyrics-syllable", lyrics: [{}], metadata });
    service.getCachedLyrics("expired");
  `, context), null);
});
