"use strict";

// Endpoint constants, retry/fetch helpers, Spicy Lyrics network setup, Spotify token/search helpers, and coverage scoring.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

const JSOSOSO_BASE_URLS = [
  "https://qq-api-soso.vercel.app",
];
const QQ_MUSICU_ENDPOINTS = [
  "https://u.y.qq.com/cgi-bin/musicu.fcg",
  "https://u6.y.qq.com/cgi-bin/musicu.fcg",
];
const QQ_SEARCH_ENDPOINTS = [
  "https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
  "https://c6.y.qq.com/soso/fcgi-bin/client_search_cp",
  "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp",
  "https://c6.y.qq.com/soso/fcgi-bin/search_for_qq_cp",
];
const QQ_LYRIC_ENDPOINTS = [
  "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
  "https://c6.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
  "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_yqq.fcg",
  "https://c6.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_yqq.fcg",
];
const QQ_LEGACY_SEARCH_ENDPOINTS = [
  "https://c.y.qq.com/lyric/fcgi-bin/fcg_search_pc_lrc.fcg",
  "https://c6.y.qq.com/lyric/fcgi-bin/fcg_search_pc_lrc.fcg",
];
const QQ_LEGACY_DOWNLOAD_ENDPOINTS = [
  "https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg",
  "https://c6.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg",
];
const METING_SEARCH_ENDPOINTS = ["https://api.i-meto.com/meting/api"];
const NETEASE_BASE_URLS = [
  "https://netease-cloud-music-api.jinghuashang.cn",
  "https://neteasecloudmusicapi.vercel.app",
];
const NETEASE_DIRECT_API_URL = "https://interface.music.163.com";
const SPICY_LYRICS_API_URL = "https://api.spicylyrics.org";
const SPICY_DEBUG_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.SPICY_DEBUG || "")
    .trim()
    .toLowerCase(),
);

function spicyDebugLog(message, meta = undefined) {
  if (!SPICY_DEBUG_ENABLED) {
    return;
  }
  if (meta === undefined) {
    console.log(`[spicy-debug] ${message}`);
    return;
  }
  console.log(`[spicy-debug] ${message}`, meta);
}

const SPOTIFY_PARTNER_API_URL =
  "https://api-partner.spotify.com/pathfinder/v1/query";
const SPOTIFY_WEB_ACCESS_TOKEN_URL =
  "https://open.spotify.com/get_access_token";
const SPOTIFY_PARTNER_SEARCH_DESKTOP_HASH =
  "75bbf6bfcfdf85b8fc828417bfad92b7cd66bf7f556d85670f4da8292373ebec";
const SPOTIFY_WEB_APP_PLATFORM = "WebPlayer";
const SPOTIFY_WEB_APP_VERSION = "1.2.66.447.g4e37e896";
const MUSIXMATCH_DEFAULT_BASE_URLS = [
  "https://apic-desktop.musixmatch.com/ws/1.1",
  "https://apic.musixmatch.com/ws/1.1",
  "https://www.musixmatch.com/ws/1.1",
];
const MUSIXMATCH_TOKEN_PRIORITY_KEYS = [
  "web-desktop-app-v1.0",
  "mxm-com-v1.0",
  "mxm-account-v1.0",
  "mxm-pro-web-v1.0",
];
const MUSIXMATCH_CLIENT_PROFILES = [
  {
    appId: "android-player-v1.0",
    tokenKey: "android-player-v1.0",
    userAgent: "Musixmatch/7.13.5 (Linux; Android 14) okhttp/4.12.0",
    userLanguage: "en",
    cookieHeader: "AWSELB=0; AWSELBCORS=0",
    baseUrls: [
      "https://apic-desktop.musixmatch.com/ws/1.1",
      "https://apic.musixmatch.com/ws/1.1",
    ],
  },
  {
    appId: "mac-ios-v2.0",
    tokenKey: "mac-ios-v2.0",
    userAgent:
      "Musixmatch/6.8.1 (iPhone; iOS 17.0; Scale/3.00) CFNetwork/1492.0.1 Darwin/23.0.0",
    userLanguage: "en",
    cookieHeader: "AWSELB=0; AWSELBCORS=0",
    baseUrls: [
      "https://apic.musixmatch.com/ws/1.1",
      "https://apic-desktop.musixmatch.com/ws/1.1",
    ],
  },
  {
    appId: "web-desktop-app-v1.0",
    tokenKey: "web-desktop-app-v1.0",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Musixmatch/0.19.4 Chrome/58.0.3029.110 Electron/1.7.6 Safari/537.36",
    userLanguage: "en",
    cookieHeader: "AWSELB=0; AWSELBCORS=0",
    baseUrls: [
      "https://apic-desktop.musixmatch.com/ws/1.1",
      "https://www.musixmatch.com/ws/1.1",
      "https://apic.musixmatch.com/ws/1.1",
    ],
  },
];
const MUSIXMATCH_IOS_DEBUG_CONTEXT = Object.freeze({
  appVersion: "8.2.0",
  appBuild: "2025120901",
  osVersion: "26.0.1",
  userId: "apl:000483.9ddc76a6e14646e689eac195e5d1c818.0532",
  deviceId: "3A4BBD14-0470-41C2-AB2D-F1F00BB96C2C",
  country: "en_US",
});
const MUSIXMATCH_TOKEN_FALLBACK_KEYS = ["user_token", "usertoken", "token"];
const MUSIXMATCH_KNOWN_TOKEN_KEYS = [
  "android-player-v1.0",
  "web-desktop-app-v1.0",
  "mac-ios-v2.0",
  "ios-v2.0",
  "ios-v1.0",
  "iphone-app-v1.0",
  "iphone-app-v2.0",
  "iphone-app-v3.0",
  "iphone-app-v4.0",
  "iphone-app-v5.0",
  "iphone-app-v6.0",
];
const MUSIXMATCH_SIGNATURE_FALLBACK_SECRET =
  "741941edc264ea6293cb9a6458103b4eda3ac8ed";
