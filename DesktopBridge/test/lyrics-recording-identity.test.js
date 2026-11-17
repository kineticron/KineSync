"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");
const identity = require("../src/lyricsRecordingIdentity");

const target = {
  title: "八方來財 (Stacks from All Sides)",
  artist: "攬佬SKAI ISYOURGOD",
  durationMs: 173037,
  spotifyTrackId: "7jm2PueKmv4EOHfdbdXMKT",
  isrc: "HKE022272921",
};

test("equal authoritative IDs win over title, featured and duration text", () => {
  assert.equal(identity.recordingIdentityMatches(target, {
    title: "Different catalog title", artist: "Different artist", durationMs: 1,
    isrc: "HKE022272921",
  }), true);
  assert.equal(identity.recordingIdentityMatches(target, {
    title: "Different catalog title", artist: "Different artist", durationMs: 1,
    spotifyTrackId: "7jm2PueKmv4EOHfdbdXMKT",
  }), true);
});

test("conflicting authoritative IDs reject even when another ID is equal", () => {
  assert.equal(identity.recordingIdentityMatches(target, {
    title: target.title, artist: target.artist, durationMs: target.durationMs,
    isrc: "HKE022272921", spotifyTrackId: "0000000000000000000000",
  }), false);
  assert.equal(identity.recordingIdentityMatches(target, {
    title: target.title, artist: target.artist, durationMs: target.durationMs,
    isrc: "US5TA1500050", spotifyTrackId: target.spotifyTrackId,
  }), false);
});

test("fallback folds script, translation and feat variants within three seconds", () => {
  assert.equal(identity.recordingIdentityMatches(target, {
    title: "八方来财", artist: "SKAI ISYOURGOD", durationMs: 173000,
  }), true);
  assert.equal(identity.recordingIdentityMatches({
    title: "Song (feat. Guest)", artist: "Artist", durationMs: 200000,
  }, { title: "Song (English Title)", artist: "Artist feat. Guest", durationMs: 202900 }), true);
  assert.equal(identity.recordingIdentityMatches(target, {
    title: "八方来财", artist: "SKAI ISYOURGOD", durationMs: 176100,
  }), false);
  assert.equal(identity.recordingIdentityMatches(target, {
    title: "八方来财", artist: "Unrelated", durationMs: 173000,
  }), false);
  assert.equal(identity.recordingIdentityMatches({
    title: "Song (Live)", artist: "Artist", durationMs: 200000,
  }, { title: "Song", artist: "Artist", durationMs: 200000 }), false);
});

test("Spotify overlay copies ISRC only for the exact same catalog track", () => {
  for (const mobile of [false, true]) {
    const context = load(null, mobile);
    context.overlay = vm.runInContext("applySpotifyCatalogOverlay", context);
    const same = context.overlay(target, { id: target.spotifyTrackId, isrc: "hke02-2272921" });
    assert.equal(same.isrc, "HKE022272921");
    const other = context.overlay(target, { id: "0000000000000000000000", isrc: "US5TA1500050" });
    assert.equal(other.isrc, target.isrc);
  }
});

function load(fetch, mobile = false) {
  const src = path.resolve(__dirname, "../src");
  const context = vm.createContext({
    AbortController, Buffer, clearTimeout, setTimeout, clearInterval, setInterval,
    TextDecoder, URL, URLSearchParams, console: { ...console, debug() {} },
    fetch: fetch || (() => { throw Error("Unexpected network request"); }),
    global: {}, module: { exports: {} }, process: { env: {} },
    require: createRequire(path.join(src, "lyricsService.js")),
  });
  if (mobile) {
    let source = fs.readFileSync(path.resolve(src, "../../ExpoLyrics/lib/mobile-lyrics-service.js"), "utf8");
    source = source.replace(/^import .*;\r?\n/gm, "");
    vm.runInContext(source.slice(0, source.indexOf("export {")), context);
    const mobileTtml = require("../../ExpoLyrics/lib/lyrics-ttml-import");
    context.parseLrcRedTtml = mobileTtml.parseTtmlToLyrics;
    context.parseLrcRedTime = mobileTtml.parseTtmlTimeExpression;
    context.extractLrcRedTtmlMetadata = mobileTtml.extractTtmlMetadata;
  } else {
    const index = fs.readFileSync(path.join(src, "lyrics/index.js"), "utf8");
    for (const match of index.match(/const partFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)) {
      vm.runInContext(fs.readFileSync(path.join(src, "lyrics/parts", match[1]), "utf8"), context);
    }
  }
  return context;
}

