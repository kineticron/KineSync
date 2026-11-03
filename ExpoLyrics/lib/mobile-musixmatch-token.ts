import CryptoJS from "crypto-js";
import { getCachedMobileLyricsSettings, getMobileLyricsSettings, saveMobileLyricsSettings } from "@/lib/mobile-lyrics-settings";
import type { MobileLyricsSettings } from "@/lib/mobile-lyrics-settings";
import { MUSIXMATCH_APP_MOBILE_PROFILE as PROFILE, isUsableMusixmatchToken } from "./musixmatch-profile";

export type MobileMusixmatchToken = {
  profileId: string;
  appId: string;
  userToken: string;
  acquiredAt: number;
  deviceId: string;
};

let inFlightRequest: Promise<string> | null = null;
const renewedTokens = new Set<string>();
const rejectedHashes = new Set<string>();
let invalidationQueue: Promise<void> = Promise.resolve();
function tokenValue(value: string) {
  try { const parsed = JSON.parse(value); if (parsed && typeof parsed === "object") return String(parsed.userToken || "").trim(); } catch {}
  return String(value || "").trim();
}
const tokenHash = (value: string) => CryptoJS.SHA256(tokenValue(value)).toString(CryptoJS.enc.Hex);
function hydrateRejections(settings: MobileLyricsSettings) {
  for (const hash of settings.musixmatchAnonymousRejectedTokenHashes || []) rejectedHashes.add(hash);
}
export function invalidateMobileMusixmatchToken(rejectedToken: string): Promise<void> {
  const value = tokenValue(rejectedToken);
  if (!value) return Promise.resolve();
  rejectedHashes.add(tokenHash(value));
  invalidationQueue = invalidationQueue.catch(() => {}).then(async () => {
    const settings = await getMobileLyricsSettings();
    hydrateRejections(settings);
    await saveMobileLyricsSettings({
      musixmatchAnonymousRejectedTokenHashes: [...rejectedHashes],
      ...(tokenValue(settings.musixmatchAnonymousUserToken) === value ? {
        musixmatchAnonymousUserToken: "", musixmatchAnonymousAppId: "", musixmatchAnonymousProfileId: "", musixmatchAnonymousFetchedAt: 0,
      } : {}),
    });
  });
  return invalidationQueue;
}

