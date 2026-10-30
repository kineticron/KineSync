"use strict";

const crypto = require("node:crypto");

const ANONYMOUS_TOKEN_RETRY_MS = 20 * 60 * 1000;
const MUSIXMATCH_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const MUSIXMATCH_PROFILE_ID = "mac-ios-v2.0@apic-appmobile";
const TOKEN_ENDPOINT_PROFILES = [
  {
    appId: "mac-ios-v2.0",
    profileId: MUSIXMATCH_PROFILE_ID,
    baseUrl: "https://apic-appmobile.musixmatch.com/ws/1.1",
    userAgent:
      "Musixmatch/2025120901 CFNetwork/3860.300.31 Darwin/25.2.0",
    headers: {
      "X-Cookie": "x-mxm-token-guid=",
      "x-mxm-token-guid": "",
      "x-mxm-app-version": "10.1.1",
      "Accept-Language": "en-US,en;q=0.9",
    },
  },
];

function buildStoredToken(appId, userToken, profileId = MUSIXMATCH_PROFILE_ID, acquiredAt = 0) {
  return JSON.stringify({ profileId, appId, userToken, acquiredAt });
}

function isUsableMusixmatchToken(value) {
  const token = String(value || "").trim();
  return Boolean(token) && !/^0+$/.test(token) && !/^UpgradeOnly$/i.test(token);
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
  const primaryProfile = profiles[0] || {};
  const primaryProfileId = primaryProfile.profileId ||
    `${primaryProfile.appId || ""}@${new URL(primaryProfile.baseUrl || "https://invalid").hostname}`;

  const getManualToken = () =>
    String(settingsStore.getMusixmatchUserToken() || "").trim();

  const readAnonymousState = () => ({
    userToken: "",
    appId: "",
    deviceId: "",
    fetchedAt: 0,
    lastAttemptAt: 0,
    profileId: "",
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
    if (!isUsableMusixmatchToken(state.userToken) || !state.appId) {
      return "";
    }
    return buildStoredToken(state.appId, state.userToken, state.profileId, state.fetchedAt);
  };

  const requestAnonymousToken = async ({ force = false } = {}) => {
    const manualToken = getManualToken();
    if (manualToken) {
      return manualToken;
    }

    let storedToken = getStoredAnonymousToken();
    const state = readAnonymousState();
    const validStored = Boolean(
      storedToken && state.profileId === primaryProfileId &&
      state.appId === primaryProfile.appId && state.fetchedAt > 0 &&
      now() - state.fetchedAt >= 0 && now() - state.fetchedAt < MUSIXMATCH_TOKEN_TTL_MS
    );
    if (storedToken && !validStored) {
      settingsStore.setMusixmatchAnonymousTokenState({
        userToken: "", appId: "", fetchedAt: 0, profileId: "",
      });
      storedToken = "";
    }
    if (validStored && !force) {
      return storedToken;
    }

    const currentTime = now();
    if (
      !force &&
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
          if (statusCode !== 200 || !isUsableMusixmatchToken(userToken)) {
            lastError = new Error(
              `Musixmatch token endpoint returned status ${statusCode || "unknown"}.`,
            );
            continue;
          }
          settingsStore.setMusixmatchAnonymousTokenState({
            userToken,
            appId: profile.appId,
            profileId: profile.profileId || `${profile.appId}@${new URL(profile.baseUrl).hostname}`,
            deviceId,
            fetchedAt: currentTime,
            lastAttemptAt: currentTime,
          });
          return buildStoredToken(profile.appId, userToken, profile.profileId || primaryProfileId, currentTime);
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
        isUsableMusixmatchToken(anonymousState.userToken) &&
        anonymousState.appId === primaryProfile.appId &&
        anonymousState.profileId === primaryProfileId &&
        anonymousState.fetchedAt > 0 &&
        now() - anonymousState.fetchedAt >= 0 &&
        now() - anonymousState.fetchedAt < MUSIXMATCH_TOKEN_TTL_MS,
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
  MUSIXMATCH_TOKEN_TTL_MS,
  MUSIXMATCH_PROFILE_ID,
  TOKEN_ENDPOINT_PROFILES,
  buildStoredToken,
  isUsableMusixmatchToken,
  createMusixmatchTokenManager,
};
