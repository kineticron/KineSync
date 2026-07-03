export type ConnectionStatus = "connected" | "disconnected" | "connecting";

export type BridgeTimingDiagnostics = {
  measuredPipelineMs?: number;
  estimatedForwardBiasMs?: number;
  recommendedPhoneCompensationMs?: number;
  projectedPositionMs?: number;
  biasFreePositionMs?: number;
  lastRawGsmtcPositionMs?: number;
  nativeExtrapolationEnabled?: boolean;
  anchorPositionMs?: number;
  isPlaying?: boolean;
};

export type PlaybackPacket = {
  type: "playback";
  trackId: string;
  spotifyTrackId?: string;
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  durationMs: number;
  positionMs: number;
  isPlaying: boolean;
  timestamp: number;
  capturedAtMs?: number;
  timing?: BridgeTimingDiagnostics;
};

export type LyricsPacket = {
  type: "lyrics";
  trackId: string;
  lyrics: LyricLine[];
  source: string;
  statusMessage?: string;
  metadata?: LyricsMetadata;
};

export type ShareGifFrameLine = {
  lineStartTime: number;
  lineEndTime: number;
  text: string;
  translatedText?: string;
  syllables?: Array<{
    text: string;
    startTime: number;
    endTime: number;
  }>;
};

export type ShareGifRequestPacket = {
  type: "share:gif:request";
  requestId: string;
  trackId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  includeTranslations: boolean;
  lines: ShareGifFrameLine[];
};

export type ShareGifResultPacket = {
  type: "share:gif:result";
  requestId: string;
  ok: boolean;
  mimeType?: string;
  fileName?: string;
  base64?: string;
  error?: string;
};

export type VaultSaveResultPacket = {
  type: "vault:save:result";
  ok: boolean;
  vaultId?: string;
  sourceLabel?: string;
  lineCount?: number;
  translatedLineCount?: number;
  vaultEntryCount?: number;
  error?: string;
};

export type Track = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  durationMs: number;
  spotifyTrackId?: string;
};

export type LyricsTranslationMetadata = {
  isLoading?: boolean;
  model?: string;
  provider?: string;
  apiRequestMs?: number;
  bridgeProcessingMs?: number;
  frontendProcessingMs?: number;
  translatedLineCount?: number;
  requestedAt?: number;
  completedAt?: number;
};

export type LyricsCreditsMetadata = {
  songwriters?: string[];
};

export type LyricsMetadata = {
  instrumental?: boolean;
  credits?: LyricsCreditsMetadata;
  translation?: LyricsTranslationMetadata;
};

export type LyricSyllable = {
  text: string;
  startTime: number;
  endTime: number;
  isPartOfWord?: boolean;
  /** Precomputed grapheme clusters for Intl-aware karaoke rendering. */
  graphemes?: string[];
};

export type LyricLine = {
  lineStartTime: number;
  lineEndTime: number;
  syllables: LyricSyllable[];
  backgroundSyllables?: LyricSyllable[];
  translatedText?: string;
  oppositeAligned?: boolean;
};
