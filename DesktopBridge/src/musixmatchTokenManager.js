"use strict";

const crypto = require("node:crypto");
const { MUSIXMATCH_APP_MOBILE_PROFILE, isUsableMusixmatchToken } = require("./musixmatchProfile");

const ANONYMOUS_TOKEN_RETRY_MS = MUSIXMATCH_APP_MOBILE_PROFILE.retryMs;
const MUSIXMATCH_TOKEN_TTL_MS = MUSIXMATCH_APP_MOBILE_PROFILE.tokenTtlMs;
const MUSIXMATCH_PROFILE_ID = MUSIXMATCH_APP_MOBILE_PROFILE.profileId;
const TOKEN_ENDPOINT_PROFILES = [MUSIXMATCH_APP_MOBILE_PROFILE];

function buildStoredToken(appId, userToken, profileId = MUSIXMATCH_PROFILE_ID, acquiredAt = 0, deviceId = "") {
  return JSON.stringify({ profileId, appId, userToken, acquiredAt, deviceId });
}

function tokenValue(value) {
  try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object") return String(parsed.userToken || "").trim(); } catch {}
  return String(value || "").trim();
}
const tokenHash = value => crypto.createHash("sha256").update(tokenValue(value)).digest("hex");

function createMusixmatchTokenManager({
  settingsStore,
  fetchImpl = global.fetch,
  now = () => Date.now(),
  randomUUID = () => crypto.randomUUID(),
  profiles = TOKEN_ENDPOINT_PROFILES,
  logger = console,
} = {}) {
  if (!settingsStore) throw new Error("A bridge settings store is required.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  let inFlightRequest = null;
  const renewedTokenHashes = new Set();
  const profileId = (profile) => profile.profileId || `${profile.appId}@${new URL(profile.baseUrl).hostname}`;
  const readState = () => ({
    userToken: "", appId: "", profileId: "", deviceId: "", fetchedAt: 0,
    lastAttemptAt: 0, renewalAttemptAt: 0, blockedUntil: 0, rejectedTokenHashes: [],
    ...(settingsStore.getMusixmatchAnonymousTokenState?.() || {}),
  });
  const manualToken = () => String(settingsStore.getMusixmatchUserToken() || "").trim();
  const validState = (state) => isUsableMusixmatchToken(state.userToken) &&
    !(state.rejectedTokenHashes || []).includes(tokenHash(state.userToken)) &&
    profiles.some((profile) => profile.appId === state.appId && profileId(profile) === state.profileId) &&
    Number.isFinite(state.fetchedAt) && state.fetchedAt > 0 &&
    now() >= state.fetchedAt && now() - state.fetchedAt < MUSIXMATCH_TOKEN_TTL_MS;
  const serialize = (state) => buildStoredToken(state.appId, state.userToken, state.profileId, state.fetchedAt, state.deviceId);
  const clearToken = () => settingsStore.setMusixmatchAnonymousTokenState({
    userToken: "", appId: "", profileId: "", fetchedAt: 0,
  });

  const invalidateToken = rejectedToken => {
    const value = tokenValue(rejectedToken);
    if (!value) return;
    const state = readState();
    const hashes = [...new Set([...(state.rejectedTokenHashes || []), tokenHash(value)])];
    settingsStore.setMusixmatchAnonymousTokenState({ rejectedTokenHashes: hashes });
    if (tokenValue(state.userToken) === value) clearToken();
  };

  const requestToken = ({ force = false, rejectedToken = "" } = {}) => {
    const manual = manualToken();
    if (manual) return Promise.resolve((readState().rejectedTokenHashes || []).includes(tokenHash(manual)) ? "" : manual);
    // Join before any cooldown or cache decisions, including a forced renewal.
    if (inFlightRequest) return inFlightRequest;

    const state = readState();
    const currentTime = now();
    const valid = validState(state);
    let rejected = String(rejectedToken || (force ? state.userToken : "")).trim();
    try {
      const parsed = JSON.parse(rejected);
      if (parsed && typeof parsed === "object") rejected = String(parsed.userToken || "").trim();
    } catch {}
    const rejectedHash = rejected ? crypto.createHash("sha256").update(rejected).digest("hex") : "";

    if (state.userToken && (!valid || (force && state.userToken === rejected))) clearToken();
    // An old request's rejection must not discard or remint a newer valid token.
    if (force && valid && rejected && state.userToken !== rejected) return Promise.resolve(serialize(state));
    if (!force && valid) return Promise.resolve(serialize(state));
    if (state.blockedUntil > currentTime) return Promise.resolve("");
    if (force) {
      if ((rejectedHash && renewedTokenHashes.has(rejectedHash)) ||
          (state.renewalAttemptAt > 0 && currentTime - state.renewalAttemptAt < ANONYMOUS_TOKEN_RETRY_MS)) {
        return Promise.resolve("");
      }
      if (rejectedHash) renewedTokenHashes.add(rejectedHash);
      settingsStore.setMusixmatchAnonymousTokenState({ renewalAttemptAt: currentTime });
    } else if (state.lastAttemptAt > 0 && currentTime - state.lastAttemptAt < ANONYMOUS_TOKEN_RETRY_MS) {
      return Promise.resolve("");
    }

    // Assign the promise before asynchronous storage/network work starts.
    inFlightRequest = Promise.resolve().then(async () => {
      const deviceId = state.deviceId || randomUUID();
      settingsStore.setMusixmatchAnonymousTokenState({ deviceId, lastAttemptAt: currentTime });
      let lastError = null;
      for (const profile of profiles) {
        try {
          const response = await fetchImpl(`${profile.baseUrl}/token.get?app_id=${encodeURIComponent(profile.appId)}`, {
            method: "GET",
            headers: {
              Accept: "application/json",
              ...(profile.appId === MUSIXMATCH_APP_MOBILE_PROFILE.appId ? {} : { "User-Agent": profile.userAgent }),
              ...profile.headers,
              "X-Cookie": profile.appId === MUSIXMATCH_APP_MOBILE_PROFILE.appId ? "x-mxm-token-guid=" : `x-mxm-token-guid=${deviceId}`,
            },
            signal: AbortSignal.timeout(12_000),
          });
          const payload = await response.json().catch(() => null);
          const status = Number(payload?.message?.header?.status_code || 0);
          const captcha = /captcha/i.test(String(payload?.message?.header?.hint || ""));
          if (captcha || response.status === 429 || status === 429) {
            settingsStore.setMusixmatchAnonymousTokenState({ blockedUntil: now() + ANONYMOUS_TOKEN_RETRY_MS });
            lastError = new Error(captcha ? "Musixmatch token request was blocked by captcha." : "Musixmatch token request was rate limited.");
            break;
          }
          if (!response.ok) {
            lastError = new Error(`Musixmatch token endpoint returned HTTP ${response.status}.`);
            continue;
          }
          const userToken = String(payload?.message?.body?.user_token || "").trim();
          if (status !== 200 || !isUsableMusixmatchToken(userToken) || (readState().rejectedTokenHashes || []).includes(tokenHash(userToken)) || (force && userToken === rejected)) {
            lastError = new Error(`Musixmatch token endpoint returned an unusable token (API ${status || "unknown"}).`);
            continue;
          }
          const acquired = { userToken, appId: profile.appId, profileId: profileId(profile), deviceId, fetchedAt: now() };
          settingsStore.setMusixmatchAnonymousTokenState(acquired);
          return serialize(acquired);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("Musixmatch anonymous token request failed.");
    }).finally(() => { inFlightRequest = null; });
    return inFlightRequest;
  };

  const resolve = async (options) => {
    try { return await requestToken(options); }
    catch (error) {
      logger.warn("[musixmatch] Anonymous token request failed:", error instanceof Error ? error.message : "request failed");
      return "";
    }
  };
  return {
    getToken: () => resolve({}),
    refreshToken: (rejectedToken = "") => {
      const rejected = rejectedToken || readState().userToken;
      invalidateToken(rejected);
      return resolve({ force: true, rejectedToken: rejected });
    },
    invalidateToken,
    getStatus() {
      const manual = manualToken();
      const state = readState();
      const automaticConfigured = validState(state);
      return {
        mode: manual ? "manual-override" : automaticConfigured ? "automatic" : "automatic-pending",
        manualOverrideConfigured: Boolean(manual), automaticConfigured,
        automaticAppId: automaticConfigured ? state.appId : "",
      };
    },
  };
}

module.exports = {
  ANONYMOUS_TOKEN_RETRY_MS, MUSIXMATCH_TOKEN_TTL_MS, MUSIXMATCH_PROFILE_ID,
  TOKEN_ENDPOINT_PROFILES, buildStoredToken, isUsableMusixmatchToken, createMusixmatchTokenManager,
};
