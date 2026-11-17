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

test("artist identity requires exact normalized aliases, not token subsets", () => {
  const base = { title: "Song", artist: "John", durationMs: 200000 };
  assert.equal(identity.recordingIdentityMatches(base, { ...base, artist: "John Legend" }), false);
  assert.equal(identity.recordingIdentityMatches(
    { ...base, artist: "Alpha" },
    { ...base, artist: "Alpha Tribute Band" },
  ), false);
  assert.equal(identity.recordingIdentityMatches(
    { ...base, artist: "John Legend" },
    { ...base, artist: "John Legend feat. Guest" },
  ), true);
  assert.equal(identity.recordingIdentityMatches(target, {
    title: "八方来财", artist: "SKAI ISYOURGOD", durationMs: 173000,
  }), true);
});

test("semantic part subtitles survive title normalization", () => {
  assert.equal(identity.titleKey("Home (Intro)"), "homeintro");
  assert.equal(identity.titleKey("Home (Outro)"), "homeoutro");
  assert.notEqual(identity.titleKey("Home (Intro)"), identity.titleKey("Home (Outro)"));
  assert.equal(identity.titleKey("Song (English Title)"), "song");
  const intro = { title: "Home (Intro)", artist: "Artist", durationMs: 200000 };
  const outro = { title: "Home (Outro)", artist: "Artist", durationMs: 200000 };
  assert.equal(identity.recordingIdentityMatches(intro, intro), true);
  assert.equal(identity.recordingIdentityMatches(intro, outro), false);
});

test("ordinary English subtitles are not treated as translations", () => {
  const titles = [
    "Home (The Beginning)",
    "Home (The End)",
    "Home (In Flames)",
    "Home (In Chains)",
  ];
  for (const title of titles) {
    assert.notEqual(identity.titleKey(title), "home", `${title} keeps its subtitle`);
  }
  const tracks = titles.map(title => ({ title, artist: "Artist", durationMs: 200000 }));
  for (const left of tracks) {
    for (const right of tracks) {
      assert.equal(
        identity.recordingIdentityMatches(left, right),
        left.title === right.title,
        `${left.title} versus ${right.title}`,
      );
    }
  }
});

const conflictTrack = {
  spotifyTrackId: "1QV6tiMFM6fSOKOGLMHYYg",
  title: "Hello",
  artist: "Artist",
  durationMs: 4000,
  isrc: "HKE022272921",
};
const conflictBody = {
  id: "1QV6tiMFM6fSOKOGLMHYYg",
  ids: { isrc: "US5TA1500050" },
  source: "spicy_lyrics",
  Type: "Syllable",
  StartTime: 1,
  EndTime: 4,
  Content: [{
    Type: "Vocal",
    Lead: {
      StartTime: 1,
      EndTime: 4,
      Syllables: [{ Text: "Wrong recording", StartTime: 1, EndTime: 4, IsPartOfWord: false }],
    },
  }],
};
const staticBody = {
  id: "1QV6tiMFM6fSOKOGLMHYYg",
  source: "spicy_lyrics",
  Type: "Static",
  Lines: [{ Text: "Plain text" }],
};

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";

  test(`${platform}: Spicy rejects conflicting provider ISRC with the same Spotify ID`, async () => {
    const context = load(async () => json({ Body: conflictBody, Status: 200 }), mobile);
    context.track = conflictTrack;
    await assert.rejects(
      () => vm.runInContext(
        'fetchFromSpicyLyrics(track, { spicyLyricsPublishableKey: "sl_pk_test_client" })',
        context,
      ),
      error => {
        assert.match(String(error.sourceFailureReason || ""), /spicy:identity-conflict-no-match/);
        return true;
      },
    );
  });

  test(`${platform}: Spicy Static stays untimed without a metadata flag`, async () => {
    const context = load(async () => json({ Body: staticBody, Status: 200 }), mobile);
    context.track = { ...conflictTrack, isrc: undefined };
    const result = await vm.runInContext(
      'fetchFromSpicyLyrics(track, { spicyLyricsPublishableKey: "sl_pk_test_client" })',
      context,
    );
    assert.equal(result?.source, "spicy-lyrics-static");
    assert.equal(result?.metadata?.untimed, undefined);
    assert.equal(result?.lyrics?.[0]?.lineStartTime, 0);
    assert.equal(result?.lyrics?.[0]?.lineEndTime, 0);
  });
}

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";

  test(`${platform}: lrc.red search rejects a conflicting ISRC after direct 404`, async () => {
    const calls = [];
    const context = load(async url => {
      const value = String(url);
      calls.push(value);
      if (value.includes("/s/HKE022272921.json")) return json({}, 404);
      if (value.includes("/s/HKE022272921.ttml")) return new Response("missing", { status: 404 });
      if (value.includes("api.deezer.com/search")) return json({ data: [] });
      if (value.includes("lrc.red/search.json")) {
        return json({
          hits: [{
            isrc: "US5TA1500050",
            title: "八方来财",
            artist: "SKAI ISYOURGOD",
            duration: 173.037,
          }],
        });
      }
      if (value.includes("/s/US5TA1500050")) {
        throw new Error("conflicting ISRC must not be fetched");
      }
      return json({}, 404);
    }, mobile);
    context.track = { ...target, trackId: "target" };
    const result = await vm.runInContext("fetchFromLrcRed(track)", context);
    assert.equal(result, null);
    assert.ok(calls.some(url => url.includes("/s/HKE022272921.json")));
    assert.ok(!calls.some(url => url.includes("/s/US5TA1500050")));
  });
}
