"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");

function load(fetchImpl, mobile = false) {
  const src = path.resolve(__dirname, "../src");
  const context = vm.createContext({
    AbortController,
    Buffer,
    clearTimeout,
    setTimeout,
    clearInterval,
    setInterval,
    TextDecoder,
    URL,
    URLSearchParams,
    console: { ...console, debug() {} },
    fetch: fetchImpl || (() => { throw new Error("Unexpected network request"); }),
    global: {},
    module: { exports: {} },
    process: { env: {} },
    require: createRequire(path.join(src, "lyricsService.js")),
  });

  if (mobile) {
    const mobilePath = path.resolve(src, "../../ExpoLyrics/lib/mobile-lyrics-service.js");
    let source = fs.readFileSync(mobilePath, "utf8");
    assert(
      source.includes("resolveIsrcNativeTitle"),
      "Mobile bundle must include resolveIsrcNativeTitle (caller regenerated mobile bundle)",
    );
    source = source.replace(/^import .*;\r?\n/gm, "");
    vm.runInContext(source.slice(0, source.indexOf("export {")), context);
  } else {
    const index = fs.readFileSync(path.join(src, "lyrics/index.js"), "utf8");
    for (const match of index.match(/const partFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)) {
      vm.runInContext(
        fs.readFileSync(path.join(src, "lyrics/parts", match[1]), "utf8"),
        context,
      );
    }
  }
  return context;
}

const spotifyMayday = {
  title: "Mayday (feat. JOY)",
  artist: "Crush",
  durationMs: 199000,
  isrc: "KRMIM2011544",
};

