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

const track = { trackId: "fixture", title: "Mayday", artist: "Artist", durationMs: 8000 };
const syncedLyrics = "[00:01.000]First line\n[00:03.000]Second line";
const yaml = `version: '1.0'
metadata:
  title: Mayday
lines:
  - text: "  안녕  (🌙) "
    start_ms: 1000
    end_ms: 2500
    words:
      - {text: "  안녕  ", start_ms: 1100}
      - {text: "(🌙) ", start_ms: 1900}
  - text: "é tide"
    start_ms: 3000
    end_ms: 4700
    words:
      - {text: "é ", start_ms: 3000, end_ms: 3300}
      - {text: tide, start_ms: 3500}
`;
const record = {
  id: 42, trackName: track.title, artistName: track.artist, duration: 8,
  syncedLyrics, hasWordSync: true, lyricsfile: yaml,
};

test("Expo classifies two words and three uniformly timed words as karaoke", async () => {
  const timingFile = path.resolve(__dirname, "../../ExpoLyrics/lib/lyrics-timing.ts");
  const ts = createRequire(timingFile)("typescript");
  const compiled = ts.transpileModule(fs.readFileSync(timingFile, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  vm.runInNewContext(compiled.outputText, { exports });

  const uniformYaml = `version: '1.0'
lines:
  - text: "one two three"
    start_ms: 1000
    end_ms: 2500
    words:
      - {text: "one ", start_ms: 1000}
      - {text: "two ", start_ms: 1500}
      - {text: three, start_ms: 2000}
`;
  const ctx = load(true);
  const twoWords = await fetchFixture(ctx, record);
  const threeWords = await fetchFixture(ctx, { ...record, lyricsfile: uniformYaml });
  for (const [packet, count] of [[twoWords.packet, 2], [threeWords.packet, 3]]) {
    assert.equal(packet.source, "lrclib-word");
    const line = packet.lyrics[0];
    assert.equal(line.syllables.length, count);
    assert.equal(exports.detectLyricsTimingMode([line], packet.source), "karaoke");
  }
});

async function fetchFixture(ctx, item, { fromGet = false } = {}) {
  const requests = [];
  ctx.fetchJsonWithRetry = async (url, options, retry) => {
    requests.push({ url, ...options, retry });
    if (url.endsWith("/get")) return fromGet ? item : null;
    return fromGet ? [] : [item];
  };
  const packet = await ctx.fetchFromLrcLib(track);
  return { packet, requests };
}

const invalid = {
  "malformed YAML": "lines: [",
  "custom tag": yaml.replace("Mayday", "!unknown Mayday"),
  "deep nesting": yaml.replace("Mayday", "[".repeat(40) + "x" + "]".repeat(40)),
  "oversize input": yaml + "#".repeat(1024 * 1024),
  "recursive alias": yaml.replace("metadata:", "metadata: &meta").replace("title: Mayday", "title: *meta"),
  "negative time": yaml.replace("1100", "-1"),
  "NaN time": yaml.replace("1100", ".nan"),
  "infinite time": yaml.replace("2500", ".inf"),
  "out of order words": yaml.replace("1900", "1050"),
  "out of order lines": yaml.replace("start_ms: 3000\n", "start_ms: 900\n"),
  "word starts before line": yaml.replace("1100", "999"),
  "word starts beyond line end": yaml.replace("1900", "2501"),
  "word ends beyond line end": yaml.replace("3300", "4800"),
  "end before start": yaml.replace("3300", "2999"),
  "overlapping words": yaml.replace("3300", "3600"),
  "empty word text": yaml.replace("tide, start", "'', start"),
  "null word": yaml.replace('{text: tide, start_ms: 3500}', "null"),
  "empty word list": yaml.replace(/words:\n(?:      - .*\n)+/g, "words: []\n"),
  "line text mismatch": yaml.replace("é tide", "é wave"),
  "sparse mixed lines": yaml + '  - {text: "third line", start_ms: 5000, end_ms: 6000}\n',
  "line only": "version: '1.0'\nlines: [{text: line, start_ms: 1000, end_ms: 2000}]",
  "word wrapper with only line timing": `version: '1.0'
lines:
  - {text: line, start_ms: 1000, end_ms: 2000, words: [{text: line, start_ms: 1000}]}
`,
  "too many lines": "version: '1.0'\nlines: [" + "{}, ".repeat(4001) + "]",
  "too many words": "version: '1.0'\nlines: [{text: line, start_ms: 1000, end_ms: 2000, words: [" +
    "{}, ".repeat(20001) + "]}]",
  "flag with no lyricsfile": undefined,
};

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";
  test(`${platform}: lyricsfile preserves Unicode, whitespace, and explicit and inferred ends`, async () => {
    const ctx = load(mobile);
    const { packet } = await fetchFixture(ctx, { ...record, syncedLyrics: null }, { fromGet: true });
    assert.equal(packet.source, "lrclib-word");
    assert.equal(packet.metadata.matchedTrack.id, 42);
    const finalized = await ctx.finalizeFetchedLyricsResult(packet);
    assert.deepEqual(JSON.parse(JSON.stringify(finalized.lyrics)), [
      { lineStartTime: 1000, lineEndTime: 2500, syllables: [
        { text: "  안녕  ", startTime: 1100, endTime: 1900 },
        { text: "(🌙) ", startTime: 1900, endTime: 2500 },
      ] },
      { lineStartTime: 3000, lineEndTime: 4700, syllables: [
        { text: "é ", startTime: 3000, endTime: 3300 },
        { text: "tide", startTime: 3500, endTime: 4700 },
      ] },
    ]);
  });

  test(`${platform}: scored LRCLIB fallback accepts valid word-only and word-plus-LRC records`, async () => {
    const ctx = load(mobile);
    const originalRequire = ctx.require;
    let strictIdentityChecks = 0;
    ctx.require = name => {
      if (!name.endsWith("/lyricsRecordingIdentity")) return originalRequire(name);
      return {
        ...originalRequire(name),
        recordingIdentityMatches() {
          strictIdentityChecks++;
          return false;
        },
      };
    };
    for (const fallback of [null, syncedLyrics]) {
      const { packet } = await fetchFixture(ctx, { ...record, syncedLyrics: fallback });
      assert.equal(packet.source, "lrclib-word");
      assert.equal(packet.lyrics.length, 2);
    }
    assert.equal(strictIdentityChecks, 2);
  });

  test(`${platform}: invalid or sparse YAML preserves ordinary and enhanced LRC fallback`, async () => {
    const ctx = load(mobile);
    for (const [label, lyricsfile] of Object.entries(invalid)) {
      const { packet } = await fetchFixture(ctx, { ...record, lyricsfile });
      assert.equal(packet.source, "lrclib-fallback", label);
      assert.deepEqual(packet.lyrics, ctx.parseLrc(syncedLyrics), label);
    }
    const enhanced = "[00:01.000]<00:01.000>First <00:01.500>line";
    const { packet } = await fetchFixture(ctx, { ...record, lyricsfile: "[", syncedLyrics: enhanced });
    assert.equal(packet.source, "lrclib-fallback");
    assert.deepEqual(packet.lyrics, ctx.parseLrc(enhanced));
    assert.equal(packet.lyrics[0].syllables.length, 2);
  });

  test(`${platform}: false flags and instrumentals skip YAML loading`, async () => {
    const ctx = load(mobile);
    const originalRequire = ctx.require;
    let yamlLoads = 0;
    ctx.require = name => {
      if (name === "js-yaml") yamlLoads++;
      return originalRequire(name);
    };
    const line = await fetchFixture(ctx, { ...record, hasWordSync: false });
    assert.equal(line.packet.source, "lrclib-fallback");
    const noFile = await fetchFixture(ctx, { ...record, lyricsfile: undefined });
    assert.equal(noFile.packet.source, "lrclib-fallback");
    const instrumental = await fetchFixture(ctx, { ...record, instrumental: true });
    assert.equal(instrumental.packet.source, "lrclib-instrumental");
    assert.equal(instrumental.packet.metadata.instrumental, true);
    assert.equal(instrumental.packet.lyrics.length, 0);
    assert.equal(yamlLoads, 0);
  });

  test(`${platform}: lyricsfile uses the existing LRCLIB search and get requests`, async () => {
    const ctx = load(mobile);
    const word = await fetchFixture(ctx, record);
    const line = await fetchFixture(ctx, { ...record, hasWordSync: false });
    assert.equal(word.packet.source, "lrclib-word");
    assert.equal(line.packet.source, "lrclib-fallback");
    assert.deepEqual(word.requests, line.requests);
    const query = { track_name: "Mayday", artist_name: "Artist" };
    assert.deepEqual(JSON.parse(JSON.stringify(word.requests.map(({ url, params }) => [url, params]))), [
      ...["lrclib.net", "www.lrclib.net"].flatMap(host =>
        [query, { track_name: "Mayday" }, { q: "Mayday" }]
          .map(params => [`https://${host}/api/search`, params])),
      ...["lrclib.net", "www.lrclib.net"].map(host =>
        [`https://${host}/api/get`, { ...query, duration: 8 }]),
    ]);
  });
}
