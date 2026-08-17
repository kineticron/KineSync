const Store = require("electron-store").default;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SETTINGS_DEFAULTS = {
  musixmatchUserToken: "",
  musixmatchAnonymousUserToken: "",
  musixmatchAnonymousAppId: "",
  musixmatchAnonymousDeviceId: "",
  musixmatchAnonymousFetchedAt: 0,
  musixmatchAnonymousLastAttemptAt: 0,
  spotifyWebToken: "",
  geminiApiKey: "",
  spotifySpDcCookie: "",
  bridgeKey: "",
  relayUrl: "",
  relayBridgeId: "",
  ngrokDomain: "",
  ngrokAuthToken: "",
  spicyLyricsUseCorsProxy: false,
};

// Legacy settings location (used when productName was "desktopbridge")
const LEGACY_SETTINGS_FILENAME = "bridge-settings.json";
const LEGACY_APP_NAME = "desktopbridge";

function sanitizeMusixmatchUserToken(token) {
  return String(token || "").trim();
}

function sanitizeTimestamp(value) {
  const timestamp = Number(value || 0);
  return Number.isFinite(timestamp) && timestamp > 0
    ? Math.floor(timestamp)
    : 0;
}

function sanitizeSpotifyWebToken(token) {
  return String(token || "").trim();
}

function sanitizeGeminiApiKey(token) {
  return String(token || "").trim();
}

function sanitizeSpicyLyricsUseCorsProxy(value) {
  if (
    value === true ||
    value === "true" ||
    value === 1 ||
    value === "1" ||
    value === "yes"
  ) {
    return true;
  }
  return false;
}

function sanitizeBridgeKey(value) {
  const safe = String(value || "").trim();
  return safe || SETTINGS_DEFAULTS.bridgeKey;
}

function sanitizeRelayUrl(value) {
  const safe = String(value || "").trim();
  if (!safe) {
    return "";
  }
  if (/^wss?:\/\//i.test(safe)) {
    return safe;
  }
  return "";
}

function sanitizeRelayBridgeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 64);
}

function sanitizeNgrokDomain(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (!safe) return "";
  // Allow domain format like subdomain.ngrok-free.app or custom domains
  return safe;
}

function sanitizeNgrokAuthToken(value) {
  return String(value || "").trim();
}

function migrateLegacySettings(app, store) {
  try {
    // Get the legacy userData path (used when productName was "desktopbridge")
    const legacyUserDataPath = path.join(
      path.dirname(app.getPath("userData")),
      LEGACY_APP_NAME
    );
    const legacySettingsPath = path.join(legacyUserDataPath, LEGACY_SETTINGS_FILENAME);
    const currentSettingsPath = path.join(app.getPath("userData"), "bridge-settings.json");

    // If legacy settings exist but current settings don't (or are empty), migrate
    if (fs.existsSync(legacySettingsPath)) {
      const legacyContent = fs.readFileSync(legacySettingsPath, "utf8");
      const legacySettings = JSON.parse(legacyContent);

      // Check if we have a musixmatch token in legacy settings
      const legacyToken = String(legacySettings?.musixmatchUserToken || "").trim();
      if (legacyToken) {
        // Read current settings
        let currentSettings = {};
        if (fs.existsSync(currentSettingsPath)) {
          try {
            const currentContent = fs.readFileSync(currentSettingsPath, "utf8");
            currentSettings = JSON.parse(currentContent);
          } catch {
            currentSettings = {};
          }
        }

        // Check if current settings already have a token
        const currentToken = String(currentSettings?.musixmatchUserToken || "").trim();
        if (!currentToken || currentToken.length < legacyToken.length) {
          // Migrate the legacy settings to the current store
          for (const [key, value] of Object.entries(legacySettings)) {
            if (key in SETTINGS_DEFAULTS && value) {
              store.set(key, value);
            }
          }
          console.log("[bridge-settings] Migrated legacy settings from", legacySettingsPath);
        }
      }
    }
  } catch (error) {
    console.warn("[bridge-settings] Failed to migrate legacy settings:", error);
  }
}

