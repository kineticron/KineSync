"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");
const policy = require("../src/lyricsPolicy");

const src = path.resolve(__dirname, "../src");
const mobileFile = path.resolve(src, "../../ExpoLyrics/lib/mobile-lyrics-service.js");
const TTML = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="1s">Hello</p></div></body></tt>';

function load(mobile, fetch) {
  const module = { exports: {} };
  const context = vm.createContext({
    AbortController, Buffer, clearTimeout, setTimeout, clearInterval, setInterval,
    TextDecoder, URL, URLSearchParams, console, fetch, global: {}, module,
    exports: module.exports, process: { env: {} },
    require: createRequire(path.join(src, "lyricsService.js")),
  });
  if (mobile) {
    let source = fs.readFileSync(mobileFile, "utf8").replace(/^import .*;\r?\n/gm, "");
    source = source.slice(0, source.indexOf("export {"));
    vm.runInContext(source, context);
    const ttml = require("../src/lyricsTtmlImport");
    context.parseLrcRedTtml = ttml.parseTtmlToLyrics;
    context.parseLrcRedTime = ttml.parseTtmlTimeExpression;
    context.extractLrcRedTtmlMetadata = ttml.extractTtmlMetadata;
  } else {
    const index = fs.readFileSync(path.join(src, "lyrics/index.js"), "utf8");
    for (const match of index.match(/const partFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)) {
      vm.runInContext(fs.readFileSync(path.join(src, "lyrics/parts", match[1]), "utf8"), context);
    }
  }
  return context;
}

function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const result = await handler(String(url), calls.length);
    if (result === undefined) return new Response("missing", { status: 404 });
    return new Response(result.body, { status: result.status || 200, headers: { "content-type": result.type || "application/json" } });
  };
  return { fetch, calls };
}

async function runExport(mobile, handler, track) {
  const net = fakeFetch(handler);
  const context = load(mobile, net.fetch);
  context.track = track;
  const result = await vm.runInContext("fetchLrcRedExportLyrics(track)", context);
  return { result, calls: net.calls };
}

