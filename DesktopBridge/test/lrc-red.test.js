"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");

const track = { title: "Example Song", artist: "Example Artist", durationMs: 10000 };
const isrc = "GBUM71029604";
const wordTtml = '<tt lrc:timing="Word"><body><div><p begin="1.000" end="9.000"><span begin="1.000" end="3.000">Hel</span><span begin="3.000" end="5.000">lo</span> <span begin="5.000" end="9.000">world</span><span ttm:role="x-bg"><span begin="6.000" end="8.000">(oh)</span></span></p></div></body></tt>';
const crushSeesawTtml = fs.readFileSync(path.join(__dirname, "fixtures/crush-seesaw.ttml"), "utf8");
const lineTtml = '<tt lrc:timing="Line"><body><div><p begin="1.000" end="9.000">Hello world</p></div></body></tt>';

test("lrc.red TTML preserves joined syllables across pauses in lead and background vocals", () => {
  const content = '<tt xmlns:lrc="http://lrc.red/lyric-ttml-internal" lrc:timing="Word"><body><p begin="1.000" end="3.000"><span begin="1.000" end="1.300">Sun</span><span begin="1.472" end="1.900">rise</span> <span begin="2.000" end="3.000">glows</span><span ttm:role="x-bg"><span begin="1.000" end="1.300">(sun</span><span begin="1.600" end="2.000">rise)</span></span></p></body></tt>';
  for (const importer of [require("../src/lyricsTtmlImport"), require("../../ExpoLyrics/lib/lyrics-ttml-import")]) {
    const line = importer.parseTtmlToLyrics(content).lyrics[0];
    assert.equal(line.syllables.map(s => s.text).join(""), "Sunrise glows");
    assert.equal(line.backgroundSyllables.map(s => s.text).join(""), "sunrise");
    assert.equal(line.syllables[0].isPartOfWord, true);
    assert.equal(line.backgroundSyllables[0].isPartOfWord, true);
    assert.deepEqual(line.syllables.map(s => [s.startTime, s.endTime]), [[1000, 1300], [1472, 1900], [2000, 3000]]);
  }
});

