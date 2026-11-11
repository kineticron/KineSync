import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const MOBILE_LYRICS_SETTINGS_KEY = "kinesync_mobile_lyrics_settings";
const MOBILE_LYRICS_SECURE_KEY = "kinesync_mobile_lyrics_secure_v1";

export type MobileLyricsSettings = {
  spicyLyricsPublishableKey: string;
  spotifyWebToken: string;
  /** Epoch ms the captured Spotify token expires; 0 when unknown. */
  spotifyWebTokenExpiresAt: number;
  /** Optional user-supplied token that overrides automatic anonymous access. */
  musixmatchUserToken: string;
  musixmatchAnonymousUserToken: string;
  musixmatchAnonymousAppId: string;
  musixmatchAnonymousDeviceId: string;
  musixmatchAnonymousFetchedAt: number;
  musixmatchAnonymousLastAttemptAt: number;
  musixmatchAnonymousProfileId: string;
  musixmatchAnonymousRenewalAttemptAt: number;
  musixmatchAnonymousBlockedUntil: number;
  musixmatchAnonymousRejectedTokenHashes: string[];
  geminiApiKey: string;
};

const DEFAULT_SETTINGS: MobileLyricsSettings = {
  spicyLyricsPublishableKey: "",
  spotifyWebToken: "",
  spotifyWebTokenExpiresAt: 0,
  musixmatchUserToken: "",
  musixmatchAnonymousUserToken: "",
  musixmatchAnonymousAppId: "",
  musixmatchAnonymousDeviceId: "",
  musixmatchAnonymousFetchedAt: 0,
  musixmatchAnonymousLastAttemptAt: 0,
  musixmatchAnonymousProfileId: "",
  musixmatchAnonymousRenewalAttemptAt: 0,
  musixmatchAnonymousBlockedUntil: 0,
  musixmatchAnonymousRejectedTokenHashes: [],
  geminiApiKey: "",
};

let cachedSettings: MobileLyricsSettings = { ...DEFAULT_SETTINGS };
let loaded = false;
let pendingSettings: Partial<MobileLyricsSettings> = {};
export type MobileLyricsSaveResult = MobileLyricsSettings & {
  persistence: "durable" | "memory";
  persistenceError?: string;
};
const memoryResult = (): MobileLyricsSaveResult => ({ ...cachedSettings, persistence: "memory",
  persistenceError: "Settings are available for this session but could not be saved on this device. Please try Save again.",
});
let initialLoad: Promise<MobileLyricsSettings> | null = null;
let settingsWrites: Promise<void> = Promise.resolve();

function normalizeSettings(value: Partial<MobileLyricsSettings> | null | undefined): MobileLyricsSettings {
  return {
    spicyLyricsPublishableKey: String(value?.spicyLyricsPublishableKey || "").trim(),
    spotifyWebToken: String(value?.spotifyWebToken || "").trim(),
    spotifyWebTokenExpiresAt: Math.max(0, Number(value?.spotifyWebTokenExpiresAt || 0)),
    musixmatchUserToken: String(value?.musixmatchUserToken || "").trim(),
    musixmatchAnonymousUserToken: String(
      value?.musixmatchAnonymousUserToken || "",
    ).trim(),
    musixmatchAnonymousAppId: String(
      value?.musixmatchAnonymousAppId || "",
    ).trim(),
    musixmatchAnonymousDeviceId: String(
      value?.musixmatchAnonymousDeviceId || "",
    ).trim(),
    musixmatchAnonymousFetchedAt: Math.max(
      0,
      Number(value?.musixmatchAnonymousFetchedAt || 0),
    ),
    musixmatchAnonymousLastAttemptAt: Math.max(
      0,
      Number(value?.musixmatchAnonymousLastAttemptAt || 0),
    ),
    musixmatchAnonymousProfileId: String(value?.musixmatchAnonymousProfileId || ""),
    musixmatchAnonymousRenewalAttemptAt: Math.max(0, Number(value?.musixmatchAnonymousRenewalAttemptAt || 0)),
    musixmatchAnonymousBlockedUntil: Math.max(0, Number(value?.musixmatchAnonymousBlockedUntil || 0)),
    musixmatchAnonymousRejectedTokenHashes: Array.isArray(value?.musixmatchAnonymousRejectedTokenHashes) ? [...new Set(value.musixmatchAnonymousRejectedTokenHashes.filter(hash => /^[a-f0-9]{64}$/.test(hash)))] : [],
    geminiApiKey: String(value?.geminiApiKey || "").trim(),
  };
}

