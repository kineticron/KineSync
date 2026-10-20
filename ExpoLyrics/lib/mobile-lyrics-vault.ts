import AsyncStorage from "@react-native-async-storage/async-storage";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { resolveImportedVaultTrack } from "@/lib/vault-spotify-match";
import type { LyricLine, LyricsMetadata, Track } from "@/types/bridge";
import { isSpicyCommunityLyrics, spicyLyricsExpiresAt, withSpicyFreshness } from "@/lib/lyrics-policy";

const MOBILE_LYRICS_VAULT_KEY = "kinesync_mobile_lyrics_vault_v1";
let databasePromise: Promise<SQLiteDatabase> | undefined;
let operationQueue: Promise<unknown> = Promise.resolve();
let nextId = 0;

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

export type MobileVaultSummary = Omit<MobileVaultEntry, "lyrics" | "metadata"> & {
  lineCount: number;
  hasTranslations: boolean;
  exportRestricted: boolean;
};
type VaultRow = { vault_id: string; saved_at: number; track: string; lyrics: string; source_label: string; original_source: string; metadata: string; line_count: number; has_translations: number; export_restricted: number };
const liveRows = "(expires_at IS NULL OR expires_at > ?)";

async function transaction<T>(db: SQLiteDatabase, operation: () => Promise<T>): Promise<T> {
  await db.execAsync("BEGIN IMMEDIATE");
  try {
    const result = await operation();
    await db.execAsync("COMMIT");
    return result;
  } catch (error) {
    await db.execAsync("ROLLBACK");
    throw error;
  }
}

async function putEntry(db: SQLiteDatabase, entry: MobileVaultEntry) {
  entry = { ...entry, metadata: withSpicyFreshness(entry) };
  const track = vaultTrack(entry.track);
  const expiresAt = spicyLyricsExpiresAt(entry);
  await db.runAsync(`INSERT INTO vault_entries
    (vault_id, saved_at, spotify_id, title_key, artist_key, duration_ms, expires_at,
     track, lyrics, source_label, original_source, metadata, line_count, has_translations, export_restricted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vault_id) DO UPDATE SET saved_at=excluded.saved_at, spotify_id=excluded.spotify_id,
    title_key=excluded.title_key, artist_key=excluded.artist_key, duration_ms=excluded.duration_ms,
    expires_at=excluded.expires_at, track=excluded.track, lyrics=excluded.lyrics,
    source_label=excluded.source_label, original_source=excluded.original_source,
    metadata=excluded.metadata, line_count=excluded.line_count, has_translations=excluded.has_translations, export_restricted=excluded.export_restricted`,
    entry.vaultId, entry.savedAt, track.spotifyTrackId || "", normalizeText(track.title), normalizeText(track.artist),
    Number(track.durationMs || 0), expiresAt,
    JSON.stringify(track), JSON.stringify(entry.lyrics), entry.sourceLabel || "local-vault", entry.originalSource || "",
    JSON.stringify(entry.metadata || {}), entry.lyrics.length,
    Number(entry.lyrics.some(line => Boolean(line.translatedText || line.backgroundTranslatedText))), Number(isSpicyCommunityLyrics(entry)));
  await db.runAsync("DELETE FROM vault_refresh WHERE vault_id = ?", entry.vaultId);
}