const MUSIXMATCH_SIGNATURE_CACHE_TTL_MS = 30 * 60 * 1000;
const MUSIXMATCH_RESULT_CACHE_TTL_MS = 25 * 60 * 1000;
const MUSIXMATCH_COOLDOWN_MS = 20 * 60 * 1000;
const MUSIXMATCH_TRANSLATION_LANGUAGE = "en";
const MUSIXMATCH_TRANSLATION_LANGUAGE_FALLBACKS = ["en", "en-US", "en-GB"];
const GEMINI_TRANSLATION_TARGET_LANGUAGE = "English";
const GEMINI_TRANSLATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEMINI_TRANSLATION_MAX_RETRIES = 2;
const GEMINI_TRANSLATION_RETRY_BASE_MS = 450;
const GEMINI_TRANSLATION_CHUNK_SIZE = 50;
const GEMINI_TRANSLATION_MAX_PARALLEL_CHUNKS = 3;
/** Above this unique-line count, translate in parallel chunks instead of one huge request. */
const GEMINI_TRANSLATION_PROACTIVE_CHUNK_LINES = 55;
const GEMINI_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
const GEMINI_RATE_LIMIT_MAX_COOLDOWN_MS = 10 * 60 * 1000;
const GEMINI_MODEL_CANDIDATES = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemma-4-31b-it",
];
const musixmatchSignatureSecretCache = {
  value: "",
  expiresAt: 0,
};
const musixmatchRuntimeState = {
  resultCache: new Map(),
  translationCache: new Map(),
  preferredClientByTokenHash: new Map(),
  rejectedClientIdsByTokenHash: new Map(),
  cooldownUntil: 0,
  cooldownReason: "",
  lastRateLimitAt: 0,
};
const geminiRuntimeState = {
  cooldownUntil: 0,
  cooldownReason: "",
  lastRateLimitAt: 0,
};
const MUSIXMATCH_IOS_APP_ID_CANDIDATES = [
  "mac-ios-v2.0",
  "iphone-app-v8.2.0",
  "iphone-app-v8.2",
  "ios-player-v8.2.0",
  "ios-player-v8.2",
  "iphone-player-v8.2.0",
  "iphone-player-v8.2",
];
const MUSIXMATCH_RAW_TOKEN_PROFILE_PRIORITY = [
  "mac-ios-v2.0",
  "android-player-v1.0",
  "web-desktop-app-v1.0",
];

function cleanupExpiredMusixmatchResultCache(now = Date.now()) {
  for (const [key, entry] of musixmatchRuntimeState.resultCache.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      musixmatchRuntimeState.resultCache.delete(key);
    }
  }
  for (const [
    key,
    entry,
  ] of musixmatchRuntimeState.translationCache.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      musixmatchRuntimeState.translationCache.delete(key);
    }
  }
}

function getMusixmatchTokenHash(rawToken) {
  const safe = String(rawToken || "").trim();
  if (!safe) {
    return "none";
  }
  return crypto.createHash("sha1").update(safe).digest("hex").slice(0, 12);
}

function buildMusixmatchCacheKey(track, rawToken) {
  const title = normalizeCoreTitle(track?.title || "");
  const artist = normalizeText(track?.artist || "");
  const album = normalizeCoreTitle(track?.album || "");
  const durationBucket =
    Number(track?.durationMs || 0) > 0
      ? Math.round(Number(track.durationMs) / 1000)
      : 0;
  const tokenHash = getMusixmatchTokenHash(rawToken);
  return [title, artist, album, durationBucket, tokenHash].join("|");
}

function getMusixmatchCachedResult(track, rawToken) {
  cleanupExpiredMusixmatchResultCache();
  const key = buildMusixmatchCacheKey(track, rawToken);
  const entry = musixmatchRuntimeState.resultCache.get(key);
  if (!entry || !entry.result) {
    return null;
  }
  return {
    ...entry.result,
    source: `${entry.result.source}|cache`,
    metadata: entry.result.metadata || {},
  };
}

