"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("../../ExpoLyrics/node_modules/typescript");

const mobileRoot = path.resolve(__dirname, "../../ExpoLyrics/lib");
const timestamp = 100_000_000;
const oldToken = "old-mobile-token-value-123456";
const freshToken = "fresh-mobile-token-value-123456";
const valid = () => ({
  musixmatchAnonymousUserToken: oldToken, musixmatchAnonymousAppId: "mac-ios-v2.0",
  musixmatchAnonymousProfileId: "mac-ios-v2.0@apic-appmobile", musixmatchAnonymousDeviceId: "device-id",
  musixmatchAnonymousFetchedAt: timestamp - 1000, musixmatchAnonymousLastAttemptAt: timestamp - 1000,
});
const response = (token = freshToken, apiStatus = 200, hint = "", httpStatus = 200) => ({
  ok: httpStatus >= 200 && httpStatus < 300, status: httpStatus,
  async json() { return { message: { header: { status_code: apiStatus, hint }, body: { user_token: token } } }; },
});

function load(initial, fetchImpl, now = () => timestamp) {
  let settings = {
    musixmatchUserToken: "", musixmatchAnonymousUserToken: "", musixmatchAnonymousAppId: "",
    musixmatchAnonymousProfileId: "", musixmatchAnonymousDeviceId: "", musixmatchAnonymousFetchedAt: 0,
    musixmatchAnonymousLastAttemptAt: 0, musixmatchAnonymousRenewalAttemptAt: 0, musixmatchAnonymousBlockedUntil: 0,
    ...initial,
  };
  const storage = {
    getCachedMobileLyricsSettings: () => ({ ...settings }),
    getMobileLyricsSettings: async () => ({ ...settings }),
    saveMobileLyricsSettings: async (patch) => { await Promise.resolve(); settings = { ...settings, ...patch }; },
  };
  const evaluate = (filename, requireImpl) => {
    const module = { exports: {} };
    const source = ts.transpileModule(fs.readFileSync(path.join(mobileRoot, filename), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, {
      module, exports: module.exports, require: requireImpl, fetch: fetchImpl,
      Date: class extends Date { static now() { return now(); } },
      AbortController, setTimeout, clearTimeout, console: { warn() {} },
    }, { filename });
    return module.exports;
  };
  const profile = evaluate("musixmatch-profile.js", () => { throw new Error("unexpected profile dependency"); });
  const api = evaluate("mobile-musixmatch-token.ts", (name) => {
    if (name === "@/lib/mobile-lyrics-settings") return storage;
    if (name === "./musixmatch-profile") return profile;
    if (name === "crypto-js") return require("../../ExpoLyrics/node_modules/crypto-js");
    throw new Error(`Unexpected dependency ${name}`);
  });
  return { api, state: () => ({ ...settings }) };
}

test("actual mobile token module binds issuance and reuse to the generated shared profile", async () => {
  let calls = 0;
  const { api, state } = load({}, async (url, options) => {
    calls++;
    assert.equal(new URL(url).origin, "https://apic-appmobile.musixmatch.com");
    assert.equal(new URL(url).searchParams.get("app_id"), "mac-ios-v2.0");
    assert.equal(options.headers["x-mxm-app-version"], "10.1.1");
    assert.equal(options.headers["X-Cookie"], "x-mxm-token-guid=");
    assert.equal(options.headers["X-User-Agent"], "Musixmatch/2025120901 CFNetwork/3860.300.31 Darwin/25.2.0");
    assert.equal(options.headers["User-Agent"], undefined);
    assert.equal(new URL(url).searchParams.has("guid"), false);
    return response();
  });
  const token = JSON.parse(await api.resolveMobileMusixmatchToken());
  assert.equal(token.acquiredAt, timestamp);
  assert.equal(token.profileId, "mac-ios-v2.0@apic-appmobile");
  assert.equal(await api.resolveMobileMusixmatchToken(), JSON.stringify(token));
  assert.equal(state().musixmatchAnonymousUserToken, freshToken);
  assert.equal(calls, 1);
});

test("actual mobile token module invalidates legacy, sentinel, wrong-profile and expired caches", async () => {
  for (const patch of [
    { musixmatchAnonymousProfileId: "" }, { musixmatchAnonymousUserToken: "0".repeat(54) },
    { musixmatchAnonymousUserToken: "UpgradeOnly" }, { musixmatchAnonymousProfileId: "other-profile" },
    { musixmatchAnonymousUserToken: "UpgradeOnlyUpgradeOnlyUpgradeOnly" },
    { musixmatchAnonymousFetchedAt: 1 }, { musixmatchAnonymousFetchedAt: timestamp + 1 },
  ]) {
    const { api, state } = load({ ...valid(), ...patch, musixmatchAnonymousLastAttemptAt: 0 }, async () => response());
    assert.equal(JSON.parse(await api.resolveMobileMusixmatchToken()).userToken, freshToken);
    assert.equal(state().musixmatchAnonymousProfileId, "mac-ios-v2.0@apic-appmobile");
  }
});

test("actual mobile forced renewal invalidates rejection and cannot return or repeatedly renew it", async () => {
  let calls = 0;
  const { api, state } = load(valid(), async () => { calls++; return response("", 401, "renew"); });
  const rejected = await api.resolveMobileMusixmatchToken();
  assert.equal(await api.refreshMobileMusixmatchToken("", rejected), "");
  assert.equal(state().musixmatchAnonymousUserToken, "");
  assert.equal(await api.refreshMobileMusixmatchToken("", rejected), "");
  assert.equal(await api.refreshMobileMusixmatchToken("", "different-rejected-token-value"), "");
  const restarted = load(state(), async () => { calls++; return response(); });
  assert.equal(await restarted.api.refreshMobileMusixmatchToken("", rejected), "");
  assert.equal(calls, 1);
});

test("actual mobile concurrent ordinary and forced callers join before cooldown and cache writes", async () => {
  let finish;
  let calls = 0;
  const { api } = load(valid(), () => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const first = api.refreshMobileMusixmatchToken("", oldToken);
  await new Promise((resolve) => setImmediate(resolve));
  const second = api.refreshMobileMusixmatchToken("", oldToken);
  const ordinary = api.resolveMobileMusixmatchToken();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  finish(response());
  const tokens = await Promise.all([first, second, ordinary]);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(JSON.parse(tokens[0]).userToken, freshToken);
});

test("actual mobile captcha and HTTP/API 429 persist a cooldown across forced calls and restart", async () => {
  for (const reply of [response("", 401, "captcha"), response("", 429), response("", 0, "", 429)]) {
    let calls = 0;
    const { api, state } = load({}, async () => { calls++; return reply; });
    assert.equal(await api.resolveMobileMusixmatchToken(), "");
    assert.equal(await api.refreshMobileMusixmatchToken("", oldToken), "");
    const restarted = load(state(), async () => { calls++; return response(); });
    assert.equal(await restarted.api.refreshMobileMusixmatchToken("", freshToken), "");
    assert.equal(calls, 1);
    assert.ok(state().musixmatchAnonymousBlockedUntil > timestamp);
  }
});

test("actual mobile manual override never triggers anonymous issuance", async () => {
  const { api } = load({ musixmatchUserToken: "manual-token" }, async () => { throw new Error("unexpected issuance"); });
  assert.equal(await api.resolveMobileMusixmatchToken(), "manual-token");
  assert.equal(await api.refreshMobileMusixmatchToken("", oldToken), "manual-token");
});

test("mobile preserves an unexpired newer credential when an old request is rejected", async () => {
  const {api}=load(valid(),async()=>{throw Error("must reuse valid current token without minting");});
  const existing=await api.resolveMobileMusixmatchToken();
  assert.equal(await api.refreshMobileMusixmatchToken("","older-rejected-credential"),existing);
});


test("mobile revocation fingerprints survive restart and reject ordinary reacquisition", async () => {
  let time=timestamp,calls=0;
  const first=load(valid(),async()=>response("",401,"renew"),()=>time);
  await first.api.refreshMobileMusixmatchToken("",oldToken);
  const saved=first.state();
  assert(saved.musixmatchAnonymousRejectedTokenHashes.every(hash=>/^[a-f0-9]{64}$/.test(hash)));
  assert(!JSON.stringify(saved.musixmatchAnonymousRejectedTokenHashes).includes(oldToken));
  time+=21*60_000;
  const restarted=load(saved,async()=>{calls++;return response(oldToken);},()=>time);
  assert.equal(await restarted.api.resolveMobileMusixmatchToken(),"");
  assert.equal(restarted.state().musixmatchAnonymousUserToken,"");
  assert.equal(calls,1);
});
