"use strict";
// Independent lrc.red identity regression coverage. Executes both the desktop
// service parts and the generated mobile service bundle with mocked network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");
const policy = require("../src/lyricsPolicy");
const { createLyricsVaultStore } = require("../src/lyricsVault");
const fsSync = require("node:fs");
const os = require("node:os");

const src = path.resolve(__dirname, "../src");
const mobileTtmlImport = require(path.resolve(src, "../../ExpoLyrics/lib/lyrics-ttml-import.js"));
const mobileFile = path.resolve(src, "../../ExpoLyrics/lib/mobile-lyrics-service.js");
const TTML = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="1s">Hello</p></div></body></tt>';
const ISRC = "US5TA1500050";
const baseTrack = { title: "Rewind", artist: "Wonder Girls", durationMs: 213000, spotifyTrackId: "1QV6tiMFM6fSOKOGLMHYYg" };

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
    context.parseLrcRedTtml = mobileTtmlImport.parseTtmlToLyrics;
    context.parseLrcRedTime = mobileTtmlImport.parseTtmlTimeExpression;
    context.extractLrcRedTtmlMetadata = mobileTtmlImport.extractTtmlMetadata;
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

async function runSpicyApi(mobile, handler) {
  const net = fakeFetch(handler);
  const context = load(mobile, net.fetch);
  const result = await vm.runInContext(`fetchSpicyLyricsByTrackId(${JSON.stringify(baseTrack.spotifyTrackId)}, "sl_pk_independent_test")`, context);
  return { result, calls: net.calls };
}

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";

  test(`${label} lrc.red direct ISRC validates format and accepts dash/lowercase plus a localized artist`, async () => {
    const { result, calls } = await runExport(mobile, url => {
      if (url.includes(`/s/${ISRC}.json`)) return { body: JSON.stringify({ title: "Rewind", duration: 213, artist: "ريويند" }) };
      if (url.includes(`/s/${ISRC}.ttml`)) return { body: TTML, type: "application/xml" };
    }, { ...baseTrack, isrc: "us5ta-1500050" });
    assert.equal(result?.source, "lrc-red-line");
    assert.deepEqual(calls.map(call => call.url), [`https://lrc.red/s/${ISRC}.json`, `https://lrc.red/s/${ISRC}.ttml`]);
  });

  test(`${label} lrc.red malformed ISRC never becomes a directory path`, async () => {
    for (const bad of ["US5TA150005", "1QV6tiMFM6fSOKOGLMHYYg", "", null]) {
      const { result, calls } = await runExport(mobile, url => {
        if (url.includes("search.json")) return { body: JSON.stringify({ hits: [] }) };
      }, { ...baseTrack, isrc: bad });
      assert.equal(result, null);
      assert.ok(!calls.some(call => call.url.includes("/s/")), `malformed ISRC ${String(bad)} must not request /s/`);
      assert.ok(calls.some(call => call.url.includes("search.json")), "malformed direct ISRC must fall through to search");
    }
  });

  test(`${label} lrc.red rejects an explicit 2010 versus 2020 remaster and never fetches the wrong TTML`, async () => {
    const wanted = { ...baseTrack, title: "Rewind (2010 Remaster)", durationMs: 213000, isrc: ISRC };
    const wrong = { isrc: ISRC, title: "Rewind (2020 Remaster)", duration: 213, artist: "Wonder Girls" };
    const { result, calls } = await runExport(mobile, url => {
      if (url.endsWith(".json")) return { body: JSON.stringify(wrong) };
      if (url.includes("search.json")) return { body: JSON.stringify({ hits: [wrong] }) };
      if (url.endsWith(".ttml")) return { body: TTML, type: "application/xml" };
    }, wanted);
    assert.equal(result, null, "a different remaster year must be rejected");
    assert.ok(!calls.some(call => call.url.endsWith(".ttml")), "no wrong-remaster TTML may be fetched");
  });

  test(`${label} lrc.red search rejects a wrong remaster, then accepts the matching safe candidate`, async () => {
    const wanted = { ...baseTrack, title: "Rewind (2010 Remaster)", durationMs: 213000 };
    const wrong = { isrc: "US5TA1500051", title: "Rewind (2020 Remaster)", duration: 213, artist: "Wonder Girls" };
    const right = { isrc: ISRC, title: "Rewind (2010 Remaster)", duration: 213, artist: "Wonder Girls" };
    let searchCount = 0;
    const { result, calls } = await runExport(mobile, url => {
      if (url.includes("search.json")) return { body: JSON.stringify({ hits: [searchCount++ === 0 ? wrong : right] }) };
      if (url.endsWith(".ttml")) return { body: TTML, type: "application/xml" };
    }, wanted);
    assert.equal(result?.source, "lrc-red-line");
    assert.ok(calls.some(call => call.url.includes(`/s/${ISRC}.ttml`)), "the correct remaster must be fetched after the safe search");
    assert.ok(!calls.some(call => call.url.includes("/s/US5TA1500051.ttml")), "wrong remaster candidate must not be fetched");
  });

  test(`${label} lrc.red direct JSON miss falls through to a correct safe search`, async () => {
    const { result, calls } = await runExport(mobile, url => {
      if (url.includes(`/s/${ISRC}.json`)) return { status: 404, body: "missing" };
      if (url.includes("search.json")) return { body: JSON.stringify({ hits: [{ isrc: ISRC, title: "Rewind", duration: 213, artist: "Wonder Girls" }] }) };
      if (url.endsWith(".ttml")) return { body: TTML, type: "application/xml" };
    }, { ...baseTrack, isrc: ISRC });
    assert.equal(result?.source, "lrc-red-line");
    assert.equal(result.metadata.attribution.source, "lrc-red");
    policy.assertLyricsExportAllowed({ metadata: result.metadata });
    assert.ok(calls.some(call => call.url.includes("search.json")));
    assert.ok(calls.some(call => call.url.includes(`/s/${ISRC}.ttml`)));
  });

  test(`${label} lrc.red direct JSON with a mismatched duration falls through to safe search without wrong TTML`, async () => {
    const { result, calls } = await runExport(mobile, url => {
      if (url.endsWith(".json")) return { body: JSON.stringify({ title: "Rewind", duration: 260, artist: "Wonder Girls" }) };
      if (url.includes("search.json")) return { body: JSON.stringify({ hits: [] }) };
      if (url.endsWith(".ttml")) return { body: TTML, type: "application/xml" };
    }, { ...baseTrack, isrc: ISRC });
    assert.equal(result, null);
    assert.ok(calls.some(call => call.url.includes("search.json")));
    assert.ok(!calls.some(call => call.url.endsWith(".ttml")));
  });

  test(`${label} Spicy Body.ids.isrc is exposed as fetch-origin ISRC`, async () => {
    const { result } = await runSpicyApi(mobile, () => ({
      body: JSON.stringify({ Status: 200, Body: { id: baseTrack.spotifyTrackId, ids: { isrc: ` ${ISRC} ` }, lines: [] } }),
    }));
    assert.equal(result.kinesyncSpicyOrigin.isrc, ISRC);
    assert.equal(result.kinesyncSpicyOrigin.host, "api.spicylyrics.org");
  });
}

