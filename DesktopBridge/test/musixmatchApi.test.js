"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const src = path.join(root, "DesktopBridge/src");

function load(fetch, mobile) {
  const module = { exports: {} };
  const context = vm.createContext({
    AbortController, AbortSignal, Buffer, clearInterval, clearTimeout, fetch,
    setInterval, setTimeout, TextDecoder, URL, URLSearchParams, Response,
    CryptoJS: require(path.join(root, "ExpoLyrics/node_modules/crypto-js")),
    console: { log() {}, warn() {}, error() {} }, global: {}, module,
    exports: module.exports, process: { env: {} },
    require: createRequire(path.join(src, "lyricsService.js")),
  });
  if (mobile) {
    let source = fs.readFileSync(path.join(root, "ExpoLyrics/lib/mobile-lyrics-service.js"), "utf8");
    source = source.replace(/^import .*;\r?\n/gm, "");
    source = source.slice(0, source.indexOf("export {"));
    vm.runInContext(source, context, { filename: "mobile-lyrics-service.js" });
  } else {
    const index = fs.readFileSync(path.join(src, "lyrics/index.js"), "utf8");
    const list = index.match(/const partFiles = \[([\s\S]*?)\];/)[1];
    for (const match of list.matchAll(/"([^"]+)"/g)) {
      vm.runInContext(fs.readFileSync(path.join(src, "lyrics/parts", match[1]), "utf8"), context);
    }
  }
  return context;
}

const typedToken = (token = "m".repeat(40), acquiredAt = Date.now()) => JSON.stringify({
  profileId: "mac-ios-v2.0@apic-appmobile", appId: "mac-ios-v2.0", userToken: token, acquiredAt,
});
const api = (status, body = {}, hint = "") => ({ message: { header: { status_code: status, hint }, body } });
const macroTrack = (overrides = {}) => ({
  track_name: "Rewind", artist_name: "Wonder Girls", track_length: 210,
  track_id: 41, commontrack_id: 42001, has_richsync: 1, has_subtitles: 1,
  ...overrides,
});
const macroPayload = (track = macroTrack(), matcherStatus = 200, matcherHint = "") => api(200, {
  macro_calls: { "matcher.track.get": { message: api(matcherStatus, { track }, matcherHint).message } },
});
const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { "content-type": "application/json" },
});