const TTML = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="1s">Hello</p></div></body></tt>';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";

  test(`${platform}: lrc.red direct ISRC accepts a translated title variant`, async () => {
    const calls = [];
    const context = load(async url => {
      calls.push(String(url));
      if (String(url).endsWith(".json")) return json({ title: "八方来财", duration: 173.037, artist: "SKAI ISYOURGOD" });
      if (String(url).endsWith(".ttml")) return new Response(TTML, { headers: { "content-type": "application/xml" } });
      return json({});
    }, mobile);
    context.track = { ...target, trackId: "target" };
    const result = await vm.runInContext("fetchFromLrcRed(track)", context);
    assert.equal(result?.source, "lrc-red-line");
    assert.ok(calls.some(url => url.includes("/s/HKE022272921.ttml")));
  });

  test(`${platform}: LRCLIB prefers a synced identity row and keeps plain text untimed`, async () => {
    const items = [
      { id: 1, trackName: "八方来财", artistName: "SKAI ISYOURGOD", duration: 173.0, syncedLyrics: "[00:01.00]Hello" },
      { id: 2, trackName: "八方来财", artistName: "SKAI ISYOURGOD", duration: 173.0, plainLyrics: "Hello\nWorld" },
    ];
    const run = async (candidates) => {
      const context = load(async url => String(url).includes("/api/search") ? json(candidates) : json({}, 404), mobile);
      context.track = { ...target, trackId: "target" };
      return vm.runInContext("fetchFromLrcLib(track)", context);
    };
    const synced = await run(items);
    assert.equal(synced.source, "lrclib-fallback");
    assert.equal(synced.lyrics.length, 1);
    const plainOnly = await run([items[1]]);
    assert.equal(plainOnly.source, "lrclib-plain");
    assert.equal(plainOnly.metadata.untimed, true);
    assert.equal(plainOnly.lyrics.length, 2);
    assert.equal(await run([{ id: 3, trackName: "Wrong Song", artistName: "Wrong", duration: 173, plainLyrics: "No" }]), null);
  });
}

test("a plain LRCLIB result never outranks a timed provider result", () => {
  const { shouldPreferAutoCandidate } = require("../src/lyricsAutoPicker");
  const timed = { source: "lrc-red-line", lyrics: [{ lineStartTime: 0, lineEndTime: 1000 }] };
  const plain = { source: "lrclib-plain", metadata: { untimed: true }, lyrics: [{ lineStartTime: 0, lineEndTime: 0 }] };
  assert.equal(shouldPreferAutoCandidate(target, plain, timed), true);
  assert.equal(shouldPreferAutoCandidate(target, timed, plain), false);
});

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";
  test(`${platform}: featured-title rejection yields to equal IDs and still rejects conflicts`, () => {
    const context = load(null, mobile);
    const track = { ...target, title: "Song (feat. Guest)" };
    const lyrics = [{ lineStartTime: 0, lineEndTime: 1000, syllables: [{ text: "Hello", startTime: 0, endTime: 1000 }] }];
    context.track = track;
    context.lyrics = lyrics;
    context.same = { isrc: target.isrc };
    context.conflict = { isrc: "US5TA1500050" };
    context.titles = ["Song"];
    const same = vm.runInContext('featuredVariantLyricsMismatch(track, lyrics, { source: "spicy", spicyDeclaredTitles: titles, candidateIdentity: same })', context);
    const conflict = vm.runInContext('featuredVariantLyricsMismatch(track, lyrics, { source: "spicy", spicyDeclaredTitles: titles, candidateIdentity: conflict })', context);
    assert.equal(same, false);
    assert.equal(conflict, true);
  });
}

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";
  test(`${platform}: verified Spotify catalog ISRC reaches the lyrics match track`, async () => {
    const context = load(async url => {
      if (String(url).includes("api.spotify.com/v1/tracks/")) {
        return json({
          id: target.spotifyTrackId, name: target.title,
          artists: [{ name: target.artist }], album: { name: "Album" },
          duration_ms: target.durationMs, external_ids: { isrc: "hke02-2272921" },
        });
      }
      return json({}, 404);
    }, mobile);
    context.input = { ...target, isrc: undefined };
    const matched = await vm.runInContext('buildLyricsMatchTrack(input, { spotifyAccessToken: "token" })', context);
    assert.equal(matched.isrc, target.isrc);
    assert.equal(matched.spotifyTrackId, target.spotifyTrackId);
  });
}

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";
  test(`${platform}: QQ identity accepts the 173 second simplified listing`, () => {
    const context = load(null, mobile);
    context.track = target;
    context.ranked = [
      { song: { songname: "八方来财", singername: "SKAI ISYOURGOD", interval: 173 }, score: 10 },
      { song: { songname: "八方来财", singername: "Unrelated", interval: 173 }, score: 9 },
    ];
    const accepted = vm.runInContext(`filterLikelyQqRankedCandidates(track, ranked,
      song => song.songname, song => song.singername, song => song.interval)`, context);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].song.singername, "SKAI ISYOURGOD");
  });
}
