"use strict";

const crypto = require("node:crypto");

const ANONYMOUS_TOKEN_RETRY_MS = 20 * 60 * 1000;
const TOKEN_ENDPOINT_PROFILES = [
  {
    appId: "android-player-v1.0",
    baseUrl: "https://apic-desktop.musixmatch.com/ws/1.1",
    userAgent: "Musixmatch/7.13.5 (Linux; Android 14) okhttp/4.12.0",
    headers: { Cookie: "AWSELB=0; AWSELBCORS=0" },
  },
  {
    appId: "android-player-v1.0",
    baseUrl: "https://apic.musixmatch.com/ws/1.1",
    userAgent: "Musixmatch/7.13.5 (Linux; Android 14) okhttp/4.12.0",
    headers: { Cookie: "AWSELB=0; AWSELBCORS=0" },
  },
  {
    appId: "mac-ios-v2.0",
    baseUrl: "https://apic-appmobile.musixmatch.com/ws/1.1",
    userAgent:
      "Musixmatch/2025120901 CFNetwork/3860.300.31 Darwin/25.2.0",
    headers: {
      "X-Cookie": "x-mxm-token-guid=",
      "x-mxm-app-version": "10.1.1",
      "Accept-Language": "en-US,en;q=0.9",
    },
  },
];

function buildStoredToken(appId, userToken) {
  return JSON.stringify({ [appId]: userToken });
}

function createMusixmatchTokenManager({
  settingsStore,
  fetchImpl = global.fetch,
  now = () => Date.now(),
  randomUUID = () => crypto.randomUUID(),
  profiles = TOKEN_ENDPOINT_PROFILES,
  logger = console,
} = {}) {
  if (!settingsStore) {
    throw new Error("A bridge settings store is required.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  let inFlightRequest = null;

  const getManualToken = () =>
    String(settingsStore.getMusixmatchUserToken() || "").trim();

  const readAnonymousState = () => ({
    userToken: "",
    appId: "",
    deviceId: "",
    fetchedAt: 0,
    lastAttemptAt: 0,
    ...(settingsStore.getMusixmatchAnonymousTokenState?.() || {}),
  });

  const ensureDeviceId = () => {
    const state = readAnonymousState();
    if (state.deviceId) {
      return state.deviceId;
    }
    const deviceId = randomUUID();
    settingsStore.setMusixmatchAnonymousTokenState({ deviceId });
    return deviceId;
  };

  const getStoredAnonymousToken = () => {
    const state = readAnonymousState();
    if (!state.userToken || !state.appId) {
      return "";
    }
    return buildStoredToken(state.appId, state.userToken);
  };

  const requestAnonymousToken = async ({ force = false } = {}) => {
    const manualToken = getManualToken();
    if (manualToken) {
      return manualToken;
    }

    const storedToken = getStoredAnonymousToken();
    if (storedToken && !force) {
      return storedToken;
    }

    const state = readAnonymousState();
    const currentTime = now();
    if (
      state.lastAttemptAt &&
      currentTime - state.lastAttemptAt < ANONYMOUS_TOKEN_RETRY_MS
    ) {
      return storedToken;
    }

    if (inFlightRequest) {
      return inFlightRequest;
    }

    inFlightRequest = (async () => {
      const deviceId = ensureDeviceId();
      settingsStore.setMusixmatchAnonymousTokenState({
        lastAttemptAt: currentTime,
      });
      let lastError = null;

      for (const profile of profiles) {
        const url = `${profile.baseUrl}/token.get?app_id=${encodeURIComponent(profile.appId)}`;
        const headers = {
          Accept: "application/json",
          "User-Agent": profile.userAgent,
          ...profile.headers,
        };
        if (headers.Cookie) {
          headers.Cookie = `${headers.Cookie}; x-mxm-token-guid=${deviceId}`;
        }
        if (headers["X-Cookie"] !== undefined) {
          headers["X-Cookie"] = `x-mxm-token-guid=${deviceId}`;
        }

        try {
          const response = await fetchImpl(url, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(12_000),
          });
          if (!response.ok) {
            lastError = new Error(
              `Musixmatch token endpoint returned HTTP ${response.status}.`,
            );
            continue;
          }
          const payload = await response.json();
          const statusCode = Number(payload?.message?.header?.status_code || 0);
          const userToken = String(
            payload?.message?.body?.user_token || "",
          ).trim();
          if (statusCode !== 200 || !userToken) {
            lastError = new Error(
              `Musixmatch token endpoint returned status ${statusCode || "unknown"}.`,
            );
            continue;
          }
          settingsStore.setMusixmatchAnonymousTokenState({
            userToken,
            appId: profile.appId,
            deviceId,
            fetchedAt: currentTime,
            lastAttemptAt: currentTime,
          });
          return buildStoredToken(profile.appId, userToken);
        } catch (error) {
          lastError = error;
        }
      }

      if (storedToken) {
        return storedToken;
      }
      throw lastError || new Error("Musixmatch anonymous token request failed.");
    })();

    try {
      return await inFlightRequest;
    } finally {
      inFlightRequest = null;
    }
  };

  return {
    async getToken() {
      const manualToken = getManualToken();
      if (manualToken) {
        return manualToken;
      }
      try {
        return await requestAnonymousToken();
      } catch (error) {
        logger.warn(
          "[musixmatch] Automatic anonymous token request failed:",
          error instanceof Error ? error.message : String(error),
        );
        return "";
      }
    },
    async refreshToken() {
      const manualToken = getManualToken();
      if (manualToken) {
        return manualToken;
      }
      try {
        return await requestAnonymousToken({ force: true });
      } catch (error) {
        logger.warn(
          "[musixmatch] Automatic anonymous token refresh failed:",
          error instanceof Error ? error.message : String(error),
        );
        return getStoredAnonymousToken();
      }
    },
    getStatus() {
      const manualToken = getManualToken();
      const anonymousState = readAnonymousState();
      const automaticConfigured = Boolean(
        anonymousState.userToken && anonymousState.appId,
      );
      const mode = manualToken
        ? "manual-override"
        : automaticConfigured
          ? "automatic"
          : "automatic-pending";
      return {
        mode,
        manualOverrideConfigured: Boolean(manualToken),
        automaticConfigured,
        automaticAppId: automaticConfigured ? anonymousState.appId : "",
      };
    },
  };
}

module.exports = {
  ANONYMOUS_TOKEN_RETRY_MS,
  TOKEN_ENDPOINT_PROFILES,
  buildStoredToken,
  createMusixmatchTokenManager,
};
