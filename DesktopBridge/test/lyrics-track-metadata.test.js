"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");

function load(mobile) {
  const desktop = path.resolve(__dirname, "../src");
  const bundle = path.resolve(desktop, "../../ExpoLyrics/lib/mobile-lyrics-service.js");
  const ctx = vm.createContext({
    AbortController, Buffer, TextDecoder, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    process: { env: {} }, global: {}, module: { exports: {} },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    require: createRequire(mobile ? bundle : path.join(desktop, "lyricsService.js")),
    fetch() { throw new Error("Unexpected network"); },
  });
  if (mobile) {
    ctx.CryptoJS = ctx.require("crypto-js");
    const source = fs.readFileSync(bundle, "utf8").replace(/^import .*;\r?\n/gm, "");
    vm.runInContext(source.slice(0, source.indexOf("export {")), ctx);
    const ttml = require("../src/lyricsTtmlImport");
    ctx.parseLrcRedTtml = ttml.parseTtmlToLyrics;
    ctx.parseLrcRedTime = ttml.parseTtmlTimeExpression;
    ctx.extractLrcRedTtmlMetadata = ttml.extractTtmlMetadata;
  } else {
    const index = fs.readFileSync(path.join(desktop, "lyrics/index.js"), "utf8");
    for (const match of index.match(/const partFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)) {
      vm.runInContext(fs.readFileSync(path.join(desktop, "lyrics/parts", match[1]), "utf8"), ctx);
    }
  }
  return ctx;
}

const id = "37cXQzQaHR7zMk8G360Vke";
const isrc = "KRMIM2011544";
const playback = { trackId: "fixture", spotifyTrackId: id, title: "Song (Live)", artist: "Artist", durationMs: 199000 };
const deferred = () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  return { pending, resolve };
};

