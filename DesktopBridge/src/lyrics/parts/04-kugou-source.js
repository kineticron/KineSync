"use strict";

// Kugou Music karaoke (KRC) source adapter.
// This file is evaluated by ../index.js in a shared compatibility context.

const KUGOU_SEARCH_ENDPOINTS = [
  "http://mobileservice.kugou.com/api/v3/search/song",
];
const KUGOU_LYRIC_SEARCH_ENDPOINTS = ["http://krcs.kugou.com/search"];
const KUGOU_LYRIC_DOWNLOAD_ENDPOINTS = ["http://lyrics.kugou.com/download"];
const MAX_KUGOU_CANDIDATES = 8;
const KUGOU_MAX_QUERY_VARIANTS = 6;
const KUGOU_ARTIST_LISTING_SPLIT = /[、，/;&|]+/u;
const KUGOU_HANGUL_TEXT_RE = /[\uac00-\ud7a3\u3130-\u318f]/u;

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

function kugouTitleMatchesTrack(track, candidateTitle) {
  if (titleCoreMatchesQuery(track, candidateTitle)) {
    return true;
  }
  const trackCore = normalizeCoreTitle(track?.title || "");
  if (!trackCore) {
    return false;
  }
  for (const segment of extractBracketedTitleSegments(candidateTitle)) {
    if (normalizeCoreTitle(segment) === trackCore) {
      return true;
    }
  }
  return false;
}

function isLikelySameKugouTrack(
  track,
  title,
  artist,
  durationMs = 0,
  { titleLinked = false } = {},
) {
  if (isLikelySameTrack(track, title, artist, durationMs)) {
    return true;
  }
  if (!titleLinked && !kugouTitleMatchesTrack(track, title)) {
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
  const durationDelta =
    track.durationMs > 0 && durationMs > 0
      ? Math.abs(durationMs - track.durationMs)
      : 0;
  const coArtistListing =
    kugouListingIncludesPrimaryArtist(track.artist, artist) &&
    splitKugouArtistNames(artist).length > 1;
  const exactTitleMatch =
    Boolean(trackCore) &&
    (trackCore === candidateCore ||
      extractBracketedTitleSegments(title).some(
        (segment) => normalizeCoreTitle(segment) === trackCore,
      ));
  const hangulTitleLinked =
    titleLinked &&
    Boolean(trackCore) &&
    needsExactShortTextMatch(trackCore) &&
    Boolean(candidateCore) &&
    !/[a-z0-9]/i.test(candidateCore) &&
    containsHangulText(candidateCore);
  const hasDurationComparison = track.durationMs > 0 && durationMs > 0;

  if (coArtistListing && exactTitleMatch) {
    const tolerance = needsExactShortTextMatch(trackCore) ? 6_000 : 12_000;
    return !hasDurationComparison || durationDelta <= tolerance;
  }
  if (hangulTitleLinked || exactTitleMatch) {
    const tolerance = needsExactShortTextMatch(trackCore) ? 45_000 : 25_000;
    return !hasDurationComparison || durationDelta <= tolerance;
  }
  return false;
}

async function collectKugouTitleLinkedKeys(track) {
  const rawTitle = String(track?.title || "").trim();
  const artistPrimary = getSpotifyPrimaryArtist(track?.artist || "");
  const titleCore = normalizeCoreTitle(rawTitle);
  if (!rawTitle || !artistPrimary || !needsExactShortTextMatch(titleCore)) {
    return new Set();
  }
  try {
    const payload = await searchKugouSongs(`${rawTitle} ${artistPrimary}`);
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

function buildKugouQueryVariants(track) {
  const rawTitle = String(track?.title || "").trim();
  const artistPrimary = getSpotifyPrimaryArtist(track?.artist || "");
  const rawArtist = String(track?.artist || "").trim();
  const titleCore = normalizeCoreTitle(rawTitle);
  const prioritized = [];
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

function scoreKugouCatalogTitleBonus(track, title) {
  if (titleCoreMatchesQuery(track, title)) {
    return 0;
  }
  return kugouTitleMatchesTrack(track, title) ? 5 : 0;
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
  const title = String(
    song?.songname ||
      song?.songname_original ||
      song?.filename ||
      "",
  ).trim();
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
  if (!lyricCandidates.length) {
    return null;
  }

  const rankedLyrics = lyricCandidates
    .map((entry) => ({
      entry,
      score: rankKugouLyricCandidate(track, entry),
    }))
    .sort((left, right) => right.score - left.score);

  for (const { entry } of rankedLyrics.slice(0, 3)) {
    if (!entry?.id || !entry?.accesskey) {
      continue;
    }
    try {
      const downloadPayload = await downloadKugouLyric(entry);
      const encodedContent = String(downloadPayload?.content || "").trim();
      if (!encodedContent) {
        continue;
      }
      const decodedKrc = decodeKugouKrc(encodedContent);
      const karaokeLyrics = stripLeadingMetadataLines(
        parseKugouKrc(decodedKrc),
        track,
      );
      if (!karaokeLyrics.length) {
        continue;
      }
      const coverage = scoreLyricsCoverage(karaokeLyrics, track.durationMs);
      const coverageRatio = getLyricsCoverageRatio(
        karaokeLyrics,
        track.durationMs,
      );
      return {
        lyrics: karaokeLyrics,
        source: "kugou-krc",
        coverage,
        coverageRatio,
        matchScore,
      };
    } catch {
      // Try the next lyric candidate.
    }
  }

  return null;
}

async function collectRankedKugouSearchCandidates(track) {
  const queryVariants = buildKugouQueryVariants(track).slice(
    0,
    KUGOU_MAX_QUERY_VARIANTS,
  );
  const titleLinkedKeys = await collectKugouTitleLinkedKeys(track);
  const rawSongs = [];

  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        const payload = await searchKugouSongs(query);
        const songs = Array.isArray(payload?.data?.info) ? payload.data.info : [];
        rawSongs.push(...flattenKugouSearchResults(songs));
      } catch {
        // Try next query variant.
      }
    }),
  );

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
      score += scoreKugouCatalogTitleBonus(track, song.title);
      if (
        isLikelySameKugouTrack(track, song.title, song.artist, song.durationMs, {
          titleLinked: song.titleLinked,
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

async function fetchFromKugou(track) {
  const ranked = await collectRankedKugouSearchCandidates(track);
  if (!ranked.length || isAmbiguousTopMatch(ranked)) {
    return null;
  }

  const likelyCandidates = ranked
    .filter((candidate) =>
      isLikelySameKugouTrack(
        track,
        candidate.title,
        candidate.artist,
        candidate.durationMs,
        { titleLinked: candidate.titleLinked },
      ),
    )
    .sort((left, right) => compareCandidateMatchQuality(track, left, right))
    .slice(0, MAX_KUGOU_CANDIDATES);

  let bestResult = null;
  let bestScore = -1;

  for (const candidate of likelyCandidates) {
    try {
      const probe = await fetchKugouKaraokeLyricsForSong(
        track,
        candidate.song,
        candidate.score,
      );
      if (!probe?.lyrics?.length) {
        continue;
      }
      if (probe.coverage > bestScore) {
        bestScore = probe.coverage;
        bestResult = { lyrics: probe.lyrics, source: probe.source };
      }
      if (
        candidate.score >= MATCH_CONFIDENCE_SCORE &&
        probe.coverageRatio >= EARLY_RETURN_COVERAGE_RATIO
      ) {
        return { lyrics: probe.lyrics, source: probe.source };
      }
    } catch {
      // Try next candidate.
    }
  }

  return bestResult;
}
