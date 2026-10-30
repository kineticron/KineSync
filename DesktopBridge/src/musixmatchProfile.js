"use strict";

// Canonical anonymous profile. The scoped generator copies this definition to mobile.
const MUSIXMATCH_APP_MOBILE_PROFILE = Object.freeze({
  profileId: "mac-ios-v2.0@apic-appmobile",
  appId: "mac-ios-v2.0",
  baseUrl: "https://apic-appmobile.musixmatch.com/ws/1.1",
  userAgent: "Musixmatch/2025120901 CFNetwork/3860.300.31 Darwin/25.2.0",
  userLanguage: "en",
  tokenTtlMs: 6 * 60 * 60 * 1000,
  retryMs: 20 * 60 * 1000,
  headers: Object.freeze({
    "X-User-Agent": "Musixmatch/2025120901 CFNetwork/3860.300.31 Darwin/25.2.0",
    "X-Cookie": "x-mxm-token-guid=",
    "x-mxm-app-version": "10.1.1",
    "Accept-Language": "en-US,en;q=0.9",
  }),
});

function isUsableMusixmatchToken(value) {
  const token = String(value || "").trim();
  return Boolean(token) && !/^0+$/.test(token) && !/^UpgradeOnly/i.test(token);
}

module.exports = { MUSIXMATCH_APP_MOBILE_PROFILE, isUsableMusixmatchToken };
