"use strict";

// Kugou Music karaoke (KRC) source adapter.
// This file is evaluated by ../index.js in a shared compatibility context.

const KUGOU_SEARCH_ENDPOINTS = [
  "https://mobileservice.kugou.com/api/v3/search/song",
];
const KUGOU_LYRIC_SEARCH_ENDPOINTS = [
  "https://lyrics.kugou.com/search",
  "https://krcs.kugou.com/search",
];
const KUGOU_LYRIC_DOWNLOAD_ENDPOINTS = [
  "https://lyrics.kugou.com/download",
];
const MAX_KUGOU_CANDIDATES = 8;
const KUGOU_MAX_QUERY_VARIANTS = 6;
const KUGOU_ARTIST_LISTING_SPLIT = /[、，/;&|]+/u;
const KUGOU_HANGUL_TEXT_RE = /[\uac00-\ud7a3\u3130-\u318f]/u;

const KUGOU_ISRC_CACHE_MAX_SIZE = 256;
const KUGOU_ISRC_CACHE_TTL_MS = 60 * 60 * 1000;
const KUGOU_ISRC_TIMEOUT_MS = 2_500;
const KUGOU_TRACK_ISRC_TIMEOUT_MS = 2_000;
const KUGOU_ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

const kugouIsrcCache = new Map();
const kugouIsrcInFlight = new Map();

function isValidIsrc(value) {
  const isrc = String(value || "").replace(/[-\s]/g, "").toUpperCase();
  return KUGOU_ISRC_RE.test(isrc) ? isrc : "";
}

function getCachedIsrcNativeTitle(isrc) {
  const entry = kugouIsrcCache.get(isrc);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.timestamp > KUGOU_ISRC_CACHE_TTL_MS) {
    kugouIsrcCache.delete(isrc);
    return undefined;
  }
  return entry.value;
}

function setCachedIsrcNativeTitle(isrc, value) {
  if (kugouIsrcCache.size >= KUGOU_ISRC_CACHE_MAX_SIZE) {
    const oldestKey = kugouIsrcCache.keys().next().value;
    if (oldestKey !== undefined) {
      kugouIsrcCache.delete(oldestKey);
    }
  }
  kugouIsrcCache.set(isrc, { value, timestamp: Date.now() });
}

async function fetchDeezerIsrcTrack(isrc, timeoutMs) {
  try {
    const payload = await fetchJson(
      `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`,
      { timeoutMs },
    );
    if (payload && !payload.error) {
      const title = String(payload.title || payload.title_short || "").trim();
      if (title) {
        return title;
      }
    }
  } catch {
    // Tolerant failure and fall back to MusicBrainz
  }
  return null;
}

async function fetchMusicBrainzIsrcRecording(isrc, timeoutMs) {
  try {
    const payload = await fetchJson(
      `https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(isrc)}`,
      {
        params: {
          fmt: "json",
        },
        timeoutMs,
      },
    );
    const topLevelIsrc = isValidIsrc(payload?.isrc);
    if (!topLevelIsrc || topLevelIsrc !== isrc) {
      return null;
    }
    const recordings = Array.isArray(payload?.recordings)
      ? payload.recordings
      : [];
    for (const rec of recordings) {
      if (!rec || typeof rec !== "object") continue;
      const title = String(rec.title || "").trim();
      if (!title) continue;
      if (Array.isArray(rec.isrcs) && rec.isrcs.length > 0) {
        const hasMatchingIsrc = rec.isrcs.some(
          (entry) =>
            isValidIsrc(
              typeof entry === "object" && entry !== null ? entry.isrc : entry,
            ) === isrc,
        );
        if (!hasMatchingIsrc) {
          continue;
        }
      }
      return title;
    }
  } catch {
    // Tolerant failure
  }
  return null;
}

