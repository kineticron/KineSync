import {
  getCachedMobileLyricsSettings,
  getMobileLyricsSettings,
  saveMobileLyricsSettings,
} from "@/lib/mobile-lyrics-settings";

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
] as const;

let inFlightRequest: Promise<string> | null = null;

function createDeviceId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (part) => {
    const random = Math.floor(Math.random() * 16);
    const value = part === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function storedAnonymousToken() {
  const settings = getCachedMobileLyricsSettings();
  if (!settings.musixmatchAnonymousUserToken || !settings.musixmatchAnonymousAppId) {
    return "";
  }
  return JSON.stringify({
    [settings.musixmatchAnonymousAppId]: settings.musixmatchAnonymousUserToken,
  });
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 12_000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method: "GET", headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAnonymousToken({
  manualOverride = "",
  force = false,
}: {
  manualOverride?: string;
  force?: boolean;
} = {}) {
  const settings = await getMobileLyricsSettings();
  const manualToken = String(settings.musixmatchUserToken || manualOverride || "").trim();
  if (manualToken) {
    return manualToken;
  }

  const storedToken = storedAnonymousToken();
  if (storedToken && !force) {
    return storedToken;
  }
  const currentTime = Date.now();
  if (
    settings.musixmatchAnonymousLastAttemptAt &&
    currentTime - settings.musixmatchAnonymousLastAttemptAt <
      ANONYMOUS_TOKEN_RETRY_MS
  ) {
    return storedToken;
  }
  if (inFlightRequest) {
    return inFlightRequest;
  }

  inFlightRequest = (async () => {
    const deviceId =
      settings.musixmatchAnonymousDeviceId || createDeviceId();
    await saveMobileLyricsSettings({
      musixmatchAnonymousDeviceId: deviceId,
      musixmatchAnonymousLastAttemptAt: currentTime,
    });
    let lastError: unknown = null;

    for (const profile of TOKEN_ENDPOINT_PROFILES) {
      const headers: Record<string, string> = {
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
        const response = await fetchWithTimeout(
          `${profile.baseUrl}/token.get?app_id=${encodeURIComponent(profile.appId)}`,
          headers,
        );
        if (!response.ok) {
          lastError = new Error(
            `Musixmatch token endpoint returned HTTP ${response.status}.`,
          );
          continue;
        }
        const payload = await response.json();
        const statusCode = Number(payload?.message?.header?.status_code || 0);
        const userToken = String(payload?.message?.body?.user_token || "").trim();
        if (statusCode !== 200 || !userToken) {
          lastError = new Error(
            `Musixmatch token endpoint returned status ${statusCode || "unknown"}.`,
          );
          continue;
        }
        await saveMobileLyricsSettings({
          musixmatchAnonymousUserToken: userToken,
          musixmatchAnonymousAppId: profile.appId,
          musixmatchAnonymousDeviceId: deviceId,
          musixmatchAnonymousFetchedAt: currentTime,
          musixmatchAnonymousLastAttemptAt: currentTime,
        });
        return JSON.stringify({ [profile.appId]: userToken });
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
}

export async function resolveMobileMusixmatchToken(manualOverride = "") {
  try {
    return await requestAnonymousToken({ manualOverride });
  } catch (error) {
    console.warn(
      "[musixmatch] Mobile anonymous token request failed:",
      error instanceof Error ? error.message : String(error),
    );
    return "";
  }
}

export async function refreshMobileMusixmatchToken(manualOverride = "") {
  try {
    return await requestAnonymousToken({ manualOverride, force: true });
  } catch (error) {
    console.warn(
      "[musixmatch] Mobile anonymous token refresh failed:",
      error instanceof Error ? error.message : String(error),
    );
    return storedAnonymousToken();
  }
}

export function getMobileMusixmatchTokenStatus() {
  const settings = getCachedMobileLyricsSettings();
  const manualOverrideConfigured = Boolean(settings.musixmatchUserToken);
  const automaticConfigured = Boolean(
    settings.musixmatchAnonymousUserToken && settings.musixmatchAnonymousAppId,
  );
  return {
    mode: manualOverrideConfigured
      ? "manual-override"
      : automaticConfigured
        ? "automatic"
        : "automatic-pending",
    manualOverrideConfigured,
    automaticConfigured,
    automaticAppId: automaticConfigured ? settings.musixmatchAnonymousAppId : "",
  } as const;
}
