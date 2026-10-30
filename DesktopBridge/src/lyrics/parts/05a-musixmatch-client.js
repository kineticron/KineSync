"use strict";

// Musixmatch client profiles, token resolution, richsync/subtitle fetching, translation mapping, and source adapter.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

function normalizeMusixmatchBody(payload) {
  const header = payload?.message?.header || payload?.header || {};
  const body = payload?.message?.body || payload?.body || {};
  const hint = redactMusixmatchDiagnostic(header?.hint || "");
  const statusCode = Number(header?.status_code || 0);
  return { statusCode, hint, body };
}

function redactMusixmatchDiagnostic(value) {
  return String(value || "").trim()
    .replace(/((?:user_?token|signature|cookie|authorization)\s*[:=]\s*)[^\s;&,)]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .slice(0, 200);
}

function assertMusixmatchSuccess(payload, endpointLabel) {
  const { statusCode, hint, body } = normalizeMusixmatchBody(payload);
  const hintSuffix = hint ? ` (${hint})` : "";
  const fail = (name, message) => {
    const error = new Error(message);
    error.name = name;
    error.apiStatus = statusCode;
    error.hint = hint;
    error.endpoint = `/${endpointLabel}`;
    throw error;
  };
  if (hint.toLowerCase().includes("captcha")) {
    fail("MusixmatchCaptchaError", `Musixmatch blocked request with captcha${hintSuffix}.`);
  }
  if (statusCode === 429) {
    fail("MusixmatchRateLimitError", `Musixmatch cooldown active (API 429)${hintSuffix}.`);
  }
  if (statusCode === 401 || statusCode === 403) {
    fail("MusixmatchAuthError", `Musixmatch user token was rejected${hintSuffix}.`);
  }
  if (statusCode === 404 && /endpoint not found/i.test(hint)) {
    fail("MusixmatchEndpointError", `Musixmatch ${endpointLabel} failed with API 404${hintSuffix}.`);
  }
  if (statusCode !== 200 && statusCode !== 404) {
    fail("MusixmatchApiError", `Musixmatch ${endpointLabel} failed with API status ${statusCode || "unknown"}${hintSuffix}.`);
  }
  return { statusCode, hint, body };
}

function extractMusixmatchTracks(payload) {
  const { body } = assertMusixmatchSuccess(payload, "track.search");
  const list = Array.isArray(body?.track_list) ? body.track_list : [];
  return list
    .map((entry) => entry?.track || entry)
    .filter((trackEntry) => trackEntry && typeof trackEntry === "object");
}

function extractMusixmatchMatchedTrack(payload) {
  const { body } = assertMusixmatchSuccess(payload, "macro.subtitles.get");
  const matcher = body?.macro_calls?.["matcher.track.get"]?.message;
  if (matcher) {
    const { statusCode, body: matchedBody } = assertMusixmatchSuccess(matcher, "matcher.track.get");
    if (statusCode === 404) return null;
    const track = matchedBody?.track;
    return track && typeof track === "object" ? track : null;
  }
  const direct = body?.track || body?.matcher?.track;
  return direct && typeof direct === "object" ? direct : null;
}

function toMusixmatchDurationMs(track) {
  const directMs = Number(track?.duration_ms || track?.track_length_ms || 0);
  if (Number.isFinite(directMs) && directMs > 0) {
    return directMs;
  }
  const seconds = Number(track?.track_length || track?.duration || 0);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds < 10_000 ? seconds * 1000 : seconds;
  }
  return 0;
}

function findFirstNestedStringByKey(value, keyName, depth = 0) {
  if (depth > 10 || value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNestedStringByKey(item, keyName, depth + 1);
      if (found) {
        return found;
      }
    }
    return "";
  }
  if (typeof value !== "object") {
    return "";
  }
  const direct = value[keyName];
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }
  for (const nestedValue of Object.values(value)) {
    const found = findFirstNestedStringByKey(nestedValue, keyName, depth + 1);
    if (found) {
      return found;
    }
  }
  return "";
}

function extractMusixmatchSubtitleBody(payload, endpointLabel = "track.subtitles.get") {
  const { statusCode, body } = assertMusixmatchSuccess(payload, endpointLabel);
  if (statusCode === 404) return "";
  if (body?.macro_calls) {
    const call = body.macro_calls["track.subtitles.get"] || body.macro_calls["track.subtitle.get"];
    if (!call?.message) return "";
    return extractMusixmatchSubtitleBody(call.message, "track.subtitles.get");
  }
  const direct = body?.subtitle?.subtitle_body;
  if (typeof direct === "string" && direct.trim()) return direct;
  const list = Array.isArray(body?.subtitle_list) ? body.subtitle_list : [];
  for (const entry of list) {
    const text = entry?.subtitle?.subtitle_body;
    if (typeof text === "string" && text.trim()) return text;
  }
  return "";
}

