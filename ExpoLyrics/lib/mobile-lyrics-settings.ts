import AsyncStorage from "@react-native-async-storage/async-storage";

const MOBILE_LYRICS_SETTINGS_KEY = "kinesync_mobile_lyrics_settings";

export type MobileLyricsSettings = {
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
    cachedSettings = normalizeSettings(raw ? JSON.parse(raw) : null);
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
  const current = await getMobileLyricsSettings();
  cachedSettings = normalizeSettings({ ...current, ...settings });
  loaded = true;
  if (!storageAvailable) {
    return cachedSettings;
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
