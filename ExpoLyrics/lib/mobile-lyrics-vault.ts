import AsyncStorage from "@react-native-async-storage/async-storage";

import type { LyricLine, LyricsMetadata, Track } from "@/types/bridge";

const MOBILE_LYRICS_VAULT_KEY = "kinesync_mobile_lyrics_vault_v1";
const MAX_VAULT_ENTRIES = 100;
const MAX_VAULT_JSON_CHARS = 8 * 1024 * 1024;

type MobileVaultEntry = {
  vaultId: string;
  savedAt: number;
  track: Track;
  lyrics: LyricLine[];
  sourceLabel: string;
  originalSource?: string;
  metadata?: LyricsMetadata;
};

function normalizeText(value: string) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cloneLyrics(lyrics: LyricLine[]) {
  return JSON.parse(JSON.stringify(Array.isArray(lyrics) ? lyrics : [])) as LyricLine[];
}

async function readVaultEntries(): Promise<MobileVaultEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(MOBILE_LYRICS_VAULT_KEY);
    if (raw && raw.length > MAX_VAULT_JSON_CHARS) return [];
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeVaultEntries(entries: MobileVaultEntry[]) {
  const serialized = JSON.stringify(entries);
  if (serialized.length > MAX_VAULT_JSON_CHARS) {
    throw new Error("Lyrics vault is full. Remove older saved lyrics and try again.");
  }
  await AsyncStorage.setItem(MOBILE_LYRICS_VAULT_KEY, serialized);
}

function entryMatchesTrack(entry: MobileVaultEntry, track: Track) {
  const entrySpotifyId = String(entry.track.spotifyTrackId || "").trim();
  const trackSpotifyId = String(track.spotifyTrackId || "").trim();
  if (entrySpotifyId && trackSpotifyId && entrySpotifyId === trackSpotifyId) {
    return true;
  }

  const titleMatches = normalizeText(entry.track.title) === normalizeText(track.title);
  const artistMatches = normalizeText(entry.track.artist) === normalizeText(track.artist);
  const entryDuration = Number(entry.track.durationMs || 0);
  const trackDuration = Number(track.durationMs || 0);
  const durationMatches =
    !entryDuration || !trackDuration || Math.abs(entryDuration - trackDuration) <= 2500;
  return titleMatches && artistMatches && durationMatches;
}

export async function lookupMobileVaultLyrics(track: Track) {
  const entries = await readVaultEntries();
  const match = entries
    .filter((entry) => entryMatchesTrack(entry, track) && entry.lyrics?.length)
    .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0))[0];
  if (!match) {
    return null;
  }
  return {
    trackId: track.id,
    lyrics: cloneLyrics(match.lyrics),
    source: match.sourceLabel || "local-vault",
    metadata: {
      ...(match.metadata || {}),
      vault: {
        vaultId: match.vaultId,
        savedAt: match.savedAt,
        originalSource: match.originalSource || "",
      },
    },
    statusMessage: `Loaded ${match.lyrics.length} synced lines from local vault.`,
  };
}

export async function saveMobileVaultLyrics({
  track,
  lyrics,
  sourceLabel = "local-vault",
  originalSource = "",
  metadata = {},
}: {
  track: Track;
  lyrics: LyricLine[];
  sourceLabel?: string;
  originalSource?: string;
  metadata?: LyricsMetadata;
}) {
  const entries = await readVaultEntries();
  const savedAt = Date.now();
  const vaultId = `${normalizeText(track.title).replace(/\s+/g, "-")}-${savedAt.toString(36)}`;
  const entry: MobileVaultEntry = {
    vaultId,
    savedAt,
    track: { ...track },
    lyrics: cloneLyrics(lyrics),
    sourceLabel,
    originalSource,
    metadata,
  };
  const nextEntries = [entry, ...entries.filter((item) => !entryMatchesTrack(item, track))].slice(0, MAX_VAULT_ENTRIES);
  await writeVaultEntries(nextEntries);
  return {
    ok: true,
    vaultId,
    sourceLabel,
    lineCount: lyrics.length,
    translatedLineCount: lyrics.reduce(
      (count, line) => count + (String(line.translatedText || "").trim() ? 1 : 0),
      0,
    ),
    vaultEntryCount: nextEntries.length,
  };
}
