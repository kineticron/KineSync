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
  geminiApiKey: "",
};

let cachedSettings: MobileLyricsSettings = { ...DEFAULT_SETTINGS };
let loaded = false;
let storageAvailable = true;

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
    geminiApiKey: String(value?.geminiApiKey || "").trim(),
  };
}

export function getCachedMobileLyricsSettings(): MobileLyricsSettings {
  return cachedSettings;
}

export async function getMobileLyricsSettings(): Promise<MobileLyricsSettings> {
  if (loaded) {
    return cachedSettings;
  }
  try {
    const raw = await AsyncStorage.getItem(MOBILE_LYRICS_SETTINGS_KEY);
    let secureRaw = "";
    if (Platform.OS !== "web") {
      try {
        secureRaw = (await SecureStore.getItemAsync(MOBILE_LYRICS_SECURE_KEY)) || "";
      } catch {
        secureRaw = "";
      }
    }
    const legacy = raw ? JSON.parse(raw) : null;
    cachedSettings = normalizeSettings(secureRaw ? JSON.parse(secureRaw) : legacy);
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
    storageAvailable = false;
    cachedSettings = { ...DEFAULT_SETTINGS };
  }
  loaded = true;
  return cachedSettings;
}

export async function saveMobileLyricsSettings(
  settings: Partial<MobileLyricsSettings>,
): Promise<MobileLyricsSettings> {
  if (settings.spicyLyricsPublishableKey && !/^sl_pk_\S+$/.test(settings.spicyLyricsPublishableKey.trim())) {
    throw new Error("Use a Spicy Lyrics publishable key (sl_pk_). Secret keys are not accepted.");
  }
  const current = await getMobileLyricsSettings();
  cachedSettings = normalizeSettings({ ...current, ...settings });
  loaded = true;
  if (!storageAvailable) {
    return cachedSettings;
  }
  if (Platform.OS !== "web") {
    try {
      await SecureStore.setItemAsync(MOBILE_LYRICS_SECURE_KEY, JSON.stringify(cachedSettings));
      await AsyncStorage.removeItem(MOBILE_LYRICS_SETTINGS_KEY);
      return cachedSettings;
    } catch {
      // Never write secrets back to plaintext storage when secure storage fails.
      return cachedSettings;
    }
  }
  try {
    await AsyncStorage.setItem(
      MOBILE_LYRICS_SETTINGS_KEY,
      JSON.stringify(cachedSettings),
    );
  } catch {
    storageAvailable = false;
  }
  return cachedSettings;
}
