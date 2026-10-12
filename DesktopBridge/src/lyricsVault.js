"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { parseTtmlToLyrics, extractTtmlMetadata } = require("./lyricsTtmlImport");
const { lyricsToTtml, lyricsUseKaraokeTiming } = require("./lyricsTtmlExport");

const VAULT_STORAGE_VERSION = 2;
const LYRICS_GZIP_FILENAME = "lyrics.json.gz";
const LEGACY_LYRICS_FILENAME = "lyrics.json";
const LEGACY_TTML_FILENAME = "lyrics.ttml";

const VAULT_DIR_NAME = "lyrics-vault";
const INDEX_FILENAME = "index.json";
const MANIFEST_FILENAME = "manifest.json";
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_GZIP_BYTES = 32 * 1024 * 1024;

let vaultStoreInstance = null;

function normalizeVaultText(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function extractPrimaryArtist(artist) {
  return String(artist || "")
    .split(/\s*(?:,|&|;|\s+feat\.?|\s+ft\.?|\s+with\s+)\s*/i)[0]
    .trim();
}

function hashTrackKey(title, artist, durationBucket = 0) {
  return crypto
    .createHash("sha1")
    .update(
      [
        normalizeVaultText(title),
        normalizeVaultText(artist),
        Number(durationBucket) || 0,
      ].join("|"),
    )
    .digest("hex");
}

function buildTrackFingerprint(track) {
  const title = normalizeVaultText(track?.title);
  const artist = normalizeVaultText(track?.artist);
  const durationBucket =
    Number(track?.durationMs || 0) > 0
      ? Math.round(Number(track.durationMs) / 1000)
      : 0;
  return hashTrackKey(title, artist, durationBucket);
}

function collectLookupFingerprintKeys(track) {
  const title = String(track?.title || "").trim();
  const artist = String(track?.artist || "").trim();
  const primaryArtist = extractPrimaryArtist(artist);
  const durationBucket =
    Number(track?.durationMs || 0) > 0
      ? Math.round(Number(track.durationMs) / 1000)
      : 0;
  const keys = new Set();
  keys.add(hashTrackKey(title, artist, durationBucket));
  keys.add(hashTrackKey(title, artist, 0));
  if (primaryArtist && normalizeVaultText(primaryArtist) !== normalizeVaultText(artist)) {
    keys.add(hashTrackKey(title, primaryArtist, durationBucket));
    keys.add(hashTrackKey(title, primaryArtist, 0));
  }
  return [...keys];
}

function buildTitleArtistKey(track) {
  const title = normalizeVaultText(track?.title);
  const artist = normalizeVaultText(extractPrimaryArtist(track?.artist));
  if (!title) {
    return "";
  }
  return `${title}|${artist}`;
}

function titlesLikelyMatch(left, right) {
  const a = normalizeVaultText(left);
  const b = normalizeVaultText(right);
  if (!a || !b) {
    return false;
  }
  return a === b || a.includes(b) || b.includes(a);
}

function artistsLikelyMatch(left, right) {
  const a = normalizeVaultText(extractPrimaryArtist(left));
  const b = normalizeVaultText(extractPrimaryArtist(right));
  if (!a || !b) {
    return true;
  }
  return a === b || a.includes(b) || b.includes(a);
}

function resolveVaultId(track) {
  const spotifyTrackId = String(track?.spotifyTrackId || "").trim();
  if (spotifyTrackId) {
    return `spotify_${spotifyTrackId}`;
  }
  return `fp_${buildTrackFingerprint(track).slice(0, 20)}`;
}

function resolveVaultSourceLabel(lyrics, storedLabel = "") {
  const label = String(storedLabel || "").trim();
  if (label.startsWith("local-vault-")) {
    return label;
  }
  return lyricsUseKaraokeTiming(lyrics, label)
    ? "local-vault-karaoke"
    : "local-vault-line";
}

function pickVaultPersistedMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }
  const persisted = {};
  if (metadata.attribution) persisted.attribution = JSON.parse(JSON.stringify(metadata.attribution));
  if (metadata.spicyApi) persisted.spicyApi = { ...metadata.spicyApi };
  if (metadata.instrumental) {
    persisted.instrumental = true;
  }
  const songwriters = Array.isArray(metadata?.credits?.songwriters)
    ? metadata.credits.songwriters
        .map((name) => String(name || "").trim())
        .filter(Boolean)
    : [];
  if (songwriters.length) {
    persisted.credits = {
      songwriters: [...new Set(songwriters)],
    };
  }
  if (typeof metadata?.ttml?.content === "string" && metadata.ttml.content) {
    if (Buffer.byteLength(metadata.ttml.content, "utf8") > MAX_IMPORT_BYTES) {
      throw new Error("Original TTML document is too large to preserve.");
    }
    persisted.ttml = { content: metadata.ttml.content };
  }
  return persisted;
}