function setMusixmatchCachedResult(track, rawToken, result) {
  if (!result?.lyrics?.length) {
    return;
  }
  cleanupExpiredMusixmatchResultCache();
  const key = buildMusixmatchCacheKey(track, rawToken);
  musixmatchRuntimeState.resultCache.set(key, {
    expiresAt: Date.now() + MUSIXMATCH_RESULT_CACHE_TTL_MS,
    result: {
      lyrics: Array.isArray(result.lyrics) ? result.lyrics : [],
      source: String(result.source || "musixmatch"),
      metadata: result.metadata || {},
    },
  });
}

function buildMusixmatchTranslationCacheKey(track, rawToken, language = "en") {
  return `${buildMusixmatchCacheKey(track, rawToken)}|translation|${String(
    language || "en",
  )
    .trim()
    .toLowerCase()}`;
}

function getMusixmatchCachedTranslations(track, rawToken, language = "en") {
  cleanupExpiredMusixmatchResultCache();
  const key = buildMusixmatchTranslationCacheKey(track, rawToken, language);
  const entry = musixmatchRuntimeState.translationCache.get(key);
  return Array.isArray(entry?.translations) ? entry.translations : [];
}

function setMusixmatchCachedTranslations(
  track,
  rawToken,
  language,
  translations,
) {
  if (!Array.isArray(translations)) {
    return;
  }
  cleanupExpiredMusixmatchResultCache();
  const key = buildMusixmatchTranslationCacheKey(track, rawToken, language);
  musixmatchRuntimeState.translationCache.set(key, {
    expiresAt: Date.now() + MUSIXMATCH_RESULT_CACHE_TTL_MS,
    translations,
  });
}

function rememberMusixmatchPreferredClient(rawToken, appId) {
  const tokenHash = getMusixmatchTokenHash(rawToken);
  const safeAppId = String(appId || "").trim();
  if (!tokenHash || tokenHash === "none" || !safeAppId) {
    return;
  }
  musixmatchRuntimeState.preferredClientByTokenHash.set(tokenHash, safeAppId);
}

function prioritizeMusixmatchClientCandidates(clientCandidates, rawToken) {
  const candidates = Array.isArray(clientCandidates)
    ? [...clientCandidates]
    : [];
  if (!candidates.length) {
    return [];
  }
  const tokenHash = getMusixmatchTokenHash(rawToken);
  const preferredAppId =
    musixmatchRuntimeState.preferredClientByTokenHash.get(tokenHash);
  const rejectedAppIds =
    musixmatchRuntimeState.rejectedClientIdsByTokenHash.get(tokenHash) ||
    new Set();
  const rankedCandidates = candidates.filter(
    (candidate) => !rejectedAppIds.has(String(candidate?.appId || "")),
  );
  const usableCandidates = rankedCandidates.length
    ? rankedCandidates
    : candidates;
  if (!preferredAppId) {
    return usableCandidates;
  }
  const preferred = [];
  const rest = [];
  for (const candidate of usableCandidates) {
    if (String(candidate?.appId || "") === preferredAppId) {
      preferred.push(candidate);
    } else {
      rest.push(candidate);
    }
  }
  return [...preferred, ...rest];
}

function activateMusixmatchCooldown(reason = "captcha") {
  musixmatchRuntimeState.cooldownUntil = Date.now() + MUSIXMATCH_COOLDOWN_MS;
  musixmatchRuntimeState.cooldownReason = String(reason || "captcha");
  musixmatchRuntimeState.lastRateLimitAt = Date.now();
}

function rememberMusixmatchRejectedClient(rawToken, appId) {
  const tokenHash = getMusixmatchTokenHash(rawToken);
  const safeAppId = String(appId || "").trim();
  if (!tokenHash || tokenHash === "none" || !safeAppId) {
    return;
  }
  const rejected =
    musixmatchRuntimeState.rejectedClientIdsByTokenHash.get(tokenHash) ||
    new Set();
  rejected.add(safeAppId);
  musixmatchRuntimeState.rejectedClientIdsByTokenHash.set(tokenHash, rejected);
  if (
    musixmatchRuntimeState.preferredClientByTokenHash.get(tokenHash) ===
    safeAppId
  ) {
    musixmatchRuntimeState.preferredClientByTokenHash.delete(tokenHash);
  }
}

function clearMusixmatchCooldownIfExpired() {
  if (musixmatchRuntimeState.cooldownUntil > Date.now()) {
    return;
  }
  musixmatchRuntimeState.cooldownUntil = 0;
  musixmatchRuntimeState.cooldownReason = "";
}

function getMusixmatchCooldownInfo() {
  clearMusixmatchCooldownIfExpired();
  const remainingMs = Math.max(
    0,
    musixmatchRuntimeState.cooldownUntil - Date.now(),
  );
  return {
    active: remainingMs > 0,
    remainingMs,
    reason: musixmatchRuntimeState.cooldownReason || "",
    startedAt: musixmatchRuntimeState.lastRateLimitAt || 0,
  };
}