function getDatabase(): Promise<SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const db = await openDatabaseAsync("kinesync-vault.sqlite");
      try {
        const version = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
        if (Number(version?.user_version || 0) > 1) throw new Error("This lyrics vault was created by a newer KineSync version.");
        await db.execAsync(`
          PRAGMA journal_mode = WAL;
          PRAGMA busy_timeout = 5000;
          PRAGMA secure_delete = ON;
          CREATE TABLE IF NOT EXISTS vault_entries (
            vault_id TEXT PRIMARY KEY NOT NULL, saved_at INTEGER NOT NULL,
            spotify_id TEXT NOT NULL, title_key TEXT NOT NULL, artist_key TEXT NOT NULL,
            duration_ms INTEGER NOT NULL, expires_at INTEGER,
            track TEXT NOT NULL, lyrics TEXT NOT NULL, source_label TEXT NOT NULL,
            original_source TEXT NOT NULL, metadata TEXT NOT NULL,
            line_count INTEGER NOT NULL, has_translations INTEGER NOT NULL, export_restricted INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS vault_spotify ON vault_entries(spotify_id, saved_at DESC);
          CREATE INDEX IF NOT EXISTS vault_title_artist ON vault_entries(title_key, artist_key, saved_at DESC);
          CREATE INDEX IF NOT EXISTS vault_saved ON vault_entries(saved_at DESC);
          CREATE INDEX IF NOT EXISTS vault_expiry ON vault_entries(expires_at);
          CREATE TABLE IF NOT EXISTS vault_migrations (name TEXT PRIMARY KEY NOT NULL);
          CREATE TABLE IF NOT EXISTS vault_refresh (vault_id TEXT PRIMARY KEY NOT NULL, track TEXT NOT NULL);
          PRAGMA user_version = 1;
        `);
        const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(vault_entries)");
        if (!columns.some(column => column.name === "export_restricted")) await db.execAsync("ALTER TABLE vault_entries ADD COLUMN export_restricted INTEGER NOT NULL DEFAULT 0");
        await transaction(db, async () => {
          if (await db.getFirstAsync("SELECT 1 FROM vault_migrations WHERE name = ?", "async-storage-v1")) return;
          const raw = await AsyncStorage.getItem(MOBILE_LYRICS_VAULT_KEY);
          const entries: MobileVaultEntry[] = raw ? JSON.parse(raw) : [];
          if (!Array.isArray(entries)) throw new Error("The existing lyrics vault could not be read. Its backup has been preserved.");
          for (const entry of entries) {
            if (!entry?.vaultId || !entry.track?.title || !Array.isArray(entry.lyrics)) {
              throw new Error("The existing lyrics vault contains an invalid song. Its backup has been preserved.");
            }
            await putEntry(db, entry);
          }
          await db.runAsync("INSERT INTO vault_migrations VALUES (?)", "async-storage-v1");
        });
        await transaction(db, async () => {
          if (await db.getFirstAsync("SELECT 1 FROM vault_migrations WHERE name = ?", "spicy-policy-v1")) return;
          for (const row of await db.getAllAsync<VaultRow>("SELECT vault_id, saved_at, source_label, original_source, metadata FROM vault_entries")) {
            const entry = { savedAt: row.saved_at, sourceLabel: row.source_label, originalSource: row.original_source, metadata: JSON.parse(row.metadata) };
            await db.runAsync("UPDATE vault_entries SET expires_at = ?, export_restricted = ? WHERE vault_id = ?", spicyLyricsExpiresAt(entry), Number(isSpicyCommunityLyrics(entry)), row.vault_id);
          }
          await db.runAsync("INSERT INTO vault_migrations VALUES (?)", "spicy-policy-v1");
        });
        // Recovery copies cannot retain unmanaged Spicy responses indefinitely.
        const backup = await AsyncStorage.getItem(MOBILE_LYRICS_VAULT_KEY);
        if (backup) {
          const entries: MobileVaultEntry[] = JSON.parse(backup);
          const unrestricted = entries.filter(entry => spicyLyricsExpiresAt(entry) === null);
          if (unrestricted.length !== entries.length) await AsyncStorage.setItem(MOBILE_LYRICS_VAULT_KEY, JSON.stringify(unrestricted));
        }
        return db;
      } catch (error) {
        await db.closeAsync();
        throw error;
      }
    })().catch(error => { databasePromise = undefined; throw error; });
  }
  return databasePromise;
}

// One connection, one queue: unrelated reads cannot enter a write transaction.
function withVault<T>(operation: (db: SQLiteDatabase) => Promise<T>): Promise<T> {
  const result = operationQueue.then(async () => {
    const db = await getDatabase();
    await purgeExpired(db);
    const value = await operation(db);
    await purgeExpired(db);
    if (refreshLyrics) await scheduleRefresh(db);
    return value;
  });
  operationQueue = result.catch(() => {});
  return result;
}

type RefreshResult = { lyrics: LyricLine[]; source?: string; metadata?: LyricsMetadata } | null;
let refreshLyrics: ((track: Track) => Promise<RefreshResult>) | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshRunning = false;

async function purgeExpired(db: SQLiteDatabase) {
  const rows = await db.getAllAsync<{ vault_id: string; track: string }>("SELECT vault_id, track FROM vault_entries WHERE expires_at IS NOT NULL AND expires_at <= ?", Date.now());
  if (!rows.length) return;
  await transaction(db, async () => {
    for (const row of rows) {
      const track: Track = JSON.parse(row.track);
      if (track.spotifyTrackId) await db.runAsync("INSERT OR REPLACE INTO vault_refresh VALUES (?, ?)", row.vault_id, row.track);
      await db.runAsync("DELETE FROM vault_entries WHERE vault_id = ?", row.vault_id);
    }
  });
  await db.execAsync("PRAGMA wal_checkpoint(TRUNCATE)");
}