function mergeVaultPersistedMetadata(existingMetadata, incomingMetadata) {
  const incoming = pickVaultPersistedMetadata(incomingMetadata);
  const existing = pickVaultPersistedMetadata(existingMetadata);
  if (incoming.credits?.songwriters?.length) {
    return incoming;
  }
  if (existing.credits?.songwriters?.length) {
    return {
      ...incoming,
      credits: existing.credits,
    };
  }
  return incoming;
}

function cloneLyrics(lyrics) {
  return JSON.parse(JSON.stringify(Array.isArray(lyrics) ? lyrics : []));
}

function compactSyllableForStorage(syllable) {
  const text = String(syllable?.text || "");
  const startTime = Number(syllable?.startTime) || 0;
  const endTime = Number(syllable?.endTime) || 0;
  if (typeof syllable?.isPartOfWord === "boolean") {
    return [startTime, endTime, text, syllable.isPartOfWord ? 1 : 0];
  }
  return [startTime, endTime, text];
}

function expandSyllableFromStorage(part) {
  if (!Array.isArray(part) || part.length < 3) {
    return null;
  }
  const syllable = {
    startTime: Number(part[0]) || 0,
    endTime: Number(part[1]) || 0,
    text: String(part[2] || ""),
  };
  if (part.length >= 4 && typeof part[3] === "number") {
    syllable.isPartOfWord = part[3] === 1;
  }
  return syllable;
}

function compactLyricsForStorage(lyrics) {
  const lines = (Array.isArray(lyrics) ? lyrics : [])
    .map((line) => {
      const syllables = (Array.isArray(line?.syllables) ? line.syllables : [])
        .map(compactSyllableForStorage)
        .filter((part) => String(part[2] || "").length > 0);
      if (!syllables.length) {
        return null;
      }
      const compact = {
        s: Number(line?.lineStartTime) || 0,
        e: Number(line?.lineEndTime) || 0,
        y: syllables,
      };
      const translatedText = String(line?.translatedText || "").trim();
      if (translatedText) {
        compact.t = translatedText;
      }
      if (line?.backgroundTranslatedText) {
        compact.bt = String(line.backgroundTranslatedText);
      }
      const backgroundSyllables = (
        Array.isArray(line?.backgroundSyllables) ? line.backgroundSyllables : []
      )
        .map(compactSyllableForStorage)
        .filter((part) => String(part[2] || "").length > 0);
      if (backgroundSyllables.length) {
        compact.b = backgroundSyllables;
      }
      if (line?.oppositeAligned) {
        compact.o = 1;
      }
      return compact;
    })
    .filter(Boolean);
  return { v: VAULT_STORAGE_VERSION, lines };
}

function expandLyricsFromStorage(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  if (payload.v === VAULT_STORAGE_VERSION && Array.isArray(payload.lines)) {
    return payload.lines
      .map((line) => {
        const syllables = (Array.isArray(line?.y) ? line.y : [])
          .map(expandSyllableFromStorage)
          .filter(Boolean);
        if (!syllables.length) {
          return null;
        }
        const expanded = {
          lineStartTime: Number(line?.s) || 0,
          lineEndTime: Number(line?.e) || 0,
          syllables,
        };
        const translatedText = String(line?.t || "").trim();
        if (translatedText) {
          expanded.translatedText = translatedText;
        }
        if (line?.bt) {
          expanded.backgroundTranslatedText = String(line.bt);
        }
        const backgroundSyllables = (Array.isArray(line?.b) ? line.b : [])
          .map(expandSyllableFromStorage)
          .filter(Boolean);
        if (backgroundSyllables.length) {
          expanded.backgroundSyllables = backgroundSyllables;
        }
        if (line?.o) {
          expanded.oppositeAligned = true;
        }
        return expanded;
      })
      .filter(Boolean);
  }
  return [];
}