function tryParseMusixmatchTokenObject(rawToken) {
  const raw = String(rawToken || "").trim();
  if (!raw) {
    return null;
  }
  const variants = [raw];
  const decoded = decodeUriComponentSafe(raw);
  if (decoded && decoded !== raw) {
    variants.push(decoded);
  }

  for (const candidate of variants) {
    let normalized = String(candidate || "").trim();
    if (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      normalized = normalized.slice(1, -1).trim();
    }
    if (!normalized.startsWith("{") || !normalized.endsWith("}")) {
      continue;
    }
    const parsed = tryParseJson(normalized);
    if (
      parsed.ok &&
      parsed.value &&
      typeof parsed.value === "object" &&
      !Array.isArray(parsed.value)
    ) {
      return parsed.value;
    }
  }
  return null;
}

function buildMusixmatchProfileForAppId(appId) {
  const normalizedAppId = String(appId || "").trim();
  if (!normalizedAppId) {
    return null;
  }
  const existing = MUSIXMATCH_CLIENT_PROFILES.find(
    (profile) => profile.appId === normalizedAppId,
  );
  if (existing) {
    const existingLower = existing.appId.toLowerCase();
    const existingIsIosLike =
      existingLower.includes("ios") ||
      existingLower.includes("iphone") ||
      existingLower.includes("ipad");
    return {
      appId: existing.appId,
      profileId: existing.profileId || "",
      tokenKey: existing.tokenKey,
      userAgent: existing.userAgent,
      userLanguage: existing.userLanguage,
      cookieHeader: existing.cookieHeader,
      headers: { ...(existing.headers || {}) },
      baseUrls: Array.isArray(existing.baseUrls)
        ? [...existing.baseUrls]
        : [...MUSIXMATCH_DEFAULT_BASE_URLS],
      defaultParams:
        existing.defaultParams ||
        (existingIsIosLike
          ? {
              app_version: MUSIXMATCH_IOS_DEBUG_CONTEXT.appVersion,
              build_number: MUSIXMATCH_IOS_DEBUG_CONTEXT.appBuild,
              os_version: MUSIXMATCH_IOS_DEBUG_CONTEXT.osVersion,
              user_id: MUSIXMATCH_IOS_DEBUG_CONTEXT.userId,
              country: MUSIXMATCH_IOS_DEBUG_CONTEXT.country,
              guid: MUSIXMATCH_IOS_DEBUG_CONTEXT.deviceId,
              device_id: MUSIXMATCH_IOS_DEBUG_CONTEXT.deviceId,
            }
          : {}),
    };
  }

  const lower = normalizedAppId.toLowerCase();
  const iosTemplate =
    MUSIXMATCH_CLIENT_PROFILES.find((profile) =>
      profile.appId.toLowerCase().includes("ios"),
    ) || MUSIXMATCH_CLIENT_PROFILES[0];
  const androidTemplate =
    MUSIXMATCH_CLIENT_PROFILES.find((profile) =>
      profile.appId.toLowerCase().includes("android"),
    ) || MUSIXMATCH_CLIENT_PROFILES[0];
  const webTemplate =
    MUSIXMATCH_CLIENT_PROFILES.find((profile) =>
      profile.appId.toLowerCase().includes("web-desktop"),
    ) || MUSIXMATCH_CLIENT_PROFILES[0];

  const template =
    lower.includes("ios") || lower.includes("iphone") || lower.includes("ipad")
      ? iosTemplate
      : lower.includes("android")
        ? androidTemplate
        : webTemplate;

  const isIosLike =
    lower.includes("ios") || lower.includes("iphone") || lower.includes("ipad");

  return {
    appId: normalizedAppId,
    profileId: template.profileId || "",
    tokenKey: normalizedAppId,
    userAgent: template.userAgent,
    userLanguage: template.userLanguage,
    cookieHeader: template.cookieHeader,
    headers: { ...(template.headers || {}) },
    baseUrls: Array.isArray(template.baseUrls)
      ? [...template.baseUrls]
      : [...MUSIXMATCH_DEFAULT_BASE_URLS],
    defaultParams: isIosLike
      ? {
          app_version: MUSIXMATCH_IOS_DEBUG_CONTEXT.appVersion,
          build_number: MUSIXMATCH_IOS_DEBUG_CONTEXT.appBuild,
          os_version: MUSIXMATCH_IOS_DEBUG_CONTEXT.osVersion,
          user_id: MUSIXMATCH_IOS_DEBUG_CONTEXT.userId,
          country: MUSIXMATCH_IOS_DEBUG_CONTEXT.country,
          guid: MUSIXMATCH_IOS_DEBUG_CONTEXT.deviceId,
          device_id: MUSIXMATCH_IOS_DEBUG_CONTEXT.deviceId,
        }
      : {},
  };
}