async function scheduleRefresh(db: SQLiteDatabase) {
  clearTimeout(refreshTimer);
  if (!refreshLyrics) return;
  const row = await db.getFirstAsync<{ expiry: number | null }>("SELECT min(expires_at) AS expiry FROM vault_entries WHERE expires_at IS NOT NULL");
  refreshTimer = setTimeout(() => { void refreshMobileVault().catch(() => {}); }, Math.max(1, Math.min(60_000, row?.expiry == null ? 60_000 : row.expiry - Date.now())));
}

export function startMobileVaultRefresh(refresh: (track: Track) => Promise<RefreshResult>) {
  refreshLyrics = refresh;
  void refreshMobileVault().catch(() => {});
  return () => { refreshLyrics = undefined; clearTimeout(refreshTimer); };
}

export async function refreshMobileVault() {
  if (!refreshLyrics) return;
  if (refreshRunning) { await withVault(async () => {}); return; }
  refreshRunning = true;
  try {
    const jobs = await withVault(db => db.getAllAsync<{ vault_id: string; track: string }>("SELECT * FROM vault_refresh"));
    for (const job of jobs) {
      if (!refreshLyrics) break;
      try {
        const track: Track = JSON.parse(job.track);
        const result = await refreshLyrics(track);
        await withVault(db => transaction(db, async () => {
          // A delete or a new save during the request supersedes this refresh.
          if (!await db.getFirstAsync("SELECT 1 FROM vault_refresh WHERE vault_id = ?", job.vault_id)) return;
          if (result?.lyrics.length) await putEntry(db, { vaultId: job.vault_id, savedAt: Date.now(), track,
            lyrics: result.lyrics, metadata: result.metadata, sourceLabel: "local-vault", originalSource: result.source });
          else await db.runAsync("DELETE FROM vault_refresh WHERE vault_id = ?", job.vault_id);
        }));
      } catch { /* Retry identifiers later. The expired content has already been removed. */ }
    }
  } finally {
    refreshRunning = false;
    await withVault(scheduleRefresh);
  }
}
function summary(row: VaultRow): MobileVaultSummary {
  return { vaultId: row.vault_id, savedAt: row.saved_at, track: vaultTrack(JSON.parse(row.track)),
    sourceLabel: row.source_label, originalSource: row.original_source,
    lineCount: row.line_count, hasTranslations: Boolean(row.has_translations), exportRestricted: Boolean(row.export_restricted) };
}
function fullEntry(row: VaultRow): MobileVaultEntry {
  return { vaultId: row.vault_id, savedAt: row.saved_at, track: vaultTrack(JSON.parse(row.track)),
    sourceLabel: row.source_label, originalSource: row.original_source,
    lyrics: JSON.parse(row.lyrics), metadata: JSON.parse(row.metadata) };
}
export function readVaultEntries(): Promise<MobileVaultEntry[]> {
  return withVault(async db => (await db.getAllAsync<VaultRow>(`SELECT * FROM vault_entries WHERE ${liveRows} ORDER BY saved_at DESC`, Date.now())).map(fullEntry));
}
export function readVaultCatalog(): Promise<MobileVaultSummary[]> {
  return withVault(async db => (await db.getAllAsync<VaultRow>(`SELECT vault_id, saved_at, track, source_label, original_source, line_count, has_translations, export_restricted FROM vault_entries WHERE ${liveRows} ORDER BY saved_at DESC`, Date.now())).map(summary));
}
export function getMobileVaultEntry(vaultId: string): Promise<MobileVaultEntry | null> {
  return withVault(async db => {
    const row = await db.getFirstAsync<VaultRow>(`SELECT * FROM vault_entries WHERE vault_id = ? AND ${liveRows}`, vaultId, Date.now());
    return row ? fullEntry(row) : null;
  });
}
export function deleteMobileVaultEntry(vaultId: string) {
  return withVault(async db => { await db.runAsync("DELETE FROM vault_entries WHERE vault_id = ?", vaultId); await db.runAsync("DELETE FROM vault_refresh WHERE vault_id = ?", vaultId); });
}
export function renameMobileVaultEntry(vaultId: string, title: string, artist: string) {
  if (!title.trim() || !artist.trim()) return Promise.reject(new Error("Enter a song name and artist."));
  return withVault(db => transaction(db, async () => {
    const row = await db.getFirstAsync<{ track: string }>("SELECT track FROM vault_entries WHERE vault_id = ?", vaultId);
    if (!row) return;
    const track = vaultTrack({ ...JSON.parse(row.track), title: title.trim(), artist: artist.trim(), spotifyTrackId: undefined });
    await db.runAsync("UPDATE vault_entries SET track = ?, title_key = ?, artist_key = ?, spotify_id = '' WHERE vault_id = ?",
      JSON.stringify(track), normalizeText(title), normalizeText(artist), vaultId);
  }));
}
async function findMatchingRows(db: SQLiteDatabase, track: Track) {
  const id = String(track.spotifyTrackId || "").trim();
  // Exact IDs take precedence; retain normalized metadata fallback for imports.
  return db.getAllAsync<Pick<VaultRow, "vault_id" | "line_count">>(`SELECT vault_id, line_count FROM vault_entries WHERE ${liveRows} AND
    ((spotify_id <> '' AND spotify_id = ?) OR
      (title_key = ? AND artist_key = ? AND (spotify_id = '' OR ? = '' OR spotify_id = ?) AND
        (original_source IN ('ttml-import', 'file-import') OR duration_ms = 0 OR ? = 0 OR abs(duration_ms - ?) <= 2500)))
    ORDER BY CASE WHEN spotify_id <> '' AND spotify_id = ? THEN 0 ELSE 1 END, saved_at DESC`,
    Date.now(), id, normalizeText(track.title), normalizeText(track.artist), id, id,
    Number(track.durationMs || 0), Number(track.durationMs || 0), id);
}
export function lookupMobileVaultLyrics(track: Track) {
  return withVault(async db => {
    const row = (await findMatchingRows(db, track)).find(row => row.line_count > 0);
    if (!row) return null;
    const full = await db.getFirstAsync<VaultRow>("SELECT * FROM vault_entries WHERE vault_id = ?", row.vault_id);
    if (!full) return null;
    const entry = fullEntry(full);
    return { trackId: track.id, lyrics: entry.lyrics, source: entry.sourceLabel || "local-vault",
      metadata: { ...(entry.metadata || {}), vault: { vaultId: entry.vaultId, savedAt: entry.savedAt, originalSource: entry.originalSource || "" } },
      statusMessage: `Loaded ${entry.lyrics.length} synced lines from local vault.` };
  });
}
export async function saveMobileVaultLyrics({ track, lyrics, sourceLabel = "local-vault", originalSource = "", metadata = {} }: {
  track: Track; lyrics: LyricLine[]; sourceLabel?: string; originalSource?: string; metadata?: LyricsMetadata;
}) {
  if (!lyrics.length) throw new Error("Cannot save empty lyrics to the vault.");
  const safeLyrics = cloneLyrics(lyrics);
  if (originalSource === "ttml-import" || originalSource === "file-import") {
    track = await resolveImportedVaultTrack(track);
  }
  const safeTrack = vaultTrack(track);
  return withVault(db => transaction(db, async () => {
    const existing = await findMatchingRows(db, safeTrack);
    const savedAt = Date.now();
    const vaultId = existing[0]?.vault_id || `${normalizeText(track.title).replace(/\s+/g, "-")}-${savedAt.toString(36)}-${(++nextId).toString(36)}`;
    const entry: MobileVaultEntry = { vaultId, savedAt, track: safeTrack, lyrics: safeLyrics, sourceLabel, originalSource, metadata: withSpicyFreshness({ metadata, sourceLabel, originalSource }) };
    // Preserve the existing replace-song behavior, atomically.
    for (const row of existing) await db.runAsync("DELETE FROM vault_entries WHERE vault_id = ?", row.vault_id);
    await putEntry(db, entry);
    // Purging removes the old entry ID, so cancel its refresh by track identity.
    if (safeTrack.spotifyTrackId) await db.runAsync("DELETE FROM vault_refresh WHERE json_extract(track, '$.spotifyTrackId') = ?", safeTrack.spotifyTrackId);
    return { ok: true, vaultId, sourceLabel, lineCount: safeLyrics.length,
      translatedLineCount: safeLyrics.filter(line => Boolean(String(line.translatedText || "").trim() || String(line.backgroundTranslatedText || "").trim())).length,
      vaultEntryCount: Number((await db.getFirstAsync<{ count: number }>(`SELECT count(*) AS count FROM vault_entries WHERE ${liveRows}`, Date.now()))?.count || 0) };
  }));
}