test("desktop vault persistence carries Spicy Body ISRC into the export lookup", async t => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "kinesync-independent-isrc-"));
  const store = createLyricsVaultStore({ userDataPath: root });
  t.after(() => { store.close(); fsSync.rmSync(root, { recursive: true, force: true }); });
  const lyrics = [{ lineStartTime: 0, lineEndTime: 1000, syllables: [{ text: "Hello", startTime: 0, endTime: 1000 }] }];
  const metadata = {
    fetchOrigin: { host: "api.spicylyrics.org", source: "spicy-lyrics-api", isrc: ISRC, spotifyTrackId: baseTrack.spotifyTrackId },
    spicyApi: { fetchedAt: Date.now(), expiresAt: Date.now() + 86400000 },
    attribution: { source: "spicy_lyrics", provider: "Spicy Lyrics" },
  };
  store.save({ track: baseTrack, lyrics, sourceLabel: "local-vault-line", originalSource: "spicy-lyrics-line", metadata });
  const saved = store.getEntry(`spotify_${baseTrack.spotifyTrackId}`);
  assert.equal(saved.manifest.metadata.fetchOrigin.isrc, ISRC);
  const { result, calls } = await runExport(false, url => {
    if (url.includes(`/s/${ISRC}.json`)) return { body: JSON.stringify({ title: "Rewind", duration: 213 }) };
    if (url.includes(`/s/${ISRC}.ttml`)) return { body: TTML, type: "application/xml" };
  }, { ...saved.manifest, isrc: undefined, metadata: saved.manifest.metadata });
  assert.equal(result?.source, "lrc-red-line");
  assert.ok(calls.some(call => call.url.includes(`/s/${ISRC}.json`)), "persisted Body ISRC must drive the direct lrc.red path");
});
