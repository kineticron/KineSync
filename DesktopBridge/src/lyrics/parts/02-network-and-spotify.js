"use strict";

// Endpoint constants, retry/fetch helpers, Spicy Lyrics network setup, Spotify token/search helpers, and coverage scoring.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

const JSOSOSO_BASE_URLS = [
  "https://api.qq.jsososo.com",
  "http://api.qq.jsososo.com",
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
const SPICY_LYRICS_API_URL = "https://api.spicylyrics.org";
/** Keep in sync with spicy-lyrics `project/config.ts` ProjectVersion. */
const SPICY_LYRICS_CLIENT_VERSION = "6.1.1";
const SPICY_QUEUE_BASE_DELAY_MS = 2_000;
const SPICY_QUEUE_MAX_DELAY_MS = 10_000;
const SPICY_QUEUE_BACKOFF_FACTOR = 1.5;
/** Official Spicy client retries 503 indefinitely; static lyrics often need long queue waits. */
const SPICY_QUEUE_MAX_WAIT_MS = 12 * 60 * 1000;
const SPICY_QUEUE_MAX_ATTEMPTS = 120;
const { SLObjPack, isSpicyObjPackPayload } = require("./slObjPack.js");
const spicyLyricsObjPack = new SLObjPack();
/** Public CORS proxy; POST + JSON body and custom headers are forwarded per https://corsproxy.io/ */
const SPICY_LYRICS_CORSPROXY_PREFIX = "https://corsproxy.io/?url=";
const SPICY_PROXY_FALLBACK_STATUSES = new Set([403, 429, 502, 503, 504]);
const SPICY_DIRECT_429_MAX_RETRIES = 2;
const SPICY_DIRECT_429_BASE_DELAY_MS = 2_500;
const SPICY_DEBUG_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.SPICY_DEBUG || "")
    .trim()
    .toLowerCase(),
);

const spicyLyricsNetworkRef = {
  /** @type {null | (() => boolean)} */
  getSpicyLyricsUseCorsProxyFromBridge: null,
};
function setSpicyLyricsNetworkOptions({
  getSpicyLyricsUseCorsProxy = null,
} = {}) {
  spicyLyricsNetworkRef.getSpicyLyricsUseCorsProxyFromBridge =
    typeof getSpicyLyricsUseCorsProxy === "function"
      ? getSpicyLyricsUseCorsProxy
      : null;
}

function shouldFetchSpicyLyricsViaCorsProxy() {
  const envFlag = String(process.env.SPICY_LYRICS_USE_CORSPROXY ?? "")
    .trim()
    .toLowerCase();
  if (["0", "false", "no", "off"].includes(envFlag)) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(envFlag)) {
    return true;
  }
  if (spicyLyricsNetworkRef.getSpicyLyricsUseCorsProxyFromBridge) {
    return (
      spicyLyricsNetworkRef.getSpicyLyricsUseCorsProxyFromBridge() === true
    );
  }
  return false;
}

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

function maskTokenPreview(value) {
  const safe = String(value || "").trim();
  if (!safe) {
    return "";
  }
  const unprefixed = safe.replace(/^bearer\s+/i, "");
  if (unprefixed.length <= 10) {
    return `${unprefixed.slice(0, 2)}...${unprefixed.slice(-2)}`;
  }
  return `${unprefixed.slice(0, 6)}...${unprefixed.slice(-4)}`;
}