function extractMusixmatchTokenStringCandidates(rawToken) {
  const candidates = [];
  const pushCandidate = (value) => {
    const safe = String(value || "").trim();
    if (!safe) {
      return;
    }
    if (!candidates.includes(safe)) {
      candidates.push(safe);
    }
  };

  const safeRaw = String(rawToken || "").trim();
  pushCandidate(safeRaw);
  const decoded = decodeUriComponentSafe(safeRaw);
  pushCandidate(decoded);

  // "Bearer xxx" appears in some mobile-debug dumps.
  if (/^bearer\s+/i.test(safeRaw)) {
    pushCandidate(safeRaw.replace(/^bearer\s+/i, ""));
  }
  return candidates;
}

function collectNestedStringEntries(value, depth = 0, entries = []) {
  if (depth > 12 || value === null || value === undefined) {
    return entries;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedStringEntries(item, depth + 1, entries);
    }
    return entries;
  }
  if (typeof value !== "object") {
    return entries;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (typeof nestedValue === "string") {
      entries.push({ key: String(key), value: nestedValue });
      continue;
    }
    collectNestedStringEntries(nestedValue, depth + 1, entries);
  }
  return entries;
}

function looksLikeMusixmatchAppIdKey(key) {
  const normalized = String(key || "")
    .trim()
    .toLowerCase();
  if (!normalized || !/^[a-z0-9._-]+$/.test(normalized)) {
    return false;
  }
  if (!/-v\d+\.\d+$/.test(normalized)) {
    return false;
  }
  return (
    normalized.includes("app") ||
    normalized.includes("ios") ||
    normalized.includes("iphone") ||
    normalized.includes("android") ||
    normalized.includes("desktop") ||
    normalized.includes("web")
  );
}

function looksLikeMusixmatchTokenValue(value) {
  const safe = String(value || "").trim();
  if (!safe || safe.length < 12 || /\s/.test(safe)) {
    return false;
  }
  return !safe.startsWith("{") && !safe.startsWith("[");
}

function shouldAbortMusixmatchTokenAttempt(error) {
  const reason = describeSourceError(error);
  return reason === "unauthorized" || reason === "rate-limited" ||
    error?.name === "MusixmatchEndpointError";
}

