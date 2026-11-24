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
  trackId: "fixture", title: "Signal", artist: "Artist", durationMs: 10000,
  isrc: "USABC2000001", spotifyTrackId: "0".repeat(22),
};
const lineLrc = "[00:01.000]First line\n[00:08.000]Last line";
const yaml = `version: '1.0'
lines:
  - text: "one two"
    start_ms: 1000
    end_ms: 2000
    words:
      - {text: "one ", start_ms: 1000}
      - {text: two, start_ms: 1500}
`;
const record = { id: 1, trackName: track.title, artistName: track.artist, duration: 10 };
const word = { ...record, hasWordSync: true, lyricsfile: yaml };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";

  test(`${platform}: QQ memo shares in-flight and failed transport across route shapes`, async () => {
    const ctx = load(mobile);
    const release = deferred();
    const calls = [];
    ctx.fetch = async (url, options) => {
      assert.ok(options.signal);
      calls.push(url);
      await release.promise;
      return json({}, url.includes("bad") ? 500 : 200);
    };
    const endpoint = "https://fixture.invalid/qq";
    const operation = ctx.createQQRequestOperation();
    const direct = operation.anyJson([endpoint], { params: { q: "bad", p: 1 } });
    const mirror = operation.json(endpoint, { params: { p: 1, q: "bad" } });
    const other = Array.from({ length: 8 }, (_, index) =>
      operation.json(endpoint, { params: { q: index } }));
    const results = Promise.allSettled([direct, mirror, ...other]);
    assert.equal(calls.length, 6);
    release.resolve();
    const completed = await results;
    assert.deepEqual(completed.slice(0, 2).map(result => result.status), ["rejected", "rejected"]);
    await assert.rejects(operation.json(endpoint, { params: { q: "bad", p: 1 } }), /HTTP 500/);
    await operation.json(endpoint, { params: { q: 0 } });
    assert.equal(calls.length, 9);
    assert.equal(new Set(calls).size, 9);
    await assert.rejects(ctx.createQQRequestOperation().json(endpoint, { params: { q: "bad", p: 1 } }), /HTTP 500/);
    assert.equal(calls.length, 10);
  });

  test(`${platform}: QQ aborts six stalled text bodies and starts the seventh request`, async () => {
    const ctx = load(mobile);
    const timers = new Map();
    ctx.setTimeout = (callback, delay) => {
      const handle = Symbol("timer");
      timers.set(handle, { callback, delay });
      return handle;
    };
    ctx.clearTimeout = handle => timers.delete(handle);

    const bodyReads = [];
    const allBodiesStarted = deferred();
    const aborted = [];
    const requests = [];
    ctx.fetch = async (url, { signal }) => {
      const id = Number(new URL(url).searchParams.get("id"));
      requests.push(id);
      if (id === 6) return new Response("queued request completed");
      return {
        ok: true,
        text() {
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              aborted.push(id);
              reject(new DOMException("Aborted while reading the body", "AbortError"));
            }, { once: true });
            bodyReads.push(id);
            if (bodyReads.length === 6) allBodiesStarted.resolve();
          });
        },
      };
    };

    const operation = ctx.createQQRequestOperation();
    const pending = Array.from({ length: 7 }, (_, id) =>
      operation.text(`https://fixture.invalid/lyrics?id=${id}`, { timeoutMs: 100 }));
    const completed = Promise.allSettled(pending);
    await allBodiesStarted.promise;
    // Let fetchText-style finally blocks run before inspecting the active timers.
    await Promise.resolve();
    assert.deepEqual(requests, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(bodyReads, requests);
    assert.equal(timers.size, 6);
    for (const { callback, delay } of [...timers.values()]) {
      assert.equal(delay, 100);
      callback();
    }

    const outcomes = await completed;
    assert.deepEqual(aborted, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(requests, [0, 1, 2, 3, 4, 5, 6]);
    for (const outcome of outcomes.slice(0, 6)) {
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.reason.name, "AbortError");
    }
    assert.deepEqual(outcomes[6], { status: "fulfilled", value: "queued request completed" });
    assert.equal(timers.size, 0);
  });

  test(`${platform}: verified native Mayday alias reaches QRC without legacy download`, async () => {
    const ctx = load(mobile);
    const mayday = {
      ...track, title: "Mayday (Feat. Joy)", artist: "Crush, JOY", artists: ["Crush", "JOY"],
      durationMs: 199267, isrc: "KRMIM2011544",
    };
    const calls = [];
    ctx.fetch = async (input, options) => {
      const url = new URL(input);
      calls.push([input, options.body]);
      if (url.hostname === "mobileservice.kugou.com") return json({ data: { info: [{
        hash: "fixture-hash", songname: "자나깨나", singername: "Crush、JOY", duration: 199,
        filename: "Crush、JOY - 자나깨나 (Mayday)", trans_param: { songname_suffix: "(Mayday)" },
      }] } });
      if (url.pathname.endsWith("musicu.fcg")) {
        const body = JSON.parse(options.body);
        if (body.req_1) return json({ req_1: { data: { lyric: "[1000,2000]one(1000,1000) two(2000,1000)\n[185000,1000]last(185000,1000)" } } });
        const key = "music.search.SearchCgiService";
        const rows = body[key].param.query.startsWith("자나깨나")
          ? [{ mid: "fixture-mid", name: "자나깨나", interval: 199, singer: [{ name: "Crush" }, { name: "JOY" }] }] : [];
        return json({ [key]: { data: { song: { list: rows } } } });
      }
      return json({}, 500);
    };
    assert.equal((await ctx.fetchFromQQ(mayday))?.source, "qq-musicu-qrc");
    assert.ok(calls.every(([url]) => !/lyric_download/.test(url)));
    assert.equal(new Set(calls.map(call => JSON.stringify(call))).size, calls.length);
  });

  for (const firstCatalog of ["desktop", "legacy"]) {
    test(`${platform}: a conflicting legacy ISRC rejects the shared QQ alias MID with ${firstCatalog} arriving first`, async () => {
      const ctx = load(mobile);
      const row = {
        mid: "fixture-mid", name: "자나깨나", interval: 199, isrc: "KRMIM2011544",
        singer: [{ name: "Crush" }, { name: "JOY" }],
      };
      const mayday = {
        ...track, title: "Mayday (Feat. Joy)", artist: "Crush, JOY", artists: ["Crush", "JOY"],
        durationMs: 199267, isrc: row.isrc,
      };
      ctx.resolveVerifiedRecordingAliases = async () => [{ title: row.name }];
      const catalogResponses = [];
      let lyricProbes = 0;
      async function catalogRows(catalog, rows, payload) {
        if (rows.length) {
          if (catalog !== firstCatalog) await new Promise(resolve => setImmediate(resolve));
          catalogResponses.push(catalog);
        }
        return json(payload);
      }
      ctx.fetch = async (input, options) => {
        const url = new URL(input);
        if (url.pathname.endsWith("musicu.fcg")) {
          const body = JSON.parse(options.body);
          if (body.req_1) {
            lyricProbes++;
            return json({ req_1: { data: { lyric: "[1000,2000]one(1000,1000) two(2000,1000)" } } });
          }
          const key = "music.search.SearchCgiService";
          const rows = body[key].param.query === `${row.name} Crush` ? [row] : [];
          return catalogRows("desktop", rows, { [key]: { data: { song: { list: rows } } } });
        }
        if (url.pathname.includes("/soso/")) {
          const rows = url.hostname === "c.y.qq.com" && url.pathname.endsWith("client_search_cp") &&
            url.searchParams.get("w") === `${row.name} Crush`
            ? [{ ...row, isrc: "USABC2000002" }] : [];
          return catalogRows("legacy", rows, { data: { song: { list: rows } } });
        }
        lyricProbes++;
        return json({}, 404);
      };

      const result = await ctx.fetchQQRecordingAliasLyrics(mayday, {}, ctx.createQQRequestOperation());
      assert.deepEqual(catalogResponses, [firstCatalog, firstCatalog === "desktop" ? "legacy" : "desktop"]);
      assert.equal(result, null);
      assert.equal(lyricProbes, 0);
    });
  }

  test(`${platform}: LRCLIB joins all canonical requests before applying baseline global ranking`, async () => {
    for (const [route, later, expected] of [
      ["get", { ...word, id: 390, syncedLyrics: lineLrc }, "lrclib-word"],
      ["later-search", { ...word, id: 390, syncedLyrics: lineLrc }, "lrclib-word"],
      ["later-search", { ...record, id: 390, syncedLyrics: lineLrc, instrumental: true }, "lrclib-instrumental"],
    ]) {
      const ctx = load(mobile);
      const requests = [];
      const release = deferred();
      const allStarted = deferred();
      ctx.fetch = async input => {
        const url = new URL(input);
        assert.equal(url.hostname, "lrclib.net");
        requests.push(input);
        if (requests.length === 4) allStarted.resolve();
        if (url.pathname === "/api/get") {
          await release.promise;
          return route === "get" ? json(later) : json({}, 404);
        }
        if (url.searchParams.has("q")) {
          await release.promise;
          return json(route === "later-search" ? [later] : []);
        }
        return json(url.searchParams.has("artist_name")
          ? [{ ...word, id: 4691533, syncedLyrics: lineLrc }] : []);
      };
      const result = ctx.fetchFromLrcLib(track);
      try {
        assert.equal(await Promise.race([allStarted.promise.then(() => true), result.then(() => false)]), true);
        assert.equal(new Set(requests).size, 4);
      } finally {
        release.resolve();
      }
      const packet = await result;
      assert.equal(packet?.source, expected);
      if (expected === "lrclib-word") assert.equal(packet.metadata.matchedTrack.id, 390);
      else assert.equal(packet.metadata.instrumental, true);
    }
  });

  test(`${platform}: LRCLIB fallback preserves word, line and instrumental outcomes`, async () => {
    for (const [first, later, source] of [
      [{ ...record, plainLyrics: "Plain" }, { ...word, id: 2, syncedLyrics: lineLrc }, "lrclib-word"],
      [{ ...word, lyricsfile: "lines: [", syncedLyrics: lineLrc }, null, "lrclib-fallback"],
      [{ ...record, id: 2, syncedLyrics: lineLrc }, { ...word, syncedLyrics: lineLrc }, "lrclib-word"],
      [{ ...word, syncedLyrics: lineLrc, instrumental: true }, null, "lrclib-instrumental"],
      [null, word, "lrclib-word"],
    ]) {
      const ctx = load(mobile);
      let calls = 0;
      ctx.fetch = async input => {
        const url = new URL(input);
        assert.equal(url.hostname, "lrclib.net");
        calls++;
        if (url.pathname === "/api/search" && url.searchParams.has("artist_name")) {
          if (!first) throw new Error("Offline");
          return json([first]);
        }
        return later && url.pathname === "/api/get" ? json(later)
          : url.pathname === "/api/get" ? json({}, 404) : json([]);
      };
      assert.equal((await ctx.fetchFromLrcLib(track))?.source, source);
      assert.ok(calls > 1);
    }
  });

  test(`${platform}: LRCLIB empty fallback responses do not hide a transport failure`, async () => {
    const ctx = load(mobile);
    ctx.fetch = async input => {
      if (new URL(input).pathname === "/api/get") throw new Error("Catalog offline");
      return json([]);
    };
    await assert.rejects(ctx.fetchFromLrcLib(track), /Catalog offline/);
  });

  test(`${platform}: Spicy backend miss permits a warm auto decision, network errors retry`, async () => {
    for (const failure of ["not-found", "network", "rate-limit", "invalid-payload"]) {
      const permanent = failure === "not-found";
      const ctx = load(mobile);
      let requests = 0;
      const fetchers = vm.runInContext("SOURCE_FETCHERS", ctx);
      for (const source of Object.keys(fetchers)) {
        if (source !== "spicy-lyrics") fetchers[source] = async () => null;
      }
      fetchers.kugou = async () => ({ source: "kugou-krc", lyrics: [{
        lineStartTime: 1000, lineEndTime: 9000,
        syllables: [{ text: "Fixture", startTime: 1000, endTime: 9000 }],
      }] });
      ctx.fetch = async url => {
        assert.match(url, /spicylyrics\.org/);
        requests++;
        if (failure === "network") throw new Error("Offline");
        if (failure === "rate-limit") return json({}, 429);
        if (failure === "invalid-payload") return json({ Status: 200, Body: {} });
        return json({}, 404);
      };
      const sourceCache = new Map();
      const options = { sourceCache, waitForAutoCompletion: true, spicyLyricsPublishableKey: "sl_pk_fixture" };
      assert.equal((await ctx.fetchBestSyncedLyrics(track, options)).source, "kugou-krc");
      assert.equal(sourceCache.has("auto"), permanent);
      assert.equal((await ctx.fetchBestSyncedLyrics(track, options)).source, "kugou-krc");
      assert.equal(requests, permanent ? 1 : 2);
    }
  });

  test(`${platform}: Kugou starts raw search before enrichment and supplements it with a native match`, async () => {
    const ctx = load(mobile);
    const raw = deferred();
    const metadata = deferred();
    const native = deferred();
    const nativeStarted = deferred();
    const queries = [];
    const probes = [];
    ctx.fetch = async input => {
      const url = new URL(input);
      if (url.hostname === "api.deezer.com") { nativeStarted.resolve(); return native.promise; }
      assert.equal(url.hostname, "mobileservice.kugou.com");
      const query = url.searchParams.get("keyword");
      queries.push(query);
      if (query === "Signal Artist") raw.resolve();
      const rows = query.startsWith("신호") ? [
        { hash: "wrong", songname: "신호 (Live)", singername: "Artist", duration: 10 },
        { hash: "right", songname: "신호", singername: "Artist", duration: 10 },
      ] : [];
      return json({ data: { info: rows } });
    };
    ctx.fetchKugouKaraokeLyricsForSong = async (_track, song) => {
      probes.push(song.hash);
      return { lyrics: [{}], source: "kugou-krc", coverage: 1, coverageRatio: 1 };
    };
    let metadataCalls = 0;
    const input = Object.freeze({ ...track, isrc: "", resolveTrackMetadata: () => {
      metadataCalls++;
      return metadata.promise;
    } });
    const result = ctx.fetchFromKugou(input);
    const concurrentMetadata = ctx.resolveLyricsTrackMetadata(input, ["isrc"]);
    await raw.promise;
    metadata.resolve({ id: track.spotifyTrackId, isrc: track.isrc });
    await nativeStarted.promise;
    native.resolve(json({ title: "신호" }));
    assert.equal((await result)?.source, "kugou-krc");
    assert.deepEqual(probes, ["right"]);
    assert.equal((await concurrentMetadata).isrc, track.isrc);
    assert.equal(metadataCalls, 1);
    assert.equal(input.isrc, "");
    assert.equal(queries.filter(query => query === "Signal Artist").length, 1);
  });

  const lineTtml = '<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="1s" end="8s">Fixture</p></body></tt>';
  const wordTtml = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:lrc="https://lrc.red" lrc:timing="Word"><body><p begin="1s" end="8s"><span begin="1s" end="4s">First </span><span begin="4s" end="8s">last</span></p></body></tt>';

  test(`${platform}: lrc.red keeps direct ISRC precedence and validates duration and TTML evidence`, async () => {
    const mayday = { ...track, title: "Mayday (Feat. Joy)", artist: "Crush, JOY",
      durationMs: 199267, isrc: "KRMIM2011544" };
    const direct = { isrc: mayday.isrc, title: "자나깨나 (feat. 조이)", artist: "Crush", duration: 199.217 };
    const conflictingTtml = lineTtml.replace("<body>",
      '<head><metadata xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><ttm:title>Unrelated Song</ttm:title></metadata></head><body>');
    for (const [recording, ttml, expected, readsTtml] of [
      [direct, wordTtml, "lrc-red-karaoke", true],
      [direct, lineTtml, "lrc-red-line", true],
      [{ ...direct, title: "Different Catalog Title" }, lineTtml, "lrc-red-line", true],
      [{ ...direct, isrc: track.isrc }, lineTtml, null, false],
      [{ ...direct, duration: 240 }, lineTtml, null, false],
      [direct, conflictingTtml, null, true],
    ]) {
      const ctx = load(mobile);
      const calls = [];
      ctx.fetch = async input => {
        const url = new URL(input);
        calls.push(url.pathname);
        if (url.pathname === "/search.json") return json({ hits: [] });
        if (url.pathname === "/search") return json({ data: [] });
        if (url.pathname.endsWith(".json")) return json(recording);
        return new Response(ttml);
      };
      const result = await ctx.fetchFromLrcRed(mayday);
      assert.equal(result?.source ?? null, expected);
      assert.equal(calls.includes(`/s/${mayday.isrc}.ttml`), readsTtml);
      assert.equal(calls.includes("/search.json"), expected !== "lrc-red-karaoke");
      if (expected === "lrc-red-karaoke") {
        assert.deepEqual(calls, [`/s/${mayday.isrc}.json`, `/s/${mayday.isrc}.ttml`]);
      }
    }
  });

  test(`${platform}: lrc.red keeps a line-to-karaoke upgrade from a guarded catalog match`, async () => {
    const ctx = load(mobile);
    const upgradeIsrc = "USABC2000002";
    const hit = { title: track.title, artist: track.artist, duration: 10 };
    const calls = [];
    ctx.fetch = async input => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.hostname === "api.deezer.com") {
        return json({ data: [{ ...hit, artist: { name: track.artist }, isrc: track.isrc }] });
      }
      if (url.pathname === "/search.json") return json({ hits: [{ ...hit, isrc: upgradeIsrc }] });
      if (url.pathname.endsWith(".json")) return json(hit);
      return new Response(url.pathname.includes(upgradeIsrc) ? wordTtml : lineTtml);
    };
    const result = await ctx.fetchFromLrcRed({ ...track, isrc: "" });
    assert.equal(result?.source, "lrc-red-karaoke");
    assert.deepEqual(calls, [
      "/search", `/s/${track.isrc}.json`, `/s/${track.isrc}.ttml`,
      "/search.json", `/s/${upgradeIsrc}.json`, `/s/${upgradeIsrc}.ttml`,
    ]);
  });
}