function gzipJsonPayload(value) {
  const json = JSON.stringify(value);
  return zlib.gzipSync(Buffer.from(json, "utf8"), { level: 9 });
}

function gunzipJsonPayload(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_IMPORT_BYTES) {
    throw new Error("Vault lyrics file is too large.");
  }
  const json = zlib.gunzipSync(buffer, { maxOutputLength: MAX_GZIP_BYTES }).toString("utf8");
  return JSON.parse(json);
}

function removeLegacyVaultLyricFiles(entryDir) {
  for (const fileName of [LEGACY_LYRICS_FILENAME, LEGACY_TTML_FILENAME]) {
    const filePath = path.join(entryDir, fileName);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best-effort cleanup of legacy sidecar files.
    }
  }
}

function entryHasLyrics(entryDir, fsModule = fs, pathModule = path) {
  return (
    fsModule.existsSync(pathModule.join(entryDir, LYRICS_GZIP_FILENAME)) ||
    fsModule.existsSync(pathModule.join(entryDir, LEGACY_LYRICS_FILENAME))
  );
}

function readLyricsFromEntryDir(entryDir, fsModule = fs, pathModule = path) {
  const gzipPath = pathModule.join(entryDir, LYRICS_GZIP_FILENAME);
  const legacyPath = pathModule.join(entryDir, LEGACY_LYRICS_FILENAME);

  if (fsModule.existsSync(gzipPath)) {
    if (fsModule.statSync(gzipPath).size > MAX_IMPORT_BYTES) {
      throw new Error("Vault lyrics file is too large.");
    }
    const payload = gunzipJsonPayload(fsModule.readFileSync(gzipPath));
    return expandLyricsFromStorage(payload);
  }
  if (fsModule.existsSync(legacyPath)) {
    if (fsModule.statSync(legacyPath).size > MAX_IMPORT_BYTES) {
      throw new Error("Vault lyrics file is too large.");
    }
    const payload = JSON.parse(fsModule.readFileSync(legacyPath, "utf8"));
    return expandLyricsFromStorage(payload);
  }
  return [];
}

function writeLyricsToEntryDir(entryDir, lyrics, fsModule = fs, pathModule = path) {
  const payload = compactLyricsForStorage(lyrics);
  const gzipPath = pathModule.join(entryDir, LYRICS_GZIP_FILENAME);
  fsModule.writeFileSync(gzipPath, gzipJsonPayload(payload));
  removeLegacyVaultLyricFiles(entryDir);
}

function isTtmlLikeContent(content) {
  const trimmed = String(content || "").trim();
  return (
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<tt") ||
    trimmed.includes("<tt ") ||
    trimmed.includes(":ttml")
  );
}

function isJsonFilePath(filePath) {
  return /\.json$/i.test(String(filePath || ""));
}

function isTtmlFilePath(filePath) {
  return /\.(ttml|xml)$/i.test(String(filePath || ""));
}

function detectImportFormat(content, filePath = "") {
  if (isTtmlFilePath(filePath) || isTtmlLikeContent(content)) {
    return "ttml";
  }
  if (isJsonFilePath(filePath)) {
    return "json";
  }
  const trimmed = String(content || "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }
  if (isTtmlLikeContent(trimmed)) {
    return "ttml";
  }
  throw new Error("Unsupported file format. Choose a .json or .ttml lyrics file.");
}

function normalizeImportedLyrics(payload) {
  const expanded = expandLyricsFromStorage(payload);
  if (expanded.length) {
    return expanded;
  }
  if (Array.isArray(payload?.lyrics)) {
    return expandLyricsFromStorage(payload.lyrics);
  }
  return [];
}

function parseJsonLyricsImport(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || ""));
  } catch {
    throw new Error("JSON file is not valid.");
  }

  const lyrics = normalizeImportedLyrics(parsed);
  if (!lyrics.length) {
    throw new Error("JSON file did not contain any lyric lines.");
  }

  const meta =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const lastLine = lyrics[lyrics.length - 1];
  const durationMs = Math.max(
    Number(meta.durationMs || 0),
    Number(lastLine?.lineEndTime || 0),
  );

  return {
    lyrics,
    title: String(meta.title || "").trim(),
    artist: String(meta.artist || "").trim(),
    album: String(meta.album || "").trim(),
    durationMs,
    spotifyTrackId: String(meta.spotifyTrackId || "").trim(),
    sourceLabel: String(meta.sourceLabel || meta.source || "").trim(),
    useKaraokeTiming: lyricsUseKaraokeTiming(
      lyrics,
      String(meta.sourceLabel || meta.source || ""),
    ),
  };
}

