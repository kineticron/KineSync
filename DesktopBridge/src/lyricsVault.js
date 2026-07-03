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
  const json = zlib.gunzipSync(buffer).toString("utf8");
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
    const payload = gunzipJsonPayload(fsModule.readFileSync(gzipPath));
    return expandLyricsFromStorage(payload);
  }
  if (fsModule.existsSync(legacyPath)) {
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
    album: "",
    durationMs: parsed.durationMs,
    spotifyTrackId: "",
    sourceLabel: parsed.useKaraokeTiming
      ? "local-vault-karaoke"
      : "local-vault-line",
    useKaraokeTiming: parsed.useKaraokeTiming,
  };
}

function parseLyricsImportFile(content, filePath = "") {
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

function createLyricsVaultStore({ userDataPath }) {
  const vaultRoot = path.join(String(userDataPath || ""), VAULT_DIR_NAME);
  const indexPath = path.join(vaultRoot, INDEX_FILENAME);

  const ensureVaultRoot = () => {
    fs.mkdirSync(vaultRoot, { recursive: true });
  };

  const readIndex = () => {
    ensureVaultRoot();
    try {
      if (!fs.existsSync(indexPath)) {
        return { bySpotifyId: {}, byFingerprint: {}, byTitleArtist: {} };
      }
      const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      return {
        bySpotifyId:
          parsed?.bySpotifyId && typeof parsed.bySpotifyId === "object"
            ? parsed.bySpotifyId
            : {},
        byFingerprint:
          parsed?.byFingerprint && typeof parsed.byFingerprint === "object"
            ? parsed.byFingerprint
            : {},
        byTitleArtist:
          parsed?.byTitleArtist && typeof parsed.byTitleArtist === "object"
            ? parsed.byTitleArtist
            : {},
      };
    } catch {
      return { bySpotifyId: {}, byFingerprint: {}, byTitleArtist: {} };
    }
  };

  const writeIndex = (index) => {
    ensureVaultRoot();
    fs.writeFileSync(
      indexPath,
      JSON.stringify({
        bySpotifyId: index.bySpotifyId || {},
        byFingerprint: index.byFingerprint || {},
        byTitleArtist: index.byTitleArtist || {},
      }),
      "utf8",
    );
  };

  const entryDirForId = (vaultId) => path.join(vaultRoot, vaultId);

  const readEntryFromDir = (vaultId) => {
    const entryDir = entryDirForId(vaultId);
    const manifestPath = path.join(entryDir, MANIFEST_FILENAME);
    if (!entryHasLyrics(entryDir)) {
      return null;
    }
    try {
      const gzipPath = path.join(entryDir, LYRICS_GZIP_FILENAME);
      const legacyPath = path.join(entryDir, LEGACY_LYRICS_FILENAME);
      const lyrics = readLyricsFromEntryDir(entryDir);
      if (!Array.isArray(lyrics) || !lyrics.length) {
        return null;
      }
      const { normalizeImportedLyricsTimestamps } = require("./lyricsTtmlImport");
      normalizeImportedLyricsTimestamps(lyrics);
      if (!fs.existsSync(gzipPath) && fs.existsSync(legacyPath)) {
        writeLyricsToEntryDir(entryDir, lyrics);
      }
      let manifest = {};
      if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      }
      const sourceLabel = resolveVaultSourceLabel(
        lyrics,
        manifest?.sourceLabel || "",
      );
      return {
        vaultId,
        lyrics: cloneLyrics(lyrics),
        sourceLabel,
        manifest,
        metadata: manifest?.metadata || {},
      };
    } catch {
      return null;
    }
  };

  const lookupKeysForTrack = (track) => {
    const spotifyTrackId = String(track?.spotifyTrackId || "").trim();
    const fingerprint = buildTrackFingerprint(track);
    return { spotifyTrackId, fingerprint };
  };

  const findEntryByTitleArtistFallback = (track) => {
    const queryTitle = String(track?.title || "").trim();
    if (!queryTitle) {
      return null;
    }
    try {
      const dirs = fs.readdirSync(vaultRoot, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory() || dir.name === INDEX_FILENAME) {
          continue;
        }
        const entry = readEntryFromDir(dir.name);
        if (!entry?.lyrics?.length) {
          continue;
        }
        const manifest = entry.manifest || {};
        if (!titlesLikelyMatch(queryTitle, manifest.title)) {
          continue;
        }
        if (!artistsLikelyMatch(track?.artist, manifest.artist)) {
          continue;
        }
        return entry;
      }
    } catch {
      return null;
    }
    return null;
  };

  const collectVaultIdsForTrack = (track, index) => {
    const spotifyTrackId = String(track?.spotifyTrackId || "").trim();
    const vaultIds = [];

    if (spotifyTrackId) {
      if (index.bySpotifyId[spotifyTrackId]) {
        vaultIds.push(index.bySpotifyId[spotifyTrackId]);
      }
      vaultIds.push(`spotify_${spotifyTrackId}`);
    }

    for (const fingerprint of collectLookupFingerprintKeys(track)) {
      if (index.byFingerprint[fingerprint]) {
        vaultIds.push(index.byFingerprint[fingerprint]);
      }
      vaultIds.push(`fp_${fingerprint.slice(0, 20)}`);
    }

    const titleArtistKey = buildTitleArtistKey(track);
    if (titleArtistKey && index.byTitleArtist[titleArtistKey]) {
      vaultIds.push(index.byTitleArtist[titleArtistKey]);
    }

    return [...new Set(vaultIds)];
  };

  return {
    getVaultRoot() {
      return vaultRoot;
    },

    lookup(track) {
      if (!track || (!track.title && !track.spotifyTrackId)) {
        return null;
      }
      const index = readIndex();
      const vaultIds = collectVaultIdsForTrack(track, index);

      for (const vaultId of vaultIds) {
        const entry = readEntryFromDir(vaultId);
        if (entry?.lyrics?.length) {
          return entry;
        }
      }
      return findEntryByTitleArtistFallback(track);
    },

    save({
      track,
      lyrics,
      sourceLabel = "",
      includeTranslations = false,
      originalSource = "",
      metadata = null,
    } = {}) {
      const safeLyrics = cloneLyrics(lyrics);
      if (!safeLyrics.length) {
        throw new Error("Cannot save empty lyrics to the vault.");
      }
      if (!track?.title && !track?.spotifyTrackId) {
        throw new Error("Track metadata is required to save lyrics to the vault.");
      }

      const vaultId = resolveVaultId(track);
      const entryDir = entryDirForId(vaultId);
      const manifestPath = path.join(entryDir, MANIFEST_FILENAME);
      let existingMetadata = {};
      if (fs.existsSync(manifestPath)) {
        try {
          const existingManifest = JSON.parse(
            fs.readFileSync(manifestPath, "utf8"),
          );
          existingMetadata = existingManifest?.metadata || {};
        } catch {
          existingMetadata = {};
        }
      }
      const persistedMetadata = mergeVaultPersistedMetadata(
        existingMetadata,
        metadata,
      );
      const resolvedSourceLabel = resolveVaultSourceLabel(
        safeLyrics,
        sourceLabel,
      );
      const { spotifyTrackId, fingerprint } = lookupKeysForTrack(track);
      const savedAt = Date.now();
      const manifest = {
        vaultId,
        title: String(track?.title || "").trim(),
        artist: String(track?.artist || "").trim(),
        album: String(track?.album || "").trim(),
        durationMs: Number(track?.durationMs || 0),
        spotifyTrackId,
        fingerprint,
        sourceLabel: resolvedSourceLabel,
        originalSource: String(originalSource || "").trim(),
        includeTranslations: Boolean(includeTranslations),
        storageVersion: VAULT_STORAGE_VERSION,
        savedAt,
        lineCount: safeLyrics.length,
        translatedLineCount: safeLyrics.reduce(
          (count, line) =>
            count + (String(line?.translatedText || "").trim() ? 1 : 0),
          0,
        ),
        ...(Object.keys(persistedMetadata).length
          ? { metadata: persistedMetadata }
          : {}),
      };

      fs.mkdirSync(entryDir, { recursive: true });
      writeLyricsToEntryDir(entryDir, safeLyrics);
      fs.writeFileSync(
        path.join(entryDir, MANIFEST_FILENAME),
        JSON.stringify(manifest),
        "utf8",
      );

      const index = readIndex();
      if (spotifyTrackId) {
        index.bySpotifyId[spotifyTrackId] = vaultId;
      }
      for (const fingerprint of collectLookupFingerprintKeys(track)) {
        index.byFingerprint[fingerprint] = vaultId;
      }
      const titleArtistKey = buildTitleArtistKey(track);
      if (titleArtistKey) {
        index.byTitleArtist[titleArtistKey] = vaultId;
      }
      writeIndex(index);

      return {
        ok: true,
        vaultId,
        entryDir,
        sourceLabel: resolvedSourceLabel,
        lineCount: safeLyrics.length,
        translatedLineCount: manifest.translatedLineCount,
        manifest,
        metadata: persistedMetadata,
      };
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
      const mergedTrack = {
        title: String(track?.title || ttmlMeta.title || "").trim(),
        artist: String(track?.artist || ttmlMeta.artist || "").trim(),
        album: String(track?.album || "").trim(),
        durationMs: Number(track?.durationMs || parsed.durationMs || 0),
        spotifyTrackId: String(track?.spotifyTrackId || "").trim(),
        trackId: String(track?.trackId || track?.spotifyTrackId || "").trim(),
      };
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

      const mergedTrack = {
        title: String(track?.title || parsed.title || "").trim(),
        artist: String(track?.artist || parsed.artist || "").trim(),
        album: String(track?.album || parsed.album || "").trim(),
        durationMs: Number(track?.durationMs || parsed.durationMs || 0),
        spotifyTrackId: String(track?.spotifyTrackId || parsed.spotifyTrackId || "").trim(),
        trackId: String(track?.trackId || track?.spotifyTrackId || "").trim(),
      };
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
        sourceLabel: label,
        includeTranslations: Boolean(options.includeTranslations),
        originalSource: "file-import",
      });
    },

    listEntryCount() {
      ensureVaultRoot();
      try {
        return fs
          .readdirSync(vaultRoot, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isDirectory() &&
              entryHasLyrics(path.join(vaultRoot, entry.name)),
          ).length;
      } catch {
        return 0;
      }
    },

    listEntries() {
      ensureVaultRoot();
      try {
        return fs
          .readdirSync(vaultRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => {
            const entryDir = path.join(vaultRoot, entry.name);
            if (!entryHasLyrics(entryDir)) {
              return null;
            }
            const full = readEntryFromDir(entry.name);
            if (!full?.manifest) {
              return null;
            }
            const manifest = full.manifest;
            return {
              vaultId: entry.name,
              title: String(manifest.title || "Unknown title"),
              artist: String(manifest.artist || "Unknown artist"),
              album: String(manifest.album || ""),
              durationMs: Number(manifest.durationMs || 0),
              lineCount: Number(manifest.lineCount || full.lyrics.length || 0),
              translatedLineCount: Number(manifest.translatedLineCount || 0),
              sourceLabel: full.sourceLabel,
              savedAt: Number(manifest.savedAt || 0),
              spotifyTrackId: String(manifest.spotifyTrackId || ""),
            };
          })
          .filter(Boolean)
          .sort((left, right) => Number(right.savedAt) - Number(left.savedAt));
      } catch {
        return [];
      }
    },

    getEntry(vaultId) {
      const safeId = String(vaultId || "").trim();
      if (!safeId) {
        return null;
      }
      return readEntryFromDir(safeId);
    },
  };
}

function initLyricsVaultStore({ userDataPath }) {
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