for (const mobile of [false, true]) {
  const label = mobile ? "generated mobile" : "desktop";

  test(`${label}: appmobile token identity and TTL are enforced at the lyric resolver`, () => {
    const context = load(async () => { throw new Error("unexpected request"); }, mobile);
    assert.equal(context.resolveMusixmatchClientCandidates(typedToken()).length, 1);
    assert.equal(context.resolveMusixmatchClientCandidates(typedToken("m".repeat(40), Date.now() - 7 * 60 * 60 * 1000)).length, 0);
    assert.equal(context.resolveMusixmatchClientCandidates(JSON.stringify({ profileId: "wrong", appId: "mac-ios-v2.0", userToken: "m".repeat(40), acquiredAt: Date.now() })).length, 0);
    assert.equal(context.resolveMusixmatchClientCandidates(typedToken("0".repeat(54))).length, 0);
  });

  test(`${label}: 401 renew and captcha stay distinct and stop repeated macro requests`, async () => {
    for (const [status, hint, expected] of [[401, "renew", /token was rejected.*renew/i], [401, "captcha", /captcha/i]]) {
      let requests = 0;
      const context = load(async () => { requests++; return jsonResponse(api(status, {}, hint)); }, mobile);
      await assert.rejects(() => context.fetchFromMusixmatch(
        { title: "Rewind", artist: "Wonder Girls", durationMs: 210000 },
        { musixmatchUserToken: typedToken() },
      ), expected);
      assert.equal(requests, 1);
    }
  });

  test(`${label}: HTTP 404 retains endpoint hint and stops macro retries`, async () => {
    let requests = 0;
    const context = load(async () => {
      requests++;
      return jsonResponse(api(404, {}, "endpoint not found"), 404);
    }, mobile);
    await assert.rejects(() => context.fetchFromMusixmatch(
      { title: "Rewind", artist: "Wonder Girls", durationMs: 210000 },
      { musixmatchUserToken: typedToken() },
    ), /macro\.subtitles\.get.*404.*endpoint not found/i);
    assert.equal(requests, 1);
  });

  test(`${label}: HTTP auth, captcha and HTTP/API 429 keep their typed classification`, async () => {
    for (const fixture of [
      { http: 401, api: 401, hint: "renew", name: "MusixmatchAuthError", reason: "unauthorized" },
      { http: 403, api: 403, hint: "renew", name: "MusixmatchAuthError", reason: "unauthorized" },
      { http: 401, api: 401, hint: "captcha", name: "MusixmatchCaptchaError", reason: "rate-limited" },
      { http: 429, api: 429, name: "MusixmatchRateLimitError", reason: "rate-limited" },
      { http: 200, api: 429, name: "MusixmatchRateLimitError", reason: "rate-limited" },
    ]) {
      let requests = 0;
      const context = load(async () => { requests++; return jsonResponse(api(fixture.api, {}, fixture.hint), fixture.http); }, mobile);
      const run = () => context.fetchFromMusixmatch({ title: "Rewind", artist: "Wonder Girls" }, { musixmatchUserToken: typedToken() });
      await assert.rejects(run, (error) => {
        assert.equal(error.name, fixture.name);
        assert.equal(error.apiStatus, fixture.api);
        assert.equal(context.describeSourceError(error), fixture.reason);
        return true;
      });
      assert.equal(requests, 1);
      if (fixture.reason === "rate-limited") {
        await assert.rejects(run, /cooldown active/i);
        assert.equal(requests, 1, "captcha/rate limit must not make another request");
      }
    }
  });

  test(`${label}: empty or HTML HTTP errors retain HTTP classification without JSON parse errors`, async () => {
    for (const [http, name, reason] of [
      [401, "MusixmatchAuthError", "unauthorized"], [403, "MusixmatchAuthError", "unauthorized"],
      [429, "MusixmatchRateLimitError", "rate-limited"], [404, "MusixmatchEndpointError", "http"],
    ]) {
      const context = load(async () => new Response(http === 401 ? "" : "<html>Unavailable</html>", { status: http }), mobile);
      await assert.rejects(() => context.fetchFromMusixmatch(
        { title: "Rewind", artist: "Wonder Girls" }, { musixmatchUserToken: typedToken() },
      ), (error) => {
        assert.equal(error.name, name);
        assert.equal(error.httpStatus, http);
        assert.equal(context.describeSourceError(error), reason);
        assert.doesNotMatch(error.message, /invalid json/i);
        return true;
      });
    }
  });

  test(`${label}: real MXM JSON schema and LRC subtitles preserve line timing`, () => {
    const context = load(async () => { throw new Error("unexpected request"); }, mobile);
    const mxm = JSON.stringify([
      { text: "First line", time: { total: 11.06, minutes: 0, seconds: 11, hundredths: 6 } },
      { text: "Second line", time: { total: 14.58, minutes: 0, seconds: 14, hundredths: 58 } },
    ]);
    for (const body of [mxm, "[00:11.06]First line\n[00:14.58]Second line"]) {
      const result = context.parseMusixmatchSubtitleLyrics(body, 181000);
      assert.equal(result.length, 2);
      assert.equal(Math.round(result[0].lineStartTime), 11060);
      assert.equal(Math.round(result[1].lineStartTime), 14580);
    }
  });

  test(`${label}: seesaw uses validated macro subtitles through the production service`, async () => {
    let requests = 0;
    const context = load(async (rawUrl) => {
      requests++;
      const url = new URL(rawUrl);
      assert.ok(url.pathname.endsWith("macro.subtitles.get"));
      assert.equal(url.searchParams.get("track_isrc"), "ZZA0P2622376");
      const payload = macroPayload(macroTrack({ track_name: "seesaw (Feat. IU)", artist_name: "Crush feat. IU",
        track_length: 181, track_isrc: "ZZA0P2622376", commontrack_id: 296631565, has_richsync: 0 }));
      payload.message.body.macro_calls["track.subtitles.get"] = { message: api(200, {
        subtitle_list: [{ subtitle: { subtitle_body: Array.from({ length: 32 }, (_, index) => {
          const seconds = 11 + index * 5;
          return `[${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.00]Sample lyric line ${index + 1}`;
        }).join("\n") } }],
      }).message };
      return jsonResponse(payload);
    }, mobile);
    const token = typedToken();
    const track = { trackId: "seesaw", title: "seesaw (Feat. IU)", artist: "Crush feat. IU",
      durationMs: 181000, isrc: "ZZA0P2622376", spotifyTrackId: "3lTdjfpGVeYLeHfrczXw1a" };
    const raw = await context.fetchFromMusixmatch(track, { musixmatchUserToken: token });
    assert.equal(raw.metadata.matchedTrack.commontrackId, 296631565);
    const service = context.createLyricsService({ getMusixmatchUserToken: () => token });
    const result = await service.fetchSyncedLyrics(track, { preferredSource: "musixmatch" });
    assert.equal(result.lyrics.length, 32, result.statusMessage);
    assert.doesNotMatch(result.source, /richsync/);
    assert.equal(requests, 1);
  });

  test(`${label}: matched commontrack richsync 404 falls back to line subtitles`, async () => {
    const requests = [];
    const context = load(async (rawUrl) => {
      const url = new URL(rawUrl);
      requests.push(url);
      if (url.pathname.endsWith("macro.subtitles.get")) {
        const payload = macroPayload();
        payload.message.body.macro_calls["track.subtitles.get"] = { message: api(200, {
          subtitle_list: [{ subtitle: { subtitle_body: "[00:01.00]Hello there\n[00:02.00]How are you" } }],
        }).message };
        return jsonResponse(payload);
      }
      if (url.pathname.endsWith("track.richsync.get") || url.pathname.endsWith("matcher.richsync.get")) {
        return jsonResponse(api(404, {}, "not available"));
      }
      if (url.pathname.endsWith("track.subtitle.get")) {
        assert.equal(url.searchParams.get("commontrack_id"), "42001");
        return jsonResponse(api(200, { subtitle: { subtitle_body: "[00:01.00]Hello there\n[00:02.00]How are you" } }));
      }
      return jsonResponse(api(404, {}, "not available"));
    }, mobile);
    const result = await context.fetchFromMusixmatch(
      { title: "Rewind", artist: "Wonder Girls", durationMs: 210000 },
      { musixmatchUserToken: typedToken() },
    );
    assert.equal(result.source, "musixmatch-user-token-mac-ios-v2.0");
    assert.equal(result.lyrics.length, 2);
    assert.equal(result.metadata.matchedTrack.commontrackId, 42001);
    const macroUrl = requests.find((url) => url.pathname.endsWith("macro.subtitles.get"));
    assert.equal(macroUrl.origin, "https://apic-appmobile.musixmatch.com");
    assert.equal(macroUrl.searchParams.get("namespace"), "lyrics_richsynched");
    assert.equal(macroUrl.searchParams.get("optional_calls"), "track.richsync");
    assert.equal(macroUrl.searchParams.get("subtitle_format"), "lrc");
    assert.equal(requests.find((url) => url.pathname.endsWith("track.richsync.get")).searchParams.get("commontrack_id"), "42001");
  });

  test(`${label}: rejects a repeated wrong-track macro payload`, async () => {
    let requests = 0;
    const context = load(async (rawUrl) => {
      requests++;
      const url = new URL(rawUrl);
      if (url.pathname.endsWith("macro.subtitles.get")) return jsonResponse(macroPayload(macroTrack({ track_name: "NOKIA", artist_name: "Drake", commontrack_id: 124185591 })));
      return jsonResponse(api(200, { track_list: [] }));
    }, mobile);
    const result = await context.fetchFromMusixmatch(
      { title: "Rewind", artist: "Wonder Girls", durationMs: 210000, isrc: "US5TA1500050" },
      { musixmatchUserToken: typedToken() },
    );
    assert.equal(result, null);
    assert.ok(requests > 0 && requests < 20);
  });

  test(`${label}: preserves requested ISRC recording identity in result metadata`, async () => {
    const context = load(async (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.pathname.endsWith("macro.subtitles.get")) {
        assert.equal(url.searchParams.get("track_isrc"), "GBUM71805979");
        return jsonResponse(macroPayload(macroTrack({ track_name: "Bohemian Rhapsody - Live Aid", artist_name: "Queen", track_length: 148, track_isrc: "GBUM71805979", commontrack_id: 136860616 })));
      }
      if (url.pathname.endsWith("track.richsync.get")) {
        return jsonResponse(api(200, { richsync: { richsync_body: JSON.stringify({ lines: [{ ts: 1, te: 2, l: [{ c: "Mama", o: 1, d: 0.4 }, { c: " ", o: 1.4, d: 0.1 }, { c: "just killed", o: 1.5, d: 0.5 }] }] }) } }));
      }
      return jsonResponse(api(404, {}, "not available"));
    }, mobile);
    const result = await context.fetchFromMusixmatch(
      { title: "Bohemian Rhapsody - Live Aid", artist: "Queen", durationMs: 148000, isrc: "GBUM71805979" },
      { musixmatchUserToken: typedToken() },
    );
    assert.match(result.metadata.matchedTrack.title, /Live Aid/i);
    assert.equal(result.metadata.matchedTrack.isrc, "GBUM71805979");
    assert.equal(result.metadata.matchedTrack.commontrackId, 136860616);
  });
}
