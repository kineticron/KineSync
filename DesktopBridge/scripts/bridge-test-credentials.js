"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadLyricsVmContext } = require("./lyrics-vm-context");

const BRIDGE_SETTINGS_PATH = path.join(
  process.env.APPDATA || "",
  "desktopbridge",
  "bridge-settings.json",
);

function loadBridgeSettings() {
  try {
    if (!fs.existsSync(BRIDGE_SETTINGS_PATH)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(BRIDGE_SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

let lyricsCtx = null;
function getLyricsCtx() {
  if (!lyricsCtx) {
    lyricsCtx = loadLyricsVmContext();
  }
  return lyricsCtx;
}

async function resolveSpotifyAccessTokenFromBridgeSettings() {
  const settings = loadBridgeSettings();
  const cachedBearer = String(settings.spotifyWebToken || "").trim();
  if (cachedBearer.length > 40 && !cachedBearer.startsWith("AQ")) {
    // Legacy: some builds stored a raw bearer in spotifyWebToken.
    return cachedBearer;
  }
  const spDc = String(settings.spotifySpDcCookie || "").trim();
  if (!spDc) {
    return "";
  }
  try {
    const ctx = getLyricsCtx();
    return await ctx.getSpotifyWebAccessToken(spDc);
  } catch {
    return "";
  }
}

function createBridgeTestCredentialGetters() {
  const settings = loadBridgeSettings();
  let accessTokenCache = "";
  let accessTokenCachedAt = 0;

  const readAccessToken = async () => {
    if (
      accessTokenCache &&
      Date.now() - accessTokenCachedAt < 50 * 60 * 1000
    ) {
      return accessTokenCache;
    }
    const token = await resolveSpotifyAccessTokenFromBridgeSettings();
    if (token) {
      accessTokenCache = token;
      accessTokenCachedAt = Date.now();
    }
    return token;
  };

  return {
    settingsPath: BRIDGE_SETTINGS_PATH,
    loadBridgeSettings,
    getMusixmatchUserToken: () =>
      String(settings.musixmatchUserToken || "").trim(),
    getSpotifyWebToken: () => String(settings.spotifyWebToken || "").trim(),
    getGeminiApiKey: () =>
      String(settings.geminiApiKey || settings.openRouterApiKey || "").trim(),
    getSpicyLyricsUseCorsProxy: () =>
      Boolean(settings.spicyLyricsUseCorsProxy),
    getSpotifyAccessToken: readAccessToken,
    hasSpotifySpDcCookie: () =>
      Boolean(String(settings.spotifySpDcCookie || "").trim()),
  };
}

module.exports = {
  BRIDGE_SETTINGS_PATH,
  loadBridgeSettings,
  createBridgeTestCredentialGetters,
  resolveSpotifyAccessTokenFromBridgeSettings,
};
