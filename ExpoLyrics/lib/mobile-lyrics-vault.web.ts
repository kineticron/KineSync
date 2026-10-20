// Experimental web keeps its existing browser storage without requiring cross-origin isolation.
import { resolveImportedVaultTrack } from "@/lib/vault-spotify-match";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { LyricLine, LyricsMetadata, Track } from "@/types/bridge";
import { isSpicyCommunityLyrics, spicyLyricsExpiresAt, withSpicyFreshness } from "@/lib/lyrics-policy";

const MOBILE_LYRICS_VAULT_KEY = "kinesync_mobile_lyrics_vault_v1";
const REFRESH_KEY = "kinesync_mobile_lyrics_vault_refresh_v1";
type RefreshJob = { vaultId: string; track: Track };
const MAX_VAULT_ENTRIES = 100;
let mutationQueue: Promise<unknown> = Promise.resolve();
let nextId = 0;
function mutateVault<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => {});
  return result;
}
const MAX_VAULT_JSON_CHARS = 8 * 1024 * 1024;

export type MobileVaultEntry = {
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

function vaultTrack(track: Track): Track {
  const artworkUrl = String(track.artworkUrl || '').trim();
  return {
    id: track.id, title: track.title, artist: track.artist, album: track.album,
    durationMs: track.durationMs, spotifyTrackId: track.spotifyTrackId,
    // Retain a small remote reference, never inline image bytes or a local image file.
    artworkUrl: /^https?:\/\//i.test(artworkUrl) && artworkUrl.length <= 2048 ? artworkUrl : undefined,
  };
}

async function readVaultEntriesUnlocked(): Promise<MobileVaultEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(MOBILE_LYRICS_VAULT_KEY);
    if (raw && raw.length > MAX_VAULT_JSON_CHARS) return [];
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const entries: MobileVaultEntry[] = [];
    const expired: RefreshJob[] = [];
    let changed = false;
    for (const entry of parsed as MobileVaultEntry[]) {
      const expiresAt = spicyLyricsExpiresAt(entry);
      if (expiresAt !== null && expiresAt <= Date.now()) {
        changed = true;
        if (entry.track?.spotifyTrackId) expired.push({ vaultId: entry.vaultId, track: vaultTrack(entry.track) });
      } else entries.push(entry);
    }
    if (expired.length) {
      const jobs: RefreshJob[] = JSON.parse(await AsyncStorage.getItem(REFRESH_KEY) || "[]");
      await AsyncStorage.setItem(REFRESH_KEY, JSON.stringify([...jobs.filter(job => !expired.some(item => item.vaultId === job.vaultId)), ...expired]));
    }
    // JSON.parse gives this read exclusive ownership; sanitize in place rather
    // than allocating a second entry object for every saved song.
    for (const entry of entries) {
      if (entry?.track) {
        const track = vaultTrack(entry.track);
        if (JSON.stringify(track) !== JSON.stringify(entry.track)) changed = true;
        entry.track = track;
      }
    }
    if (raw && changed) {
      await AsyncStorage.setItem(MOBILE_LYRICS_VAULT_KEY, JSON.stringify(entries));
    }
    return entries;
  } catch {
    return [];
  }
}

export function readVaultEntries(): Promise<MobileVaultEntry[]> {
  return mutateVault(readVaultEntriesUnlocked);
}

export async function deleteMobileVaultEntry(vaultId: string) {
  return mutateVault(async () => {
    await writeVaultEntries((await readVaultEntriesUnlocked()).filter(entry => entry.vaultId !== vaultId));
    const jobs: RefreshJob[] = JSON.parse(await AsyncStorage.getItem(REFRESH_KEY) || "[]");
    await AsyncStorage.setItem(REFRESH_KEY, JSON.stringify(jobs.filter(job => job.vaultId !== vaultId)));
  });
}

export async function renameMobileVaultEntry(vaultId: string, title: string, artist: string) {
  if (!title.trim() || !artist.trim()) throw new Error('Enter a song name and artist.');
  return mutateVault(async () => {
  const entries = await readVaultEntriesUnlocked();
  const entry = entries.find(entry => entry.vaultId === vaultId);
  if (entry) {
    entry.track = { ...entry.track, title: title.trim(), artist: artist.trim(), spotifyTrackId: undefined };
  }
  await writeVaultEntries(entries);
  });
}

async function writeVaultEntries(entries: MobileVaultEntry[]) {
  const serialized = JSON.stringify(entries.map(entry => ({ ...entry, track: vaultTrack(entry.track) })));
  if (serialized.length > MAX_VAULT_JSON_CHARS) {
    throw new Error("Lyrics vault is full. Remove older saved lyrics and try again.");
  }
  await AsyncStorage.setItem(MOBILE_LYRICS_VAULT_KEY, serialized);
  scheduleRefresh(entries);
}

function entryMatchesTrack(entry: MobileVaultEntry, track: Track) {
  const entrySpotifyId = String(entry.track.spotifyTrackId || "").trim();
  const trackSpotifyId = String(track.spotifyTrackId || "").trim();
  if (entrySpotifyId && trackSpotifyId && entrySpotifyId === trackSpotifyId) {
    return true;
  }
  if (entrySpotifyId && trackSpotifyId) return false;

  const titleMatches = normalizeText(entry.track.title) === normalizeText(track.title);
  const artistMatches = normalizeText(entry.track.artist) === normalizeText(track.artist);
  const entryDuration = Number(entry.track.durationMs || 0);
  const trackDuration = Number(track.durationMs || 0);
  // Imports store the last lyric timestamp, not the full recording duration.
  // Keep matching existing imports by title/artist even with a silent outro.
  const durationMatches =
    entry.originalSource === "ttml-import" ||
    entry.originalSource === "file-import" ||
    !entryDuration || !trackDuration || Math.abs(entryDuration - trackDuration) <= 2500;
  return titleMatches && artistMatches && durationMatches;
}