function observeProviders(ctx) {
  const seen = [];
  ctx.collectRankedKugouSearchCandidates = async track => { seen.push(["kugou", track.isrc]); return []; };
  ctx.resolveIsrcNativeTitle = async () => null;
  ctx.fetchJson = async url => {
    seen.push([url.includes("/s/") ? "lrc-red-isrc" : "catalog", url]);
    return {};
  };
  ctx.fetchText = async () => "";
  ctx.fetchFromQQDirect = async track => { seen.push(["qq-direct", track.title]); return { lyrics: [{}] }; };
  ctx.fetchNeteaseSearchJson = async query => { seen.push(["netease", query]); return {}; };
  ctx.fetchJsonWithRetry = async url => { seen.push(["lrclib", url]); return []; };
  ctx.fetchMusixmatchTrackCandidates = async track => { seen.push(["musixmatch", track.title]); return { matches: [] }; };
  ctx.fetchSpicyLyricsByTrackId = async spotifyId => { seen.push(["spicy-lyrics", spotifyId]); return null; };
  return seen;
}

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";

  test(`${platform}: cold ISRC lookup is shared, text and ID providers start first, warm providers reuse the result`, async () => {
    const ctx = load(mobile);
    const seen = observeProviders(ctx);
    const lookup = deferred();
    let calls = 0;
    const base = Object.freeze({ ...playback, resolveTrackMetadata: requested => {
      assert.equal(requested, id);
      calls++;
      return lookup.pending;
    } });
    const track = ctx.attachLyricsTrackMetadata(base);
    assert.equal(JSON.stringify(track), JSON.stringify({ ...base, isrc: "" }));
    assert.equal(track.isrc, "", "cold snapshot has no ISRC");
    assert.equal(calls, 0, "attaching a cold snapshot starts no lookup");
    const kugou = ctx.fetchFromKugou(track);
    const lrcRed = ctx.probeLyricsSource({ ...track }, "lrc-red");
    const fast = [
      ctx.fetchFromQQ(track),
      ctx.fetchFromNetease(track),
      ctx.fetchFromLrcLib(track),
      ctx.fetchFromMusixmatch(track, { musixmatchUserToken: "0123456789abcdef".repeat(2) + "01234567" }),
      ctx.fetchFromSpicyLyrics({ ...track, title: "", artist: "" }, { spicyLyricsPublishableKey: "sl_pk_fixture" }),
    ];
    const settled = Promise.allSettled([...fast, kugou, lrcRed]);
    try {
      // Observe provider I/O before allowing the ISRC request to settle.
      for (let turn = 0; turn < 30; turn++) await Promise.resolve();
      for (const source of ["qq-direct", "netease", "lrclib", "musixmatch", "spicy-lyrics"]) {
        assert.ok(seen.some(([name]) => name === source), `${source} starts before enrichment settles`);
      }
      assert.equal(calls, 1);
      assert.ok(!seen.some(([name]) => name === "kugou" || name === "lrc-red-isrc"));
    } finally {
      lookup.resolve({ spotifyTrackId: id, title: "Song", artists: ["Artist", "Guest"], isrc: "kr-mim 20-11544" });
      await settled;
    }
    assert.ok(seen.some(([name, value]) => name === "kugou" && value === isrc));
    assert.ok(seen.some(([name, value]) => name === "lrc-red-isrc" && value.endsWith(`/${isrc}.json`)));
    const enriched = await ctx.resolveLyricsTrackMetadata(track, ["metadataEnrichment"]);
    assert.equal(enriched, await ctx.resolveLyricsTrackMetadata(track, ["isrc"]));
    assert.equal(enriched.title, playback.title);
    assert.deepEqual([...enriched.artists], ["Artist", "Guest"]);
    assert.equal(base.isrc, undefined);
    assert.equal(track.isrc, "");
    assert.equal(calls, 1);

    // Warm calls use the original ISRC-less snapshot and a diagnostic spread.
    const warmStart = seen.length;
    await Promise.all([
      ctx.fetchFromKugou(track),
      ctx.probeLyricsSource({ ...track }, "lrc-red"),
    ]);
    const warm = seen.slice(warmStart);
    assert.ok(warm.some(([name, value]) => name === "kugou" && value === isrc));
    assert.ok(warm.some(([name, value]) => name === "lrc-red-isrc" && value.endsWith(`/${isrc}.json`)));
    assert.equal(calls, 1, "warm provider calls reuse the resolved ISRC");
  });

  test(`${platform}: supplied ISRC still fills missing text for Kugou and lrc.red`, async () => {
    const ctx = load(mobile);
    observeProviders(ctx);
    let matchedTrack;
    const catalogQueries = [];
    ctx.collectRankedKugouSearchCandidates = async track => { matchedTrack = track; return []; };
    ctx.fetchJson = async (url, options) => {
      if (url === "https://api.deezer.com/search") catalogQueries.push(options.params.q);
      return {};
    };
    let calls = 0;
    const input = Object.freeze({
      ...playback, title: "", artist: "", durationMs: 0, isrc,
      resolveTrackMetadata: async requested => {
        assert.equal(requested, id);
        calls++;
        return { id, title: playback.title, artist: playback.artist, durationMs: playback.durationMs };
      },
    });
    await Promise.all([ctx.fetchFromKugou(input), ctx.fetchFromLrcRed(input)]);
    assert.equal(calls, 1);
    assert.equal(matchedTrack.title, playback.title);
    assert.equal(matchedTrack.artist, playback.artist);
    assert.equal(matchedTrack.durationMs, playback.durationMs);
    assert.equal(matchedTrack.isrc, isrc);
    assert.deepEqual(catalogQueries, [`${playback.artist} ${playback.title}`]);
    assert.equal(input.title, "");
  });

  test(`${platform}: blank-title service track starts ID-only Spicy during shared enrichment`, async () => {
    const ctx = load(mobile);
    const seen = observeProviders(ctx);
    const registry = vm.runInContext("SOURCE_FETCHERS", ctx);
    registry["local-vault"] = async () => null;
    const service = ctx.createLyricsService({ getSpicyLyricsPublishableKey: () => "sl_pk_fixture" });
    const lookup = deferred();
    let calls = 0;
    const input = {
      ...playback, title: " ", artist: "", durationMs: 0,
      resolveTrackMetadata: requested => {
        assert.equal(requested, id);
        calls++;
        return lookup.pending;
      },
    };
    let run;
    try {
      for (const invalidId of ["", "wrong-length", "!".repeat(22)]) {
        const invalid = await service.fetchSyncedLyrics({ ...input, spotifyTrackId: invalidId });
        assert.equal(invalid.statusMessage, "No active track.");
      }
      assert.equal(calls, 0);
      run = service.fetchSyncedLyrics(input);
      for (let turn = 0; turn < 100; turn++) await Promise.resolve();
      assert.equal(calls, 1);
      assert.ok(seen.some(([name, value]) => name === "spicy-lyrics" && value === id));
      assert.ok(!seen.some(([name]) => name === "netease" || name === "kugou" || name === "lrc-red-isrc"));
      lookup.resolve({ id, isrc, title: playback.title, artist: playback.artist, durationMs: playback.durationMs });
      await run;
      assert.ok(seen.some(([name, value]) => name === "qq-direct" && value === playback.title));
      assert.ok(seen.some(([name, value]) => name === "kugou" && value === isrc));
      assert.ok(seen.some(([name]) => name === "lrc-red-isrc"));
      assert.equal(calls, 1);
    } finally {
      lookup.resolve(null);
      await Promise.allSettled([run]);
      service.clearCache();
    }
  });

  test(`${platform}: standalone providers share one failure and preserve text fallback`, async () => {
    const ctx = load(mobile);
    const seen = observeProviders(ctx);
    for (const resolve of [
      async () => { throw new Error("unavailable"); },
      async () => ({ isrc: "invalid" }),
      async () => ({ spotifyTrackId: "other", isrc }),
    ]) {
      let calls = 0;
      const input = { ...playback, resolveTrackMetadata: () => { calls++; return resolve(); } };
      const start = seen.length;
      await Promise.all([ctx.fetchFromKugou(input), ctx.fetchFromLrcRed(input)]);
      assert.equal(calls, 1);
      assert.ok(seen.slice(start).some(([name]) => name === "catalog"));
      assert.ok(seen.slice(start).some(([name, value]) => name === "kugou" && value === ""));
      assert.ok(!seen.slice(start).some(([name]) => name === "lrc-red-isrc"));
    }

    const supplied = { ...playback, isrc, resolveTrackMetadata: () => assert.fail("supplied ISRC") };
    await Promise.all([ctx.fetchFromKugou(supplied), ctx.fetchFromLrcRed(supplied)]);
    assert.ok(seen.some(([name, value]) => name === "kugou" && value === isrc));
  });

  test(`${platform}: timed-out results cannot replace a fresh recording snapshot`, async () => {
    const ctx = load(mobile);
    observeProviders(ctx);
    const old = deferred();
    const timeout = vm.runInContext("KUGOU_TRACK_ISRC_TIMEOUT_MS", ctx);
    ctx.setTimeout = (fn, ms) => ms === timeout ? setTimeout(fn, 0) : setTimeout(fn, ms);
    const track = ctx.attachLyricsTrackMetadata({ ...playback, resolveTrackMetadata: () => old.pending });
    await Promise.all([ctx.fetchFromKugou(track), ctx.fetchFromLrcRed(track)]);
    const otherId = "0".repeat(22);
    const other = { ...track, spotifyTrackId: otherId, resolveTrackMetadata: async () => ({ id: otherId, isrc }) };
    const fresh = await ctx.resolveLyricsTrackMetadata(other, ["isrc"]);
    old.resolve({ id, isrc: "KRABC2000001" });
    assert.equal((await ctx.resolveLyricsTrackMetadata(track, ["isrc"])).isrc, "");
    assert.equal(fresh.isrc, isrc);
  });

  test(`${platform}: direct auto entry keeps vault and cache ahead of lazy metadata`, async () => {
    const ctx = load(mobile);
    const seen = observeProviders(ctx);
    const registry = vm.runInContext("SOURCE_FETCHERS", ctx);
    const vault = { source: "local-vault", lyrics: [{ text: "Vault", lineStartTime: 1000, lineEndTime: 2000 }] };
    registry["local-vault"] = async () => vault;
    let calls = 0;
    const input = { ...playback, resolveTrackMetadata: async () => { calls++; return { id, isrc }; } };
    assert.equal((await ctx.fetchBestSyncedLyrics(input)).source, "local-vault");
    registry["local-vault"] = async () => null;
    assert.equal(await ctx.fetchBestSyncedLyrics(input, { sourceCache: { get: key => key === "auto" ? vault : null } }), vault);
    assert.equal(calls, 0);
    await ctx.fetchBestSyncedLyrics(input, { waitForAutoCompletion: true });
    assert.equal(calls, 1);
    assert.ok(seen.some(([name, value]) => name === "kugou" && value === isrc));
    assert.ok(seen.some(([name]) => name === "lrc-red-isrc"));
  });

  test(`${platform}: Web API fallback accepts only the requested recording`, async () => {
    const ctx = load(mobile);
    let calls = 0;
    ctx.fetchSpotifyWebApiTrackById = async (requested, token) => {
      assert.equal(requested, id);
      assert.equal(token, "fixture-token");
      calls++;
      return { id: "other", external_ids: { isrc } };
    };
    const seen = observeProviders(ctx);
    const options = { spotifyAccessToken: "fixture-token" };
    const track = { ...playback };
    await Promise.all([ctx.fetchFromKugou(track, options), ctx.fetchFromLrcRed(track, options)]);
    assert.equal(calls, 1);
    assert.ok(!seen.some(([name]) => name === "lrc-red-isrc"));
    await ctx.fetchFromKugou({ ...track, resolveTrackMetadata: async () => undefined }, options);
    assert.equal(calls, 1);
  });

  test(`${platform}: service reads Spotify credentials only for missing metadata`, async () => {
    const ctx = load(mobile);
    const seen = observeProviders(ctx);
    let calls = 0;
    const service = ctx.createLyricsService({
      getSpotifyAccessToken: () => { calls++; return new Promise(() => {}); },
    });
    const timeout = vm.runInContext("KUGOU_TRACK_ISRC_TIMEOUT_MS", ctx);
    ctx.setTimeout = (fn, ms) => ms === timeout ? setTimeout(fn, 0) : setTimeout(fn, ms);
    try {
      await service.fetchSyncedLyrics(playback, { preferredSource: "netease" });
      assert.equal(calls, 0);
      assert.ok(seen.some(([name]) => name === "netease"));
      await service.fetchSyncedLyrics(playback, { preferredSource: "kugou" });
      assert.equal(calls, 1);
      assert.ok(seen.some(([name, value]) => name === "kugou" && value === ""));
    } finally {
      service.clearCache();
    }
  });

  test(`${platform}: service switches reuse metadata, force and identity changes renew it`, async () => {
    const ctx = load(mobile);
    observeProviders(ctx);
    const service = ctx.createLyricsService();
    let calls = 0;
    const track = { ...playback, resolveTrackMetadata: async () => { calls++; return { id, isrc }; } };
    try {
      await service.fetchSyncedLyrics(track, { preferredSource: "kugou" });
      await service.fetchSyncedLyrics({ ...track }, { preferredSource: "lrc-red" });
      assert.equal(calls, 1);
      await service.fetchSyncedLyrics(track, { preferredSource: "kugou", force: true });
      assert.equal(calls, 2);
      await service.fetchSyncedLyrics({ ...track, title: "Different (Live)" }, { preferredSource: "lrc-red" });
      assert.equal(calls, 3);
    } finally {
      service.clearCache();
    }
  });

  test(`${platform}: force isolates a service run from pending old metadata`, async () => {
    const ctx = load(mobile);
    const seen = observeProviders(ctx);
    const service = ctx.createLyricsService();
    const previous = deferred();
    const started = deferred();
    const oldIsrc = "KRABC2000001";
    let calls = 0;
    const track = { ...playback, resolveTrackMetadata: () => {
      if (++calls === 1) {
        started.resolve();
        return previous.pending;
      }
      return { id, isrc };
    } };
    const old = service.fetchSyncedLyrics(track, { preferredSource: "kugou" });
    try {
      await Promise.race([started.pending, old.then(() => assert.fail("old metadata never started"))]);
      await service.fetchSyncedLyrics(track, { preferredSource: "kugou", force: true });
      previous.resolve({ id, isrc: oldIsrc });
      await old;
      await service.fetchSyncedLyrics(track, { preferredSource: "lrc-red" });
      assert.equal(calls, 2);
      assert.ok(seen.some(([name, value]) => name === "lrc-red-isrc" && value.endsWith(`/${isrc}.json`)));
      assert.ok(!seen.some(([name, value]) => name === "lrc-red-isrc" && value.includes(oldIsrc)));
    } finally {
      previous.resolve(null);
      await Promise.allSettled([old]);
      service.clearCache();
    }
  });

}
