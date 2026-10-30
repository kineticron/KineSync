"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ANONYMOUS_TOKEN_RETRY_MS,
  MUSIXMATCH_TOKEN_TTL_MS,
  createMusixmatchTokenManager,
} = require("../src/musixmatchTokenManager");

function createSettingsStore(initial = {}) {
  let manualToken = String(initial.manualToken || "");
  let anonymousState = {
    userToken: "",
    appId: "",
    deviceId: "",
    fetchedAt: 0,
    lastAttemptAt: 0,
    ...(initial.anonymousState || {}),
  };
  return {
    getMusixmatchUserToken: () => manualToken,
    setMusixmatchUserToken: (value) => {
      manualToken = String(value || "");
    },
    getMusixmatchAnonymousTokenState: () => ({ ...anonymousState }),
    setMusixmatchAnonymousTokenState: (patch) => {
      anonymousState = { ...anonymousState, ...patch };
      return { ...anonymousState };
    },
  };
}

function successfulTokenFetch(token = "anonymous-token-value") {
  return async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        message: {
          header: { status_code: 200 },
          body: { user_token: token },
        },
      };
    },
  });
}

test("manual override takes precedence without requesting an anonymous token", async () => {
  const settingsStore = createSettingsStore({ manualToken: "manual-token" });
  let fetchCount = 0;
  const manager = createMusixmatchTokenManager({
    settingsStore,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("should not fetch");
    },
  });

  assert.equal(await manager.getToken(), "manual-token");
  assert.equal(fetchCount, 0);
  assert.deepEqual(manager.getStatus(), {
    mode: "manual-override",
    manualOverrideConfigured: true,
    automaticConfigured: false,
    automaticAppId: "",
  });
});

test("anonymous token is acquired, tagged with its app id, persisted, and reused", async () => {
  const settingsStore = createSettingsStore();
  let fetchCount = 0;
  let capturedUrl = "";
  let capturedOptions = null;
  const manager = createMusixmatchTokenManager({
    settingsStore,
    fetchImpl: async (url, options) => {
      fetchCount += 1;
      capturedUrl = url;
      capturedOptions = options;
      return successfulTokenFetch()(url, options);
    },
    now: () => 123_456,
    randomUUID: () => "stable-device-id",
    logger: { warn() {} },
    profiles: [
      {
        appId: "android-player-v1.0",
        baseUrl: "https://example.test/ws/1.1",
        userAgent: "test-agent",
        headers: { Cookie: "AWSELB=0" },
      },
    ],
  });

  const expected = JSON.stringify({ profileId: "android-player-v1.0@example.test", appId: "android-player-v1.0", userToken: "anonymous-token-value", acquiredAt: 123456 });
  assert.equal(await manager.getToken(), expected);
  assert.equal(await manager.getToken(), expected);
  assert.equal(fetchCount, 1);
  assert.equal(
    capturedUrl,
    "https://example.test/ws/1.1/token.get?app_id=android-player-v1.0",
  );
  assert.match(capturedOptions.headers.Cookie, /x-mxm-token-guid=stable-device-id/);
  assert.deepEqual(settingsStore.getMusixmatchAnonymousTokenState(), {
    userToken: "anonymous-token-value",
    appId: "android-player-v1.0",
    deviceId: "stable-device-id",
    fetchedAt: 123_456,
    lastAttemptAt: 123_456,
    profileId: "android-player-v1.0@example.test",
  });
});

test("failed issuance is throttled instead of repeatedly hitting token.get", async () => {
  const settingsStore = createSettingsStore();
  let currentTime = 1_000_000;
  let fetchCount = 0;
  const manager = createMusixmatchTokenManager({
    settingsStore,
    fetchImpl: async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { message: { header: { status_code: 401 }, body: {} } };
        },
      };
    },
    now: () => currentTime,
    randomUUID: () => "stable-device-id",
    logger: { warn() {} },
    profiles: [
      {
        appId: "android-player-v1.0",
        baseUrl: "https://example.test/ws/1.1",
        userAgent: "test-agent",
        headers: {},
      },
    ],
  });

  assert.equal(await manager.getToken(), "");
  assert.equal(await manager.getToken(), "");
  assert.equal(fetchCount, 1);

  currentTime += ANONYMOUS_TOKEN_RETRY_MS + 1;
  assert.equal(await manager.getToken(), "");
  assert.equal(fetchCount, 2);
});

test("refresh does not replace a manual override", async () => {
  const settingsStore = createSettingsStore({ manualToken: "manual-token" });
  const manager = createMusixmatchTokenManager({
    settingsStore,
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });

  assert.equal(await manager.refreshToken(), "manual-token");
});

test("clearing a manual override invalidates legacy untyped cached tokens", async () => {
  const settingsStore = createSettingsStore({
    manualToken: "manual-token",
    anonymousState: {
      userToken: "anonymous-token",
      appId: "android-player-v1.0",
      deviceId: "stable-device-id",
      fetchedAt: 100,
      lastAttemptAt: 100,
    },
  });
  const manager = createMusixmatchTokenManager({
    settingsStore,
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });

  assert.equal(await manager.getToken(), "manual-token");
  settingsStore.setMusixmatchUserToken("");
  assert.equal(await manager.getToken(), "");
});

test("placeholder tokens are rejected, and valid profile tokens expire after six hours", async () => {
  let currentTime = 2_000_000;
  const settingsStore = createSettingsStore();
  let values = ["0".repeat(54), "UpgradeOnly", "valid-token"];
  let fetchCount = 0;
  const manager = createMusixmatchTokenManager({
    settingsStore, now: () => currentTime, logger: { warn() {} },
    profiles: ["one", "two", "three"].map(host => ({ appId: "mac-ios-v2.0", profileId: "mac-ios-v2.0@apic-appmobile", baseUrl: `https://${host}.test/ws/1.1`, userAgent: "test", headers: {} })),
    fetchImpl: async () => { fetchCount++; return successfulTokenFetch(values.shift())(); },
  });
  assert.equal(JSON.parse(await manager.getToken()).userToken, "valid-token");
  assert.equal(fetchCount, 3);
  currentTime += MUSIXMATCH_TOKEN_TTL_MS + 1;
  values = ["fresh-token"];
  assert.equal(JSON.parse(await manager.getToken()).userToken, "fresh-token");
  assert.equal(fetchCount, 4);
});

test("forced renewal bypasses cooldown once and concurrent callers share it", async () => {
  const settingsStore = createSettingsStore();
  let resolveFetch;
  let fetchCount = 0;
  const manager = createMusixmatchTokenManager({
    settingsStore, now: () => 9_000_000, logger: { warn() {} },
    profiles: [{ appId: "mac-ios-v2.0", profileId: "mac-ios-v2.0@apic-appmobile", baseUrl: "https://example.test/ws/1.1", userAgent: "test", headers: {} }],
    fetchImpl: () => { fetchCount++; return new Promise(resolve => { resolveFetch = resolve; }); },
  });
  const first = manager.refreshToken();
  const second = manager.refreshToken();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCount, 1);
  resolveFetch(await successfulTokenFetch("renewed-token")());
  assert.equal(JSON.parse(await first).userToken, "renewed-token");
  assert.equal(await second, await first);
  assert.equal(fetchCount, 1);
});