function clearMusixmatchRuntimeState() {
  musixmatchRuntimeState.resultCache.clear();
  musixmatchRuntimeState.translationCache.clear();
  musixmatchRuntimeState.preferredClientByTokenHash.clear();
  musixmatchRuntimeState.rejectedClientIdsByTokenHash.clear();
  musixmatchRuntimeState.cooldownUntil = 0;
  musixmatchRuntimeState.cooldownReason = "";
  musixmatchRuntimeState.lastRateLimitAt = 0;
}

function activateGeminiCooldown(reason = "http-429", cooldownMs = 0) {
  const safeMs = Number.isFinite(Number(cooldownMs))
    ? Math.max(0, Math.floor(Number(cooldownMs)))
    : 0;
  const boundedMs = Math.min(
    GEMINI_RATE_LIMIT_MAX_COOLDOWN_MS,
    safeMs || GEMINI_RATE_LIMIT_COOLDOWN_MS,
  );
  geminiRuntimeState.cooldownUntil = Date.now() + boundedMs;
  geminiRuntimeState.cooldownReason = String(reason || "http-429");
  geminiRuntimeState.lastRateLimitAt = Date.now();
}

function clearGeminiCooldownIfExpired() {
  if (geminiRuntimeState.cooldownUntil > Date.now()) {
    return;
  }
  geminiRuntimeState.cooldownUntil = 0;
  geminiRuntimeState.cooldownReason = "";
}

function getGeminiCooldownInfo() {
  clearGeminiCooldownIfExpired();
  const remainingMs = Math.max(
    0,
    geminiRuntimeState.cooldownUntil - Date.now(),
  );
  return {
    active: remainingMs > 0,
    remainingMs,
    reason: geminiRuntimeState.cooldownReason || "",
    startedAt: geminiRuntimeState.lastRateLimitAt || 0,
  };
}

function isGeminiTranslationRateLimitedMessage(message = "") {
  const lowerMessage = String(message || "").toLowerCase();
  return (
    lowerMessage.includes("openrouter 429") ||
    lowerMessage.includes("openrouter 503") ||
    lowerMessage.includes("gemini 429") ||
    lowerMessage.includes("gemini 503") ||
    lowerMessage.includes("http 429") ||
    lowerMessage.includes("http 503") ||
    lowerMessage.includes("resource_exhausted") ||
    lowerMessage.includes("temporarily rate-limited") ||
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("service unavailable")
  );
}