export function getCachedMobileLyricsSettings(): MobileLyricsSettings {
  return cachedSettings;
}

async function loadMobileLyricsSettings(): Promise<MobileLyricsSettings> {
  if (loaded) {
    return cachedSettings;
  }
  try {
    const raw = await AsyncStorage.getItem(MOBILE_LYRICS_SETTINGS_KEY);
    let secureRaw = "";
    if (Platform.OS !== "web") {
      secureRaw = (await SecureStore.getItemAsync(MOBILE_LYRICS_SECURE_KEY)) || "";
    }
    const legacy = raw ? JSON.parse(raw) : null;
    const stored = normalizeSettings(secureRaw ? JSON.parse(secureRaw) : legacy);
    cachedSettings = normalizeSettings({ ...stored, ...pendingSettings,
      musixmatchAnonymousRejectedTokenHashes: [...stored.musixmatchAnonymousRejectedTokenHashes,
        ...(pendingSettings.musixmatchAnonymousRejectedTokenHashes || [])],
    });
    // Migrate legacy plaintext settings only after the secure write succeeds.
    if (!secureRaw && legacy && Platform.OS !== "web") {
      try {
        await SecureStore.setItemAsync(MOBILE_LYRICS_SECURE_KEY, JSON.stringify(cachedSettings));
        await AsyncStorage.removeItem(MOBILE_LYRICS_SETTINGS_KEY);
      } catch {
        // Preserve legacy data if secure storage is unavailable.
      }
    }
  } catch {
    // Reads remain retryable. Preserve memory edits and never write a default
    // snapshot over storage we could not read.
    return cachedSettings;
  }
  loaded = true;
  return cachedSettings;
}

export function getMobileLyricsSettings(): Promise<MobileLyricsSettings> {
  if (loaded) return Promise.resolve(cachedSettings);
  if (!initialLoad) initialLoad = loadMobileLyricsSettings().finally(() => { initialLoad = null; });
  return initialLoad;
}

export async function saveMobileLyricsSettings(
  settings: Partial<MobileLyricsSettings>,
): Promise<MobileLyricsSaveResult> {
  if (settings.spicyLyricsPublishableKey && !/^sl_pk_\S+$/.test(settings.spicyLyricsPublishableKey.trim())) {
    throw new Error("Use a Spicy Lyrics publishable key (sl_pk_). Secret keys are not accepted.");
  }
  // Serialize both merge and persistence, not just the final disk write. Cold
  // readers share initialLoad so a late load cannot overwrite a newer mutation.
  const write = settingsWrites.then(async () => {
    await getMobileLyricsSettings();
    const current = cachedSettings;
    pendingSettings = { ...pendingSettings, ...settings };
    cachedSettings = normalizeSettings({ ...current, ...settings,
      // Revocation knowledge is monotonic even if a settings form submits an old
      // full snapshot. Token values themselves are never retained in this list.
      musixmatchAnonymousRejectedTokenHashes: [...new Set([
        ...current.musixmatchAnonymousRejectedTokenHashes,
        ...(settings.musixmatchAnonymousRejectedTokenHashes || []),
      ])],
    });
    if (!loaded) return memoryResult();
    if (Platform.OS !== "web") {
      try {
        await SecureStore.setItemAsync(MOBILE_LYRICS_SECURE_KEY, JSON.stringify(cachedSettings));
        await AsyncStorage.removeItem(MOBILE_LYRICS_SETTINGS_KEY);
        pendingSettings = {};
        return { ...cachedSettings, persistence: "durable" as const };
      } catch {
        // Never write secrets back to plaintext storage when secure storage fails.
        return memoryResult();
      }
    }
    try {
      await AsyncStorage.setItem(
        MOBILE_LYRICS_SETTINGS_KEY,
        JSON.stringify(cachedSettings),
      );
    } catch {
      return memoryResult();
    }
    pendingSettings = {};
    return { ...cachedSettings, persistence: "durable" as const };
  });
  settingsWrites = write.then(() => {}, () => {});
  return write;
}