function load(fetch, mobile) {
  const src = path.resolve(__dirname, "../src");
  const context = vm.createContext({
    AbortController, Buffer, clearTimeout, setTimeout, clearInterval, setInterval,
    TextDecoder, URL, URLSearchParams, console, fetch, global: {}, module: { exports: {} },
    process: { env: {} }, require: createRequire(path.join(src, "lyricsService.js")),
    parseLrcRedTtml: require("../../ExpoLyrics/lib/lyrics-ttml-import").parseTtmlToLyrics,
    parseLrcRedTime: require("../../ExpoLyrics/lib/lyrics-ttml-import").parseTtmlTimeExpression,
    extractLrcRedTtmlMetadata: require("../../ExpoLyrics/lib/lyrics-ttml-import").extractTtmlMetadata,
  });
  if (mobile) {
    context.CryptoJS = createRequire(path.resolve(src, "../../ExpoLyrics/lib/mobile-lyrics-service.js"))("crypto-js");
    let source = fs.readFileSync(path.resolve(src, "../../ExpoLyrics/lib/mobile-lyrics-service.js"), "utf8");
    source = source.replace(/^import .*;\r?\n/gm, "");
    vm.runInContext(source.slice(0, source.indexOf("export {")), context);
  } else {
    const index = fs.readFileSync(path.join(src, "lyrics/index.js"), "utf8");
    for (const match of index.match(/const partFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)) {
      vm.runInContext(fs.readFileSync(path.join(src, "lyrics/parts", match[1]), "utf8"), context);
    }
  }
  context.track = { ...track };
  return context;
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"}: source wins per line through fresh AI, AI cache, source cache and language switch`, async () => {
    const content = `<tt xmlns:lrc="http://lrc.red/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" lrc:timing="Word"><head><metadata>
      <sourceMetadata xmlns="http://lrc.red/lyric-ttml-internal"><translations>
      <translation xml:lang="en" type="subtitle" automaticallyCreated="true"><text for="A">Source English</text><text for="orphan">Unmatched</text></translation>
      <translation xml:lang="es" type="subtitle" automaticallyCreated="false"><text for="A">Source Spanish</text></translation>
      </translations></sourceMetadata></metadata></head><body>
      <p lrc:key="A" begin="1" end="3">첫번째</p>
      <p lrc:key="B" begin="3" end="5">두번째<span ttm:role="x-translation">Inline choice</span></p>
      <p begin="5" end="7">세번째<span ttm:role="x-translation">Unkeyed inline</span></p>
      <p lrc:key="D" begin="7" end="9">네번째</p></body></tt>`;
    let requests = 0;
    let fetches = 0;
    const context = load(async (url, options) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        requests++;
        const payload = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ lineCount: 4,
          translations: [0, 1, 2, 3].map(i => ({ i, t: `AI ${payload.targetLanguage} ${i}` })) }) }] } }] });
      }
      if (url.endsWith(".json")) return Response.json({});
      fetches++;
      return new Response(content);
    }, mobile);
    context.track = { ...track, trackId: "precedence", isrc };
    vm.runInContext('var service = createLyricsService({ getGeminiApiKey: () => "test-key" })', context);
    const fresh = await vm.runInContext('service.fetchSyncedLyrics(track, { preferredSource: "lrc-red", immediateTranslation: true })', context);
    const texts = packet => Array.from(packet.lyrics, line => line.translatedText);
    assert.deepEqual(texts(fresh), ["Source English", "Inline choice", "Unkeyed inline", "AI English 3"]);
    const atoms = packet => JSON.stringify(Array.from(packet.lyrics, ({ translatedText, ...line }) => line));
    const check = (packet, source, fallback) => {
      assert.deepEqual(texts(packet), [source, "Inline choice", "Unkeyed inline", fallback]);
      assert.equal(atoms(packet), atoms(fresh), "All timing/lead/background atoms unchanged");
      assert.equal(packet.metadata.ttml.translationTracks[0].automaticallyCreated, true);
      assert.equal(packet.metadata.ttml.translationTracks[1].automaticallyCreated, false);
    };
    context.published = fresh;
    vm.runInContext('service.rememberPublishedLyrics(track.trackId, published)', context);
    const cachedAi = await vm.runInContext('service.translatePublishedLyrics(track)', context);
    check(cachedAi, "Source English", "AI English 3");
    assert.equal(requests, 1, "The actual AI cache is exercised");
    check(await vm.runInContext('service.fetchSyncedLyrics(track, { preferredSource: "lrc-red" })', context), "Source English", "AI English 3");
    const spanish = await vm.runInContext('service.translatePublishedLyrics(track, { translationLanguage: "Spanish" })', context);
    check(spanish, "Source Spanish", "AI Spanish 3");
    const switched = await vm.runInContext('service.fetchSyncedLyrics(track, { preferredSource: "lrc-red", translationLanguage: "French" })', context);
    assert.deepEqual(texts(switched), [undefined, "Inline choice", "Unkeyed inline", undefined], "No stale AI language after switching");
    assert.equal(requests, 2);
    assert.equal(fetches, 1);
  });
}

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";
  test(`${platform}: real sourceMetadata translations survive valid or absent recording JSON`, async () => {
    for (const [id, count, title, artist, duration] of [
      ["US5TA1500050", 54, "Rewind", "SUNMI", 213480],
      ["ZZA0P2622376", 42, "seesaw (Feat. IU)", "Crush", 181000],
      ["KRMIM2652961", 12, "ew", "DPR CREAM", 125000],
    ]) {
      const content = fs.readFileSync(path.join(__dirname, `fixtures/lrc-red/${id}.ttml`), "utf8");
      for (const missingJson of [false, true]) {
        let ttmlFetches = 0;
        const context = load(async url => {
          if (url.endsWith(".json")) return missingJson ? new Response("missing", { status: 404 })
            : Response.json({ title, duration: duration / 1000 });
          assert.equal(url, `https://lrc.red/s/${id}.ttml`);
          ttmlFetches++;
          return new Response(content);
        }, mobile);
        context.track = { trackId: id, isrc: id, title, artist, durationMs: duration };
        vm.runInContext('var service = createLyricsService()', context);
        const result = await vm.runInContext('service.fetchSyncedLyrics(track, { preferredSource: "lrc-red" })', context);
        const cached = await vm.runInContext('service.fetchSyncedLyrics(track, { preferredSource: "lrc-red" })', context);
        assert.equal(ttmlFetches, 1, 'Second request uses the source cache');
        for (const packet of [result, cached, vm.runInContext('service.getCachedLyrics(track.trackId)', context)]) {
          assert.equal(packet.lyrics.filter(line => line.translatedText).length, count);
          assert.equal(packet.metadata.ttml.translationTracks[0].language, 'en-US');
          assert.equal(packet.metadata.ttml.appliedTranslations.length, count);
        }
        assert.equal(JSON.stringify(cached.lyrics), JSON.stringify(result.lyrics));
        assert.equal(result.lyrics.filter(line => line.translatedText).length, count);
        assert.equal(result.metadata.ttml.content, content);
        assert.equal(result.metadata.ttml.translationTracks[0].lines.length, count);
        assert.equal(result.metadata.attribution.source, "lrc-red");
        assert.equal(result.source.split('|')[0], id === "US5TA1500050" ? "lrc-red-line" : "lrc-red-karaoke");
        context.metadata = result.metadata;
        assert.equal(vm.runInContext("mergeLyricsMetadata(metadata).ttml.translationTracks[0].lines.length", context), count);
      }
    }
  });

  test(`${platform}: requested language selects retained source tracks on cache hits; AI fills missing source lines`, async () => {
    const content = `<tt xmlns:lrc="http://lrc.red/lyric-ttml-internal" lrc:timing="Word"><head><metadata>
      <sourceMetadata xmlns="http://lrc.red/lyric-ttml-internal"><translations>
      <translation xml:lang="en" type="subtitle"><text for="A">Hello world</text></translation>
      <translation xml:lang="es" type="subtitle"><text for="A">Hola mundo</text></translation>
      </translations></sourceMetadata></metadata></head><body><p lrc:key="A" begin="1" end="9">안녕하세요</p></body></tt>`;
    let ttmlFetches = 0;
    const aiLanguages = [];
    const context = load(async (url, options) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        const body = JSON.parse(options.body);
        const payload = JSON.parse(body.contents[0].parts[0].text);
        aiLanguages.push(payload.targetLanguage);
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ lineCount: 1,
          translations: [{ i: 0, t: "Bonjour le monde" }] }) }] } }] });
      }
      if (url.endsWith(".json")) return Response.json({});
      assert.ok(url.endsWith(".ttml"));
      ttmlFetches++;
      return new Response(content);
    }, mobile);
    context.track = { ...track, trackId: "metadata-language", isrc };
    vm.runInContext('var service = createLyricsService({ getGeminiApiKey: () => "test-key" })', context);
    const fetchLanguage = language => {
      context.language = language;
      return vm.runInContext('service.fetchSyncedLyrics(track, { preferredSource: "lrc-red", translationLanguage: language })', context);
    };
    const english = await fetchLanguage("English");
    assert.equal(english.lyrics[0].translatedText, "Hello world");
    const spanish = await fetchLanguage("Spanish");
    assert.equal(spanish.lyrics[0].translatedText, "Hola mundo");
    const french = await fetchLanguage("French");
    assert.equal(french.lyrics[0].translatedText, undefined);
    assert.equal(ttmlFetches, 1, "Language switches use retained tracks without another provider request");
    assert.deepEqual(aiLanguages, [], "Source translations do not trigger unsolicited AI requests");
    context.published = spanish;
    vm.runInContext('service.rememberPublishedLyrics(track.trackId, published)', context);
    const translated = await vm.runInContext('service.translatePublishedLyrics(track, { translationLanguage: "French" })', context);
    assert.equal(translated.lyrics[0].translatedText, "Bonjour le monde");
    assert.deepEqual(aiLanguages, ["French"]);
    assert.equal(translated.metadata.ttml.translationTracks.length, 2);
    assert.equal(translated.metadata.translation.provider, "Gemini");
  });
}

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";
  test(`${platform}: searches and preserves karaoke timing, joins, background vocals and credit`, async () => {
    const calls = [];
    const context = load(async (url, options) => {
      if (url.includes("api.deezer.com")) return new Response('{"data":[]}');
      if (url.endsWith(".json") && !url.includes("search.json")) return new Response('{"sync":"word"}');
      calls.push({ url, options });
      return new Response(url.includes("search.json") ? JSON.stringify({ hits: [
        { isrc: "USAAA2600001", title: "Example Song (Live)", artist: track.artist, duration: 10 },
        { isrc: "USAAA2600002", title: track.title, artist: "Wrong Singer", duration: 10 },
        { isrc, title: track.title, artist: track.artist, duration: 10 },
      ] }) : wordTtml);
    }, mobile);
    const result = await vm.runInContext("fetchFromLrcRed(track).then(finalizeFetchedLyricsResult)", context);
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0].url).searchParams.get("q"), `${track.title} ${track.artist}`);
    assert.equal(calls[1].url, `https://lrc.red/s/${isrc}.ttml`);
    assert.equal(calls[1].options.headers.Authorization, undefined);
    assert.equal(result.source, "lrc-red-karaoke");
    assert.equal(result.lyrics[0].syllables[0].startTime, 1000);
    assert.equal(result.lyrics[0].syllables[1].startTime, 3000);
    assert.equal(result.lyrics[0].syllables.map(s => s.text).join(""), "Hello world");
    assert(result.lyrics[0].backgroundSyllables.length);
    assert.equal(result.metadata.attribution.provider, "lrc.red");
    assert.equal(result.metadata.ttml.content, wordTtml);
    context.metadata = result.metadata;
    assert.equal(vm.runInContext('mergeLyricsMetadata(metadata).ttml.content', context), wordTtml);
    const exporter = require(mobile ? "../../ExpoLyrics/lib/lyrics-ttml-export" : "../src/lyricsTtmlExport");
    assert.equal(exporter.detectLyricsTimingMode(result.lyrics, result.source), "karaoke");
    assert.equal(vm.runInContext('sanitizePreferredSource("lrc.red")', context), "lrc-red");
    assert.equal(vm.runInContext('getSourceAttemptOrder("auto")[1]', context), "lrc-red");
  });

  test(`${platform}: direct ISRC, line timing, no match, static and API failure`, async () => {
    for (const [body, status, expected] of [[lineTtml, 200, "lrc-red-line"], ["missing", 404, null],
      ['<tt><body><p>Static</p></body></tt>', 200, null],
      ['<tt><body><p begin="0" end="0">Static</p></body></tt>', 200, null],
      ['<html>Error</html>', 200, null]]) {
      const context = load(async (url) => {
        if (url.includes("search.json")) return new Response('{"hits":[]}');
        if (url.includes("api.deezer.com")) return Response.json({ data: [] });
        if (url.endsWith(".json")) return new Response('{"sync":"line"}');
        assert.equal(url, `https://lrc.red/s/${isrc}.ttml`);
        return new Response(body, { status });
      }, mobile);
      context.track.isrc = "GB-UM7-10-29604";
      const result = await vm.runInContext("fetchFromLrcRed(track)", context);
      assert.equal(result?.source || null, expected);
      if (result) {
        const exporter = require(mobile ? "../../ExpoLyrics/lib/lyrics-ttml-export" : "../src/lyricsTtmlExport");
        assert.equal(exporter.detectLyricsTimingMode(result.lyrics, result.source), "interpolated");
      }
    }
    const directWithTtmlIdentity = load(async url => {
      if (url.endsWith(".json")) return new Response("missing", { status: 404 });
      return new Response('<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata" lrc:timing="Word"><ttm:title>Example Song</ttm:title><ttm:agent><ttm:name>Example Artist</ttm:name></ttm:agent><body><p begin="1" end="9"><span begin="1" end="9">Hello</span></p></body></tt>');
    }, mobile);
    directWithTtmlIdentity.track.isrc = isrc;
    assert.equal((await vm.runInContext("fetchFromLrcRed(track)", directWithTtmlIdentity))?.source, "lrc-red-karaoke");
    const context = load(async () => new Response("unavailable", { status: 503 }), mobile);
    context.track.isrc = isrc;
    await assert.rejects(vm.runInContext("fetchFromLrcRed(track)", context), /503/);
    const miss = load(async () => new Response('{"hits":[]}'), mobile);
    assert.equal(await vm.runInContext("fetchFromLrcRed(track)", miss), null);
  });

  test(`${platform}: TTML survives missing JSON metadata and Deezer resolves a track without an ISRC`, async () => {
    const calls = [];
    const crushTrack = { title: "seesaw (Feat. IU)", artist: "Crush", durationMs: 181000,
      spotifyTrackId: "3lTdjfpGVeYLeHfrczXw1a" };
    const context = load(async url => {
      calls.push(url);
      if (url.includes("api.deezer.com/search")) return Response.json({ data: [
        { isrc: "ZZA0P2622376", title: crushTrack.title, artist: { name: "Crush" }, duration: 181 },
      ] });
      if (url.includes("search.json")) return Response.json({ hits: [] });
      if (url.endsWith(".json")) return new Response("missing", { status: 404 });
      assert.equal(url, "https://lrc.red/s/ZZA0P2622376.ttml");
      return new Response(crushSeesawTtml);
    }, mobile);
    context.track = crushTrack;
    const result = await vm.runInContext("fetchFromLrcRed(track)", context);
    assert.equal(result?.source, "lrc-red-karaoke");
    assert.equal(result?.lyrics.length, 42);
    assert.equal(result?.lyrics.at(-1).lineEndTime, 164925);
    assert(calls.includes("https://lrc.red/s/ZZA0P2622376.json"));
    assert(calls.includes("https://lrc.red/s/ZZA0P2622376.ttml"));
    assert(!calls.some(url => url.includes("search.json")), "successful Deezer match should bypass empty lrc.red search");
    assert.equal(result.metadata.attribution.url, "https://lrc.red/s/ZZA0P2622376");

    const rejectsTtml = async content => {
      const mismatch = load(async url => {
        if (url.includes("api.deezer.com")) return Response.json({ data: [] });
        if (url.includes("search.json")) return Response.json({ hits: [] });
        if (url.endsWith(".json")) return new Response("missing", { status: 404 });
        return new Response(content);
      }, mobile);
      mismatch.track = { ...crushTrack, isrc: "ZZA0P2622376" };
      return vm.runInContext("fetchFromLrcRed(track)", mismatch);
    };
    assert.equal(await rejectsTtml(crushSeesawTtml.replace("<head>", "<head><ttm:title>Different Song</ttm:title>")), null,
      "TTML title mismatch must be rejected");
    assert.equal(await rejectsTtml(crushSeesawTtml.replace("<head>", "<head><ttm:agent><ttm:name>Different Artist</ttm:name></ttm:agent>")), null,
      "TTML artist mismatch must be rejected");
    assert.equal(await rejectsTtml(crushSeesawTtml.replaceAll("2:44.925", "3:20.000")), null,
      "TTML timing substantially beyond the real 181-second recording must be rejected");
    assert.equal(await rejectsTtml("<html>not a TTML document</html>"), null,
      "malformed TTML must be rejected");
  });

  for (const example of [
    { title: "ew", artist: "DPR CREAM", durationMs: 125000, isrc: "KRMIM2652961", sync: "word" },
    { title: "Rewind", artist: "Wonder Girls", durationMs: 210000, isrc: "US5TA1500050", sync: "line" },
  ]) {
    test(`${platform}: resolves ${example.title} through Deezer despite an empty lrc.red index and caches the ISRC`, async () => {
      const calls = [];
      const context = load(async (url, options) => {
        calls.push(url);
        if (url.includes("api.deezer.com")) {
          assert.equal(new URL(url).searchParams.get("q"), `${example.artist} ${example.title}`);
          return new Response(JSON.stringify({ data: [
            { ...example, isrc: "USAAA2600001", artist: { name: "Wrong Artist" }, duration: example.durationMs / 1000 },
            { ...example, isrc: "USAAA2600002", artist: { name: example.artist }, duration: example.durationMs / 1000 + 4 },
            { ...example, artist: { name: example.artist }, duration: example.durationMs / 1000 },
          ] }));
        }
        assert.match(options.headers["User-Agent"], /KineSync/);
        if (url.includes("search.json")) return new Response('{"hits":[]}');
        assert(url.includes(`/s/${example.isrc}.`));
        if (url.endsWith(".json")) return new Response(JSON.stringify({ sync: example.sync, lines: 12, artist: "Localized name" }));
        return new Response(example.sync === "word" ? wordTtml : lineTtml);
      }, mobile);
      context.track = { title: example.title, artist: example.artist, durationMs: example.durationMs };
      for (let i = 0; i < 2; i++) {
        const result = await vm.runInContext("fetchFromLrcRed(track)", context);
        assert.equal(result.source, example.sync === "word" ? "lrc-red-karaoke" : "lrc-red-line");
      }
      assert.equal(calls.filter(url => url.includes("api.deezer.com")).length, 1);
      assert.equal(calls.filter(url => url.includes("search.json")).length, example.sync === "line" ? 2 : 0);
    });
  }

  test(`${platform}: corroborates localized artists with a catalog artist ID`, async () => {
    for (const confirmed of [true, false]) {
      const calls = [];
      const context = load(async url => {
        calls.push(url);
        if (url.includes("search/artist")) return Response.json({ data: [{ id: confirmed ? 7 : 99, name: "BTS" }] });
        if (url.includes("api.deezer.com/search")) return Response.json({ data: [
          { title: track.title, artist: { id: 7, name: "BTS" }, duration: 10, isrc },
        ] });
        if (url.includes("search.json")) return Response.json({ hits: [] });
        return url.endsWith(".json") ? Response.json({ sync: "word" }) : new Response(wordTtml);
      }, mobile);
      context.track.artist = "방탄소년단";
      const result = await vm.runInContext("fetchFromLrcRed(track)", context);
      assert.equal(result?.source || null, confirmed ? "lrc-red-karaoke" : null);
      assert.equal(calls.some(url => url.includes("search/artist")), true);
      assert.equal(calls.some(url => url.includes("/s/")), confirmed);
    }
  });

  test(`${platform}: rejects different versions, remaster years, artists and durations`, async () => {
    const cases = [
      ["Example Song", "Example Song (Live)"],
      ["Example Song", "Example Song (2022 Mix)"],
      ["Example Song", "Example Song (Home Demo)"],
      ["Example Song", "Example Song (Mono)"],
      ["Example Song - Remastered 2009", "Example Song (Remastered 2015)"],
    ];
    for (const [wanted, actual] of cases) {
      const context = load(async url => {
        if (url.includes("api.deezer.com")) return Response.json({ data: [] });
        if (url.includes("search.json")) return Response.json({ hits: [
          { isrc, title: actual, artist: track.artist, duration: 10 },
          { isrc, title: wanted, artist: "Unrelated Singer", duration: 10 },
          { isrc, title: wanted, artist: track.artist, duration: 14 },
        ] });
        assert.fail(`wrong recording must not be fetched: ${wanted} / ${actual} / ${url}`);
      }, mobile);
      context.track.title = wanted;
      assert.equal(await vm.runInContext("fetchFromLrcRed(track)", context), null);
    }
    const context = load(async url => {
      if (url.includes("api.deezer.com")) return Response.json({ data: [
        { isrc, title: "Example Song (2009 - Remaster)", artist: { name: track.artist }, duration: 10 },
      ] });
      return url.endsWith(".json") ? Response.json({ sync: "word", duration: 10 }) : new Response(wordTtml);
    }, mobile);
    context.track.title = "Example Song - Remastered 2009";
    assert.equal((await vm.runInContext("fetchFromLrcRed(track)", context)).source, "lrc-red-karaoke");
  });

  test(`${platform}: deduplicates catalog ISRCs and upgrades line results through text fallback`, async () => {
    const calls = [];
    const context = load(async url => {
      calls.push(url);
      if (url.includes("api.deezer.com")) return Response.json({ data: [0, 1, 2, 3].map(i => ({
        isrc: i < 3 ? isrc : "USAAA2600002", title: track.title,
        artist: { name: track.artist }, duration: 10,
      })) });
      if (url.includes("search.json")) return Response.json({ hits: [
        { isrc: "USAAA2600003", title: track.title, artist: track.artist, duration: 10 },
      ] });
      if (url.includes("USAAA2600003")) return url.endsWith(".json") ? Response.json({ sync: "word" }) : new Response(wordTtml);
      if (url.includes("USAAA2600002")) return new Response("missing", { status: 404 });
      return url.endsWith(".json") ? Response.json({ sync: "line" }) : new Response(lineTtml);
    }, mobile);
    const result = await vm.runInContext("fetchFromLrcRed(track)", context);
    assert.equal(result.source, "lrc-red-karaoke");
    assert.equal(calls.filter(url => url.endsWith(`/${isrc}.json`)).length, 1);
    assert(calls.some(url => url.includes("USAAA2600002")));
    assert(calls.some(url => url.includes("search.json")));
  });

  test(`${platform}: retries catalog after a stale direct ISRC and rejects recording duration mismatch`, async () => {
    const context = load(async url => {
      if (url.includes("api.deezer.com")) return Response.json({ data: [
        { isrc, title: track.title, artist: { name: track.artist }, duration: 10 },
      ] });
      if (url.includes("USAAA2600001")) return Response.json({ sync: "word", duration: 14 });
      return url.endsWith(".json") ? Response.json({ sync: "word", duration: 10 }) : new Response(wordTtml);
    }, mobile);
    context.track.isrc = "USAAA2600001";
    const result = await vm.runInContext("fetchFromLrcRed(track)", context);
    assert.equal(result.metadata.attribution.url, `https://lrc.red/s/${isrc}`);
  });

  test(`${platform}: priority holds in both arrival orders without promoting line lyrics over karaoke`, () => {
    const context = load(async () => { throw Error("unexpected fetch"); }, mobile);
    context.lyrics = [{ text: "Hello world", lineStartTime: 1000, lineEndTime: 9000, syllables: [] }];
    const upgrades = (from, to) => {
      context.from = from; context.to = to;
      return vm.runInContext("shouldUpgradeLyricsCandidate(track, { source: from, lyrics }, { source: to, lyrics })", context);
    };
    for (const source of ["spicy-lyrics-syllable", "kugou-krc", "qq-musicu-qrc", "netease-yrc", "musixmatch-richsync"]) {
      assert.equal(upgrades(source, "lrc-red-karaoke"), true, source);
      assert.equal(upgrades("lrc-red-karaoke", source), false, source);
      assert.equal(upgrades(source, "lrc-red-line"), false, source);
      assert.equal(upgrades("lrc-red-line", source), true, source);
    }
    assert.equal(upgrades("spicy-lyrics-line", "lrc-red-line"), true);
    assert.equal(upgrades("lrc-red-line", "spicy-lyrics-line"), false);
    assert.equal(vm.runInContext('getSourcePriorityBucket("lrc-red-line") > getSourcePriorityBucket("spicy-lyrics-line")', context), true);
  });

  test(`${platform}: top-ranked lrc-red karaoke returns without waiting for a hanging lower-ranked request`, async () => {
    const started = [];
    const deferreds = [];
    let resolveStarted;
    const startedAll = new Promise((resolve) => { resolveStarted = resolve; });
    const context = load(async (url) => {
      if (url.includes("api.deezer.com")) return Response.json({ data: [] });
      if (url.endsWith(".json") && !url.includes("search.json")) return Response.json({ sync: "word" });
      if (url.includes("search.json")) {
        return new Response(JSON.stringify({ hits: [
          { isrc: "USAAA2600001", title: track.title, artist: track.artist, duration: 10 },
          { isrc: "USAAA2600002", title: track.title, artist: track.artist, duration: 10 },
        ] }));
      }
      const index = url.includes("USAAA2600001") ? 0 : 1;
      started.push(index);
      if (started.length === 2) resolveStarted();
      return new Promise((resolve) => {
        deferreds[index] = resolve;
      });
    }, mobile);
    context.track = { title: track.title, artist: track.artist, durationMs: track.durationMs };
    const resultPromise = vm.runInContext("fetchFromLrcRed(track)", context);
    await startedAll;
    assert.deepEqual(started.slice().sort(), [0, 1]);
    deferreds[0](new Response(wordTtml));
    const result = await resultPromise;
    assert.equal(result.source, "lrc-red-karaoke");
    assert.ok(String(result.metadata.attribution.url).includes("USAAA2600001"));
    deferreds[1](new Response(wordTtml));
  });

  test(`${platform}: lrc-red candidate priority holds when lower-ranked requests complete first`, async () => {
    const started = [];
    const deferreds = [];
    let resolveStarted;
    const startedAll = new Promise((resolve) => { resolveStarted = resolve; });
    const context = load(async (url) => {
      if (url.includes("api.deezer.com")) return Response.json({ data: [] });
      if (url.endsWith(".json") && !url.includes("search.json")) return Response.json({ sync: "word" });
      if (url.includes("search.json")) {
        return new Response(JSON.stringify({ hits: [
          { isrc: "USAAA2600001", title: track.title, artist: track.artist, duration: 10 },
          { isrc: "USAAA2600002", title: track.title, artist: track.artist, duration: 10 },
        ] }));
      }
      const index = url.includes("USAAA2600001") ? 0 : 1;
      started.push(index);
      if (started.length === 2) resolveStarted();
      return new Promise((resolve) => {
        deferreds[index] = resolve;
      });
    }, mobile);
    context.track = { title: track.title, artist: track.artist, durationMs: track.durationMs };
    const resultPromise = vm.runInContext("fetchFromLrcRed(track)", context);
    await startedAll;
    assert.deepEqual(started.slice().sort(), [0, 1]);
    // Lower-ranked candidate completes first, but must not win.
    deferreds[1](new Response(wordTtml));
    deferreds[0](new Response(wordTtml));
    const result = await resultPromise;
    assert.equal(result.source, "lrc-red-karaoke");
    assert.ok(String(result.metadata.attribution.url).includes("USAAA2600001"));
  });
}