const kugouMaydaySong = {
  songname: "자나깨나",
  songname_suffix: "(Mayday)",
  singername: "Crush、JOY",
  filename: "Crush、JOY - 자나깨나 (Mayday)",
  hash: "45f36318eacf3a6776405c4f0e7e28af",
  duration: 199,
};

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";

  test(`${label}: normalizeKugouSong incorporates songname_suffix and bracketed filename aliases`, () => {
    const ctx = load(null, mobile);

    // Case 1: with songname_suffix "(Mayday)"
    const norm1 = ctx.normalizeKugouSong(kugouMaydaySong);
    assert.equal(norm1.title, "자나깨나 (Mayday)");
    assert.equal(norm1.artist, "Crush、JOY");
    assert.equal(norm1.durationMs, 199000);
    assert.equal(norm1.hash, "45f36318eacf3a6776405c4f0e7e28af");

    // Case 2: empty suffix, bracketed segment only in filename
    const norm2 = ctx.normalizeKugouSong({
      songname: "자나깨나",
      songname_suffix: "",
      singername: "Crush、JOY",
      filename: "Crush、JOY - 자나깨나 (Mayday)",
      duration: 199,
    });
    assert.equal(norm2.title, "자나깨나 (Mayday)");

    // Case 3: suffix without parentheses e.g. "Mayday"
    const norm3 = ctx.normalizeKugouSong({
      songname: "자나깨나",
      songname_suffix: "Mayday",
      singername: "Crush、JOY",
      filename: "Crush、JOY - 자나깨나 (Mayday)",
      duration: 199,
    });
    assert.equal(norm3.title, "자나깨나 (Mayday)");

    // Case 4: bracketed version tags like (Live) in filename are preserved in title
    const normLive = ctx.normalizeKugouSong({
      songname: "자나깨나",
      songname_suffix: "(Mayday)",
      singername: "Crush、JOY",
      filename: "Crush、JOY - 자나깨나 (Mayday) (Live)",
      duration: 199,
    });
    assert(normLive.title.includes("(Live)"));
  });

  test(`${label}: isLikelySameKugouTrack matches Spotify Mayday against Kugou 자나깨나 (Mayday)`, () => {
    const ctx = load(null, mobile);

    const norm = ctx.normalizeKugouSong(kugouMaydaySong);
    const matches = ctx.isLikelySameKugouTrack(
      spotifyMayday,
      norm.title,
      norm.artist,
      norm.durationMs,
    );
    assert.equal(matches, true);
  });

  test(`${label}: isLikelySameKugouTrack matches via nativeTitle alias even without Mayday in candidate title`, () => {
    const ctx = load(null, mobile);

    // Candidate has only Korean title "자나깨나" and no Mayday
    const norm = ctx.normalizeKugouSong({
      songname: "자나깨나",
      singername: "Crush、JOY",
      filename: "Crush、JOY - 자나깨나",
      duration: 199,
    });
    const matches = ctx.isLikelySameKugouTrack(
      spotifyMayday,
      norm.title,
      norm.artist,
      norm.durationMs,
      { nativeTitle: "자나깨나" },
    );
    assert.equal(matches, true);
  });

  test(`${label}: rejects wrong artist, wrong duration, live, and remix negatives`, () => {
    const ctx = load(null, mobile);

    // Negative 1: Wrong artist
    const wrongArtistNorm = ctx.normalizeKugouSong({
      ...kugouMaydaySong,
      singername: "IU",
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        spotifyMayday,
        wrongArtistNorm.title,
        wrongArtistNorm.artist,
        wrongArtistNorm.durationMs,
      ),
      false,
      "Must reject wrong artist",
    );

    // Negative 2: Wrong duration (e.g. 250s vs 199s)
    const wrongDurationNorm = ctx.normalizeKugouSong({
      ...kugouMaydaySong,
      duration: 250,
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        spotifyMayday,
        wrongDurationNorm.title,
        wrongDurationNorm.artist,
        wrongDurationNorm.durationMs,
      ),
      false,
      "Must reject mismatched duration",
    );

    // Negative 3: Live recording version negative
    const liveNorm = ctx.normalizeKugouSong({
      ...kugouMaydaySong,
      filename: "Crush、JOY - 자나깨나 (Mayday) (Live)",
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        spotifyMayday,
        liveNorm.title,
        liveNorm.artist,
        liveNorm.durationMs,
      ),
      false,
      "Must reject Live version when studio track requested",
    );

    // Negative 4: Remix recording version negative
    const remixNorm = ctx.normalizeKugouSong({
      ...kugouMaydaySong,
      filename: "Crush、JOY - 자나깨나 (Mayday) (Remix)",
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        spotifyMayday,
        remixNorm.title,
        remixNorm.artist,
        remixNorm.durationMs,
      ),
      false,
      "Must reject Remix version when studio track requested",
    );

    // Negative 5: Native alias match must not discard recording version guards
    assert.equal(
      ctx.isLikelySameKugouTrack(
        spotifyMayday,
        liveNorm.title,
        liveNorm.artist,
        liveNorm.durationMs,
        { nativeTitle: "자나깨나" },
      ),
      false,
      "Native alias match must preserve recording version guards",
    );

    // Negative 6: Reverse check - Live track requested against studio candidate
    assert.equal(
      ctx.isLikelySameKugouTrack(
        { ...spotifyMayday, title: "Mayday (Live)" },
        ctx.normalizeKugouSong(kugouMaydaySong).title,
        kugouMaydaySong.singername,
        199000,
      ),
      false,
      "Must reject studio candidate when Live track requested",
    );
  });

  test(`${label}: explicit version annotations prevent false positives for titles containing live or mix words`, () => {
    const ctx = load(null, mobile);

    const liveForeverStudio = { title: "Live Forever", artist: "Oasis", durationMs: 276000 };
    const liveForeverLiveCandidate = ctx.normalizeKugouSong({
      songname: "Live Forever",
      singername: "Oasis",
      filename: "Oasis - Live Forever (Live)",
      duration: 276,
    });
    // Live Forever vs Live Forever (Live) must be rejected
    assert.equal(
      ctx.isLikelySameKugouTrack(
        liveForeverStudio,
        liveForeverLiveCandidate.title,
        liveForeverLiveCandidate.artist,
        liveForeverLiveCandidate.durationMs,
      ),
      false,
      "Live Forever studio must not match Live Forever (Live)",
    );

    // Ordinary Live Forever studio vs Live Forever studio unchanged
    const liveForeverStudioCandidate = ctx.normalizeKugouSong({
      songname: "Live Forever",
      singername: "Oasis",
      filename: "Oasis - Live Forever",
      duration: 276,
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        liveForeverStudio,
        liveForeverStudioCandidate.title,
        liveForeverStudioCandidate.artist,
        liveForeverStudioCandidate.durationMs,
      ),
      true,
      "Ordinary Live Forever studio must match Live Forever studio",
    );

    // Ordinary Mix Tape studio vs Mix Tape studio unchanged
    const mixTapeStudio = { title: "Mix Tape", artist: "Brand New", durationMs: 237000 };
    const mixTapeCandidate = ctx.normalizeKugouSong({
      songname: "Mix Tape",
      singername: "Brand New",
      filename: "Brand New - Mix Tape",
      duration: 237,
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        mixTapeStudio,
        mixTapeCandidate.title,
        mixTapeCandidate.artist,
        mixTapeCandidate.durationMs,
      ),
      true,
      "Ordinary Mix Tape studio must match Mix Tape studio",
    );

    // Mix Tape studio vs Mix Tape (Remix) rejected
    const mixTapeRemixCandidate = ctx.normalizeKugouSong({
      songname: "Mix Tape",
      singername: "Brand New",
      filename: "Brand New - Mix Tape (Remix)",
      duration: 237,
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        mixTapeStudio,
        mixTapeRemixCandidate.title,
        mixTapeRemixCandidate.artist,
        mixTapeRemixCandidate.durationMs,
      ),
      false,
      "Mix Tape studio must reject Mix Tape (Remix)",
    );
  });

  test(`${label}: native alias preserves original Spotify version guards in both directions`, () => {
    const ctx = load(null, mobile);

    const maydayLiveTrack = { title: "Mayday (Live)", artist: "Crush", durationMs: 199000 };
    const studioCandidate = ctx.normalizeKugouSong({
      songname: "자나깨나",
      singername: "Crush",
      filename: "Crush - 자나깨나",
      duration: 199,
    });

    // Mayday(Live) vs native studio rejected even if resolver alias omits live
    assert.equal(
      ctx.isLikelySameKugouTrack(
        maydayLiveTrack,
        studioCandidate.title,
        studioCandidate.artist,
        studioCandidate.durationMs,
        { nativeTitle: "자나깨나" },
      ),
      false,
      "Mayday (Live) must reject studio candidate even if resolver alias omits live",
    );

    // Mayday studio vs native(Live) rejected even if resolver alias has live
    const liveCandidate = ctx.normalizeKugouSong({
      songname: "자나깨나",
      singername: "Crush",
      filename: "Crush - 자나깨나 (Live)",
      duration: 199,
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        spotifyMayday,
        liveCandidate.title,
        liveCandidate.artist,
        liveCandidate.durationMs,
        { nativeTitle: "자나깨나 (Live)" },
      ),
      false,
      "Mayday studio must reject candidate when candidate is Live, even if resolver alias has live",
    );
  });

  test(`${label}: native alias uses strict tolerance without broadening single-artist fallback to 25s`, () => {
    const ctx = load(null, mobile);

    // Single artist track (Crush only) matching solely via native alias
    const singleArtistTrack = { title: "Mayday", artist: "Crush", durationMs: 199000 };

    // Candidate delta: 223000 - 199000 = 24000ms (within old 25s fallback, but exceeds strict 6s/12s tolerance)
    const broadenedDurationCandidate = ctx.normalizeKugouSong({
      songname: "자나깨나",
      singername: "Crush",
      filename: "Crush - 자나깨나",
      duration: 223,
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        singleArtistTrack,
        broadenedDurationCandidate.title,
        broadenedDurationCandidate.artist,
        broadenedDurationCandidate.durationMs,
        { nativeTitle: "자나깨나" },
      ),
      false,
      "Native alias must reject 24s duration delta (no broadening to 25s)",
    );

    // Candidate within strict tolerance: delta = 202000 - 199000 = 3000ms <= 6000ms
    const strictDurationCandidate = ctx.normalizeKugouSong({
      songname: "자나깨나",
      singername: "Crush",
      filename: "Crush - 자나깨나",
      duration: 202,
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        singleArtistTrack,
        strictDurationCandidate.title,
        strictDurationCandidate.artist,
        strictDurationCandidate.durationMs,
        { nativeTitle: "자나깨나" },
      ),
      true,
      "Native alias must accept delta within strict tolerance (3s)",
    );
  });

  test(`${label}: ordinary English and Korean matches pass`, () => {
    const ctx = load(null, mobile);

    // Ordinary English match
    const btsEnglish = { title: "Dynamite", artist: "BTS", durationMs: 199000 };
    const btsCandidate = ctx.normalizeKugouSong({
      songname: "Dynamite",
      singername: "BTS",
      duration: 199,
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        btsEnglish,
        btsCandidate.title,
        btsCandidate.artist,
        btsCandidate.durationMs,
      ),
      true,
    );

    // Ordinary Korean match
    const btsKorean = { title: "봄날", artist: "방탄소년단", durationMs: 274000 };
    const btsKoreanCandidate = ctx.normalizeKugouSong({
      songname: "봄날",
      singername: "방탄소년단",
      duration: 274,
    });
    assert.equal(
      ctx.isLikelySameKugouTrack(
        btsKorean,
        btsKoreanCandidate.title,
        btsKoreanCandidate.artist,
        btsKoreanCandidate.durationMs,
      ),
      true,
    );
  });

  test(`${label}: buildKugouQueryVariants places nativeTitle first with primary artist`, () => {
    const ctx = load(null, mobile);

    const variants = ctx.buildKugouQueryVariants(spotifyMayday, "자나깨나");
    assert.equal(variants[0], "자나깨나 Crush");
    assert(variants.includes("자나깨나"));
    assert(variants.some(v => v.includes("Mayday")));
  });

  test(`${label}: ISRC resolver handles success, fallback, cache, in-flight dedupe, timeout, failures, TTL, bound, and no ISRC`, async () => {
    let deezerCalls = 0;
    let musicBrainzCalls = 0;
    let dedupeFetchCalls = 0;
    let dedupeResolve;
    const dedupeDeferred = new Promise((resolve) => {
      dedupeResolve = resolve;
    });

    let slowResolve;
    const slowDeferred = new Promise((resolve) => {
      slowResolve = resolve;
    });

    let negCalls = 0;
    let ttlCalls = 0;

    const mockFetch = async (url) => {
      const urlStr = String(url);

      // Success fixture: KRMIM2011544
      if (urlStr.includes("api.deezer.com/track/isrc:KRMIM2011544")) {
        deezerCalls++;
        return new Response(
          JSON.stringify({
            id: 966961802,
            title: "자나깨나 (Mayday)",
            title_short: "자나깨나",
            artist: { name: "Crush" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Fallback fixture: KRABC2000001
      if (urlStr.includes("api.deezer.com/track/isrc:KRABC2000001")) {
        deezerCalls++;
        return new Response(
          JSON.stringify({ error: { code: 800, message: "no data" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("musicbrainz.org") && urlStr.includes("KRABC2000001")) {
        musicBrainzCalls++;
        return new Response(
          JSON.stringify({
            isrc: "KRABC2000001",
            recordings: [{ id: "mb-rec-1", title: "자나깨나", isrcs: ["KRABC2000001"] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Network fail fixture: KRABC2000002
      if (urlStr.includes("KRABC2000002")) {
        throw new Error("Network offline");
      }

      // Slow timeout fixture: KRABC2000003 (tolerates mock ignoring abort signal)
      if (urlStr.includes("KRABC2000003")) {
        await slowDeferred;
        return new Response(
          JSON.stringify({ title: "Late Title" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // In-flight dedupe fixture: KRABC2000004
      if (urlStr.includes("KRABC2000004")) {
        dedupeFetchCalls++;
        await dedupeDeferred;
        return new Response(
          JSON.stringify({ title: "Dedupe Title" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // TTL expiry fixture: KRABC2000005
      if (urlStr.includes("KRABC2000005")) {
        ttlCalls++;
        return new Response(
          JSON.stringify({ title: "TTL Title" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Negative cache fixture: KRABC2000006
      if (urlStr.includes("KRABC2000006")) {
        negCalls++;
        return new Response("Not Found", { status: 404 });
      }

      return new Response("Not Found", { status: 404 });
    };

    const ctx = load(mockFetch, mobile);
    const getCache = () => vm.runInContext("kugouIsrcCache", ctx);
    const getInFlight = () => vm.runInContext("kugouIsrcInFlight", ctx);

    // 1. Success via Deezer
    const title1 = await ctx.resolveIsrcNativeTitle("KRMIM2011544");
    assert.equal(title1, "자나깨나 (Mayday)");
    assert.equal(deezerCalls, 1);

    // 2. Cache hit: second call does not re-fetch
    const titleCached = await ctx.resolveIsrcNativeTitle("KRMIM2011544");
    assert.equal(titleCached, "자나깨나 (Mayday)");
    assert.equal(deezerCalls, 1, "Cached call must not trigger fetch");

    // 3. Fallback to MusicBrainz when Deezer misses
    const titleFallback = await ctx.resolveIsrcNativeTitle("KRABC2000001");
    assert.equal(titleFallback, "자나깨나");
    assert.equal(musicBrainzCalls, 1);

    // 4. In-flight dedupe: 3 parallel calls trigger only 1 fetch before resolution
    const p1 = ctx.resolveIsrcNativeTitle("KRABC2000004");
    const p2 = ctx.resolveIsrcNativeTitle("KRABC2000004");
    const p3 = ctx.resolveIsrcNativeTitle("KRABC2000004");
    assert.equal(dedupeFetchCalls, 1, "Only 1 network request should be started for concurrent calls");
    dedupeResolve();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1, "Dedupe Title");
    assert.equal(r2, "Dedupe Title");
    assert.equal(r3, "Dedupe Title");
    assert.equal(dedupeFetchCalls, 1, "Total fetch calls must remain 1 after resolution");

    // 5. Network failure returns null without throwing
    const titleFail = await ctx.resolveIsrcNativeTitle("KRABC2000002");
    assert.equal(titleFail, null);

    // 6. Hard timeout returns null without throwing, clears dedupe/cache, and ignores late result
    const titleTimeout = await ctx.resolveIsrcNativeTitle("KRABC2000003", { timeoutMs: 30 });
    assert.equal(titleTimeout, null);
    assert.equal(getInFlight().has("KRABC2000003"), false, "In-flight map must clear at timeout");
    assert.equal(getCache().has("KRABC2000003"), false, "Cache must clear at timeout");
    // Resolve late request and verify cache is not overwritten by late result
    slowResolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(getCache().has("KRABC2000003"), false, "Late result must not overwrite cache");

    // 7. Negative caching: failed resolution is cached as null so second call doesn't re-fetch
    const neg1 = await ctx.resolveIsrcNativeTitle("KRABC2000006");
    assert.equal(neg1, null);
    assert.equal(negCalls, 2, "1 Deezer call + 1 MusicBrainz fallback call");
    const neg2 = await ctx.resolveIsrcNativeTitle("KRABC2000006");
    assert.equal(neg2, null);
    assert.equal(negCalls, 2, "Second call must hit negative cache without re-fetching");

    // 8. TTL Expiry: entry expires after TTL and triggers a new fetch
    const ttl1 = await ctx.resolveIsrcNativeTitle("KRABC2000005");
    assert.equal(ttl1, "TTL Title");
    assert.equal(ttlCalls, 1);
    const ttlEntry = getCache().get("KRABC2000005");
    assert.ok(ttlEntry);
    ttlEntry.timestamp = Date.now() - (60 * 60 * 1000 + 1000); // 1 hr + 1 sec
    const ttl2 = await ctx.resolveIsrcNativeTitle("KRABC2000005");
    assert.equal(ttl2, "TTL Title");
    assert.equal(ttlCalls, 2, "Expired TTL must re-fetch");

    // 9. Cache 256 size bound: oldest entries evicted when cap reached
    for (let i = 0; i < 256; i++) {
      const isrcKey = `KRABC${String(i).padStart(7, "0")}`;
      ctx.setCachedIsrcNativeTitle(isrcKey, `Title ${i}`);
    }
    assert.equal(getCache().size, 256);
    assert.ok(getCache().has("KRABC0000000"));
    ctx.setCachedIsrcNativeTitle("KRABC9999999", "Newest Title");
    assert.equal(getCache().size, 256, "Cache size must be bounded at 256");
    assert.equal(getCache().has("KRABC0000000"), false, "Oldest entry must be evicted");
    assert.equal(getCache().get("KRABC9999999").value, "Newest Title");

    // 10. No ISRC / invalid ISRC: synchronous null return without fetch
    assert.equal(await ctx.resolveIsrcNativeTitle(""), null);
    assert.equal(await ctx.resolveIsrcNativeTitle(null), null);
    assert.equal(await ctx.resolveIsrcNativeTitle("INVALID"), null);
  });

  test(`${label}: MusicBrainz exact ISRC endpoint verifies top-level ISRC and filters mismatched recording isrcs`, async () => {
    const mockFetch = async (url) => {
      const urlStr = String(url);

      // Deezer misses for these test ISRCs to trigger MusicBrainz fallback
      if (urlStr.includes("api.deezer.com")) {
        return new Response(JSON.stringify({ error: { code: 800 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Case 1: Missing top-level ISRC in MusicBrainz payload
      if (urlStr.includes("KRABC2000008")) {
        return new Response(
          JSON.stringify({
            recordings: [{ id: "mb-rec-1", title: "Should Be Rejected" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Case 2: Mismatched top-level ISRC in MusicBrainz payload
      if (urlStr.includes("KRABC2000009")) {
        return new Response(
          JSON.stringify({
            isrc: "KRWRONG00001",
            recordings: [{ id: "mb-rec-2", title: "Should Be Rejected" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Case 3: First recording has explicit mismatched ISRC, second has matching ISRC
      if (urlStr.includes("KRABC2000010")) {
        return new Response(
          JSON.stringify({
            isrc: "KRABC2000010",
            recordings: [
              {
                id: "mb-rec-wrong",
                title: "Wrong Recording",
                isrcs: ["KRWRONG00002"],
              },
              {
                id: "mb-rec-exact",
                title: "Exact Title",
                isrcs: ["KRABC2000010"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("Not Found", { status: 404 });
    };

    const ctx = load(mockFetch, mobile);

    // 1. Missing top-level ISRC => null
    const missingTopLevel = await ctx.resolveIsrcNativeTitle("KRABC2000008");
    assert.equal(missingTopLevel, null, "Must reject payload missing top-level isrc");

    // 2. Mismatched top-level ISRC => null
    const mismatchedTopLevel = await ctx.resolveIsrcNativeTitle("KRABC2000009");
    assert.equal(mismatchedTopLevel, null, "Must reject payload with mismatched top-level isrc");

    // 3. First recording with explicit wrong isrc is skipped in favor of exact second recording
    const exactRecording = await ctx.resolveIsrcNativeTitle("KRABC2000010");
    assert.equal(exactRecording, "Exact Title", "Must skip explicit wrong isrc recording and choose exact match");
  });

  test(`${label}: resolver race handling proves timedout first, pending retry, finish old, third joins retry no third network, and no stale cache clobber`, async () => {
    let raceFetches = 0;
    let firstResolve;
    const firstDeferred = new Promise((resolve) => {
      firstResolve = resolve;
    });
    let retryResolve;
    const retryDeferred = new Promise((resolve) => {
      retryResolve = resolve;
    });

    const mockFetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("KRABC2000007")) {
        raceFetches++;
        if (raceFetches === 1) {
          // First call: slow, will time out
          await firstDeferred;
          return new Response(
            JSON.stringify({ title: "Stale Late Title" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (raceFetches === 2) {
          // Retry call
          await retryDeferred;
          return new Response(
            JSON.stringify({ title: "Retry Title" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      return new Response("Not Found", { status: 404 });
    };

    const ctx = load(mockFetch, mobile);
    const getCache = () => vm.runInContext("kugouIsrcCache", ctx);
    const getInFlight = () => vm.runInContext("kugouIsrcInFlight", ctx);

    // Step 1: First call times out
    const p1 = ctx.resolveIsrcNativeTitle("KRABC2000007", { timeoutMs: 30 });
    assert.equal(raceFetches, 1, "First fetch started");
    const r1 = await p1;
    assert.equal(r1, null, "First call must time out to null");
    assert.equal(getInFlight().has("KRABC2000007"), false, "In-flight must be cleared on timeout");

    // Step 2: Retry call starts while old first call is still pending
    const p2 = ctx.resolveIsrcNativeTitle("KRABC2000007", { timeoutMs: 500 });
    assert.equal(raceFetches, 2, "Retry fetch started");
    assert.equal(getInFlight().has("KRABC2000007"), true, "In-flight holds retry promise");

    // Step 3: Old first call finally completes. Token-safe cleanup must NOT delete retry from inFlight
    firstResolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(getInFlight().has("KRABC2000007"), true, "Old work finally must NOT erase retry from inFlight");
    assert.equal(getCache().has("KRABC2000007"), false, "Old work must not clobber cache with stale late result");

    // Step 4: Third call arrives while retry is still pending and must join retry without third network call
    const p3 = ctx.resolveIsrcNativeTitle("KRABC2000007", { timeoutMs: 500 });
    assert.equal(raceFetches, 2, "Third call must join in-flight retry, not start a 3rd fetch");

    // Step 5: Finish retry call
    retryResolve();
    const [r2, r3] = await Promise.all([p2, p3]);
    assert.equal(r2, "Retry Title");
    assert.equal(r3, "Retry Title");
    assert.equal(raceFetches, 2, "Total network requests must remain 2");
    assert.equal(getCache().get("KRABC2000007").value, "Retry Title", "Cache must store retry result");
  });

  test(`${label}: collectRankedKugouSearchCandidates offline integration with native first query and noISRC bypass`, async () => {
    const executedQueries = [];
    let deezerFetches = 0;

    const mockFetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("api.deezer.com/track/isrc:KRMIM2011544")) {
        deezerFetches++;
        return new Response(
          JSON.stringify({
            title: "자나깨나",
            artist: { name: "Crush" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("mobileservice.kugou.com")) {
        const parsed = new URL(urlStr);
        const query = parsed.searchParams.get("keyword") || "";
        executedQueries.push(query);
        return new Response(
          JSON.stringify({
            data: {
              info: [kugouMaydaySong],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const ctx = load(mockFetch, mobile);

    // 1. With valid ISRC: resolves native title and uses native title first
    const rankedWithIsrc = await ctx.collectRankedKugouSearchCandidates(spotifyMayday);
    assert(deezerFetches > 0, "Deezer ISRC lookup must be executed");
    assert.equal(executedQueries[0], "자나깨나 Crush", "First query must be native title with primary artist");
    assert(rankedWithIsrc.length > 0);
    assert.equal(rankedWithIsrc[0].hash, "45f36318eacf3a6776405c4f0e7e28af");
    assert.equal(rankedWithIsrc[0].title, "자나깨나 (Mayday)");

    // 2. No ISRC bypass: skips resolver completely, queries start with standard variants
    executedQueries.length = 0;
    const deezerBefore = deezerFetches;
    const noIsrcTrack = {
      title: "Mayday (feat. JOY)",
      artist: "Crush",
      durationMs: 199000,
    };
    const rankedNoIsrc = await ctx.collectRankedKugouSearchCandidates(noIsrcTrack);
    assert.equal(deezerFetches, deezerBefore, "No ISRC track must not trigger ISRC network fetches");
    assert.equal(executedQueries[0], "Mayday (feat. JOY) Crush", "Queries start directly with standard variants");
    assert(rankedNoIsrc.length > 0);
  });

  test(`${label}: fetchFromKugou timeout or null resolves ISRC exactly once and direct collectRanked still resolves`, async () => {
    const mockFetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("mobileservice.kugou.com")) {
        return new Response(
          JSON.stringify({ data: { info: [] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const ctx = load(mockFetch, mobile);

    vm.runInContext(
      `
      let harnessStubCalls = 0;
      resolveIsrcNativeTitle = async () => {
        harnessStubCalls++;
        return null;
      };
      `,
      ctx,
    );

    const trackWithIsrc = {
      title: "Mayday (feat. JOY)",
      artist: "Crush",
      durationMs: 199000,
      isrc: "KRABC2000099",
    };

    const result = await ctx.fetchFromKugou(trackWithIsrc);
    assert.equal(result, null);
    const countAfterFetch = vm.runInContext("harnessStubCalls", ctx);
    assert.equal(
      countAfterFetch,
      1,
      "fetchFromKugou must call ISRC resolver exactly once even on timeout or null",
    );

    const directTrack = {
      title: "Mayday (feat. JOY)",
      artist: "Crush",
      durationMs: 199000,
      isrc: "KRABC2000099",
    };
    await ctx.collectRankedKugouSearchCandidates(directTrack);
    const countAfterDirect = vm.runInContext("harnessStubCalls", ctx);
    assert.equal(
      countAfterDirect,
      2,
      "Direct collectRanked call without nativeTitle still must resolve ISRC",
    );
  });
}