async function resolveIsrcNativeTitle(
  rawIsrc,
  { timeoutMs = KUGOU_ISRC_TIMEOUT_MS } = {},
) {
  const isrc = isValidIsrc(rawIsrc);
  if (!isrc) {
    return null;
  }
  const cached = getCachedIsrcNativeTitle(isrc);
  if (cached !== undefined) {
    return cached;
  }
  if (kugouIsrcInFlight.has(isrc)) {
    return kugouIsrcInFlight.get(isrc);
  }

  let timerId = null;
  let timedOut = false;
  let racedPromise = null;

  const deadlinePromise = new Promise((resolve) => {
    timerId = setTimeout(() => {
      timedOut = true;
      if (kugouIsrcInFlight.get(isrc) === racedPromise) {
        kugouIsrcInFlight.delete(isrc);
      }
      kugouIsrcCache.delete(isrc);
      resolve(null);
    }, timeoutMs);
  });

  const workPromise = (async () => {
    const startTime = Date.now();
    try {
      const deezerBudget = Math.max(1, timeoutMs - (Date.now() - startTime));
      let title = await fetchDeezerIsrcTrack(isrc, deezerBudget);
      if (!title && !timedOut) {
        const remaining = timeoutMs - (Date.now() - startTime);
        if (remaining > 20) {
          title = await fetchMusicBrainzIsrcRecording(isrc, remaining);
        }
      }
      if (timedOut) {
        return null;
      }
      const result = title || null;
      setCachedIsrcNativeTitle(isrc, result);
      return result;
    } catch {
      if (!timedOut) {
        setCachedIsrcNativeTitle(isrc, null);
      }
      return null;
    } finally {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (kugouIsrcInFlight.get(isrc) === racedPromise) {
        kugouIsrcInFlight.delete(isrc);
      }
    }
  })();

  racedPromise = Promise.race([workPromise, deadlinePromise]);
  kugouIsrcInFlight.set(isrc, racedPromise);
  return racedPromise;
}

const KUGOU_EXPLICIT_VERSION_PATTERNS = [
  { key: "live", re: /\b(?:live|concert|first\s*take|unplugged)\b|现场|現場/i },
  { key: "remix", re: /\b(?:remix|mix|club\s*edit)\b|重混|混音/i },
  { key: "acoustic", re: /\bacoustic\b|原声|不插电/i },
  { key: "instrumental", re: /\b(?:instrumental|karaoke|inst)\b|伴奏/i },
  { key: "sped_up", re: /\bsped\s*up\b/i },
  { key: "slowed", re: /\bslowed\b/i },
  { key: "demo", re: /\bdemo\b/i },
];

function extractExplicitVersionAnnotations(title) {
  const str = String(title || "").trim();
  if (!str) return [];
  const annotations = [];

  const bracketMatches =
    str.match(/\(([^)]*)\)|\[[^\]]*\]|\{[^}]*\}/g) || [];
  for (const match of bracketMatches) {
    const inner = match.slice(1, -1).trim();
    if (inner) {
      annotations.push(inner);
    }
  }

  const dashMatch = str.match(/\s+[-–—]\s+([^-–—]+)$/);
  if (dashMatch?.[1]) {
    annotations.push(dashMatch[1].trim());
  }

  return annotations;
}