async function getMusixmatchSignatureSecret({ timeoutMs = 6_000 } = {}) {
  const now = Date.now();
  if (
    musixmatchSignatureSecretCache.value &&
    musixmatchSignatureSecretCache.expiresAt > now
  ) {
    return musixmatchSignatureSecretCache.value;
  }

  let signatureSecret = MUSIXMATCH_SIGNATURE_FALLBACK_SECRET;
  try {
    const communityHtml = await fetchText(
      "https://www.musixmatch.com/community",
      {
        timeoutMs,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
      },
    );
    const scriptPathMatch =
      communityHtml.match(/"(https?:\/\/[^"]*common-[^"]+\.js)"/i) ||
      communityHtml.match(/"(\/\/[^"]*common-[^"]+\.js)"/i) ||
      communityHtml.match(/"(\/[^"]*common-[^"]+\.js)"/i);
    if (scriptPathMatch?.[1]) {
      const rawScriptUrl = String(scriptPathMatch[1]);
      const scriptUrl = rawScriptUrl.startsWith("//")
        ? `https:${rawScriptUrl}`
        : rawScriptUrl.startsWith("/")
          ? `https://www.musixmatch.com${rawScriptUrl}`
          : rawScriptUrl;
      const scriptBody = await fetchText(scriptUrl, {
        timeoutMs,
        headers: {
          Accept: "*/*",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
      });
      const secretMatch =
        scriptBody.match(/signatureSecret\s*:\s*"([a-fA-F0-9]{40})"/) ||
        scriptBody.match(/signatureSecret\\?":\\?"([a-fA-F0-9]{40})"/);
      if (secretMatch?.[1]) {
        signatureSecret = secretMatch[1];
      }
    }
  } catch {
    // Fall back to known static key when scraping fails.
  }

  musixmatchSignatureSecretCache.value = signatureSecret;
  musixmatchSignatureSecretCache.expiresAt =
    Date.now() + MUSIXMATCH_SIGNATURE_CACHE_TTL_MS;
  return signatureSecret;
}

function appendMusixmatchSignature(unsignedUrl, signatureSecret) {
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const hmacPayload = `${unsignedUrl}${dateStamp}`;
  const signature = crypto
    .createHmac(
      "sha1",
      String(signatureSecret || MUSIXMATCH_SIGNATURE_FALLBACK_SECRET),
    )
    .update(hmacPayload, "utf8")
    .digest("base64");
  const separator = unsignedUrl.includes("?") ? "&" : "?";
  return `${unsignedUrl}${separator}signature=${encodeURIComponent(signature)}&signature_protocol=sha1`;
}

async function fetchMusixmatchText(url, { headers = {}, timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const safeHeaders = typeof makeMobileSafeHeaders === "function"
      ? makeMobileSafeHeaders(headers)
      : headers;
    const response = await fetch(url, { method: "GET", headers: safeHeaders, signal: controller.signal });
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      const error = new Error(`HTTP ${response.status}`);
      error.httpStatus = response.status;
      error.responseText = responseText;
      throw error;
    }
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function resolveMusixmatchClientCandidates(rawToken) {
  const safeRaw = String(rawToken || "").trim();
  if (!safeRaw) {
    return [];
  }

  const resolved = [];
  const seen = new Set();
  const pushCandidate = (profile, token, tokenSource) => {
    const safeToken = String(token || "").trim();
    if (!safeToken || /^0+$/.test(safeToken) || /^UpgradeOnly$/i.test(safeToken)) {
      return;
    }
    const signature = `${profile.appId}|${safeToken}`;
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    resolved.push({
      ...profile,
      userToken: safeToken,
      tokenSource: tokenSource || "raw",
    });
  };

  const parsedTokenObject =
    tryParseMusixmatchTokenObject(safeRaw) ||
    (() => {
      for (const candidate of extractMusixmatchTokenStringCandidates(safeRaw)) {
        const parsed = tryParseMusixmatchTokenObject(candidate);
        if (parsed) {
          return parsed;
        }
      }
      return null;
    })();

  if (
    parsedTokenObject &&
    ["profileId", "acquiredAt", "userToken", "appId"].some((key) => Object.prototype.hasOwnProperty.call(parsedTokenObject, key))
  ) {
    const userToken = String(parsedTokenObject.userToken || "").trim();
    const acquiredAt = Number(parsedTokenObject.acquiredAt || 0);
    const now = Date.now();
    if (
      parsedTokenObject.profileId !== MUSIXMATCH_APP_MOBILE_PROFILE.profileId ||
      parsedTokenObject.appId !== MUSIXMATCH_APP_MOBILE_PROFILE.appId ||
      !looksLikeMusixmatchTokenValue(userToken) ||
      /^0+$/.test(userToken) ||
      /^UpgradeOnly$/i.test(userToken) ||
      !Number.isFinite(acquiredAt) ||
      acquiredAt <= 0 || now - acquiredAt < 0 ||
      now - acquiredAt >= MUSIXMATCH_APP_MOBILE_PROFILE.tokenTtlMs
    ) {
      return [];
    }
    const profile = buildMusixmatchProfileForAppId(parsedTokenObject.appId);
    profile.defaultParams = { guid: String(parsedTokenObject.deviceId || "").trim() || crypto.randomUUID() };
    pushCandidate(profile, userToken, "typed-cache");
    return resolved;
  }

  const collectPrioritizedTokenEntries = (parsedObject) => {
    const entries = [];
    const seen = new Set();
    const addEntry = (key, token) => {
      const safeKey = String(key || "").trim();
      const safeToken = String(token || "").trim();
      if (!safeKey || !safeToken) {
        return;
      }
      const signature = `${safeKey}|${safeToken}`;
      if (seen.has(signature)) {
        return;
      }
      seen.add(signature);
      entries.push({ key: safeKey, token: safeToken });
    };

    if (
      parsedObject.profileId === "mac-ios-v2.0@apic-appmobile" &&
      parsedObject.appId === "mac-ios-v2.0" &&
      parsedObject.acquiredAt > 0
    ) {
      addEntry(parsedObject.appId, parsedObject.userToken);
    }

    for (const key of MUSIXMATCH_TOKEN_PRIORITY_KEYS) {
      addEntry(key, findFirstNestedStringByKey(parsedObject, key));
    }
    const desktopToken = entries.find(
      (entry) => entry.key === "web-desktop-app-v1.0",
    );
    const ordered = desktopToken
      ? [
          desktopToken,
          ...entries.filter((entry) => entry.key !== "web-desktop-app-v1.0"),
        ]
      : entries;
    const hasPriorityToken = entries.length > 0;
    if (hasPriorityToken) {
      return ordered.slice(0, 4);
    }
    for (const entry of collectNestedStringEntries(parsedObject)) {
      if (!looksLikeMusixmatchAppIdKey(entry.key)) {
        continue;
      }
      if (!looksLikeMusixmatchTokenValue(entry.value)) {
        continue;
      }
      addEntry(entry.key, entry.value);
    }
    return entries;
  };

  const profileByAppId = new Map();
  for (const profile of MUSIXMATCH_CLIENT_PROFILES) {
    profileByAppId.set(profile.appId, profile);
  }
  for (const appId of [
    ...MUSIXMATCH_KNOWN_TOKEN_KEYS,
    ...MUSIXMATCH_IOS_APP_ID_CANDIDATES,
  ]) {
    const profile = buildMusixmatchProfileForAppId(appId);
    if (profile && !profileByAppId.has(profile.appId)) {
      profileByAppId.set(profile.appId, profile);
    }
  }
  const nestedStringEntries = collectNestedStringEntries(parsedTokenObject);
  for (const entry of nestedStringEntries) {
    if (!looksLikeMusixmatchAppIdKey(entry.key)) {
      continue;
    }
    const dynamicProfile = buildMusixmatchProfileForAppId(entry.key);
    if (dynamicProfile && !profileByAppId.has(dynamicProfile.appId)) {
      profileByAppId.set(dynamicProfile.appId, dynamicProfile);
    }
  }
  const allProfiles = [...profileByAppId.values()];

  if (!parsedTokenObject) {
    for (const tokenCandidate of extractMusixmatchTokenStringCandidates(
      safeRaw,
    )) {
      const prioritizedProfiles = MUSIXMATCH_RAW_TOKEN_PROFILE_PRIORITY.map(
        (appId) => allProfiles.find((profile) => profile.appId === appId),
      ).filter(Boolean);
      const profilesToTry = prioritizedProfiles.length
        ? prioritizedProfiles
        : allProfiles.slice(0, 3);
      for (const profile of profilesToTry) {
        pushCandidate(profile, tokenCandidate, "raw");
      }
    }
    return resolved;
  }

  const prioritizedEntries = collectPrioritizedTokenEntries(parsedTokenObject);
  for (const prioritizedEntry of prioritizedEntries) {
    const prioritizedProfile = buildMusixmatchProfileForAppId(
      prioritizedEntry.key,
    );
    if (prioritizedProfile) {
      pushCandidate(
        prioritizedProfile,
        prioritizedEntry.token,
        prioritizedEntry.key,
      );
    }
  }
  if (prioritizedEntries.length) {
    return resolved;
  }

  for (const profile of allProfiles) {
    pushCandidate(
      profile,
      findFirstNestedStringByKey(parsedTokenObject, profile.tokenKey),
      profile.tokenKey,
    );
  }
  for (const appId of MUSIXMATCH_KNOWN_TOKEN_KEYS) {
    const tokenForKnownKey = findFirstNestedStringByKey(
      parsedTokenObject,
      appId,
    );
    if (!tokenForKnownKey) {
      continue;
    }
    const profile = buildMusixmatchProfileForAppId(appId);
    if (profile) {
      pushCandidate(profile, tokenForKnownKey, appId);
    }
  }
  for (const fallbackKey of MUSIXMATCH_TOKEN_FALLBACK_KEYS) {
    const fallbackToken = findFirstNestedStringByKey(
      parsedTokenObject,
      fallbackKey,
    );
    if (!fallbackToken) {
      continue;
    }
    for (const profile of allProfiles) {
      pushCandidate(profile, fallbackToken, fallbackKey);
    }
  }
  for (const entry of nestedStringEntries) {
    if (!looksLikeMusixmatchAppIdKey(entry.key)) {
      continue;
    }
    if (!looksLikeMusixmatchTokenValue(entry.value)) {
      continue;
    }
    const dynamicProfile = buildMusixmatchProfileForAppId(entry.key);
    if (dynamicProfile) {
      pushCandidate(dynamicProfile, entry.value, entry.key);
    }
  }
  return resolved;
}

async function fetchMusixmatchJson(
  path,
  params,
  {
    timeoutMs = 12_000,
    appId = "web-desktop-app-v1.0",
    userToken = "",
    userAgent = "KineSyncDesktopBridge/1.0",
    userLanguage = "en",
    cookieHeader = "",
    headers: clientHeaders = {},
    baseUrls = MUSIXMATCH_DEFAULT_BASE_URLS,
    defaultParams = {},
    requireSignature = true,
  } = {},
) {
  const endpoints = (
    Array.isArray(baseUrls) && baseUrls.length
      ? baseUrls
      : MUSIXMATCH_DEFAULT_BASE_URLS
  ).map((baseUrl) => `${baseUrl}${path}`);
  let lastError = null;
  const shouldSign = requireSignature && appId !== "mac-ios-v2.0";
  const signatureSecret = shouldSign
    ? await getMusixmatchSignatureSecret()
    : "";

  for (const endpoint of endpoints) {
    const requestParams = {
      ...defaultParams,
      app_id: appId,
      format: "json",
      user_language: userLanguage,
      usertoken: userToken || undefined,
      guid:
        params?.guid ||
        defaultParams?.guid ||
        defaultParams?.device_id ||
        crypto.randomUUID(),
      ...params,
    };
    try {
      const unsignedUrl = buildMusixmatchUrlWithParams(endpoint, requestParams);
      const requestUrls = shouldSign
        ? [appendMusixmatchSignature(unsignedUrl, signatureSecret), unsignedUrl]
        : [unsignedUrl];
      for (const requestUrl of requestUrls) {
        const responseText = await fetchMusixmatchText(requestUrl, {
          timeoutMs,
          headers: {
            Accept: "application/json,text/plain,*/*",
            "User-Agent": userAgent,
            ...(clientHeaders || {}),
            ...(appId === "mac-ios-v2.0"
              ? { "X-Cookie": `x-mxm-token-guid=${requestParams.guid}` }
              : {}),
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
        });
        const payload = parseJsonLenient(responseText);
        const statusCode = Number(
          payload?.message?.header?.status_code ||
            payload?.header?.status_code ||
            0,
        );
        // If one mode returns auth rejection, try the alternate mode first.
        if (
          requireSignature &&
          statusCode === 401 &&
          requestUrl !== requestUrls[requestUrls.length - 1]
        ) {
          continue;
        }
        return payload;
      }
    } catch (error) {
      if (error?.httpStatus) {
        let errorPayload = null;
        try { errorPayload = parseJsonLenient(error.responseText || ""); } catch {}
        const header = errorPayload?.message?.header || errorPayload?.header || {};
        const hint = redactMusixmatchDiagnostic(header.hint || "");
        const apiStatus = Number(header.status_code || 0);
        const captcha = /captcha/i.test(hint);
        const rateLimited = error.httpStatus === 429 || apiStatus === 429;
        const auth = [401, 403].includes(error.httpStatus) || [401, 403].includes(apiStatus);
        const prefix = captcha ? "Musixmatch blocked request with captcha" : rateLimited ? "Musixmatch cooldown active" :
          auth ? "Musixmatch user token was rejected" : `Musixmatch ${path.slice(1)} failed`;
        const endpointError = new Error(`${prefix} with HTTP ${error.httpStatus}${apiStatus ? ` / API ${apiStatus}` : ""}${hint ? ` (${hint})` : ""}.`);
        endpointError.name = captcha ? "MusixmatchCaptchaError" : rateLimited ? "MusixmatchRateLimitError" : auth ? "MusixmatchAuthError" :
          error.httpStatus === 404 ? "MusixmatchEndpointError" : "MusixmatchHttpError";
        endpointError.httpStatus = error.httpStatus;
        endpointError.apiStatus = apiStatus;
        endpointError.endpoint = path;
        endpointError.hint = hint;
        lastError = endpointError;
        continue;
      }
      lastError = new Error(`Musixmatch ${path.slice(1)} ${error?.name === "AbortError" ? "request timeout" : "network request failed"}.`);
      lastError.name = "MusixmatchTransportError";
      lastError.endpoint = path;
    }
  }
  throw lastError || new Error("All Musixmatch endpoint attempts failed");
}

