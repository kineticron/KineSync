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

const track = {
  title: "Mayday (Feat. Joy)", artist: "Crush, JOY", artists: ["Crush", "JOY"],
  durationMs: 199267, isrc: "KRMIM2011544", spotifyTrackId: "37cXQzQaHR7zMk8G360Vke",
};
const catalog = {
  hash: "fixture-hash", songname: "자나깨나", trans_param: { songname_suffix: "(Mayday)" },
  filename: "Crush、JOY - 자나깨나 (Mayday)", singername: "Crush、JOY", duration: 199,
};
const qqSong = {
  mid: "fixture-mid", name: "자나깨나", interval: 199, singer: [{ name: "Crush" }, { name: "JOY" }],
};

function stubCatalog(ctx, { rows = [catalog], songs = [qqSong] } = {}) {
  const catalogQueries = [];
  const qqQueries = [];
  const probes = [];
  let deezerCalls = 0;
  ctx.fetchJson = async url => {
    assert.match(url, /api\.deezer\.com\/track\/isrc:/);
    deezerCalls++;
    return { title: track.title, isrc: track.isrc };
  };
  ctx.searchKugouSongs = async query => {
    catalogQueries.push(query.toLowerCase());
    return { data: { info: query.toLowerCase() === "mayday crush" ? rows : [] } };
  };
  ctx.searchKugouLyricCandidates = async () => [];
  ctx.fetchQQDesktopSearchSongs = async query => {
    qqQueries.push(query);
    return songs.filter(song => query.startsWith(song.name.split(" (")[0]));
  };
  ctx.collectQQSongsFromLegacyClientSearch = async () => [];
  ctx.resolveQQLegacyDownloadFallback = async () => null;
  ctx.fetchFromQQMirror = async () => null;
  ctx.fetchFromQQMeting = async () => null;
  ctx.probeQQDirectCandidate = async (_track, candidate, accessors) => {
    probes.push(candidate.song.mid);
    return {
      selection: {
        title: accessors.getSongTitle(candidate.song),
        artist: accessors.getSongArtist(candidate.song),
        durationMs: 199000,
        searchScore: candidate.score,
      },
      karaokeResult: {
        lyrics: [{ text: "Fixture", lineStartTime: 1000, lineEndTime: 2000 }],
        coverage: 1, coverageRatio: 1,
      },
    };
  };
  return { catalogQueries, qqQueries, probes, get deezerCalls() { return deezerCalls; } };
}

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";
  test(`${platform}: standalone QQ discovers a verified alias without Kugou lyrics`, async () => {
    const ctx = load(mobile);
    const seen = stubCatalog(ctx, { songs: [
      { ...qqSong, mid: "instrumental", name: "자나깨나 (纯音乐)" },
      { ...qqSong, mid: "relinked", spotifyTrackId: "0".repeat(22) },
      { ...qqSong, mid: "wrong-isrc", isrc: "USABC2000001" },
      { ...qqSong, mid: "missing-feature", singer: [{ name: "Crush" }] },
      { ...qqSong, mid: "wrong-duration", interval: 220 },
      qqSong,
    ] });
    let lyricSearches = 0;
    ctx.searchKugouLyricCandidates = async () => { lyricSearches++; return []; };
    assert.equal((await ctx.fetchFromQQ({ ...track })).source, "qq-musicu-qrc");
    assert.match(seen.qqQueries[0], /^Mayday \(Feat\. Joy\)/);
    assert.ok(seen.qqQueries.some(query => query.startsWith("자나깨나")));
    assert.deepEqual(seen.probes, [qqSong.mid]);
    assert.equal(seen.deezerCalls, 0);
    assert.equal(lyricSearches, 0);
  });

  test(`${platform}: complete inputs and snapshot spreads share catalog searches with Kugou`, async () => {
    const ctx = load(mobile);
    const seen = stubCatalog(ctx);
    const input = { ...track };
    const snapshot = await ctx.resolveLyricsTrackMetadata(input, ["title"]);
    assert.equal(await ctx.resolveLyricsTrackMetadata(input, ["title"]), snapshot);
    const kugouProbes = [];
    ctx.fetchKugouKaraokeLyricsForSong = async (_track, song) => {
      kugouProbes.push(song.hash);
      return {
        lyrics: [{ text: "Fixture", lineStartTime: 1000, lineEndTime: 2000 }],
        source: "kugou-krc", coverage: 1, coverageRatio: 1,
      };
    };
    const [kugou, first, second] = await Promise.all([
      ctx.fetchFromKugou(input),
      ctx.fetchFromQQ(input),
      ctx.fetchFromQQ({ ...snapshot }),
    ]);
    assert.equal(kugou.source, "kugou-krc");
    assert.deepEqual(kugouProbes, [catalog.hash]);
    assert.equal(first.source, "qq-musicu-qrc");
    assert.equal(second.source, first.source);
    assert.equal(seen.deezerCalls, 1);
    assert.equal(seen.catalogQueries.filter(query => query === "mayday crush").length, 1);
    assert.equal(new Set(seen.catalogQueries).size, seen.catalogQueries.length);
  });

  test(`${platform}: concurrent standalone QQ misses share missing identity metadata`, async () => {
    const ctx = load(mobile);
    const seen = stubCatalog(ctx);
    let metadataCalls = 0;
    const input = {
      ...track, isrc: "",
      resolveTrackMetadata: async () => {
        metadataCalls++;
        return { id: track.spotifyTrackId, isrc: track.isrc };
      },
    };
    const results = await Promise.all([ctx.fetchFromQQ(input), ctx.fetchFromQQ(input)]);
    assert.ok(results.every(result => result?.source === "qq-musicu-qrc"));
    assert.equal(metadataCalls, 1);
    assert.equal(seen.catalogQueries.filter(query => query === "mayday crush").length, 1);
  });

  test(`${platform}: English QQ succeeds while another track is waiting for aliases`, async () => {
    const ctx = load(mobile);
    const seen = stubCatalog(ctx);
    let finish;
    let started;
    const blocked = new Promise(resolve => { finish = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    ctx.searchKugouSongs = async () => { started(); return blocked; };
    const waiting = ctx.fetchFromQQ(track);
    try {
      await ready;
      const other = { ...track, title: "Second Song", spotifyTrackId: "0".repeat(22) };
      ctx.fetchQQDesktopSearchSongs = async query => query.startsWith(other.title)
        ? [{ ...qqSong, name: other.title }] : [];
      assert.equal((await ctx.fetchFromQQ(other)).source, "qq-musicu-qrc");
      let neteaseQueries = 0;
      ctx.fetchNeteaseSearchJson = async () => { neteaseQueries++; return {}; };
      await ctx.fetchFromNetease(other);
      assert.ok(neteaseQueries > 0);
      assert.deepEqual(seen.probes, [qqSong.mid]);
    } finally {
      finish({ data: { info: [] } });
      await waiting;
    }
  });

  test(`${platform}: insufficient and conflicting catalog evidence cannot publish aliases`, async () => {
    for (const rows of [
      [{ ...catalog, isrc: "USABC2000001" }],
      [{ ...catalog, spotifyTrackId: "0".repeat(22) }],
      [{ ...catalog, singername: "Crush、Other" }],
      [{ ...catalog, singername: "Crush" }],
      [{ ...catalog, singername: "" }],
      [{ ...catalog, duration: 0 }],
      [{ ...catalog, duration: 210 }],
      [{ ...catalog, songname: "자나깨나 Instrumental" }],
      [{ ...catalog, trans_param: {}, songname_suffix: "(Mayday) (Live)" }],
      [{ ...catalog, trans_param: {}, songname_suffix: "(Mayday) (Feat. Other)" }],
      [{ ...catalog, trans_param: {}, songname_suffix: "(Mayday) (English Version)" }],
      [{ ...catalog, filename: "Crush、JOY - 자나깨나", trans_param: {} }],
      [catalog, { ...catalog, hash: "other", songname: "다른 노래", filename: "" }],
    ]) {
      const ctx = load(mobile);
      const seen = stubCatalog(ctx, { rows });
      assert.equal(await ctx.fetchFromQQ({ ...track, nativeTitle: qqSong.name, aliases: [qqSong.name] }), null);
      assert.ok(seen.qqQueries.every(query => !query.startsWith(qqSong.name)));
      assert.deepEqual(seen.probes, []);
    }
  });

  test(`${platform}: matching top-level IDs cannot mask conflicting nested IDs`, async () => {
    const maskedIsrc = { isrc: track.isrc, external_ids: { isrc: "USABC2000001" } };
    const maskedSpotify = {
      spotifyTrackId: track.spotifyTrackId,
      metadata: { fetchOrigin: { spotifyTrackId: "0".repeat(22) } },
    };
    for (const conflict of [maskedIsrc, maskedSpotify]) {
      const kugouContext = load(mobile);
      const kugouSeen = stubCatalog(kugouContext, { rows: [{ ...catalog, ...conflict }] });
      assert.equal(await kugouContext.fetchFromQQ({ ...track }), null);
      assert.ok(kugouSeen.qqQueries.every(query => !query.startsWith(qqSong.name)));

      const qqContext = load(mobile);
      const qqSeen = stubCatalog(qqContext, { songs: [{ ...qqSong, ...conflict }] });
      assert.equal(await qqContext.fetchFromQQ({ ...track }), null);
      assert.deepEqual(qqSeen.probes, []);
    }
  });

  test(`${platform}: contradictory Kugou query responses invalidate their shared hash in both orders`, async () => {
    for (const conflict of [
      { songname: "다른 노래", filename: "" },
      { singername: "Crush、Other" },
      { songname: "자나깨나 (Live)" },
      { duration: 200 },
      { external_ids: { isrc: "USABC2000001" } },
    ]) {
      for (const conflictFirst of [false, true]) {
        const ctx = load(mobile);
        const seen = stubCatalog(ctx);
        const conflicting = { ...catalog, ...conflict };
        const responses = new Map([
          ["mayday crush", conflictFirst ? conflicting : catalog],
          ["mayday", conflictFirst ? catalog : conflicting],
        ]);
        ctx.searchKugouSongs = async query => {
          const key = query.toLowerCase();
          seen.catalogQueries.push(key);
          return { data: { info: responses.has(key) ? [responses.get(key)] : [] } };
        };
        assert.equal(await ctx.fetchFromQQ({ ...track }), null);
        assert.ok([...responses.keys()].every(query => seen.catalogQueries.includes(query)));
        assert.ok(seen.qqQueries.every(query => !query.startsWith(qqSong.name)));
      }
    }
  });

  test(`${platform}: contradictory QQ query responses invalidate only their shared MID in both orders`, async () => {
    for (const conflict of [
      { name: "다른 노래" },
      { singer: [{ name: "Crush" }] },
      { name: "자나깨나 (纯音乐)" },
      { interval: 200 },
      { metadata: { spotifyTrackId: "0".repeat(22) } },
    ]) {
      for (const conflictFirst of [false, true]) {
        const ctx = load(mobile);
        const seen = stubCatalog(ctx);
        const conflicting = { ...qqSong, ...conflict };
        const responses = new Map([
          [`${qqSong.name} Crush`, [conflictFirst ? conflicting : qqSong]],
          [`${qqSong.name} Crush, JOY`, [
            conflictFirst ? qqSong : conflicting,
            { ...qqSong, mid: "independent" },
          ]],
        ]);
        ctx.fetchQQDesktopSearchSongs = async query => {
          seen.qqQueries.push(query);
          return responses.get(query) || [];
        };
        assert.equal((await ctx.fetchFromQQ({ ...track })).source, "qq-musicu-qrc");
        assert.ok([...responses.keys()].every(query => seen.qqQueries.includes(query)));
        assert.deepEqual(seen.probes, ["independent"]);
      }
    }
  });

  test(`${platform}: alias ownership follows recording inputs and rejects relinked enrichment`, async () => {
    const ctx = load(mobile);
    const seen = stubCatalog(ctx);
    const input = { ...track, artists: [...track.artists] };
    const snapshot = await ctx.resolveLyricsTrackMetadata(input, ["title"]);
    assert.equal((await ctx.fetchFromQQ(input)).source, "qq-musicu-qrc");
    input.artists.push("Other");
    assert.equal(await ctx.fetchFromQQ(input), null);
    assert.equal(await ctx.fetchFromQQ({ ...snapshot, durationMs: 220000 }), null);
    assert.equal(await ctx.fetchFromQQ({
      ...track, isrc: "", resolveTrackMetadata: async () => ({ id: "0".repeat(22), isrc: track.isrc }),
    }), null);
    assert.deepEqual(seen.probes, [qqSong.mid]);
  });

  test(`${platform}: a filename links a non-Korean alternate title`, async () => {
    const ctx = load(mobile);
    stubCatalog(ctx, {
      rows: [{ ...catalog, songname: "夜の灯", trans_param: {}, filename: "Crush、JOY - 夜の灯 (Mayday)" }],
      songs: [{ ...qqSong, name: "夜の灯" }],
    });
    assert.equal((await ctx.fetchFromQQ({ ...track })).source, "qq-musicu-qrc");
  });
}
