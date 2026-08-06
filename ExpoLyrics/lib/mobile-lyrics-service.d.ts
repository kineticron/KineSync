import type { LyricLine, LyricsMetadata } from "@/types/bridge";

export type MobileLyricsTrack = {
  trackId: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  spotifyTrackId?: string;
};

export type MobileLyricsPacket = {
  trackId: string;
  lyrics: LyricLine[];
  source: string;
  metadata?: LyricsMetadata;
  statusMessage?: string;
};

export type SpotifyCatalogTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
};

export type MobileLyricsSourcePreference =
  | "auto"
  | "local-vault"
  | "kugou"
  | "netease"
  | "qq-direct"
  | "musixmatch"
  | "lrclib"
  | "spicy-lyrics";

export function createLyricsService(options?: {
  getMusixmatchUserToken?: () => string;
  getSpotifyWebToken?: () => string;
  getGeminiApiKey?: () => string;
  getSpotifyAccessToken?: () => string | Promise<string>;
  getSpicyLyricsUseCorsProxy?: (() => boolean) | null;
}): {
  fetchSyncedLyrics(
    track: MobileLyricsTrack,
    options?: {
      force?: boolean;
      preferredSource?: MobileLyricsSourcePreference;
      immediateTranslation?: boolean;
      onSyncedLyrics?: (packet: MobileLyricsPacket) => void;
    },
  ): Promise<MobileLyricsPacket>;
  getCachedLyrics(trackId: string): MobileLyricsPacket | null;
  clearCache(): void;
  resolveSpotifyCatalogTrackById(
    spotifyTrackId: string,
    accessToken: string,
  ): Promise<SpotifyCatalogTrack | null>;
  resolveSpotifyCatalogTrackViaPartnerSearch(
    track: {
      title: string;
      artist: string;
      album?: string;
      durationMs?: number;
    },
    accessToken: string,
  ): Promise<SpotifyCatalogTrack | null>;
  mergeNativePlaybackArtist(nativeArtist: string, catalogArtist: string): string;
};

export function isLikelySameTrack(
  track: {
    title: string;
    artist: string;
    durationMs?: number;
  },
  title: string,
  artist: string,
  durationMs?: number,
): boolean;

export function getAvailableLyricsSources(): string[];
export function getTemporarilyDisabledLyricsSources(): string[];
export function normalizeLyricsSourceKey(source: string): string;