function sanitizeSpicyHeaders(headers = {}) {
  const entries = Object.entries(headers || {});
  const sanitized = {};
  for (const [key, value] of entries) {
    const lower = String(key || "").toLowerCase();
    if (
      lower.includes("auth") ||
      lower.includes("token") ||
      lower === "cookie"
    ) {
      sanitized[key] = maskTokenPreview(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function buildSpicyLyricsQueryVariables(spotifyTrackId) {
  return {
    id: String(spotifyTrackId || "").trim(),
    auth: "SpicyLyrics-WebAuth",
  };
}

function normalizeSpicyLyricsQueryData(data) {
  if (!data) {
    return data;
  }
  if (isSpicyObjPackPayload(data)) {
    return spicyLyricsObjPack.unpack(data);
  }
  return data;
}

function resolveSpicyResultTrackId(data) {
  if (!data) {
    return "";
  }
  if (!isSpicyObjPackPayload(data)) {
    return String(data?.id || "").trim();
  }
  try {
    return String(spicyLyricsObjPack.unpack(data)?.id || "").trim();
  } catch {
    return "";
  }
}

function computeSpicyQueueDelayMs(attempt) {
  const scaled =
    SPICY_QUEUE_BASE_DELAY_MS * SPICY_QUEUE_BACKOFF_FACTOR ** attempt;
  return Math.min(SPICY_QUEUE_MAX_DELAY_MS, Math.round(scaled));
}

function getSpicyLyricsQueryHttpStatus(
  queryResults,
  {
    expectedOperation = "lyrics",
    expectedOperationId = "0",
    expectedTrackId = "",
  } = {},
) {
  const entry = selectSpicyQueryResult(queryResults, {
    expectedOperation,
    expectedOperationId,
    expectedTrackId,
  });
  return Number(entry?.result?.httpStatus || 0);
}

function summarizeSpicyPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      kind: typeof payload,
    };
  }
  if (isSpicyObjPackPayload(payload)) {
    return {
      packed: true,
      valuesLength: Array.isArray(payload[0]) ? payload[0].length : 0,
      streamLength: Array.isArray(payload[1]) ? payload[1].length : 0,
    };
  }
  return {
    type: payload.Type || "",
    id: payload.id || "",
    provider: payload.Provider || payload.ProviderDisplayName || "",
    lineCount: Array.isArray(payload.Content)
      ? payload.Content.length
      : Array.isArray(payload.Lines)
        ? payload.Lines.length
        : 0,
    hasContent: Array.isArray(payload.Content),
    hasLines: Array.isArray(payload.Lines),
    includesRomanization: Boolean(payload.IncludesRomanization),
    songwriterCount: extractSpicySongwriters(payload).length,
    hasTimedStaticLines: Array.isArray(payload.Lines)
      ? hasSpicyStaticLineTiming(payload.Lines)
      : false,
  };
}

function hasSpicyLyricsQueryPayload(result) {
  if (!result || typeof result !== "object") {
    return false;
  }
  const data = result.data;
  if (data === null || data === undefined || data === "") {
    return false;
  }
  const format = String(result.format || "").toLowerCase();
  // Static lyrics commonly return format "text"; syllable/line use "json".
  // The official Spicy client unpacks either without checking format.
  if (!format || format === "json" || format === "text") {
    return true;
  }
  return false;
}

function buildSpicyLyricsDirectUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${SPICY_LYRICS_API_URL}${normalizedPath}`;
}

function buildSpicyLyricsFetchUrl(path) {
  const direct = buildSpicyLyricsDirectUrl(path);
  if (!shouldFetchSpicyLyricsViaCorsProxy()) {
    return direct;
  }
  return `${SPICY_LYRICS_CORSPROXY_PREFIX}${encodeURIComponent(direct)}`;
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
      "https://apic.musixmatch.com/ws/1.1",
      "https://apic-desktop.musixmatch.com/ws/1.1",
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
  return query.size ? `${url}?${query.toString()}` : url;
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

async function fetchSpicyLyricsQuery(queries, headers = {}) {
  const version = SPICY_LYRICS_CLIENT_VERSION;
  const body = JSON.stringify({
    queries,
    client: {
      version,
    },
  });
  const baseHeaders = {
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-Latn-US,en-US;q=0.9,en-Latn;q=0.8,en;q=0.7",
    "Content-Type": "application/json",
    "SpicyLyrics-Version": version,
    Origin: "https://xpui.app.spotify.com",
    Referer: "https://xpui.app.spotify.com/",
    Priority: "u=1, i",
    "Sec-CH-UA": '"Not-A.Brand";v="24", "Chromium";v="146"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.179 Spotify/1.2.92.147 Safari/537.36",
    ...headers,
  };

  const doPost = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      return await fetch(url, {
        method: "POST",
        headers: baseHeaders,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const primaryUrl = buildSpicyLyricsFetchUrl("/query");
  const directUrl = buildSpicyLyricsDirectUrl("/query");
  const primaryWasProxied = primaryUrl !== directUrl;

  spicyDebugLog("Spicy /query request", {
    version,
    primaryUrl,
    directUrl,
    primaryWasProxied,
    headers: sanitizeSpicyHeaders(baseHeaders),
    queryJsonPreview: JSON.stringify(
      Array.isArray(queries)
        ? queries.map((query) => ({
            operation: String(query?.operation || ""),
            variables: query?.variables || {},
          }))
        : [],
    ),
    queryCount: Array.isArray(queries) ? queries.length : 0,
    queryOperations: Array.isArray(queries)
      ? queries.map((query) => ({
          operation: String(query?.operation || ""),
          variables: query?.variables || {},
        }))
      : [],
  });

  let response = await doPost(primaryUrl);
  spicyDebugLog("Spicy /query response received", {
    url: primaryUrl,
    status: response.status,
    retryAfter: response.headers.get("retry-after") || "",
    contentType: response.headers.get("content-type") || "",
    server: response.headers.get("server") || "",
  });
  if (
    !response.ok &&
    primaryWasProxied &&
    SPICY_PROXY_FALLBACK_STATUSES.has(response.status)
  ) {
    spicyDebugLog("Spicy /query retrying direct after proxied failure", {
      proxiedStatus: response.status,
      directUrl,
    });
    response = await doPost(directUrl);
    spicyDebugLog("Spicy /query direct retry response received", {
      url: directUrl,
      status: response.status,
      retryAfter: response.headers.get("retry-after") || "",
      contentType: response.headers.get("content-type") || "",
      server: response.headers.get("server") || "",
    });
  }

  let attempt = 0;
  while (
    !response.ok &&
    response.status === 429 &&
    attempt < SPICY_DIRECT_429_MAX_RETRIES
  ) {
    const headerSec = Number(response.headers.get("retry-after") || 0);
    const headerMs =
      Number.isFinite(headerSec) && headerSec > 0 ? headerSec * 1000 : 0;
    const backoffMs = SPICY_DIRECT_429_BASE_DELAY_MS * (attempt + 1);
    const delayMs = Math.min(
      45_000,
      Math.max(backoffMs, headerMs || backoffMs),
    );
    spicyDebugLog("Spicy /query backing off after 429", {
      attempt: attempt + 1,
      status: response.status,
      retryAfterHeader: response.headers.get("retry-after") || "",
      delayMs,
      directUrl,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await doPost(directUrl);
    spicyDebugLog("Spicy /query retry response received", {
      attempt: attempt + 1,
      status: response.status,
      retryAfter: response.headers.get("retry-after") || "",
      contentType: response.headers.get("content-type") || "",
      server: response.headers.get("server") || "",
    });
    attempt += 1;
  }

  if (!response.ok) {
    const hint =
      primaryWasProxied && response.status === 429
        ? " (corsproxy.io often returns 429 for POST; leave Spicy proxy off in the bridge for desktop.)"
        : "";
    throw new Error(`HTTP ${response.status}${hint}`);
  }

  const rawText = await response.text();
  const payload = parseJsonLenient(rawText);
  const returnedQueries = Array.isArray(payload?.queries)
    ? payload.queries
    : [];
  spicyDebugLog("Spicy /query payload summary", {
    returnedQueryCount: returnedQueries.length,
    payloadKeys:
      payload && typeof payload === "object"
        ? Object.keys(payload).slice(0, 12)
        : [],
    firstQueryOperationId: String(returnedQueries[0]?.operationId ?? ""),
    firstQueryStatus: Number(returnedQueries[0]?.result?.httpStatus || 0),
    firstQueryFormat: String(returnedQueries[0]?.result?.format || ""),
    firstQueryData: summarizeSpicyPayload(returnedQueries[0]?.result?.data),
    rawPreview: String(rawText || "").slice(0, 500),
  });
  return returnedQueries.map((entry, index) => ({
    operation: String(entry?.operation || ""),
    operationId: String(entry?.operationId ?? index),
    result: entry?.result || null,
  }));
}

async function fetchSpicyLyricsQueryWithQueueRetry(
  queries,
  headers = {},
  {
    expectedOperation = "lyrics",
    expectedOperationId = "0",
    expectedTrackId = "",
    maxAttempts = SPICY_QUEUE_MAX_ATTEMPTS,
    maxWaitMs = SPICY_QUEUE_MAX_WAIT_MS,
    signal = null,
  } = {},
) {
  let attempt = 0;
  let lastResults = null;
  const startedAt = Date.now();
  while (
    attempt < maxAttempts &&
    Date.now() - startedAt < Math.max(5_000, Number(maxWaitMs) || 0)
  ) {
    lastResults = await fetchSpicyLyricsQuery(queries, headers);
    const status = getSpicyLyricsQueryHttpStatus(lastResults, {
      expectedOperation,
      expectedOperationId,
      expectedTrackId,
    });
    if (status !== 503) {
      if (attempt > 0) {
        spicyDebugLog("Spicy /query queue resolved", {
          attempt,
          status,
          waitedMs: Date.now() - startedAt,
        });
      }
      return lastResults;
    }

    const delayMs = computeSpicyQueueDelayMs(attempt);
    attempt += 1;
    spicyDebugLog("Spicy /query queued (HTTP 503), retrying", {
      attempt,
      delayMs,
      maxAttempts,
      waitedMs: Date.now() - startedAt,
      maxWaitMs,
      expectedTrackId: String(expectedTrackId || ""),
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason || new Error("Spicy queue retry aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason || new Error("Spicy queue retry aborted"));
        },
        { once: true },
      );
    });
  }
  spicyDebugLog("Spicy /query queue wait exhausted", {
    attempt,
    waitedMs: Date.now() - startedAt,
    maxWaitMs,
    maxAttempts,
    expectedTrackId: String(expectedTrackId || ""),
    lastStatus: getSpicyLyricsQueryHttpStatus(lastResults, {
      expectedOperation,
      expectedOperationId,
      expectedTrackId,
    }),
  });
  return lastResults;
}

function selectSpicyQueryResult(
  queryResults,
  {
    expectedOperation = "",
    expectedOperationId = "",
    expectedTrackId = "",
  } = {},
) {
  const entries = Array.isArray(queryResults) ? queryResults : [];
  if (!entries.length) {
    return null;
  }

  const normalizedOperation = String(expectedOperation || "")
    .trim()
    .toLowerCase();
  const normalizedOperationId = String(expectedOperationId || "").trim();
  const normalizedTrackId = String(expectedTrackId || "").trim();

  const hasResult = (entry) => Boolean(entry?.result);
  const matchesOperation = (entry) =>
    Boolean(normalizedOperation) &&
    String(entry?.operation || "")
      .trim()
      .toLowerCase() === normalizedOperation;
  const matchesOperationId = (entry) =>
    Boolean(normalizedOperationId) &&
    String(entry?.operationId || "").trim() === normalizedOperationId;
  const matchesTrackId = (entry) =>
    Boolean(normalizedTrackId) &&
    resolveSpicyResultTrackId(entry?.result?.data) === normalizedTrackId;

  return (
    entries.find(
      (entry) =>
        hasResult(entry) && matchesOperation(entry) && matchesTrackId(entry),
    ) ||
    entries.find(
      (entry) =>
        hasResult(entry) && matchesOperationId(entry) && matchesTrackId(entry),
    ) ||
    entries.find((entry) => hasResult(entry) && matchesOperation(entry)) ||
    entries.find((entry) => hasResult(entry) && matchesOperationId(entry)) ||
    entries.find((entry) => hasResult(entry) && matchesTrackId(entry)) ||
    entries.find((entry) => hasResult(entry)) ||
    null
  );
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

function strictSpicySpotifyTitleArtistMatch(track, candidate) {
  if (!titleCoreMatchesQuery(track, candidate?.title || "")) {
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

  const requestedPrimaryArtist = normalizeText(
    getPrimaryArtistName(track?.artist || ""),
  );
  if (!requestedPrimaryArtist) {
    // If we don't know the artist, at least enforce exact core-title matching.
    return true;
  }
  const candidatePrimaryArtist = normalizeText(
    getPrimaryArtistName(candidate?.artist || ""),
  );
  if (!candidatePrimaryArtist) {
    return false;
  }

  // Windows media session often only provides the first artist; accept primary overlap.
  return (
    requestedPrimaryArtist === candidatePrimaryArtist ||
    requestedPrimaryArtist.includes(candidatePrimaryArtist) ||
    candidatePrimaryArtist.includes(requestedPrimaryArtist)
  );
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

function pickBestSpotifyPartnerCatalogMatch(track, matches) {
  const ranked = (Array.isArray(matches) ? matches : [])
    .filter((candidate) => candidate?.id)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) {
    return null;
  }

  const eligible = ranked.filter((candidate) => {
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
  if (isAmbiguousTopMatch(eligible)) {
    return null;
  }
  return eligible[0];
}

async function resolveSpotifyCatalogTrackViaPartnerSearch(track, accessToken) {
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

  const best = pickBestSpotifyPartnerCatalogMatch(safeTrack, matches);
  if (!best?.id) {
    return null;
  }

  let title = best.title;
  let artist = best.artist;
  let album = best.album || "";
  let durationMs = best.durationMs;
  const webTrack = await fetchSpotifyWebApiTrackById(best.id, safeToken);
  if (webTrack) {
    const webArtists = formatSpotifyWebApiTrackArtists(webTrack);
    if (webArtists) {
      artist = webArtists;
    }
    title = String(webTrack?.name || title).trim();
    album = String(webTrack?.album?.name || album).trim();
    durationMs = Number(webTrack?.duration_ms || durationMs || 0);
  }

  return {
    id: best.id,
    title,
    artist,
    album,
    durationMs,
    score: best.score,
  };
}

async function searchSpotifyTrackCandidatesStrictForSpicy(track, accessToken) {
  const queryVariants = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  const seenIds = new Set();
  const matches = [];
  let lastError = null;
  const searchResults = await Promise.all(
    queryVariants.map(async (query) => {
      try {
        const payload = await fetchSpotifyPartnerSearch(query, accessToken);
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
      track,
      result.payload,
      seenIds,
      matches,
    );
  }
  if (!matches.length && lastError) {
    throw lastError;
  }
  const ranked = matches.sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    return [];
  }

  const strict = ranked.filter((candidate) =>
    strictSpicySpotifyTitleArtistMatch(track, candidate),
  );
  if (strict.length) {
    return strict
      .slice(0, MAX_SPICY_STRICT_SPOTIFY_CANDIDATES)
      .map((candidate) => candidate.id)
      .filter(Boolean);
  }

  // No strict hit: return empty so Spicy can fail fast instead of mismatching.
  return [];
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
