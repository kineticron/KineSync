"use strict";

// Text normalization, candidate scoring helpers, LRC/QRC/YRC parsing, and generic source error helpers.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

const crypto = require("node:crypto");
const { qqKaraokeDecryptHex } = require("./qqBuggyDes");

const featuringRegex = /(?:^|[\s([{,-])(?:feat\.?|ft\.?|featuring)\s+.+$/i;
const artistSplitRegex = /\b(?:feat\.?|ft\.?|featuring)\b|,|;|&|\/|\||\s+x\s+/i;
const LEADING_PREFIX_MERGE_THRESHOLD_MS = 50;
const MATCH_ACCEPTANCE_THRESHOLD = 5;
const MATCH_CONFIDENCE_SCORE = 7;
const EARLY_RETURN_COVERAGE_RATIO = 0.9;
const AMBIGUITY_MAX_SCORE_GAP = 1.2;
/** Above this overlap, title-matched candidates use strict `isLikelySameTrack` only. */
const ARTIST_OVERLAP_CONFIDENT_THRESHOLD = 0.75;
/** Clear-winner fallback when no title-matched row exceeds the confident threshold. */
const CLEAR_WINNER_MIN_OVERLAP = 0.65;
const CLEAR_WINNER_MIN_OVERLAP_GAP = 0.15;
const VALID_SOURCE_KEYS = new Set([
  "auto",
  "local-vault",
  "kugou",
  "netease",
  "qq-direct",
  "musixmatch",
  "lrclib",
  "spicy-lyrics",
]);
const TEMPORARILY_DISABLED_SOURCES = new Set([]);
const SOURCE_ALIASES = Object.freeze({
  163: "netease",
  "netease-cloud-music": "netease",
  "qq-mirror": "qq-direct",
  mxm: "musixmatch",
  "musixmatch-token": "musixmatch",
  spicy: "spicy-lyrics",
  spicylyrics: "spicy-lyrics",
  spicy_lyrics: "spicy-lyrics",
  vault: "local-vault",
  "local-vault-line": "local-vault",
  "local-vault-karaoke": "local-vault",
  "kugou-music": "kugou",
  kugoumusic: "kugou",
});
const KUGOU_KRC_XOR_KEY = Uint8Array.from([
  64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105,
]);
const MAX_QUERY_VARIANTS = 3;
const MAX_MUSIXMATCH_ARTIST_VARIANTS = 3;
const MAX_QQ_LEGACY_CANDIDATES = 8;
const MAX_QQ_DIRECT_CANDIDATES = 10;
const QQ_DIRECT_CANDIDATE_PARALLELISM = 4;
const QQ_DIRECT_CANDIDATE_PROBE_CAP = 8;
const QQ_DIRECT_LYRIC_FETCH_TIMEOUT_MS = 8_000;
const MAX_SPOTIFY_TRACK_CANDIDATES = 12;
const MAX_SPICY_STRICT_SPOTIFY_CANDIDATES = 3;
const SPICY_QQ_FINGERPRINT_TIMEOUT_MS = 3_000;
const VERSION_HINTS = [
  "japanese",
  "jpn",
  "jp ver",
  "japanese ver",
  "japanese version",
  "english",
  "eng ver",
  "english ver",
  "english version",
  "korean",
  "kr ver",
  "korean ver",
  "korean version",
  "romanized",
  "romaji",
  "live",
  "remix",
  "acoustic",
  "instrumental",
  "inst",
  "karaoke",
  "sped up",
  "slowed",
  "tv size",
  "short ver",
  "version",
  "ver",
];
const LANGUAGE_VARIANT_HINTS = [
  "japanese",
  "jpn",
  "jp ver",
  "japanese ver",
  "japanese version",
  "english",
  "eng ver",
  "english ver",
  "english version",
  "korean",
  "kr ver",
  "korean ver",
  "korean version",
  "romanized",
  "romaji",
];

function foldDiacritics(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "");
}

function normalizeText(input) {
  return foldDiacritics(String(input || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip feat. suffixes from artist strings (Spotify artist field is primary-only). */
function normalizeArtistText(input) {
  return foldDiacritics(String(input || ""))
    .toLowerCase()
    .replace(featuringRegex, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ponytail: alias kept to avoid updating 20+ call sites in shared VM scope
const normalizeMatchText = normalizeText;

function extractParentheticalAliases(input) {
  const raw = String(input || "");
  const matches = raw.match(/\(([^)]+)\)/g) || [];
  const aliases = [];
  const seen = new Set();
  for (const match of matches) {
    const inner = normalizeMatchText(String(match || "").slice(1, -1));
    if (!inner || inner.length < 2 || seen.has(inner)) {
      continue;
    }
    seen.add(inner);
    aliases.push(inner);
  }
  return aliases;
}

function tokens(input) {
  return normalizeText(input).split(" ").filter(Boolean);
}

function getPrimaryArtistName(input) {
  return (
    String(input || "")
      .split(artistSplitRegex)
      .map((part) => part.trim())
      .filter(Boolean)[0] || String(input || "").trim()
  );
}

function getArtistNames(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return [];
  }

  const names = [];
  const seen = new Set();
  const addName = (value) => {
    const safe = String(value || "").trim();
    if (!safe) {
      return;
    }
    const key = safe.toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    names.push(safe);
  };

  addName(raw);
  for (const fragment of raw.split(artistSplitRegex)) {
    addName(fragment);
  }
  addName(getPrimaryArtistName(raw));
  return names;
}

function buildMusixmatchArtistVariants(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return [];
  }

  const variants = [];
  const seen = new Set();
  const addVariant = (value) => {
    const safe = String(value || "").trim();
    if (!safe) {
      return;
    }
    const key = safe.toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    variants.push(safe);
  };

  addVariant(raw);
  addVariant(getPrimaryArtistName(raw));
  for (const fragment of raw.split(artistSplitRegex)) {
    addVariant(fragment);
  }

  // Handle artist handles like "dabin.kr" where Musixmatch often indexes as "Dabin".
  const strippedDomain = raw.replace(/\.[a-z]{2,3}$/i, "").trim();
  addVariant(strippedDomain);

  const punctuationSplit = raw
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  addVariant(punctuationSplit);

  const normalizedTokens = tokens(raw);
  if (normalizedTokens.length > 1) {
    const maybeSuffix = normalizedTokens[normalizedTokens.length - 1];
    if (/^[a-z]{2,3}$/i.test(maybeSuffix)) {
      addVariant(normalizedTokens.slice(0, -1).join(" "));
    }
  }

  return variants.slice(0, MAX_MUSIXMATCH_ARTIST_VARIANTS);
}

function overlapRatio(a, b) {
  if (!a.length || !b.length) {
    return 0;
  }
  const bSet = new Set(b);
  let shared = 0;
  for (const token of a) {
    if (bSet.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.max(a.length, b.length);
}

function hasTokenSequence(haystackTokens, needleTokens) {
  if (!haystackTokens.length || !needleTokens.length) {
    return false;
  }
  if (needleTokens.length > haystackTokens.length) {
    return false;
  }
  for (
    let startIndex = 0;
    startIndex <= haystackTokens.length - needleTokens.length;
    startIndex += 1
  ) {
    let matched = true;
    for (let index = 0; index < needleTokens.length; index += 1) {
      if (haystackTokens[startIndex + index] !== needleTokens[index]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

function hasWholeTextContainment(left, right) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  if (containsCjk(normalizedLeft) || containsCjk(normalizedRight)) {
    return (
      normalizedLeft.includes(normalizedRight) ||
      normalizedRight.includes(normalizedLeft)
    );
  }
  const leftTokens = tokens(normalizedLeft);
  const rightTokens = tokens(normalizedRight);
  return (
    hasTokenSequence(leftTokens, rightTokens) ||
    hasTokenSequence(rightTokens, leftTokens)
  );
}

function needsExactShortTextMatch(input) {
  const core = normalizeCoreTitle(input);
  if (!core || containsCjk(core)) {
    return false;
  }
  const coreTokens = tokens(core);
  return coreTokens.length <= 2 && core.length <= 8;
}

function hasExtraneousTitleWords(queryTitle, candidateTitle) {
  const queryCore = normalizeCoreTitle(queryTitle);
  const candidateCore = normalizeCoreTitle(candidateTitle);
  if (!queryCore || !candidateCore || queryCore === candidateCore) {
    return false;
  }
  const queryTokens = tokens(queryCore);
  const candidateTokens = tokens(candidateCore);
  if (!queryTokens.length || queryTokens.length > 2) {
    return false;
  }
  if (!hasTokenSequence(candidateTokens, queryTokens)) {
    return false;
  }
  if (candidateTokens.length <= queryTokens.length) {
    return false;
  }

  const allowedExtraTokens = new Set([
    ...collectFeaturedArtistHints(queryTitle),
    ...extractBracketedTitleSegments(queryTitle).flatMap((segment) =>
      tokens(segment),
    ),
  ]);
  for (const token of candidateTokens) {
    if (queryTokens.includes(token)) {
      continue;
    }
    if (allowedExtraTokens.has(token)) {
      continue;
    }
    if (collectVersionHints(token).length) {
      continue;
    }
    return true;
  }
  return false;
}

function collectComparableArtistNames(input) {
  const names = getArtistNames(input);
  for (const alias of extractParentheticalAliases(input)) {
    names.push(alias);
  }
  return names;
}

function getBestArtistOverlap(trackArtist, candidateArtist) {
  const queryNames = collectComparableArtistNames(
    getSpotifyPrimaryArtist(trackArtist) || trackArtist,
  ).map(normalizeArtistText);
  const candidateNames =
    collectComparableArtistNames(candidateArtist).map(normalizeArtistText);
  let best = 0;
  for (const queryName of queryNames) {
    for (const candidateName of candidateNames) {
      if (!queryName || !candidateName) {
        continue;
      }
      if (queryName === candidateName) {
        return 1;
      }
      const overlap = overlapRatio(tokens(queryName), tokens(candidateName));
      best = Math.max(best, overlap);
      if (
        !needsExactShortTextMatch(queryName) &&
        (hasWholeTextContainment(queryName, candidateName) ||
          hasWholeTextContainment(candidateName, queryName))
      ) {
        best = Math.max(best, 0.82);
      }
    }
  }
  return best;
}

function artistNamesLookRelated(trackArtist, candidateArtist) {
  const overlap = getBestArtistOverlap(trackArtist, candidateArtist);
  const trackPrimary = normalizeArtistText(
    getSpotifyPrimaryArtist(trackArtist),
  );
  const candidateTokens = tokens(normalizeArtistText(candidateArtist));
  if (
    trackPrimary &&
    needsExactShortTextMatch(trackPrimary) &&
    candidateTokens.includes(trackPrimary)
  ) {
    return true;
  }

  if (overlap >= 0.42) {
    const candidatePrimary = normalizeArtistText(
      getPrimaryArtistName(candidateArtist),
    );
    if (needsExactShortTextMatch(trackPrimary)) {
      return (
        trackPrimary === candidatePrimary ||
        overlap >= 0.88 ||
        (trackPrimary &&
          candidatePrimary &&
          (candidatePrimary.includes(trackPrimary) ||
            trackPrimary.includes(candidatePrimary)) &&
          overlap >= 0.75)
      );
    }
    return true;
  }
  const candidatePrimary = normalizeArtistText(
    getPrimaryArtistName(candidateArtist),
  );
  if (!trackPrimary || !candidatePrimary) {
    return false;
  }
  if (trackPrimary === candidatePrimary) {
    return true;
  }
  if (needsExactShortTextMatch(trackPrimary)) {
    return trackPrimary === candidatePrimary;
  }
  return (
    hasWholeTextContainment(trackPrimary, candidatePrimary) ||
    hasWholeTextContainment(candidatePrimary, trackPrimary)
  );
}