export async function lookupMobileVaultLyrics(track: Track) {
  const entries = await readVaultEntries();
  const match = entries
    .filter((entry) => entryMatchesTrack(entry, track) && entry.lyrics?.length)
    .sort((a, b) => Number(Boolean(b.track.spotifyTrackId && b.track.spotifyTrackId === track.spotifyTrackId)) -
      Number(Boolean(a.track.spotifyTrackId && a.track.spotifyTrackId === track.spotifyTrackId)) || Number(b.savedAt || 0) - Number(a.savedAt || 0))[0];
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
  if (originalSource === "ttml-import" || originalSource === "file-import") track = await resolveImportedVaultTrack(track);
  return mutateVault(async () => {
  const entries = await readVaultEntriesUnlocked();
  const savedAt = Date.now();
  const vaultId = `${normalizeText(track.title).replace(/\s+/g, "-")}-${savedAt.toString(36)}-${(++nextId).toString(36)}`;
  const entry: MobileVaultEntry = {
    vaultId,
    savedAt,
    track: vaultTrack(track),
    lyrics: cloneLyrics(lyrics),
    sourceLabel,
    originalSource,
    metadata: withSpicyFreshness({ metadata, originalSource, sourceLabel }),
  };
  const nextEntries = [entry, ...entries.filter((item) => !entryMatchesTrack(item, track))];
  if (nextEntries.length > MAX_VAULT_ENTRIES) throw new Error("Your vault holds 100 songs. Remove an entry before adding another.");
  await writeVaultEntries(nextEntries);
  const jobs: RefreshJob[] = JSON.parse(await AsyncStorage.getItem(REFRESH_KEY) || "[]");
  await AsyncStorage.setItem(REFRESH_KEY, JSON.stringify(jobs.filter(job => !entryMatchesTrack({ ...entry, track: job.track }, track))));
  return {
    ok: true,
    vaultId,
    sourceLabel,
    lineCount: lyrics.length,
    translatedLineCount: lyrics.reduce(
      (count, line) =>
        count +
        (String(line.translatedText || "").trim() ||
        String(line.backgroundTranslatedText || "").trim()
          ? 1
          : 0),
      0,
    ),
    vaultEntryCount: nextEntries.length,
  };
  });
}

export type MobileVaultSummary = Omit<MobileVaultEntry, "lyrics" | "metadata"> & { lineCount: number; hasTranslations: boolean; exportRestricted: boolean };
export async function readVaultCatalog(): Promise<MobileVaultSummary[]> {
  return (await readVaultEntries()).map(({ lyrics, metadata, ...entry }) => ({ ...entry, exportRestricted: isSpicyCommunityLyrics({ ...entry, metadata }),
    lineCount: lyrics.length, hasTranslations: lyrics.some(line => Boolean(line.translatedText || line.backgroundTranslatedText)) }));
}
export async function getMobileVaultEntry(vaultId: string): Promise<MobileVaultEntry | null> {
  return (await readVaultEntries()).find(entry => entry.vaultId === vaultId) || null;
}

let refreshLyrics: ((track: Track) => Promise<{ lyrics: LyricLine[]; source?: string; metadata?: LyricsMetadata } | null>) | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshRunning = false;
function scheduleRefresh(entries: MobileVaultEntry[]) {
  clearTimeout(refreshTimer);
  if (!refreshLyrics) return;
  const expiries = entries.map(spicyLyricsExpiresAt).filter((expiry): expiry is number => expiry !== null);
  const delay = Math.max(1, Math.min(60_000, ...expiries.map(expiry => expiry - Date.now())));
  refreshTimer = setTimeout(() => { void refreshMobileVault().catch(() => {}); }, delay);
}
export function startMobileVaultRefresh(refresh: NonNullable<typeof refreshLyrics>) {
  refreshLyrics = refresh;
  void refreshMobileVault().catch(() => {});
  return () => { refreshLyrics = undefined; clearTimeout(refreshTimer); };
}
export async function refreshMobileVault() {
  if (!refreshLyrics) return;
  if (refreshRunning) { scheduleRefresh(await readVaultEntries()); return; }
  refreshRunning = true;
  try {
    await readVaultEntries();
    const jobs: RefreshJob[] = JSON.parse(await AsyncStorage.getItem(REFRESH_KEY) || "[]");
    for (const job of jobs) {
      if (!refreshLyrics) break;
      try {
        const result = await refreshLyrics(job.track);
        await mutateVault(async () => {
          const entries = await readVaultEntriesUnlocked();
          const pending: RefreshJob[] = JSON.parse(await AsyncStorage.getItem(REFRESH_KEY) || "[]");
          if (!pending.some(item => item.vaultId === job.vaultId)) return;
          if (result?.lyrics.length && !entries.some(entry => entryMatchesTrack(entry, job.track))) {
            await writeVaultEntries([{ vaultId: job.vaultId, savedAt: Date.now(), track: job.track, lyrics: result.lyrics,
              metadata: result.metadata, sourceLabel: "local-vault", originalSource: result.source }, ...entries]);
          }
          await AsyncStorage.setItem(REFRESH_KEY, JSON.stringify(pending.filter(item => item.vaultId !== job.vaultId)));
        });
      } catch { /* Only identifiers survive a failed refresh. */ }
    }
  } finally {
    refreshRunning = false;
    clearTimeout(refreshTimer);
    scheduleRefresh(await readVaultEntries());
  }
}
