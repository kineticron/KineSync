import { createLyricsService } from "@/lib/mobile-lyrics-service";
import { lookupMobileVaultLyrics } from "@/lib/mobile-lyrics-vault";
import {
  getCachedMobileLyricsSettings,
  getMobileLyricsSettings,
} from "@/lib/mobile-lyrics-settings";
import type { LyricsPacket, Track } from "@/types/bridge";
import type { LyricsSourcePreference } from "@/lib/lyrics-sync";

const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;

function readEnv(...keys: string[]) {
  for (const key of keys) {
    const value = String(env[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

void getMobileLyricsSettings();

const mobileLyricsService = createLyricsService({
  getMusixmatchUserToken: () =>
    getCachedMobileLyricsSettings().musixmatchUserToken ||
    readEnv("EXPO_PUBLIC_MUSIXMATCH_USER_TOKEN", "MUSIXMATCH_USER_TOKEN"),
  getSpotifyWebToken: () =>
    getCachedMobileLyricsSettings().spotifyWebToken ||
    readEnv("EXPO_PUBLIC_SPOTIFY_WEB_TOKEN", "SPOTIFY_WEB_TOKEN"),
  getSpotifyAccessToken: () =>
    getCachedMobileLyricsSettings().spotifyWebToken ||
    readEnv("EXPO_PUBLIC_SPOTIFY_ACCESS_TOKEN", "SPOTIFY_ACCESS_TOKEN"),
  getGeminiApiKey: () =>
    getCachedMobileLyricsSettings().geminiApiKey ||
    readEnv(
      "EXPO_PUBLIC_GEMINI_API_KEY",
      "EXPO_PUBLIC_OPENROUTER_API_KEY",
      "GEMINI_API_KEY",
      "OPENROUTER_API_KEY",
    ),
  getSpicyLyricsUseCorsProxy: () => false,
});

function cleanTrackMetadata(value: unknown) {
  const text = String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return "";
  }
  if (text.length % 2 === 0) {
    const half = text.length / 2;
    const left = text.slice(0, half).trim();
    const right = text.slice(half).trim();
    if (left && left.toLowerCase() === right.toLowerCase()) {
      return left;
    }
  }
  const words = text.split(" ").filter(Boolean);
  if (words.length > 1 && words.length % 2 === 0) {
    const half = words.length / 2;
    const left = words.slice(0, half).join(" ");
    const right = words.slice(half).join(" ");
    if (left && left.toLowerCase() === right.toLowerCase()) {
      return left;
    }
  }
  const byMatch = text.match(/^(.+?)\s+by\s+.+$/i);
  if (byMatch?.[1]) {
    return byMatch[1].trim();
  }
  const lines = text
    .split(/[\r\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    lines.length > 1 &&
    lines.every((part) => part.toLowerCase() === lines[0].toLowerCase())
  ) {
    return lines[0];
  }
  return text;
}

function buildMobileTrackCacheKey({
  title,
  artist,
  album,
  durationMs,
  spotifyTrackId,
}: {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  spotifyTrackId: string;
}) {
  return [
    "mobile-active",
    spotifyTrackId || title.toLowerCase(),
    artist.toLowerCase(),
    album.toLowerCase(),
    Math.max(0, Math.round(durationMs || 0)),
  ].join(":");
}

function toMobileTrack(track: Track) {
  const title = cleanTrackMetadata(track.title);
  const artist = cleanTrackMetadata(track.artist);
  const album = cleanTrackMetadata(track.album);
  const durationMs = Number(track.durationMs || 0);
  const spotifyTrackId = String(track.spotifyTrackId || "").trim();
  return {
    trackId: buildMobileTrackCacheKey({
      title,
      artist,
      album,
      durationMs,
      spotifyTrackId,
    }),
    title,
    artist,
    album,
    durationMs,
    spotifyTrackId,
  };
}

function toActiveLyricsPacket(track: Track, packet: Omit<LyricsPacket, "type">): LyricsPacket {
  return {
    type: "lyrics",
    ...packet,
    trackId: track.id,
  };
}

export async function fetchMobileLyricsForTrack(
  track: Track,
  {
    preferredSource = "auto",
    immediateTranslation = false,
    onSyncedLyrics,
  }: {
    preferredSource?: LyricsSourcePreference;
    immediateTranslation?: boolean;
    onSyncedLyrics?: (packet: LyricsPacket) => void;
  } = {},
): Promise<LyricsPacket> {
  const vaultPacket = await lookupMobileVaultLyrics(track);
  if (vaultPacket && (preferredSource === "auto" || preferredSource === "local-vault")) {
    const packet = { type: "lyrics" as const, ...vaultPacket };
    onSyncedLyrics?.(packet);
    return packet;
  }
  if (preferredSource === "local-vault") {
    return {
      type: "lyrics",
      trackId: track.id,
      lyrics: [],
      source: "local-vault:no-match",
      statusMessage: "No saved lyrics found in the mobile local vault.",
    };
  }

  const mobileTrack = toMobileTrack(track);
  const result = await mobileLyricsService.fetchSyncedLyrics(mobileTrack, {
    force: true,
    preferredSource,
    immediateTranslation,
    onSyncedLyrics: onSyncedLyrics
      ? (packet) => onSyncedLyrics(toActiveLyricsPacket(track, packet))
      : undefined,
  });
  if (!result.lyrics?.length) {
    return toActiveLyricsPacket(track, {
      ...result,
      statusMessage:
        result.statusMessage ||
        `No synced lyrics found for "${mobileTrack.title}" by "${mobileTrack.artist}" (${result.source || "mobile-app"}).`,
    });
  }
  return toActiveLyricsPacket(track, result);
}

export function clearMobileLyricsCache() {
  mobileLyricsService.clearCache();
}