function parseTtmlLyricsImport(content) {
  const parsed = parseTtmlToLyrics(content);
  if (!parsed?.lyrics?.length) {
    throw new Error("TTML file did not contain any lyric lines.");
  }
  const ttmlMeta = extractTtmlMetadata(content);
  return {
    lyrics: parsed.lyrics,
    title: ttmlMeta.title,
    artist: ttmlMeta.artist,
    album: ttmlMeta.album || "",
    metadata: parsed.metadata,
    durationMs: parsed.durationMs,
    spotifyTrackId: ttmlMeta.spotifyTrackId || "",
    sourceLabel: parsed.useKaraokeTiming
      ? "local-vault-karaoke"
      : "local-vault-line",
    useKaraokeTiming: parsed.useKaraokeTiming,
  };
}

function parseLyricsImportFile(content, filePath = "") {
  if (Buffer.byteLength(String(content || ""), "utf8") > MAX_IMPORT_BYTES) {
    throw new Error("Lyrics import is too large (8 MiB maximum).");
  }
  const format = detectImportFormat(content, filePath);
  if (format === "ttml") {
    return { format, ...parseTtmlLyricsImport(content) };
  }
  return { format, ...parseJsonLyricsImport(content) };
}

function buildExportBaseName({ title = "", artist = "" } = {}) {
  const safeTitle = String(title || "lyrics")
    .replace(/[<>:"/\\|?* -]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const safeArtist = String(artist || "")
    .replace(/[<>:"/\\|?* -]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return safeArtist ? `${safeTitle} - ${safeArtist}` : safeTitle;
}

function defaultExportPath(entry, format) {
  const base = buildExportBaseName(entry?.manifest || entry);
  const ext = format === "ttml" ? "ttml" : "json";
  return `${base}.${ext}`;
}

// File metadata identifies the imported song; now-playing is only a fallback.
function buildVaultImportTrack(parsed = {}, track = {}) {
  track = track || {};
  const samePlayback = (!parsed.title || normalizeVaultText(parsed.title) === normalizeVaultText(track.title)) &&
    (!parsed.artist || (track.artist && artistsLikelyMatch(parsed.artist, track.artist)));
  const spotifyTrackId = String(parsed.spotifyTrackId || (samePlayback ? track.spotifyTrackId : "") || "").trim();
  return {
    title: String(parsed.title || track.title || "").trim(),
    artist: String(parsed.artist || track.artist || "").trim(),
    album: String(parsed.album || (samePlayback ? track.album : "") || "").trim(),
    durationMs: Number((samePlayback ? track.durationMs : 0) || parsed.durationMs || 0),
    spotifyTrackId, trackId: spotifyTrackId || (samePlayback ? track.trackId : "") || "",
  };
}

function createLyricsVaultStore({ userDataPath }) {
  const { DatabaseSync } = require("node:sqlite");
  const vaultRoot = path.join(String(userDataPath || ""), VAULT_DIR_NAME);
  fs.mkdirSync(vaultRoot, { recursive: true });
  const db = new DatabaseSync(path.join(vaultRoot, "vault.sqlite"));
  try {
    if (Number(db.prepare("PRAGMA user_version").get().user_version) > 1) {
      throw new Error("This lyrics vault was created by a newer KineSync version.");
    }
    db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS vault_entries (
      vault_id TEXT PRIMARY KEY, spotify_id TEXT NOT NULL,
      title_artist TEXT NOT NULL, saved_at INTEGER NOT NULL,
      expires_at INTEGER, manifest TEXT NOT NULL, lyrics BLOB NOT NULL, catalog TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS vault_spotify ON vault_entries(spotify_id);
    CREATE INDEX IF NOT EXISTS vault_title_artist ON vault_entries(title_artist);
    CREATE INDEX IF NOT EXISTS vault_saved ON vault_entries(saved_at DESC);
    CREATE TABLE IF NOT EXISTS vault_keys (
      lookup_key TEXT PRIMARY KEY, vault_id TEXT NOT NULL
      REFERENCES vault_entries(vault_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS vault_migrations (name TEXT PRIMARY KEY);
    PRAGMA user_version = 1;
    `);
  } catch (error) { db.close(); throw error; }
  const transaction = operation => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const validId = vaultId => {
    if (!/^(?:spotify_[A-Za-z0-9._-]{1,128}|fp_[a-f0-9]{20,64})$/.test(String(vaultId || ""))) {
      throw new Error("Invalid vault entry ID.");
    }
    return vaultId;
  };
  const put = (vaultId, manifest, lyrics) => {
    validId(vaultId);
    manifest = { ...manifest, vaultId, lineCount: Number(manifest.lineCount || lyrics.length),
      sourceLabel: resolveVaultSourceLabel(lyrics, manifest.sourceLabel) };
    const compressed = gzipJsonPayload(compactLyricsForStorage(lyrics));
    // Keep the same bounded decompression contract as legacy vault files.
    gunzipJsonPayload(compressed);
    const track = { ...manifest, spotifyTrackId: manifest.spotifyTrackId || "" };
    const expiresAt = Number(manifest.metadata?.spicyApi?.expiresAt || 0);
    const catalog = { ...manifest };
    delete catalog.metadata;
    db.prepare(`INSERT INTO vault_entries
      (vault_id, spotify_id, title_artist, saved_at, expires_at, manifest, lyrics, catalog) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vault_id) DO UPDATE SET spotify_id=excluded.spotify_id,
      title_artist=excluded.title_artist, saved_at=excluded.saved_at,
      expires_at=excluded.expires_at, manifest=excluded.manifest, lyrics=excluded.lyrics, catalog=excluded.catalog`)
      .run(vaultId, track.spotifyTrackId, buildTitleArtistKey(track), Number(manifest.savedAt || 0),
        manifest.metadata?.spicyApi ? (Number.isFinite(expiresAt) ? expiresAt : 0) : null,
        JSON.stringify(manifest), compressed, JSON.stringify(catalog));
    db.prepare("DELETE FROM vault_keys WHERE vault_id = ?").run(vaultId);
    const keys = collectLookupFingerprintKeys(track).map(key => `fp:${key}`);
    if (track.spotifyTrackId) keys.unshift(`spotify:${track.spotifyTrackId}`);
    if (buildTitleArtistKey(track)) keys.push(`title:${buildTitleArtistKey(track)}`);
    const insertKey = db.prepare("INSERT INTO vault_keys VALUES (?, ?) ON CONFLICT(lookup_key) DO UPDATE SET vault_id=excluded.vault_id");
    for (const key of keys) insertKey.run(key, vaultId);
  };
  // Commit all legacy entries and the marker together. Retain legacy files as a
  // recovery copy; a failed migration rolls back and is retried on next launch.
  try {
    if (!db.prepare("SELECT 1 FROM vault_migrations WHERE name = ?").get("filesystem-v2")) {
      transaction(() => {
        for (const dir of fs.readdirSync(vaultRoot, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          const entryDir = path.join(vaultRoot, dir.name);
          if (!entryHasLyrics(entryDir)) continue;
          const manifest = JSON.parse(fs.readFileSync(path.join(entryDir, MANIFEST_FILENAME), "utf8"));
          const lyrics = readLyricsFromEntryDir(entryDir);
          if (!lyrics.length) throw new Error(`Legacy vault entry ${dir.name} contains no lyrics.`);
          require("./lyricsTtmlImport").normalizeImportedLyricsTimestamps(lyrics);
          put(dir.name, manifest, lyrics);
        }
        // Preserve aliases from the old index, including historical fingerprints.
        const indexPath = path.join(vaultRoot, INDEX_FILENAME);
        if (fs.existsSync(indexPath)) {
          const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
          for (const [field, prefix] of [["bySpotifyId", "spotify"], ["byFingerprint", "fp"], ["byTitleArtist", "title"]]) {
            for (const [key, id] of Object.entries(index[field] || {})) {
              if (db.prepare("SELECT 1 FROM vault_entries WHERE vault_id = ?").get(id)) {
                db.prepare("INSERT OR REPLACE INTO vault_keys VALUES (?, ?)").run(`${prefix}:${key}`, id);
              }
            }
          }
        }
        db.prepare("INSERT INTO vault_migrations VALUES (?)").run("filesystem-v2");
      });
    }
  } catch (error) { db.close(); throw error; }
  const readEntry = vaultId => {
    validId(vaultId);
    const row = db.prepare("SELECT manifest, lyrics FROM vault_entries WHERE vault_id = ? AND (expires_at IS NULL OR expires_at > ?)").get(vaultId, Date.now());
    if (!row) return null;
    const manifest = JSON.parse(row.manifest);
    const lyrics = expandLyricsFromStorage(gunzipJsonPayload(Buffer.from(row.lyrics)));
    require("./lyricsTtmlImport").normalizeImportedLyricsTimestamps(lyrics);
    return { vaultId, manifest, lyrics, sourceLabel: resolveVaultSourceLabel(lyrics, manifest.sourceLabel), metadata: manifest.metadata || {} };
  };
  const catalog = () => db.prepare("SELECT vault_id, catalog AS manifest FROM vault_entries WHERE expires_at IS NULL OR expires_at > ? ORDER BY saved_at DESC").all(Date.now());
  return {
    getVaultRoot() { return vaultRoot; },
    close() { db.close(); },
    lookup(track) {
      if (!track || (!track.title && !track.spotifyTrackId)) return null;
      const keys = collectLookupFingerprintKeys(track).map(key => `fp:${key}`);
      if (track.spotifyTrackId) keys.unshift(`spotify:${track.spotifyTrackId}`);
      if (buildTitleArtistKey(track)) keys.push(`title:${buildTitleArtistKey(track)}`);
      for (const key of keys) {
        const row = db.prepare("SELECT vault_id FROM vault_keys WHERE lookup_key = ?").get(key);
        if (row) { const entry = readEntry(row.vault_id); if (entry && (!track.spotifyTrackId || !entry.manifest.spotifyTrackId || track.spotifyTrackId === entry.manifest.spotifyTrackId)) return entry; }
      }
      // Preserve legacy fuzzy matching, inspecting only small catalog metadata.
      for (const row of catalog()) {
        const manifest = JSON.parse(row.manifest);
        if (track.spotifyTrackId && manifest.spotifyTrackId && track.spotifyTrackId !== manifest.spotifyTrackId) continue;
        if (titlesLikelyMatch(track.title, manifest.title) && artistsLikelyMatch(track.artist, manifest.artist)) return readEntry(row.vault_id);
      }
      return null;
    },
    save({ track, lyrics, sourceLabel = "", includeTranslations = false, originalSource = "", metadata = null } = {}) {
      const safeLyrics = cloneLyrics(lyrics);
      if (!safeLyrics.length) throw new Error("Cannot save empty lyrics to the vault.");
      if (!track?.title && !track?.spotifyTrackId) throw new Error("Track metadata is required to save lyrics to the vault.");
      const vaultId = resolveVaultId(track);
      const existing = db.prepare("SELECT manifest FROM vault_entries WHERE vault_id = ?").get(vaultId);
      const persistedMetadata = mergeVaultPersistedMetadata(existing ? JSON.parse(existing.manifest).metadata : {}, metadata);
      const resolvedSourceLabel = resolveVaultSourceLabel(safeLyrics, sourceLabel);
      const manifest = {
        vaultId, title: String(track.title || "").trim(), artist: String(track.artist || "").trim(),
        album: String(track.album || "").trim(), durationMs: Number(track.durationMs || 0),
        spotifyTrackId: String(track.spotifyTrackId || "").trim(), fingerprint: buildTrackFingerprint(track),
        sourceLabel: resolvedSourceLabel, originalSource: String(originalSource || "").trim(),
        includeTranslations: Boolean(includeTranslations), storageVersion: 3, savedAt: Date.now(),
        lineCount: safeLyrics.length,
        translatedLineCount: safeLyrics.filter(line => String(line.translatedText || "").trim()).length,
        ...(Object.keys(persistedMetadata).length ? { metadata: persistedMetadata } : {}),
      };
      transaction(() => put(vaultId, manifest, safeLyrics));
      return { ok: true, vaultId, entryDir: path.join(vaultRoot, vaultId), sourceLabel: resolvedSourceLabel,
        lineCount: safeLyrics.length, translatedLineCount: manifest.translatedLineCount, manifest, metadata: persistedMetadata };
    },
    importTtml({
      ttmlContent,
      track = null,
      includeTranslations = false,
      sourceLabel = "",
    } = {}) {
      const parsed = parseTtmlToLyrics(ttmlContent);
      if (!parsed?.lyrics?.length) {
        throw new Error("TTML file did not contain any lyric lines.");
      }

      const ttmlMeta = extractTtmlMetadata(ttmlContent);
      const mergedTrack = buildVaultImportTrack({ ...ttmlMeta, durationMs: parsed.durationMs }, track);
      if (!mergedTrack.title) {
        throw new Error(
          "Could not determine song title. Play the track on Spotify or use a TTML with title metadata.",
        );
      }

      const label =
        sourceLabel ||
        (parsed.useKaraokeTiming ? "local-vault-karaoke" : "local-vault-line");

      return this.save({
        track: mergedTrack,
        lyrics: parsed.lyrics,
        metadata: parsed.metadata,
        sourceLabel: label,
        includeTranslations,
        originalSource: "ttml-import",
      });
    },

    importLyricsFile(content, filePath, track = {}, options = {}) {
      const parsed = parseLyricsImportFile(content, filePath);
      if (!parsed.lyrics.length) {
        throw new Error("File did not contain any lyric lines.");
      }

      const mergedTrack = buildVaultImportTrack(parsed, track);
      if (!mergedTrack.title) {
        throw new Error(
          "Could not determine song title. Play the track on Spotify or use a file with title metadata.",
        );
      }

      const label =
        options.sourceLabel ||
        parsed.sourceLabel ||
        (parsed.useKaraokeTiming ? "local-vault-karaoke" : "local-vault-line");

      return this.save({
        track: mergedTrack,
        lyrics: parsed.lyrics,
        metadata: parsed.metadata,
        sourceLabel: label,
        includeTranslations: Boolean(options.includeTranslations),
        originalSource: "file-import",
      });
    },


    listEntryCount() { return Number(db.prepare("SELECT count(*) AS count FROM vault_entries WHERE expires_at IS NULL OR expires_at > ?").get(Date.now()).count); },
    listEntries() {
      return catalog().map(row => {
        const manifest = JSON.parse(row.manifest);
        return { vaultId: row.vault_id, title: manifest.title || "Unknown title", artist: manifest.artist || "Unknown artist",
          album: manifest.album || "", durationMs: Number(manifest.durationMs || 0),
          lineCount: Number(manifest.lineCount || 0), translatedLineCount: Number(manifest.translatedLineCount || 0),
          sourceLabel: manifest.sourceLabel, savedAt: Number(manifest.savedAt || 0), spotifyTrackId: manifest.spotifyTrackId || "" };
      });
    },
    getEntry(vaultId) { return String(vaultId || "").trim() ? readEntry(String(vaultId).trim()) : null; },
  };
}

function initLyricsVaultStore({ userDataPath }) {
  vaultStoreInstance?.close();
  vaultStoreInstance = createLyricsVaultStore({ userDataPath });
  return vaultStoreInstance;
}

function getLyricsVaultStore() {
  return vaultStoreInstance;
}

module.exports = {
  VAULT_STORAGE_VERSION,
  LEGACY_LYRICS_FILENAME,
  LEGACY_TTML_FILENAME,
  LYRICS_GZIP_FILENAME,
  VAULT_DIR_NAME,
  INDEX_FILENAME,
  MANIFEST_FILENAME,
  artistsLikelyMatch,
  buildTitleArtistKey,
  buildVaultImportTrack,
  buildTrackFingerprint,
  cloneLyrics,
  collectLookupFingerprintKeys,
  compactLyricsForStorage,
  compactSyllableForStorage,
  createLyricsVaultStore,
  defaultExportPath,
  detectImportFormat,
  expandLyricsFromStorage,
  expandSyllableFromStorage,
  getLyricsVaultStore,
  gzipJsonPayload,
  gunzipJsonPayload,
  hashTrackKey,
  initLyricsVaultStore,
  isJsonFilePath,
  isTtmlFilePath,
  isTtmlLikeContent,
  mergeVaultPersistedMetadata,
  normalizeImportedLyrics,
  normalizeVaultText,
  parseJsonLyricsImport,
  parseLyricsImportFile,
  parseTtmlLyricsImport,
  pickVaultPersistedMetadata,
  readLyricsFromEntryDir,
  removeLegacyVaultLyricFiles,
  resolveVaultId,
  resolveVaultSourceLabel,
  writeLyricsToEntryDir,
  buildExportBaseName,
  entryHasLyrics,
};