function createBridgeSettingsStore({ app }) {
  if (!app || typeof app.getPath !== "function") {
    throw new Error("createBridgeSettingsStore requires an Electron app.");
  }

  const store = new Store({
    name: "bridge-settings",
    cwd: app.getPath("userData"),
    defaults: SETTINGS_DEFAULTS,
    migrations: {
      "1.0.0": (stored) => ({
        ...SETTINGS_DEFAULTS,
        ...stored,
        geminiApiKey: stored.geminiApiKey || stored.openRouterApiKey || "",
      }),
    },
  });

  // Migrate legacy settings from the old productName directory
  migrateLegacySettings(app, store);

  const normalize = (raw) => ({
    musixmatchUserToken: sanitizeMusixmatchUserToken(raw?.musixmatchUserToken || ""),
    musixmatchAnonymousUserToken: sanitizeMusixmatchUserToken(
      raw?.musixmatchAnonymousUserToken || "",
    ),
    musixmatchAnonymousAppId: String(
      raw?.musixmatchAnonymousAppId || "",
    ).trim(),
    musixmatchAnonymousDeviceId: String(
      raw?.musixmatchAnonymousDeviceId || "",
    ).trim(),
    musixmatchAnonymousFetchedAt: sanitizeTimestamp(
      raw?.musixmatchAnonymousFetchedAt,
    ),
    musixmatchAnonymousLastAttemptAt: sanitizeTimestamp(
      raw?.musixmatchAnonymousLastAttemptAt,
    ),
    spotifyWebToken: sanitizeSpotifyWebToken(raw?.spotifyWebToken || ""),
    geminiApiKey: sanitizeGeminiApiKey(raw?.geminiApiKey || raw?.openRouterApiKey || ""),
    spotifySpDcCookie: String(raw?.spotifySpDcCookie || "").trim(),
    bridgeKey: sanitizeBridgeKey(raw?.bridgeKey || ""),
    relayUrl: sanitizeRelayUrl(raw?.relayUrl || ""),
    relayBridgeId: sanitizeRelayBridgeId(raw?.relayBridgeId || ""),
    ngrokDomain: sanitizeNgrokDomain(raw?.ngrokDomain || ""),
    ngrokAuthToken: sanitizeNgrokAuthToken(raw?.ngrokAuthToken || ""),
    spicyLyricsUseCorsProxy: sanitizeSpicyLyricsUseCorsProxy(raw?.spicyLyricsUseCorsProxy),
  });

  return {
    getSettings() {
      const {
        musixmatchAnonymousUserToken: _anonymousUserToken,
        musixmatchAnonymousAppId: _anonymousAppId,
        musixmatchAnonymousDeviceId: _anonymousDeviceId,
        musixmatchAnonymousFetchedAt: _anonymousFetchedAt,
        musixmatchAnonymousLastAttemptAt: _anonymousLastAttemptAt,
        ...publicSettings
      } = normalize(store.store);
      return publicSettings;
    },
    getMusixmatchUserToken() {
      return normalize(store.store).musixmatchUserToken;
    },
    getMusixmatchAnonymousTokenState() {
      const settings = normalize(store.store);
      return {
        userToken: settings.musixmatchAnonymousUserToken,
        appId: settings.musixmatchAnonymousAppId,
        deviceId: settings.musixmatchAnonymousDeviceId,
        fetchedAt: settings.musixmatchAnonymousFetchedAt,
        lastAttemptAt: settings.musixmatchAnonymousLastAttemptAt,
      };
    },
    getSpotifyWebToken() {
      return normalize(store.store).spotifyWebToken;
    },
    getGeminiApiKey() {
      return normalize(store.store).geminiApiKey;
    },
    getBridgeKey() {
      return normalize(store.store).bridgeKey;
    },
    getRelayUrl() {
      return normalize(store.store).relayUrl;
    },
    getRelayBridgeId() {
      const stored = normalize(store.store).relayBridgeId;
      if (stored) return stored;
      const generated = sanitizeRelayBridgeId(os.hostname());
      store.set("relayBridgeId", generated);
      return generated;
    },
    setMusixmatchUserToken(token) {
      store.set("musixmatchUserToken", sanitizeMusixmatchUserToken(token));
      return normalize(store.store).musixmatchUserToken;
    },
    setMusixmatchAnonymousTokenState(state = {}) {
      if (Object.prototype.hasOwnProperty.call(state, "userToken")) {
        store.set(
          "musixmatchAnonymousUserToken",
          sanitizeMusixmatchUserToken(state.userToken),
        );
      }
      if (Object.prototype.hasOwnProperty.call(state, "appId")) {
        store.set("musixmatchAnonymousAppId", String(state.appId || "").trim());
      }
      if (Object.prototype.hasOwnProperty.call(state, "deviceId")) {
        store.set(
          "musixmatchAnonymousDeviceId",
          String(state.deviceId || "").trim(),
        );
      }
      if (Object.prototype.hasOwnProperty.call(state, "fetchedAt")) {
        store.set(
          "musixmatchAnonymousFetchedAt",
          sanitizeTimestamp(state.fetchedAt),
        );
      }
      if (Object.prototype.hasOwnProperty.call(state, "lastAttemptAt")) {
        store.set(
          "musixmatchAnonymousLastAttemptAt",
          sanitizeTimestamp(state.lastAttemptAt),
        );
      }
      return this.getMusixmatchAnonymousTokenState();
    },
    setSpotifyWebToken(token) {
      store.set("spotifyWebToken", sanitizeSpotifyWebToken(token));
      return normalize(store.store).spotifyWebToken;
    },
    setGeminiApiKey(token) {
      store.set("geminiApiKey", sanitizeGeminiApiKey(token));
      return normalize(store.store).geminiApiKey;
    },
    setBridgeKey(value) {
      store.set("bridgeKey", sanitizeBridgeKey(value));
      return normalize(store.store).bridgeKey;
    },
    setRelayUrl(value) {
      store.set("relayUrl", sanitizeRelayUrl(value));
      return normalize(store.store).relayUrl;
    },
    setRelayBridgeId(value) {
      store.set("relayBridgeId", sanitizeRelayBridgeId(value));
      return normalize(store.store).relayBridgeId;
    },
    getNgrokDomain() {
      return normalize(store.store).ngrokDomain;
    },
    setNgrokDomain(value) {
      store.set("ngrokDomain", sanitizeNgrokDomain(value));
      return normalize(store.store).ngrokDomain;
    },
    getNgrokAuthToken() {
      return normalize(store.store).ngrokAuthToken;
    },
    setNgrokAuthToken(value) {
      store.set("ngrokAuthToken", sanitizeNgrokAuthToken(value));
      return normalize(store.store).ngrokAuthToken;
    },
    getSpotifySpDcCookie() {
      return normalize(store.store).spotifySpDcCookie;
    },
    getSpicyLyricsUseCorsProxy() {
      return normalize(store.store).spicyLyricsUseCorsProxy;
    },
    setSpicyLyricsUseCorsProxy(enabled) {
      store.set("spicyLyricsUseCorsProxy", sanitizeSpicyLyricsUseCorsProxy(enabled));
      return normalize(store.store).spicyLyricsUseCorsProxy;
    },
    setSpotifySpDcCookie(value) {
      store.set("spotifySpDcCookie", String(value || "").trim());
      return normalize(store.store).spotifySpDcCookie;
    },
  };
}

module.exports = {
  createBridgeSettingsStore,
  sanitizeMusixmatchUserToken,
  sanitizeSpotifyWebToken,
  sanitizeGeminiApiKey,
  sanitizeNgrokDomain,
  sanitizeNgrokAuthToken,
  DEFAULT_BRIDGE_KEY: SETTINGS_DEFAULTS.bridgeKey,
};