function createDeviceId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (part) => {
    const random = Math.floor(Math.random() * 16);
    return (part === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function validCache(settings: MobileLyricsSettings) {
  hydrateRejections(settings);
  const acquiredAt = settings.musixmatchAnonymousFetchedAt;
  return isUsableMusixmatchToken(settings.musixmatchAnonymousUserToken) &&
    !rejectedHashes.has(tokenHash(settings.musixmatchAnonymousUserToken)) &&
    settings.musixmatchAnonymousAppId === PROFILE.appId &&
    settings.musixmatchAnonymousProfileId === PROFILE.profileId &&
    Number.isFinite(acquiredAt) && acquiredAt > 0 && Date.now() >= acquiredAt &&
    Date.now() - acquiredAt < PROFILE.tokenTtlMs;
}

function serialize(settings: MobileLyricsSettings) {
  const record: MobileMusixmatchToken = {
    profileId: settings.musixmatchAnonymousProfileId,
    appId: settings.musixmatchAnonymousAppId,
    userToken: settings.musixmatchAnonymousUserToken,
    acquiredAt: settings.musixmatchAnonymousFetchedAt,
    deviceId: settings.musixmatchAnonymousDeviceId,
  };
  return JSON.stringify(record);
}

async function requestAnonymousToken({ manualOverride = "", force = false, rejectedToken = "" } = {}) {
  const settings = await getMobileLyricsSettings();
  const manual = String(settings.musixmatchUserToken || manualOverride || "").trim();
  hydrateRejections(settings);
  if (manual) return rejectedHashes.has(tokenHash(manual)) ? "" : manual;
  if (inFlightRequest) return inFlightRequest;
  if (!force && validCache(settings)) return serialize(settings);

  // Establish singleflight before asynchronous invalidation or storage writes.
  inFlightRequest = Promise.resolve().then(async () => {
    const currentTime = Date.now();
    let rejected = String(rejectedToken || (force ? settings.musixmatchAnonymousUserToken : "")).trim();
    try {
      const parsed = JSON.parse(rejected);
      if (parsed && typeof parsed === "object") rejected = String(parsed.userToken || "").trim();
    } catch {}
    if (force && validCache(settings) && rejected && settings.musixmatchAnonymousUserToken !== rejected) return serialize(settings);
    if (settings.musixmatchAnonymousUserToken && (!validCache(settings) ||
        (force && settings.musixmatchAnonymousUserToken === rejected))) {
      await saveMobileLyricsSettings({
        musixmatchAnonymousUserToken: "", musixmatchAnonymousAppId: "",
        musixmatchAnonymousProfileId: "", musixmatchAnonymousFetchedAt: 0,
      });
    }
    if (settings.musixmatchAnonymousBlockedUntil > currentTime) return "";
    if (force) {
      if ((rejected && renewedTokens.has(rejected)) ||
          (settings.musixmatchAnonymousRenewalAttemptAt > 0 &&
           currentTime - settings.musixmatchAnonymousRenewalAttemptAt < PROFILE.retryMs)) return "";
      if (rejected) renewedTokens.add(rejected);
      await saveMobileLyricsSettings({ musixmatchAnonymousRenewalAttemptAt: currentTime });
    } else if (settings.musixmatchAnonymousLastAttemptAt > 0 &&
        currentTime - settings.musixmatchAnonymousLastAttemptAt < PROFILE.retryMs) return "";

    const deviceId = settings.musixmatchAnonymousDeviceId || createDeviceId();
    await saveMobileLyricsSettings({ musixmatchAnonymousDeviceId: deviceId, musixmatchAnonymousLastAttemptAt: currentTime });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`${PROFILE.baseUrl}/token.get?app_id=${encodeURIComponent(PROFILE.appId)}`, {
        method: "GET", signal: controller.signal,
        headers: { Accept: "application/json", ...PROFILE.headers },
      });
      const payload = await response.json().catch(() => null);
      const status = Number(payload?.message?.header?.status_code || 0);
      const captcha = /captcha/i.test(String(payload?.message?.header?.hint || ""));
      if (captcha || response.status === 429 || status === 429) {
        await saveMobileLyricsSettings({ musixmatchAnonymousBlockedUntil: Date.now() + PROFILE.retryMs });
        throw new Error(captcha ? "Musixmatch token request was blocked by captcha." : "Musixmatch token request was rate limited.");
      }
      if (!response.ok) throw new Error(`Musixmatch token endpoint returned HTTP ${response.status}.`);
      const userToken = String(payload?.message?.body?.user_token || "").trim();
      if (status !== 200 || !isUsableMusixmatchToken(userToken) || rejectedHashes.has(tokenHash(userToken)) || (force && userToken === rejected)) {
        throw new Error(`Musixmatch token endpoint returned an unusable token (API ${status || "unknown"}).`);
      }
      const acquiredAt = Date.now();
      await saveMobileLyricsSettings({
        musixmatchAnonymousUserToken: userToken, musixmatchAnonymousAppId: PROFILE.appId,
        musixmatchAnonymousProfileId: PROFILE.profileId, musixmatchAnonymousFetchedAt: acquiredAt,
      });
      return JSON.stringify({ profileId: PROFILE.profileId, appId: PROFILE.appId, userToken, acquiredAt, deviceId } satisfies MobileMusixmatchToken);
    } finally { clearTimeout(timeout); }
  }).finally(() => { inFlightRequest = null; });
  return inFlightRequest;
}

export async function resolveMobileMusixmatchToken(manualOverride = "") {
  try { return await requestAnonymousToken({ manualOverride }); }
  catch (error) {
    console.warn("[musixmatch] Mobile anonymous token request failed:", error instanceof Error ? error.message : "request failed");
    return "";
  }
}

export async function refreshMobileMusixmatchToken(manualOverride = "", rejectedToken = "") {
  try {
    const rejected = rejectedToken || (await getMobileLyricsSettings()).musixmatchAnonymousUserToken;
    await invalidateMobileMusixmatchToken(rejected);
    return await requestAnonymousToken({ manualOverride, force: true, rejectedToken: rejected });
  }
  catch (error) {
    console.warn("[musixmatch] Mobile anonymous token renewal failed:", error instanceof Error ? error.message : "request failed");
    return "";
  }
}

export function getMobileMusixmatchTokenStatus() {
  const settings = getCachedMobileLyricsSettings();
  const manualOverrideConfigured = Boolean(settings.musixmatchUserToken);
  const automaticConfigured = validCache(settings);
  return {
    mode: manualOverrideConfigured ? "manual-override" : automaticConfigured ? "automatic" : "automatic-pending",
    manualOverrideConfigured, automaticConfigured,
    automaticAppId: automaticConfigured ? settings.musixmatchAnonymousAppId : "",
  } as const;
}
