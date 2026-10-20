import type { LyricLine, LyricsMetadata } from "@/types/bridge";

export type MobileLyricsTrack = {
  trackId: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  spotifyTrackId?: string;
  isrc?: string;
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

export function fetchFromSpicyLyrics(track: MobileLyricsTrack, options: { spicyLyricsPublishableKey: string }): Promise<MobileLyricsPacket | null>;

export type MobileLyricsSourcePreference =
  | "auto"
  | "local-vault"
  | "lrc-red"
  | "kugou"
  | "netease"
  | "qq-direct"
  | "musixmatch"
  | "lrclib"
  | "spicy-lyrics";

export function createLyricsService(options?: {
  getMusixmatchUserToken?: () => string | Promise<string>;
  refreshMusixmatchUserToken?: (() => string | Promise<string>) | null;
  getSpotifyWebToken?: () => string;
  getGeminiApiKey?: () => string;
  getSpotifyAccessToken?: () => string | Promise<string>;
  getSpicyLyricsPublishableKey?: () => string | Promise<string>;
}): {
  fetchSyncedLyrics(
    track: MobileLyricsTrack,
    options?: {
      force?: boolean;
      preferredSource?: MobileLyricsSourcePreference;
      immediateTranslation?: boolean;
      translationLanguage?: string;
      onSyncedLyrics?: (packet: MobileLyricsPacket) => void;
    },
  ): Promise<MobileLyricsPacket>;
  rememberPublishedLyrics(trackId: string, packet: MobileLyricsPacket): void;
  translatePublishedLyrics(track: MobileLyricsTrack, options?: { translationLanguage?: string; onSyncedLyrics?: (packet: MobileLyricsPacket) => void }): Promise<MobileLyricsPacket>;
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
    options?: { enrichFromWebApi?: boolean; strictImportMatch?: boolean },
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