const track = { title: "Rewind", artist: "Wonder Girls", durationMs: 213000, spotifyTrackId: "1QV6tiMFM6fSOKOGLMHYYg" };
const isrc = "US5TA1500050";

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";

  test(`${label} policy blocks relabeled Spicy but keeps independent lrc.red exportable`, () => {
    assert.equal(policy.isSpicyLyricsResponse({ originalSource: "lrc-red-karaoke", metadata: { spicyApi: { fetchedAt: 1, expiresAt: 2 } } }), true);
    assert.equal(policy.isSpicyLyricsResponse({ originalSource: "lrc-red-karaoke", metadata: { fetchOrigin: { host: "api.spicylyrics.org" } } }), true);
    assert.equal(policy.isSpicyLyricsResponse({ originalSource: "lrc-red-karaoke", metadata: { attribution: { provider: "lrc.red", source: "lrc-red" } } }), false);
    assert.equal(policy.isSpicyLyricsResponse({ originalSource: "local-vault-line", source: "lrc-red-karaoke", metadata: { vault: { originalSource: "spicy-lyrics-syllable" } } }), true, 'nested Spicy labels cannot be masked');
    assert.equal(policy.isSpicyLyricsResponse({ originalSource: "spicy-lyrics-syllable", sourceLabel: "lrc-red-karaoke", metadata: { vault: { originalSource: "lrc-red-karaoke" } } }), true, 'direct Spicy labels cannot be masked');
    assert.throws(() => policy.assertLyricsExportAllowed({ metadata: { fetchOrigin: { host: "api.spicylyrics.org" } } }), /cannot be exported/);
    policy.assertLyricsExportAllowed({ metadata: { attribution: { provider: "lrc.red", source: "lrc-red" } } });
  });

  test(`${label} direct ISRC fetches JSON then TTML and accepts line timing`, async () => {
    const { result, calls } = await runExport(mobile, (url) => {
      if (url.includes("/s/US5TA1500050.json")) return { body: JSON.stringify({ title: "Rewind", duration: 213, artist: "Wonder Girls" }) };
      if (url.includes("/s/US5TA1500050.ttml")) return { body: TTML, type: "application/xml" };
    }, { ...track, isrc });
    assert.equal(result.source, "lrc-red-line");
    assert.deepEqual(calls.map(call => call.url), [
      "https://lrc.red/s/US5TA1500050.json",
      "https://lrc.red/s/US5TA1500050.ttml",
    ]);
    assert.equal(result.metadata.ttml.content, TTML);
    assert.equal(calls[0].options.headers["User-Agent"].includes("kineticrondev@gmail.com"), true);
  });

  test(`${label} remaster years are compared before suffix stripping`, async () => {
    for (const candidate of ["Song (2010 Remaster)", "Song (2020 Remaster)"]) {
      const { result, calls } = await runExport(mobile, (url) => {
        if (url.endsWith(".json")) return { body: JSON.stringify({ title: "Song (2020 Remaster)", duration: 213, artist: "Artist" }) };
        if (url.includes("search.json")) return { body: JSON.stringify({ hits: [] }) };
      }, { title: "Song (2010 Remaster)", artist: "Artist", durationMs: 213000, isrc });
      assert.equal(result, null, candidate);
      assert.ok(!calls.some(call => call.url.endsWith(".ttml")));
    }
  });

  test(`${label} direct ISRC accepts localized artist but rejects wrong title or duration and falls back to search`, async () => {
    const localized = await runExport(mobile, (url) => {
      if (url.endsWith(".json")) return { body: JSON.stringify({ title: "Rewind", duration: 213, artist: "ريويند" }) };
      if (url.endsWith(".ttml")) return { body: TTML, type: "application/xml" };
    }, { ...track, isrc });
    assert.equal(localized.result.source, "lrc-red-line");

    for (const recording of [{ title: "Rewind Again", duration: 213 }, { title: "Rewind", duration: 260 }]) {
      const { result, calls } = await runExport(mobile, (url) => {
        if (url.includes("/s/US5TA1500050.json")) return { body: JSON.stringify(recording) };
        if (url.includes("search.json")) return { body: JSON.stringify({ hits: [] }) };
      }, { ...track, isrc });
      assert.equal(result, null);
      assert.ok(calls.some(call => call.url.includes("search.json")), "a direct mismatch must reach search");
      assert.ok(!calls.some(call => call.url.endsWith(".ttml")), "no wrong-song TTML fetch");
    }
  });

  test(`${label} invalid or missing ISRC never becomes an lrc.red path`, async () => {
    const { result, calls } = await runExport(mobile, (url) => {
      if (url.includes("search.json")) return { body: JSON.stringify({ hits: [] }) };
    }, { ...track, isrc: "1QV6tiMFM6fSOKOGLMHYYg" });
    assert.equal(result, null);
    assert.ok(!calls.some(call => call.url.includes("/s/")));
    assert.ok(calls.some(call => call.url.includes("search.json")));
  });

  test(`${label} search requires exact primary artist, safe title and duration`, async () => {
    const cases = [
      { isrc, artist: "Wonder Girls", title: "Rewind", duration: 213, ok: true },
      { isrc, artist: "Someone Else", title: "Rewind", duration: 213, ok: false },
      { isrc, artist: "Wonder Girls Tribute", title: "Rewind", duration: 213, ok: false },
      { isrc, artist: "Wonder Girls", title: "Rewind Again", duration: 213, ok: false },
      { isrc, artist: "Wonder Girls", title: "Rewind", duration: 260, ok: false },
    ];
    for (const item of cases) {
      const { result, calls } = await runExport(mobile, (url) => {
        if (url.includes("search.json")) return { body: JSON.stringify({ hits: [item] }) };
        if (url.endsWith(".ttml")) return { body: TTML, type: "application/xml" };
      }, { ...track });
      if (item.ok) assert.equal(result.source, "lrc-red-line");
      else {
        assert.equal(result, null);
        assert.ok(!calls.some(call => call.url.endsWith(".ttml")), "wrong candidate must not fetch TTML");
      }
    }
  });

  test(`${label} search tries title-only after title and artist miss`, async () => {
    const queries = [];
    const { result } = await runExport(mobile, (url) => {
      if (url.includes("search.json")) {
        const q = new URL(url).searchParams.get("q");
        queries.push(q);
        return { body: JSON.stringify({ hits: q === "Rewind" ? [{ isrc, title: "Rewind", duration: 213, artist: "Wonder Girls" }] : [] }) };
      }
      if (url.endsWith(".ttml")) return { body: TTML, type: "application/xml" };
    }, { ...track });
    assert.equal(result.source, "lrc-red-line");
    assert.deepEqual(queries, ["Rewind Wonder Girls", "Rewind"]);
  });

  test(`${label} ambiguous search candidates fail closed`, async () => {
    const { result, calls } = await runExport(mobile, (url) => {
      if (url.includes("search.json")) return { body: JSON.stringify({ hits: [
        { isrc: "US5TA1500050", title: "Rewind", duration: 213, artist: "Wonder Girls" },
        { isrc: "US5TA1500051", title: "Rewind", duration: 213, artist: "Wonder Girls" },
      ] }) };
      if (url.endsWith(".ttml")) return { body: TTML, type: "application/xml" };
    }, { ...track });
    assert.equal(result, null);
    assert.ok(!calls.some(call => call.url.endsWith(".ttml")));
  });

  test(`${label} TTML without optional duration is accepted after verified JSON`, async () => {
    const { result } = await runExport(mobile,
(url) => {
      if (url.endsWith(".json")) return { body: JSON.stringify({ title: "Rewind", duration: 213, artist: "Wonder Girls" }) };
      if (url.endsWith(".ttml")) return { body: TTML, type: "application/xml" };
    }, { ...track, isrc });
    assert.equal(result.source, "lrc-red-line");
  });
}