function extractExplicitVersionKeys(title) {
  const annotations = extractExplicitVersionAnnotations(title);
  const keys = new Set();
  for (const annotation of annotations) {
    const norm = normalizeText(annotation);
    for (const { key, re } of KUGOU_EXPLICIT_VERSION_PATTERNS) {
      if (re.test(norm)) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function hasRecordingVersionMismatch(trackTitle, candidateTitle) {
  if (hasLanguageVariantMismatch(trackTitle, candidateTitle)) {
    return true;
  }
  const trackKeys = extractExplicitVersionKeys(trackTitle);
  const candidateKeys = extractExplicitVersionKeys(candidateTitle);
  if (trackKeys.size !== candidateKeys.size) {
    return true;
  }
  for (const key of trackKeys) {
    if (!candidateKeys.has(key)) {
      return true;
    }
  }
  return false;
}

function normalizeKugouCatalogText(input) {
  return String(input || "").normalize("NFC");
}

function containsHangulText(input) {
  const value = normalizeKugouCatalogText(input);
  if (!value) {
    return false;
  }
  try {
    return /\p{Script=Hangul}/u.test(value);
  } catch {
    return KUGOU_HANGUL_TEXT_RE.test(value);
  }
}

function splitKugouArtistNames(artist) {
  return String(artist || "")
    .split(KUGOU_ARTIST_LISTING_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
}

function kugouListingIncludesPrimaryArtist(trackArtist, candidateArtist) {
  const trackPrimary = normalizeArtistText(
    getSpotifyPrimaryArtist(trackArtist),
  );
  if (!trackPrimary) {
    return false;
  }
  let listingNames = splitKugouArtistNames(candidateArtist);
  if (!listingNames.length) {
    listingNames = [String(candidateArtist || "").trim()];
  }
  return listingNames.some((name) => {
    const normalized = normalizeArtistText(name);
    if (!normalized) {
      return false;
    }
    return (
      normalized === trackPrimary ||
      tokens(normalizeArtistText(candidateArtist)).includes(trackPrimary)
    );
  });
}

function kugouTitleMatchesTrack(track, candidateTitle, nativeTitle = null) {
  if (titleCoreMatchesQuery(track, candidateTitle)) {
    return true;
  }
  const trackCore = normalizeCoreTitle(track?.title || "");
  if (trackCore) {
    for (const segment of extractBracketedTitleSegments(candidateTitle)) {
      if (normalizeCoreTitle(segment) === trackCore) {
        return true;
      }
    }
  }
  const rawNative = nativeTitle || track?.nativeTitle || null;
  const effectiveNativeTitle =
    rawNative && !hasRecordingVersionMismatch(track?.title, rawNative)
      ? rawNative
      : null;
  if (effectiveNativeTitle) {
    const nativeCore = normalizeCoreTitle(effectiveNativeTitle);
    const candidateCore = normalizeCoreTitle(
      normalizeKugouCatalogText(candidateTitle),
    );
    if (nativeCore && candidateCore) {
      if (
        nativeCore === candidateCore ||
        hasWholeTextContainment(nativeCore, candidateCore) ||
        hasWholeTextContainment(candidateCore, nativeCore) ||
        overlapRatio(tokens(nativeCore), tokens(candidateCore)) >= 0.62
      ) {
        return true;
      }
      for (const segment of extractBracketedTitleSegments(candidateTitle)) {
        const segCore = normalizeCoreTitle(segment);
        if (
          segCore === nativeCore ||
          hasWholeTextContainment(segCore, nativeCore) ||
          hasWholeTextContainment(nativeCore, segCore)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function isLikelySameKugouTrack(
  track,
  title,
  artist,
  durationMs = 0,
  { titleLinked = false, nativeTitle = null } = {},
) {
  if (hasRecordingVersionMismatch(track?.title, title)) {
    return false;
  }

  const rawNative = nativeTitle || track?.nativeTitle || null;
  const effectiveNativeTitle =
    rawNative && !hasRecordingVersionMismatch(track?.title, rawNative)
      ? rawNative
      : null;

  if (isLikelySameTrack(track, title, artist, durationMs)) {
    return true;
  }
  if (
    !titleLinked &&
    !kugouTitleMatchesTrack(track, title, effectiveNativeTitle)
  ) {
    return false;
  }
  if (!kugouListingIncludesPrimaryArtist(track.artist, artist)) {
    const overlap = getBestArtistOverlap(track.artist, artist);
    if (overlap < 0.75) {
      return false;
    }
  }

  const trackCore = normalizeCoreTitle(track?.title || "");
  const candidateCore = normalizeCoreTitle(normalizeKugouCatalogText(title));
  const nativeCore = effectiveNativeTitle
    ? normalizeCoreTitle(effectiveNativeTitle)
    : "";
  const durationDelta =
    track.durationMs > 0 && durationMs > 0
      ? Math.abs(durationMs - track.durationMs)
      : 0;
  const coArtistListing =
    kugouListingIncludesPrimaryArtist(track.artist, artist) &&
    splitKugouArtistNames(artist).length > 1;

  const exactOriginalTitleMatch =
    Boolean(trackCore) &&
    (trackCore === candidateCore ||
      extractBracketedTitleSegments(title).some(
        (segment) => normalizeCoreTitle(segment) === trackCore,
      ));

  const nativeAliasMatch =
    Boolean(nativeCore) &&
    (nativeCore === candidateCore ||
      extractBracketedTitleSegments(title).some(
        (segment) => normalizeCoreTitle(segment) === nativeCore,
      ));

  const hangulTitleLinked =
    titleLinked &&
    Boolean(trackCore) &&
    needsExactShortTextMatch(trackCore) &&
    Boolean(candidateCore) &&
    !/[a-z0-9]/i.test(candidateCore) &&
    containsHangulText(candidateCore);
  const hasDurationComparison = track.durationMs > 0 && durationMs > 0;

  if (coArtistListing && exactOriginalTitleMatch) {
    const tolerance = needsExactShortTextMatch(trackCore) ? 6_000 : 12_000;
    return !hasDurationComparison || durationDelta <= tolerance;
  }
  if (hangulTitleLinked || exactOriginalTitleMatch) {
    const tolerance = needsExactShortTextMatch(trackCore) ? 45_000 : 25_000;
    return !hasDurationComparison || durationDelta <= tolerance;
  }
  if (nativeAliasMatch) {
    const tolerance = needsExactShortTextMatch(trackCore) ? 6_000 : 12_000;
    return !hasDurationComparison || durationDelta <= tolerance;
  }
  return false;
}

async function collectKugouTitleLinkedKeys(track, searchSongs = searchKugouSongs) {
  const rawTitle = String(track?.title || "").trim();
  const artistPrimary = getSpotifyPrimaryArtist(track?.artist || "");
  const titleCore = normalizeCoreTitle(rawTitle);
  if (!rawTitle || !artistPrimary || !needsExactShortTextMatch(titleCore)) {
    return new Set();
  }
  try {
    const payload = await searchSongs(`${rawTitle} ${artistPrimary}`);
    const songs = Array.isArray(payload?.data?.info) ? payload.data.info : [];
    const keys = new Set();
    for (const song of flattenKugouSearchResults(songs)) {
      const normalized = normalizeKugouSong(song);
      if (!normalized.hash) {
        continue;
      }
      if (!containsHangulText(normalized.title)) {
        continue;
      }
      if (!kugouListingIncludesPrimaryArtist(track.artist, normalized.artist)) {
        continue;
      }
      keys.add(`${normalized.hash}:${normalized.albumAudioId}`);
    }
    return keys;
  } catch {
    return new Set();
  }
}

function buildKugouQueryVariants(track, nativeTitle = null) {
  const rawTitle = String(track?.title || "").trim();
  const artistPrimary = getSpotifyPrimaryArtist(track?.artist || "");
  const rawArtist = String(track?.artist || "").trim();
  const titleCore = normalizeCoreTitle(rawTitle);
  const rawNative = nativeTitle || track?.nativeTitle || null;
  const effectiveNativeTitle =
    rawNative && !hasRecordingVersionMismatch(track?.title, rawNative)
      ? rawNative
      : null;
  const prioritized = [];

  if (effectiveNativeTitle) {
    const cleanNative = String(effectiveNativeTitle).trim();
    if (cleanNative) {
      if (artistPrimary) {
        prioritized.push(`${cleanNative} ${artistPrimary}`.trim());
      }
      prioritized.push(cleanNative);
      const nativeCore = normalizeCoreTitle(cleanNative);
      if (nativeCore && nativeCore !== cleanNative) {
        if (artistPrimary) {
          prioritized.push(`${nativeCore} ${artistPrimary}`.trim());
        }
        prioritized.push(nativeCore);
      }
    }
  }

  if (artistPrimary && rawTitle) {
    prioritized.push(`${rawTitle} ${artistPrimary}`.trim());
  }
  if (artistPrimary) {
    prioritized.push(artistPrimary);
  }
  if (rawArtist && rawArtist !== artistPrimary) {
    prioritized.push(rawArtist);
  }
  if (needsExactShortTextMatch(titleCore) && artistPrimary) {
    prioritized.push(`(${rawTitle}) ${artistPrimary}`.trim());
    if (titleCore.length <= 3) {
      prioritized.push(`ㅠ`);
      prioritized.push(`${artistPrimary} ㅠ`.trim());
    }
  }
  const merged = [...prioritized, ...buildQueryVariants(track)];
  const deduped = [];
  const seen = new Set();
  for (const value of merged) {
    const normalized = String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(String(value).trim());
  }
  return deduped;
}

function scoreKugouCatalogTitleBonus(track, title, nativeTitle = null) {
  if (titleCoreMatchesQuery(track, title)) {
    return 0;
  }
  return kugouTitleMatchesTrack(track, title, nativeTitle) ? 5 : 0;
}

function flattenKugouSearchResults(songs) {
  const flattened = [];
  for (const song of songs) {
    if (!song || typeof song !== "object") {
      continue;
    }
    flattened.push(song);
    if (Array.isArray(song.group)) {
      flattened.push(...song.group);
    }
  }
  return flattened;
}

function normalizeKugouSong(song) {
  const hash = String(song?.hash || song?.FileHash || "").trim();
  const albumAudioId = String(
    song?.album_audio_id || song?.album_id || "",
  ).trim();
  let baseTitle = String(
    song?.songname ||
      song?.songname_original ||
      "",
  ).trim();
  if (!baseTitle && song?.filename) {
    baseTitle = String(song.filename).trim();
  }
  const suffix = String(song?.songname_suffix || "").trim();
  let title = baseTitle;
  if (suffix) {
    const formattedSuffix = /^[([{]/.test(suffix) ? suffix : `(${suffix})`;
    if (!title.toLowerCase().includes(formattedSuffix.toLowerCase())) {
      title = `${title} ${formattedSuffix}`.trim();
    }
  }
  const filename = String(song?.filename || "").trim();
  if (filename) {
    const bracketMatches =
      filename.match(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g) || [];
    for (const match of bracketMatches) {
      if (!title.toLowerCase().includes(match.toLowerCase())) {
        title = `${title} ${match}`.trim();
      }
    }
  }
  if (!title) {
    title = filename;
  }
  const artist = String(song?.singername || "").trim();
  const durationSec = Number(song?.duration || 0);
  const durationMs =
    Number.isFinite(durationSec) && durationSec > 0
      ? Math.round(durationSec * 1000)
      : 0;
  return { hash, albumAudioId, title, artist, durationMs, raw: song };
}

async function searchKugouSongs(query, { timeoutMs = 10_000 } = {}) {
  return fetchJsonFromAnyEndpoint(KUGOU_SEARCH_ENDPOINTS, {
    params: {
      format: "json",
      keyword: query,
      page: 1,
      pagesize: 30,
      showtype: 1,
    },
    timeoutMs,
  });
}

function searchKugouRecordingCatalog(track, query) {
  const searches = lyricsRecordingAliasStates.get(track?.[lyricsTrackMetadata])?.searches;
  if (!searches) return searchKugouSongs(query);
  const key = query.trim().toLowerCase();
  if (!searches.has(key)) {
    const request = searchKugouSongs(query);
    if (searches.size >= 2 * KUGOU_MAX_QUERY_VARIANTS + 1) return request;
    searches.set(key, request);
  }
  return searches.get(key);
}

function recordingAliasVersionMatches(originalTitle, candidateTitle) {
  const { versionKey, stripFeaturing } = require("./lyricsRecordingIdentity");
  const original = stripFeaturing(originalTitle);
  const candidate = stripFeaturing(candidateTitle);
  const edition = /\b(?:explicit|clean|deluxe|alternate|reprise|re-recorded)\b|伴奏|[纯純]音[乐樂]|翻唱|カラオケ|ライブ|라이브|반주/iu;
  return (original.match(edition)?.[0] || "").toLowerCase() ===
      (candidate.match(edition)?.[0] || "").toLowerCase() &&
    versionKey(original) === versionKey(candidate) &&
    !hasRecordingVersionMismatch(original, candidate) &&
    collectLanguageVariantHints(original).join("|") === collectLanguageVariantHints(candidate).join("|") &&
    KUGOU_EXPLICIT_VERSION_PATTERNS.every(({ re }) => re.test(original) === re.test(candidate));
}

function recordingAliasArtistNames(artist) {
  return String(artist || "").split(/[,、，/;&|]+/u).map(name => name.trim()).filter(Boolean);
}

function recordingAliasFeaturedArtists(title) {
  const clause = String(title || "").match(/(?:^|[\s([{,/-])(?:feat\.?|ft\.?|featuring)\s+([^\])}]+)/i);
  return recordingAliasArtistNames(clause?.[1]);
}

function recordingAliasCandidateMatches(track, raw, title, artists, durationMs) {
  const { artistIdentityMatches } = require("./lyricsRecordingIdentity");
  if (recordingAliasIdentitiesConflict(recordingAliasIdentityFields(track), recordingAliasIdentityFields(raw)) ||
      !recordingAliasVersionMatches(track.title, title) ||
      !Number.isFinite(durationMs) || durationMs <= 0 ||
      !Number.isFinite(Number(track.durationMs)) || Number(track.durationMs) <= 0 ||
      Math.abs(track.durationMs - durationMs) > 3_000) return false;

  const originalFeatures = recordingAliasFeaturedArtists(track.title);
  const expectedArtists = [
    ...recordingAliasArtistNames(track.artist),
    ...(Array.isArray(track.artists) ? track.artists.filter(Boolean) : []),
    ...originalFeatures,
  ];
  return expectedArtists.length > 0 && artists.length > 0 &&
    featuredArtistHintsPresentInCandidate(track.title, title, artists.join(" ")) &&
    expectedArtists.every(name => artists.some(artist => artistIdentityMatches(name, artist))) &&
    artists.every(artist => expectedArtists.some(name => artistIdentityMatches(name, artist))) &&
    recordingAliasFeaturedArtists(title).every(name =>
      originalFeatures.some(feature => artistIdentityMatches(name, feature)));
}

function recordingAliasRowEvidence(value, raw, title, artists, durationMs) {
  const { foldCatalogText, stripFeaturing } = require("./lyricsRecordingIdentity");
  const signature = JSON.stringify([
    foldCatalogText(stripFeaturing(title)),
    [...new Set(artists.map(foldCatalogText))].sort(),
    durationMs,
  ]);
  return { value, signature, ids: recordingAliasIdentityFields(raw) };
}

function extractKugouRecordingAlias(track, raw) {
  const { foldCatalogText, stripFeaturing } = require("./lyricsRecordingIdentity");
  const suffix = raw?.songname_suffix;
  const nestedSuffix = raw?.trans_param?.songname_suffix;
  if (suffix && nestedSuffix && foldCatalogText(suffix) !== foldCatalogText(nestedSuffix)) return null;
  const song = normalizeKugouSong({ ...raw, songname_suffix: suffix || nestedSuffix });
  const original = foldCatalogText(stripFeaturing(track.title));
  const base = String(raw?.songname || raw?.songname_original || "").trim();
  const filenameTitle = String(raw?.filename || "").trim().replace(/^.*?\s+-\s+/, "");
  const artists = recordingAliasArtistNames(song.artist);
  const displays = [song.title, filenameTitle];
  if (!song.hash || !original || !base ||
      !recordingAliasVersionMatches(track.title, base) ||
      (raw?.songname_original && !recordingAliasVersionMatches(track.title, raw.songname_original)) ||
      !recordingAliasCandidateMatches(track, raw, song.title, artists, song.durationMs)) return null;

  let aliasTitle = "";
  for (const display of displays) {
    const pair = String(display || "").match(/^(.+?)\s*[（(]([^()（）]+)[)）]$/u);
    if (!pair || !recordingAliasVersionMatches(track.title, display)) continue;
    const left = pair[1].trim();
    const right = pair[2].trim();
    const baseKey = foldCatalogText(base);
    const leftKey = foldCatalogText(left);
    const rightKey = foldCatalogText(right);
    if (baseKey !== leftKey && baseKey !== rightKey && baseKey !== foldCatalogText(display)) continue;
    const title = leftKey === original ? right : rightKey === original ? left : "";
    if (!title || title.length > 256 || foldCatalogText(title) === original ||
        /[()\[\]{}（）]/u.test(title) || !recordingAliasVersionMatches(track.title, title)) continue;
    if (aliasTitle && foldCatalogText(aliasTitle) !== foldCatalogText(title)) return null;
    aliasTitle = title;
  }
  if (!aliasTitle) return null;
  const alias = Object.freeze({ title: aliasTitle, source: "kugou", hash: song.hash, albumAudioId: song.albumAudioId });
  return recordingAliasRowEvidence(alias, raw, aliasTitle, artists, song.durationMs);
}

async function discoverKugouRecordingAliases(track) {
  const { foldCatalogText, stripFeaturing } = require("./lyricsRecordingIdentity");
  const title = stripFeaturing(track.title);
  if (!title || !track.artist || !(track.durationMs > 0)) return Object.freeze([]);
  const queries = [...new Set([
    `${title} ${getSpotifyPrimaryArtist(track.artist)}`.trim(), title,
    ...buildKugouQueryVariants({ ...track, nativeTitle: null }),
  ].map(query => query.toLowerCase()))].slice(0, KUGOU_MAX_QUERY_VARIANTS);
  const payloads = await Promise.all(queries.map(query => searchKugouRecordingCatalog(track, query).catch(() => null)));
  const rows = payloads.flatMap(payload => {
    const songs = Array.isArray(payload?.data?.info) ? payload.data.info : [];
    return flattenKugouSearchResults(songs.slice(0, 30)).slice(0, 60);
  });
  const verified = reconcileRecordingAliasRows(
    rows,
    row => String(row?.hash || row?.FileHash || "").trim().toLowerCase(),
    row => extractKugouRecordingAlias(track, row),
  );
  const aliases = new Map(verified.map(alias => [foldCatalogText(alias.title), alias]));
  return Object.freeze(aliases.size === 1 ? [...aliases.values()] : []);
}

async function searchKugouLyricCandidates(song, { timeoutMs = 8_000 } = {}) {
  return fetchJsonFromAnyEndpoint(KUGOU_LYRIC_SEARCH_ENDPOINTS, {
    params: {
      ver: 1,
      man: "yes",
      client: "pc",
      keyword: "",
      duration: song.durationMs || 0,
      hash: song.hash,
      album_audio_id: song.albumAudioId,
    },
    timeoutMs,
  });
}

async function downloadKugouLyric(candidate, { timeoutMs = 8_000 } = {}) {
  return fetchJsonFromAnyEndpoint(KUGOU_LYRIC_DOWNLOAD_ENDPOINTS, {
    params: {
      ver: 1,
      client: "pc",
      id: candidate.id,
      accesskey: candidate.accesskey,
      fmt: "krc",
      charset: "utf8",
    },
    timeoutMs,
  });
}

function rankKugouLyricCandidate(track, candidate) {
  let score = Number(candidate?.score || 0);
  const candidateDuration = Number(candidate?.duration || 0);
  const trackDuration = Number(track?.durationMs || 0);
  if (trackDuration > 0 && candidateDuration > 0) {
    const delta = Math.abs(candidateDuration - trackDuration);
    const tolerance = Math.max(5_000, trackDuration * 0.06);
    if (delta <= tolerance) {
      score += 12;
    } else if (delta <= tolerance * 2) {
      score += 4;
    } else {
      score -= Math.min(20, Math.floor(delta / 1000));
    }
  }
  if (Number(candidate?.krctype || 0) === 1) {
    score += 8;
  }
  return score;
}

async function fetchKugouKaraokeLyricsForSong(track, song, matchScore) {
  const lyricSearchPayload = await searchKugouLyricCandidates(song);
  const lyricCandidates = Array.isArray(lyricSearchPayload?.candidates)
    ? lyricSearchPayload.candidates
    : [];
  const rankedLyrics = lyricCandidates
    .map((entry) => ({ entry, score: rankKugouLyricCandidate(track, entry) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .filter(({ entry }) => entry?.id && entry?.accesskey);

  const downloads = createRankedProbePool(rankedLyrics, 3, async ({ entry }) => {
    try {
      const downloadPayload = await downloadKugouLyric(entry);
      const encodedContent = String(downloadPayload?.content || "").trim();
      if (!encodedContent) return null;
      const karaokeLyrics = stripLeadingMetadataLines(
        parseKugouKrc(decodeKugouKrc(encodedContent)),
        track,
      );
      if (!karaokeLyrics.length) return null;
      return {
        lyrics: karaokeLyrics,
        source: "kugou-krc",
        coverage: scoreLyricsCoverage(karaokeLyrics, track.durationMs),
        coverageRatio: getLyricsCoverageRatio(karaokeLyrics, track.durationMs),
        matchScore,
      };
    } catch {
      return null;
    }
  });
  try {
    for (let index = 0; index < rankedLyrics.length; index += 1) {
      const result = await downloads.read(index);
      if (result?.lyrics?.length) return result;
    }
    return null;
  } finally { downloads.stop(); }
}

async function collectRankedKugouSearchCandidates(
  track,
  { timeoutMs = KUGOU_ISRC_TIMEOUT_MS } = {},
) {
  const isrc = isValidIsrc(track?.isrc);
  let nativeTitle = track?.nativeTitle;
  if ((nativeTitle === undefined || nativeTitle === "") && isrc) {
    try {
      nativeTitle = await resolveIsrcNativeTitle(isrc, { timeoutMs });
    } catch {
      nativeTitle = null;
    }
  }
  nativeTitle = nativeTitle || null;

  const queryVariants = buildKugouQueryVariants(track, nativeTitle).slice(
    0,
    KUGOU_MAX_QUERY_VARIANTS,
  );
  const searches = new Map();
  const searchSongs = (query) => {
    if (!searches.has(query)) searches.set(query, searchKugouRecordingCatalog(track, query));
    return searches.get(query);
  };
  const firstQueryPromise = queryVariants[0]
    ? searchSongs(queryVariants[0])
    : null;
  const titleLinkedKeysPromise = collectKugouTitleLinkedKeys(
    track,
    searchSongs,
  );
  const rawSongs = [];

  await Promise.all(
    queryVariants.map(async (query, idx) => {
      try {
        const payload =
          idx === 0 && firstQueryPromise
            ? await firstQueryPromise
            : await searchSongs(query);
        const songs = Array.isArray(payload?.data?.info)
          ? payload.data.info
          : [];
        rawSongs.push(...flattenKugouSearchResults(songs));
      } catch {
        // Try next query variant.
      }
    }),
  );
  const titleLinkedKeys = await titleLinkedKeysPromise;

  const deduped = [];
  const seen = new Set();
  for (const song of rawSongs) {
    const normalized = normalizeKugouSong(song);
    if (!normalized.hash) {
      continue;
    }
    const dedupeKey = `${normalized.hash}:${normalized.albumAudioId}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    deduped.push({
      ...normalized,
      titleLinked: titleLinkedKeys.has(dedupeKey),
    });
  }

  return deduped
    .map((song) => {
      let score = scoreCandidate(track, song.title, song.artist);
      score += scoreDurationBonus(
        track,
        song.title,
        song.artist,
        song.durationMs,
      );
      score += scoreKugouCatalogTitleBonus(track, song.title, nativeTitle);
      if (
        isLikelySameKugouTrack(track, song.title, song.artist, song.durationMs, {
          titleLinked: song.titleLinked,
          nativeTitle,
        })
      ) {
        score += 6;
      }
      if (song.titleLinked) {
        score += 8;
      }
      return {
        song,
        score,
        title: song.title,
        artist: song.artist,
        durationMs: song.durationMs,
        hash: song.hash,
        albumAudioId: song.albumAudioId,
        titleLinked: song.titleLinked,
      };
    })
    .sort((left, right) => right.score - left.score);
}

async function previewKugouSearchCandidates(track) {
  return collectRankedKugouSearchCandidates(track);
}

async function fetchFromKugou(
  track,
  { timeoutMs = KUGOU_ISRC_TIMEOUT_MS, spotifyAccessToken = "" } = {},
) {
  const lookupTrack = await resolveLyricsTrackMetadata(track, ["isrc", ...lyricsTextMatchFields], { spotifyAccessToken });
  const isrc = lookupTrack.isrc;
  let nativeTitle = lookupTrack?.nativeTitle;
  if ((nativeTitle === undefined || nativeTitle === "") && isrc) {
    try {
      nativeTitle = await resolveIsrcNativeTitle(isrc, { timeoutMs });
    } catch {
      nativeTitle = null;
    }
  }
  nativeTitle = nativeTitle || null;
  const trackToUse = { ...lookupTrack, nativeTitle };
  const ranked = await collectRankedKugouSearchCandidates(trackToUse, {
    timeoutMs,
  });
  if (!ranked.length) {
    return null;
  }

  const likelyCandidates = ranked
    .filter((candidate) =>
      isLikelySameKugouTrack(
        trackToUse,
        candidate.title,
        candidate.artist,
        candidate.durationMs,
        { titleLinked: candidate.titleLinked, nativeTitle },
      ),
    )
    .sort((left, right) => compareCandidateMatchQuality(trackToUse, left, right))
    .slice(0, MAX_KUGOU_CANDIDATES);

  const probes = createRankedProbePool(likelyCandidates, 4, async (candidate) => {
    try {
      return await fetchKugouKaraokeLyricsForSong(
        lookupTrack,
        candidate.song,
        candidate.score,
      );
    } catch {
      return null;
    }
  });
  let bestResult = null;
  let bestScore = -1;
  try {
    for (let index = 0; index < likelyCandidates.length; index += 1) {
      const candidate = likelyCandidates[index];
      const probe = await probes.read(index);
      if (!probe?.lyrics?.length) continue;
      if (probe.coverage > bestScore) {
        bestScore = probe.coverage;
        bestResult = { lyrics: probe.lyrics, source: probe.source };
      }
      if (candidate.score >= MATCH_CONFIDENCE_SCORE && probe.coverageRatio >= EARLY_RETURN_COVERAGE_RATIO) {
        return { lyrics: probe.lyrics, source: probe.source };
      }
    }
    return bestResult;
  } finally { probes.stop(); }
}