async function fetchJsososoWithFallback(path, options = {}, retryOptions = {}) {
  let lastError = null;
  for (const baseUrl of JSOSOSO_BASE_URLS) {
    try {
      return await fetchJsonWithRetry(
        `${baseUrl}${path}`,
        options,
        retryOptions,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All jsososo endpoints failed");
}

async function fetchText(url, { headers = {}, timeoutMs = 8_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "KineSyncDesktopBridge/1.0",
        ...headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function buildUrlWithParams(url, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && `${value}`.length > 0) {
      query.set(key, String(value));
    }
  }
  const queryString = query.toString();
  return queryString ? `${url}?${queryString}` : url;
}

function buildMusixmatchUrlWithParams(url, params = {}) {
  const queryParts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || `${value}`.length === 0) {
      continue;
    }
    queryParts.push(
      `${encodeURIComponent(String(key))}=${encodeURIComponent(String(value))}`,
    );
  }
  return queryParts.length ? `${url}?${queryParts.join("&")}` : url;
}

async function fetchJsonFromAnyEndpoint(
  endpoints,
  { params = {}, headers = {}, timeoutMs = 8_000 } = {},
) {
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      return await fetchJson(endpoint, { params, headers, timeoutMs });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All endpoint attempts failed");
}

async function fetchTextFromAnyEndpoint(
  endpoints,
  { params = {}, headers = {}, timeoutMs = 8_000 } = {},
) {
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      return await fetchText(buildUrlWithParams(endpoint, params), {
        headers,
        timeoutMs,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All endpoint attempts failed");
}

async function fetchJsonPost(
  url,
  body,
  { headers = {}, timeoutMs = 10_000 } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const retrySuffix = retryAfter ? ` (retry-after=${retryAfter})` : "";
      throw new Error(`HTTP ${response.status}${retrySuffix}`);
    }
    const text = await response.text();
    return parseJsonLenient(text);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonPostFromAnyEndpoint(
  endpoints,
  body,
  { headers = {}, timeoutMs = 10_000 } = {},
) {
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      return await fetchJsonPost(endpoint, body, { headers, timeoutMs });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All endpoint attempts failed");
}

async function fetchNeteaseJson(
  path,
  { params = {}, timeoutMs = 10_000 } = {},
) {
  let lastError = null;
  for (const baseUrl of NETEASE_BASE_URLS) {
    try {
      return await fetchJsonWithRetry(
        `${baseUrl}${path}`,
        {
          params,
          timeoutMs,
          headers: {
            Accept: "application/json",
            Referer: "https://music.163.com/",
            Origin: "https://music.163.com",
            "User-Agent":
              "KineSyncDesktopBridge/1.0 (+https://github.com)",
          },
        },
        { attempts: 3, backoffMs: 450 },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All Netease endpoints failed");
}

async function fetchNeteaseDirectApiJson(
  path,
  params,
  { timeoutMs = 10_000 } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null) {
        body.set(key, String(value));
      }
    }
    const response = await fetch(`${NETEASE_DIRECT_API_URL}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Referer: "https://music.163.com/",
        Origin: "https://music.163.com",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 KineSync/1.0",
      },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Netease direct API HTTP ${response.status}`);
    }
    return parseJsonLenient(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNeteaseSearchJson(query, { timeoutMs = 10_000 } = {}) {
  try {
    return await fetchNeteaseJson("/search", {
      params: { keywords: query, type: 1, limit: 30 },
      timeoutMs,
    });
  } catch {
    return fetchNeteaseDirectApiJson(
      "/api/search/get",
      { s: query, type: 1, limit: 30, offset: 0 },
      { timeoutMs },
    );
  }
}

async function fetchNeteaseLyricsJson(songId, { timeoutMs = 10_000 } = {}) {
  try {
    return await fetchNeteaseJson("/lyric/new", {
      params: { id: songId },
      timeoutMs,
    });
  } catch {
    return fetchNeteaseDirectApiJson(
      "/api/song/lyric/v1",
      { id: songId, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 },
      { timeoutMs },
    );
  }
}

function parseSpotifyWebTokenInput(rawToken) {
  const trimmed = String(rawToken || "").trim();
  if (!trimmed) {
    return { mode: "missing", value: "", cookieHeader: "" };
  }
  const bearerMatch = trimmed.match(/^(?:authorization:\s*)?bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) {
    return {
      mode: "access-token",
      value: bearerMatch[1].trim(),
      cookieHeader: "",
    };
  }
  if (/^BQ[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    return {
      mode: "access-token",
      value: trimmed,
      cookieHeader: "",
    };
  }
  if (/sp_dc=/.test(trimmed)) {
    const cookieParts = trimmed
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    return {
      mode: "cookie",
      value: trimmed,
      cookieHeader: cookieParts.join("; "),
    };
  }
  if (/^[A-Za-z0-9-_]{40,}$/.test(trimmed) && !trimmed.includes(".")) {
    return {
      mode: "cookie",
      value: trimmed,
      cookieHeader: `sp_dc=${trimmed}`,
    };
  }
  return {
    mode: "access-token",
    value: trimmed,
    cookieHeader: "",
  };
}

async function getSpotifyWebAccessToken(rawToken) {
  const parsed = parseSpotifyWebTokenInput(rawToken);
  if (parsed.mode === "missing") {
    throw new Error(
      "Missing Spotify web token. Paste a Spotify bearer token or sp_dc cookie value in desktop bridge settings.",
    );
  }
  if (parsed.mode === "access-token") {
    return parsed.value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response = null;
  try {
    response = await fetch(
      buildUrlWithParams(SPOTIFY_WEB_ACCESS_TOKEN_URL, {
        reason: "transport",
        productType: "web_player",
      }),
      {
        method: "GET",
        headers: {
          Accept: "application/json,text/plain,*/*",
          Cookie: parsed.cookieHeader,
          Referer: "https://open.spotify.com/",
          Origin: "https://open.spotify.com",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
        },
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }
  const rawBody = await response.text();
  if (!response.ok) {
    const normalizedBody = String(rawBody || "").toLowerCase();
    if (
      response.status === 403 &&
      (normalizedBody.includes("url blocked") ||
        normalizedBody.includes("error 54113"))
    ) {
      throw new Error(
        "Spotify web token exchange URL Blocked (HTTP 403, Error 54113).",
      );
    }
    if (response.status === 429) {
      throw new Error("Spotify web token exchange HTTP 429.");
    }
    throw new Error(`Spotify web token exchange HTTP ${response.status}.`);
  }
  const payload = parseJsonLenient(rawBody);
  const accessToken = String(
    payload?.accessToken || payload?.access_token || "",
  ).trim();
  if (!accessToken) {
    throw new Error(
      "Spotify web token exchange did not return an access token.",
    );
  }
  return accessToken;
}

// Official API: only publishable keys may be used in apps shipped to users.
async function fetchSpicyLyricsByTrackId(trackId, publishableKey) {
  const key = String(publishableKey || "").trim();
  if (!/^sl_pk_\S+$/.test(key)) {
    throw new Error("Configure a Spicy Lyrics publishable client key (sl_pk_). Secret keys are not accepted.");
  }
  if (!/^[A-Za-z0-9]{22}$/.test(trackId)) {
    throw new Error("Spicy Lyrics requires a valid Spotify track ID.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${SPICY_LYRICS_API_URL}/v1/lyrics/${trackId}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      throw new Error(`Spicy Lyrics HTTP ${response.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ""}.`);
    }
    const payload = await response.json();
    if (Number(payload?.Status) === 404) return null;
    if (Number(payload?.Status) !== 200 || !payload.Body || typeof payload.Body !== "object") {
      throw new Error("Spicy Lyrics returned an invalid API response.");
    }
    if (payload.Body.id && payload.Body.id !== trackId) {
      throw new Error("Spicy Lyrics returned lyrics for a different track.");
    }
    return payload.Body;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSpotifyPartnerSearch(query, accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      buildUrlWithParams(SPOTIFY_PARTNER_API_URL, {
        operationName: "searchDesktop",
        variables: JSON.stringify({
          searchTerm: query,
          offset: 0,
          limit: 25,
          numberOfTopResults: 10,
        }),
        extensions: JSON.stringify({
          persistedQuery: {
            version: 1,
            sha256Hash: SPOTIFY_PARTNER_SEARCH_DESKTOP_HASH,
          },
        }),
      }),
      {
        method: "GET",
        headers: {
          Accept: "application/json,text/plain,*/*",
          Authorization: `Bearer ${accessToken}`,
          "app-platform": SPOTIFY_WEB_APP_PLATFORM,
          "spotify-app-version": SPOTIFY_WEB_APP_VERSION,
          Origin: "https://open.spotify.com",
          Referer: "https://open.spotify.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
        },
        signal: controller.signal,
      },
    );
    const rawBody = await response.text();
    if (!response.ok) {
      const normalizedBody = String(rawBody || "").toLowerCase();
      if (
        response.status === 403 &&
        (normalizedBody.includes("url blocked") ||
          normalizedBody.includes("error 54113"))
      ) {
        throw new Error(
          "Spotify partner search URL Blocked (HTTP 403, Error 54113).",
        );
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        throw new Error(
          `Spotify partner search HTTP 429${retryAfter ? ` (retry-after=${retryAfter})` : ""}.`,
        );
      }
      if (response.status === 403) {
        throw new Error(
          `Spotify partner search HTTP 403${normalizedBody ? ` (${normalizedBody.slice(0, 120)})` : ""}.`,
        );
      }
      throw new Error(`Spotify partner search HTTP ${response.status}.`);
    }
    return parseJsonLenient(rawBody);
  } finally {
    clearTimeout(timer);
  }
}

async function searchSpotifyTrackCandidates(track, accessToken) {
  const queryVariants = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  const seenIds = new Set();
  const matches = [];
  let lastError = null;
  for (const query of queryVariants) {
    try {
      const payload = await fetchSpotifyPartnerSearch(query, accessToken);
      const items = Array.isArray(payload?.data?.search?.tracks?.items)
        ? payload.data.search.tracks.items
        : Array.isArray(payload?.data?.search?.tracksV2?.items)
          ? payload.data.search.tracksV2.items
          : [];
      for (const item of items) {
        const trackItem = item?.track || item?.item?.data || item?.data || item;
        const id = String(
          trackItem?.id ||
            String(trackItem?.uri || "")
              .split(":")
              .pop() ||
            "",
        ).trim();
        if (!id || seenIds.has(id)) {
          continue;
        }
        seenIds.add(id);
        const title = String(trackItem?.name || trackItem?.title || "").trim();
        const artist = Array.isArray(trackItem?.artists?.items)
          ? trackItem.artists.items
              .map((entry) => entry?.profile?.name || entry?.name || "")
              .join(" ")
          : Array.isArray(trackItem?.artists)
            ? trackItem.artists.map((entry) => entry?.name || "").join(" ")
            : "";
        const durationMs = Number(
          trackItem?.duration?.totalMilliseconds || trackItem?.duration_ms || 0,
        );
        let score = scoreCandidate(track, title, artist);
        score += scoreDurationBonus(track, title, artist, durationMs);
        matches.push({ id, title, artist, durationMs, score });
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (!matches.length && lastError) {
    throw lastError;
  }
  const ranked = matches.sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    return [];
  }
  const filtered = ranked.filter(
    (candidate) =>
      candidate.score >= MATCH_ACCEPTANCE_THRESHOLD &&
      isLikelySameTrack(
        track,
        candidate.title,
        candidate.artist,
        candidate.durationMs,
      ),
  );
  return filtered
    .slice(0, MAX_SPOTIFY_TRACK_CANDIDATES)
    .map((candidate) => candidate.id)
    .filter(Boolean);
}

function formatSpotifyArtistNames(artistEntries = []) {
  const names = [];
  const seen = new Set();
  for (const entry of artistEntries) {
    const name = String(entry?.name || entry?.profile?.name || "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(name);
  }
  return names.join(", ");
}

function formatSpotifyPartnerSearchArtists(trackItem = {}) {
  if (Array.isArray(trackItem?.artists?.items)) {
    return formatSpotifyArtistNames(trackItem.artists.items);
  }
  if (Array.isArray(trackItem?.artists)) {
    return formatSpotifyArtistNames(trackItem.artists);
  }
  return "";
}

const SPOTIFY_CATALOG_BY_ID_CACHE_TTL_MS = 5 * 60 * 1000;
const spotifyCatalogByIdCache = new Map();

async function fetchSpotifyWebApiTrackById(trackId, accessToken) {
  const safeId = String(trackId || "").trim();
  const safeToken = String(accessToken || "").trim();
  if (!safeId || !safeToken) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(
      `https://api.spotify.com/v1/tracks/${encodeURIComponent(safeId)}`,
      {
        method: "GET",
        headers: {
          Authorization: safeToken.startsWith("Bearer ")
            ? safeToken
            : `Bearer ${safeToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function formatSpotifyWebApiTrackArtists(trackPayload = {}) {
  return formatSpotifyArtistNames(
    Array.isArray(trackPayload?.artists) ? trackPayload.artists : [],
  );
}

async function resolveSpotifyCatalogTrackById(spotifyTrackId, accessToken) {
  const safeId = String(spotifyTrackId || "").trim();
  const safeToken = String(accessToken || "").trim();
  if (!safeId || !safeToken) {
    return null;
  }

  const cached = spotifyCatalogByIdCache.get(safeId);
  if (
    cached &&
    Date.now() - Number(cached.cachedAt || 0) < SPOTIFY_CATALOG_BY_ID_CACHE_TTL_MS
  ) {
    return cached.data;
  }

  const webTrack = await fetchSpotifyWebApiTrackById(safeId, safeToken);
  if (!webTrack) {
    return null;
  }

  const data = {
    id: safeId,
    title: String(webTrack?.name || "").trim(),
    artist: formatSpotifyWebApiTrackArtists(webTrack),
    album: String(webTrack?.album?.name || "").trim(),
    durationMs: Number(webTrack?.duration_ms || 0),
  };
  spotifyCatalogByIdCache.set(safeId, {
    cachedAt: Date.now(),
    data,
  });
  return data;
}

async function buildLyricsMatchTrack(track, { spotifyAccessToken = "" } = {}) {
  const playbackTrack =
    track && typeof track === "object" ? { ...track } : track;
  if (!playbackTrack || typeof playbackTrack !== "object") {
    return playbackTrack;
  }

  const spotifyTrackId = String(playbackTrack.spotifyTrackId || "").trim();
  if (!spotifyTrackId) {
    return playbackTrack;
  }

  try {
    const catalog = await resolveSpotifyCatalogTrackById(
      spotifyTrackId,
      spotifyAccessToken,
    );
    return applySpotifyCatalogOverlay(playbackTrack, catalog);
  } catch {
    return playbackTrack;
  }
}

function collectSpotifyPartnerSearchMatches(track, payload, seenIds, matches) {
  const items = Array.isArray(payload?.data?.search?.tracks?.items)
    ? payload.data.search.tracks.items
    : Array.isArray(payload?.data?.search?.tracksV2?.items)
      ? payload.data.search.tracksV2.items
      : [];
  for (const item of items) {
    const trackItem = item?.track || item?.item?.data || item?.data || item;
    const id = String(
      trackItem?.id ||
        String(trackItem?.uri || "")
          .split(":")
          .pop() ||
        "",
    ).trim();
    if (!id || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    const title = String(trackItem?.name || trackItem?.title || "").trim();
    const artist = formatSpotifyPartnerSearchArtists(trackItem);
    const durationMs = Number(
      trackItem?.duration?.totalMilliseconds || trackItem?.duration_ms || 0,
    );
    const album = String(
      trackItem?.album?.name ||
        trackItem?.album?.title ||
        trackItem?.albumName ||
        "",
    ).trim();
    let score = scoreCandidate(track, title, artist);
    score += scoreDurationBonus(track, title, artist, durationMs);
    matches.push({ id, title, artist, album, durationMs, score });
  }
}

function isSpotifyPartnerDurationAcceptable(track, candidateDurationMs = 0) {
  const trackDurationMs = Number(track?.durationMs || 0);
  const candidateDuration = Number(candidateDurationMs || 0);
  if (!(trackDurationMs > 0 && candidateDuration > 0)) {
    return true;
  }
  const toleranceMs = Math.max(
    8_000,
    Math.min(20_000, Math.floor(trackDurationMs * 0.08)),
  );
  return Math.abs(candidateDuration - trackDurationMs) <= toleranceMs;
}

function pickBestSpotifyPartnerCatalogMatch(track, matches, { strictImportMatch = false } = {}) {
  const ranked = (Array.isArray(matches) ? matches : [])
    .filter((candidate) => candidate?.id)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) {
    return null;
  }

  const eligible = ranked.filter((candidate) => {
    if (strictImportMatch && getBestArtistOverlap(track?.artist, candidate.artist) < ARTIST_OVERLAP_CONFIDENT_THRESHOLD) return false;
    if (strictImportMatch && track?.album && candidate.album && normalizeCoreTitle(track.album) !== normalizeCoreTitle(candidate.album)) return false;
    if (!titleCoreMatchesQuery(track, candidate.title)) {
      return false;
    }
    if (hasMissingFeaturedArtistHints(track?.title || "", candidate?.title || "")) {
      if (
        !featuredArtistHintsPresentInCandidate(
          track?.title || "",
          candidate?.title || "",
          candidate?.artist || "",
        )
      ) {
        return false;
      }
    }
    if (hasExtraneousTitleWords(track?.title || "", candidate?.title || "")) {
      return false;
    }
    if (!isSpotifyPartnerDurationAcceptable(track, candidate.durationMs)) {
      return false;
    }
    if (Number(candidate.score || 0) < MATCH_ACCEPTANCE_THRESHOLD) {
      return false;
    }
    return true;
  });
  if (!eligible.length) {
    return null;
  }
  if (isAmbiguousTopMatch(eligible) || (strictImportMatch && eligible[1] && eligible[0].score - eligible[1].score < AMBIGUITY_MAX_SCORE_GAP)) {
    return null;
  }
  return eligible[0];
}

const SPOTIFY_PARTNER_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const spotifyPartnerCatalogCache = new Map();
const spotifyPartnerCatalogInFlight = new Map();

function buildSpotifyPartnerCatalogCacheKey(track) {
  const durationBucket =
    Number(track?.durationMs || 0) > 0
      ? Math.round(Number(track.durationMs) / 1000)
      : 0;
  return [
    normalizeCoreTitle(track?.title || ""),
    normalizeText(track?.artist || ""),
    normalizeCoreTitle(track?.album || ""),
    durationBucket,
  ].join("|");
}
async function resolveSpotifyCatalogTrackViaPartnerSearch(track, accessToken, { enrichFromWebApi = true, strictImportMatch = false } = {}) {
  const safeToken = String(accessToken || "").trim();
  if (!safeToken) {
    return null;
  }
  const safeTrack = {
    title: String(track?.title || "").trim(),
    artist: String(track?.artist || "").trim(),
    album: String(track?.album || "").trim(),
    durationMs: Number(track?.durationMs || 0),
  };
  if (!safeTrack.title) {
    return null;
  }

  const cacheKey = `${enrichFromWebApi ? "enriched" : "partner"}|${strictImportMatch ? "import" : "playback"}|${buildSpotifyPartnerCatalogCacheKey(safeTrack)}`;
  const cached = spotifyPartnerCatalogCache.get(cacheKey);
  if (
    cached &&
    Date.now() - Number(cached.cachedAt || 0) < SPOTIFY_PARTNER_CATALOG_CACHE_TTL_MS
  ) {
    return cached.data ? { ...cached.data } : null;
  }
  const inFlight = spotifyPartnerCatalogInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const lookupPromise = (async () => {
    const queryVariants = buildQueryVariants(safeTrack).slice(0, MAX_QUERY_VARIANTS);
    const seenIds = new Set();
    const matches = [];
    let lastError = null;
    const searchResults = await Promise.all(
      queryVariants.map(async (query) => {
        try {
          const payload = await fetchSpotifyPartnerSearch(query, safeToken);
          return { payload, error: null };
        } catch (error) {
          return { payload: null, error };
        }
      }),
    );
    for (const result of searchResults) {
      if (result.error) {
        lastError = result.error;
        continue;
      }
      collectSpotifyPartnerSearchMatches(
        safeTrack,
        result.payload,
        seenIds,
        matches,
      );
    }
    if (!matches.length && lastError) {
      throw lastError;
    }

    const best = pickBestSpotifyPartnerCatalogMatch(safeTrack, matches, { strictImportMatch });
    if (!best?.id) {
      spotifyPartnerCatalogCache.set(cacheKey, {
        cachedAt: Date.now(),
        data: null,
      });
      return null;
    }

    let title = best.title;
    let artist = best.artist;
    let album = best.album || "";
    let durationMs = best.durationMs;
    const webTrack = enrichFromWebApi ? await fetchSpotifyWebApiTrackById(best.id, safeToken) : null;
    if (webTrack) {
      const webArtists = formatSpotifyWebApiTrackArtists(webTrack);
      if (webArtists) {
        artist = webArtists;
      }
      title = String(webTrack?.name || title).trim();
      album = String(webTrack?.album?.name || album).trim();
      durationMs = Number(webTrack?.duration_ms || durationMs || 0);
    }

    const data = {
      id: best.id,
      title,
      artist,
      album,
      durationMs,
      score: best.score,
    };
    spotifyPartnerCatalogCache.set(cacheKey, {
      cachedAt: Date.now(),
      data,
    });
    return { ...data };
  })();

  spotifyPartnerCatalogInFlight.set(cacheKey, lookupPromise);
  try {
    return await lookupPromise;
  } finally {
    spotifyPartnerCatalogInFlight.delete(cacheKey);
  }
}
function scoreLyricsCoverage(lyrics, durationMs = 0) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return -1;
  }
  const { lastTimedPointMs, coverageRatio } = getLyricsCoverageStats(
    lyrics,
    durationMs,
  );
  const safeDuration = Number(durationMs) > 0 ? Number(durationMs) : 0;
  const hasLateLyrics =
    safeDuration > 0 ? lastTimedPointMs >= safeDuration * 0.68 : true;
  const lateBonus = hasLateLyrics ? 20 : -30;
  return lyrics.length * 2 + coverageRatio * 100 + lateBonus;
}
