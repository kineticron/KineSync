"use strict";
function compareCandidateMatchQuality(track, left, right) {
  const leftTitle = String(left?.title || left?.candidateTitle || "").trim();
  const rightTitle = String(right?.title || right?.candidateTitle || "").trim();
  const leftArtist = String(left?.artist || left?.candidateArtist || "").trim();
  const rightArtist = String(
    right?.artist || right?.candidateArtist || "",
  ).trim();
  const leftArtistOverlap = getBestArtistOverlap(track.artist, leftArtist);
  const rightArtistOverlap = getBestArtistOverlap(track.artist, rightArtist);
  const leftFeatPenalty = hasMissingFeaturedArtistHints(track.title, leftTitle)
    ? 1
    : 0;
  const rightFeatPenalty = hasMissingFeaturedArtistHints(
    track.title,
    rightTitle,
  )
    ? 1
    : 0;
  if (leftFeatPenalty !== rightFeatPenalty) {
    return leftFeatPenalty - rightFeatPenalty;
  }
  if (rightArtistOverlap !== leftArtistOverlap) {
    return rightArtistOverlap - leftArtistOverlap;
  }
  const leftExtraneous = hasExtraneousTitleWords(track.title, leftTitle);
  const rightExtraneous = hasExtraneousTitleWords(track.title, rightTitle);
  if (leftExtraneous !== rightExtraneous) {
    return leftExtraneous ? 1 : -1;
  }
  return Number(right?.score || 0) - Number(left?.score || 0);
}

function scoreDurationBonus(track, title, artist, durationMs = 0) {
  if (!(track.durationMs > 0 && durationMs > 0)) {
    return 0;
  }
  const delta = Math.abs(durationMs - track.durationMs);
  const artistRel = getBestArtistOverlap(track.artist, artist);
  const titleCore = normalizeCoreTitle(track.title);
  const candidateCore = normalizeCoreTitle(title);
  const titleExact = Boolean(
    titleCore && candidateCore && titleCore === candidateCore,
  );
  const shortTitle = needsExactShortTextMatch(titleCore);

  if (artistRel < 0.42) {
    if (shortTitle) {
      return delta > 8_000 ? -3.5 : -2;
    }
    if (titleExact && delta <= 2_500) {
      return 0.35;
    }
    if (delta > 12_000) {
      return -1.5;
    }
    return 0;
  }

  if (delta < 1200) {
    return 2.5;
  }
  if (delta < 4000) {
    return 1.5;
  }
  if (delta > 12_000) {
    return -2.5;
  }
  if (delta > 20_000) {
    return -2.5;
  }
  return 0;
}

function normalizeCoreTitle(input) {
  const noBracketed = String(input || "").replace(
    /\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g,
    " ",
  );
  return normalizeText(noBracketed);
}

function extractBracketedTitleSegments(input) {
  const raw = String(input || "");
  if (!raw) {
    return [];
  }
  const matches = raw.match(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g) || [];
  const segments = [];
  const seen = new Set();
  for (const match of matches) {
    const inner = String(match || "")
      .slice(1, -1)
      .trim();
    const normalized = normalizeText(inner);
    if (!normalized || normalized.length < 2) {
      continue;
    }
    // Ignore pure version labels like "(Live)" / "(Remix)".
    const versionHints = collectVersionHints(normalized);
    if (versionHints.length && tokens(normalized).length <= 3) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    segments.push(normalized);
  }
  return segments;
}

function collectVersionHints(input) {
  const normalized = normalizeText(input);
  const hintTokens = tokens(normalized);
  return VERSION_HINTS.filter((hint) => {
    const hintParts = tokens(hint);
    if (hintParts.length === 1) {
      return hintTokens.includes(hintParts[0]);
    }
    return normalized.includes(hint);
  });
}

function collectFeaturedArtistHints(input) {
  const raw = String(input || "");
  const hints = [];
  const seen = new Set();
  const addHint = (value) => {
    for (const token of tokens(value)) {
      if (token.length < 3 || seen.has(token)) {
        continue;
      }
      if (/^(?:ft|feat|featuring)$/.test(token)) {
        continue;
      }
      if (collectVersionHints(token).length) {
        continue;
      }
      seen.add(token);
      hints.push(token);
    }
  };
  const addHintSegment = (value) => {
    for (const piece of String(value || "").split(
      /\s*(?:&|,|\+|\/|、|与|和|x|×)\s*/i,
    )) {
      addHint(piece);
    }
  };

  for (const segment of extractBracketedTitleSegments(raw)) {
    if (!collectVersionHints(segment).length) {
      addHintSegment(segment);
    }
  }

  const featuringMatch = raw.match(
    /\b(?:ft\.?|feat\.?|featuring)\s+([^)\]\[]+)/i,
  );
  if (featuringMatch?.[1]) {
    addHintSegment(featuringMatch[1]);
  }

  return hints;
}

function mergeNativePlaybackArtist(nativeArtist, catalogArtist) {
  const native = String(nativeArtist || "").trim();
  const catalog = String(catalogArtist || "").trim();
  if (!catalog) {
    return native;
  }
  if (!native) {
    return catalog;
  }
  const nativeNorm = native.toLowerCase();
  const catalogNorm = catalog.toLowerCase();
  if (catalogNorm === nativeNorm) {
    return catalog;
  }
  if (catalogNorm.includes(nativeNorm) && catalog.length >= native.length) {
    return catalog;
  }
  const nativeSeparators = (native.match(/[,;&]/g) || []).length;
  const catalogSeparators = (catalog.match(/[,;&]/g) || []).length;
  if (catalogSeparators > nativeSeparators) {
    return catalog;
  }
  return native;
}

/** Overlay Spotify catalog fields onto a playback track for lyrics matching only. */
function applySpotifyCatalogOverlay(playbackTrack, catalog) {
  if (!playbackTrack || typeof playbackTrack !== "object") {
    return playbackTrack;
  }
  if (!catalog || typeof catalog !== "object") {
    return { ...playbackTrack };
  }
  const overlay = { ...playbackTrack };
  const catalogDurationMs = Number(catalog.durationMs || 0);
  if (catalogDurationMs > 0) {
    overlay.durationMs = catalogDurationMs;
  }
  const catalogArtist = String(catalog.artist || "").trim();
  if (catalogArtist) {
    overlay.artist = mergeNativePlaybackArtist(
      playbackTrack.artist,
      catalogArtist,
    );
  }
  const catalogAlbum = String(catalog.album || "").trim();
  if (catalogAlbum && !String(overlay.album || "").trim()) {
    overlay.album = catalogAlbum;
  }
  return overlay;
}

function hasMissingFeaturedArtistHints(queryTitle, candidateTitle) {
  const queryHints = collectFeaturedArtistHints(queryTitle);
  if (!queryHints.length) {
    return false;
  }
  const candidateNorm = normalizeMatchText(candidateTitle);
  return queryHints.some((hint) => !candidateNorm.includes(hint));
}

function hasExtraneousFeaturedArtistHints(queryTitle, candidateTitle) {
  const candidateHints = collectFeaturedArtistHints(candidateTitle);
  if (!candidateHints.length) {
    return false;
  }
  const queryHints = collectFeaturedArtistHints(queryTitle);
  const queryNorm = normalizeMatchText(
    `${queryTitle} ${queryHints.join(" ")} ${normalizeCoreTitle(queryTitle)}`,
  );
  return candidateHints.some(
    (hint) => !queryHints.includes(hint) && !queryNorm.includes(hint),
  );
}

function collectLanguageVariantHints(input) {
  const normalized = normalizeText(input);
  return LANGUAGE_VARIANT_HINTS.filter((hint) => normalized.includes(hint));
}

function hasLanguageVariantMismatch(queryTitle, candidateTitle) {
  const queryHints = collectLanguageVariantHints(queryTitle);
  const candidateHints = collectLanguageVariantHints(candidateTitle);
  // Only treat as a mismatch when both sides explicitly declare a variant and disagree.
  if (!queryHints.length || !candidateHints.length) {
    return false;
  }
  return !queryHints.some((hint) => candidateHints.includes(hint));
}

function extractLyricVariantProbeText(lyricText) {
  const text = String(lyricText || "");
  if (!text.trim()) {
    return "";
  }
  const titleTag = text.match(/\[ti:([^\]]+)\]/i)?.[1] || "";
  const firstTimedLine = (
    text
      .split(/\r?\n/)
      .find((line) => /\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/.test(line)) || ""
  )
    .replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, "")
    .trim();
  return `${titleTag} ${firstTimedLine}`.trim();
}

function shouldRejectLyricVariant(trackTitle, candidateTitle, lyricText) {
  const probeTitle =
    `${candidateTitle || ""} ${extractLyricVariantProbeText(lyricText)}`.trim();
  if (!probeTitle) {
    return false;
  }
  return hasLanguageVariantMismatch(trackTitle, probeTitle);
}

function extractPlainTextFromParsedLyrics(lyrics) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return "";
  }
  const parts = [];
  for (const line of lyrics) {
    if (typeof line?.text === "string" && line.text.trim()) {
      parts.push(line.text);
      continue;
    }
    if (Array.isArray(line?.syllables)) {
      parts.push(
        line.syllables.map((part) => String(part?.text || "")).join(""),
      );
      continue;
    }
    if (Array.isArray(line?.words)) {
      parts.push(line.words.map((word) => String(word?.text || "")).join(""));
    }
  }
  return parts.join(" ");
}

const LYRIC_PRODUCER_CREDIT_TOKENS = new Set([
  "score",
  "megatone",
  "iluvjulia",
  "hitman",
  "bang",
  "kali",
  "jbach",
  "jake",
  "torrey",
  "supreme",
  "boi",
  "anthony",
  "watts",
  "amanda",
  "ibanez",
  "leven",
  "kidddo",
  "ai",
  "prod",
  "production",
  "composer",
  "composed",
  "written",
  "writer",
  "writers",
  "songwriter",
  "songwriters",
  "lyricist",
  "lyricists",
  "arranger",
  "arranged",
  "producer",
  "producers",
  "engineer",
  "master",
  "mix",
  "mixed",
  "recorded",
  "verse",
  "chorus",
  "bridge",
  "hook",
  "source",
  "music",
  "lyrics",
  "copyright",
  "publishing",
  "unknown",
]);

function isLikelyProducerCreditToken(token) {
  const value = String(token || "").toLowerCase();
  if (!value || value.length < 2) {
    return true;
  }
  if (/\d/.test(value)) {
    return true;
  }
  if (LYRIC_PRODUCER_CREDIT_TOKENS.has(value)) {
    return true;
  }
  return false;
}

function isLikelyProducerCreditName(nameNorm) {
  const nameTokens = tokens(nameNorm);
  if (!nameTokens.length) {
    return true;
  }
  if (nameTokens.some((token) => /\d/.test(token))) {
    return true;
  }
  return nameTokens.every((token) => isLikelyProducerCreditToken(token));
}

function collectAllowedFeatTokens(track) {
  const queryTitle = String(track?.title || "");
  const allowed = new Set();
  const primaryNorm = normalizeMatchText(
    getSpotifyPrimaryArtist(track?.artist || ""),
  );
  for (const token of tokens(primaryNorm)) {
    if (token.length >= 3) {
      allowed.add(token);
    }
  }
  for (const token of tokens(normalizeCoreTitle(queryTitle))) {
    if (token.length >= 3) {
      allowed.add(token);
    }
  }
  for (const hint of collectFeaturedArtistHints(queryTitle)) {
    allowed.add(hint);
    for (const token of tokens(hint)) {
      if (token.length >= 3) {
        allowed.add(token);
      }
    }
  }
  return allowed;
}

function lyricPerformerCreditMatchesAllowed(
  nameNorm,
  queryHints,
  allowedTokens,
) {
  if (
    queryHints.some(
      (hint) => nameNorm.includes(hint) || hint.includes(nameNorm),
    )
  ) {
    return true;
  }
  const nameTokens = tokens(nameNorm).filter(
    (token) => !isLikelyProducerCreditToken(token),
  );
  if (!nameTokens.length) {
    return true;
  }
  const significantAllowed = [...allowedTokens].filter(
    (token) => token.length >= 4,
  );
  if (
    nameTokens.every((token) =>
      significantAllowed.some(
        (allowed) => token.includes(allowed) || allowed.includes(token),
      ),
    )
  ) {
    return true;
  }
  return nameTokens.some((token) =>
    queryHints.some((hint) => token.includes(hint) || hint.includes(token)),
  );
}

function looksLikePerformerCreditName(nameNorm) {
  const nameTokens = tokens(nameNorm).filter(
    (token) => !isLikelyProducerCreditToken(token),
  );
  return (
    nameTokens.length >= 2 ||
    (nameTokens.length === 1 && nameTokens[0].length >= 7)
  );
}

function collectVocalCreditsFromSlashLine(value) {
  const scratch = [];
  normalizeCreditNameParts(value, scratch);
  const vocalNames = [];
  for (const part of scratch) {
    const nameNorm = normalizeMatchText(part);
    if (nameNorm.length < 4) {
      continue;
    }
    if (isLikelyProducerCreditName(nameNorm)) {
      break;
    }
    vocalNames.push(nameNorm);
  }
  return vocalNames;
}

/** Featured vocalists only — not the full composer/producer tail on 曲： lines. */
function collectLyricFeaturedPerformerNames(plainText) {
  const names = [];
  const seen = new Set();
  const addName = (nameNorm) => {
    if (nameNorm.length < 4 || seen.has(nameNorm)) {
      return;
    }
    seen.add(nameNorm);
    names.push(nameNorm);
  };
  const addFeatPhrase = (value) => {
    const scratch = [];
    normalizeCreditNameParts(value, scratch);
    for (const part of scratch) {
      addName(normalizeMatchText(part));
    }
  };
  const source = String(plainText || "");
  for (const match of source.matchAll(
    /\b(?:feat\.?|featuring|ft\.)\s+([^|\n\[\]]+)/gi,
  )) {
    addFeatPhrase(match[1]);
  }
  for (const match of source.matchAll(/(?:曲|唱)[:：]\s*([^\n]+)/gi)) {
    for (const nameNorm of collectVocalCreditsFromSlashLine(match[1])) {
      addName(nameNorm);
    }
  }
  return names;
}

function countRequestedFeaturedArtistGroups(queryTitle) {
  const raw = String(queryTitle || "");
  let maxGroups = 0;
  const featMatch = raw.match(/\b(?:ft\.?|feat\.?|featuring)\s+([^)\]]+)/i);
  if (featMatch?.[1]) {
    const parts = featMatch[1]
      .split(/\s*(?:&|,|\+|\/|、|与|和|x|×)\s*/i)
      .map((part) => part.trim())
      .filter((part) => tokens(part).length);
    maxGroups = Math.max(maxGroups, parts.length);
  }
  for (const segment of extractBracketedTitleSegments(raw)) {
    if (collectVersionHints(segment).length) {
      continue;
    }
    const featBody = segment
      .replace(/^(?:ft\.?|feat\.?|featuring)\s+/i, "")
      .trim();
    const hasFeatMarker =
      /^(?:ft\.?|feat\.?|featuring)\b/i.test(segment) || /[&＆,]/.test(segment);
    if (!hasFeatMarker) {
      continue;
    }
    const parts = featBody
      .split(/\s*(?:&|,|\+|\/|、|与|和|x|×)\s*/i)
      .map((part) => part.trim())
      .filter((part) => tokens(part).length);
    maxGroups = Math.max(
      maxGroups,
      parts.length || (tokens(featBody).length ? 1 : 0),
    );
  }
  if (maxGroups > 0) {
    return maxGroups;
  }
  return collectFeaturedArtistHints(raw).length > 0 ? 1 : 0;
}

function hasExtraneousFeatTokensInLyricBody(track, norm) {
  const queryTitle = String(track?.title || "");
  const queryHints = collectFeaturedArtistHints(queryTitle);
  if (!queryHints.length || !norm) {
    return false;
  }
  const queryNorm = normalizeText(queryTitle);
  if (/\bmash[\s-]?up\b/.test(norm) && !/\bmash[\s-]?up\b/.test(queryNorm)) {
    return true;
  }
  for (const hint of queryHints) {
    if (hint.length >= 6 && norm.includes(hint)) {
      return false;
    }
  }
  const longFeatHints = queryHints.filter(
    (hint) => /^[a-z0-9]+$/.test(hint) && hint.length >= 6,
  );
  if (!longFeatHints.length) {
    return false;
  }
  const opening = norm.slice(0, 800);
  if (longFeatHints.some((hint) => opening.includes(hint))) {
    return false;
  }
  const latinChars = (opening.match(/[a-z]/gi) || []).length;
  const latinRatio = latinChars / Math.max(opening.length, 1);
  return latinRatio < 0.1;
}

function hasExtraneousLyricPerformerCredits(track, plainText) {
  const queryTitle = String(track?.title || "");
  const queryHints = collectFeaturedArtistHints(queryTitle);
  if (!queryHints.length) {
    return false;
  }
  const allowedTokens = collectAllowedFeatTokens(track);
  for (const nameNorm of collectLyricFeaturedPerformerNames(plainText)) {
    if (isLikelyProducerCreditName(nameNorm)) {
      continue;
    }
    if (!looksLikePerformerCreditName(nameNorm)) {
      continue;
    }
    if (
      lyricPerformerCreditMatchesAllowed(nameNorm, queryHints, allowedTokens)
    ) {
      continue;
    }
    return true;
  }
  const norm = normalizeMatchText(plainText);
  for (const match of norm.matchAll(
    /\b(?:feat\.?|featuring|ft\.)\s+([a-z0-9][a-z0-9\s.'-]{2,48})/gi,
  )) {
    const featNorm = normalizeMatchText(match[1]);
    if (isLikelyProducerCreditName(featNorm)) {
      continue;
    }
    if (!looksLikePerformerCreditName(featNorm)) {
      continue;
    }
    if (
      lyricPerformerCreditMatchesAllowed(featNorm, queryHints, allowedTokens)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function hasChineseLyricCreditLabel(text) {
  return /(?:作词|作曲|编曲|监制|制作人|词|曲|唱|编)\s*[：:]/u.test(
    String(text || ""),
  );
}

function hasProductionRoleLabel(text) {
  const raw = String(text || "").trim();
  if (!raw || /^[\[(（]/.test(raw)) {
    return false;
  }
  if (hasChineseLyricCreditLabel(raw)) {
    return true;
  }
  return /^[A-Za-z][A-Za-z0-9\s/&.'@-]{0,56}[：:]\s*\S/u.test(raw);
}

function getMedianSyllableDurationMs(line) {
  const syllables = Array.isArray(line?.syllables) ? line.syllables : [];
  const durations = syllables
    .map((entry) =>
      Math.max(0, Number(entry?.endTime || 0) - Number(entry?.startTime || 0)),
    )
    .filter((duration) => duration > 0)
    .sort((left, right) => left - right);
  if (!durations.length) {
    return 0;
  }
  return durations[Math.floor(durations.length / 2)];
}

function isTimingCompressedPreludeLine(line) {
  const lineStart = Number(line?.lineStartTime || 0);
  const lineEnd = Number(line?.lineEndTime || 0);
  if (lineEnd > 90_000) {
    return false;
  }
  const lineDuration = Math.max(0, lineEnd - lineStart);
  const medianSyllableDuration = getMedianSyllableDurationMs(line);
  if (!medianSyllableDuration) {
    return lineDuration > 0 && lineDuration <= 300;
  }
  return lineDuration <= 300 && medianSyllableDuration <= 120;
}

function isLikelyCreditOrMetadataLine(text, track = null) {
  const raw = String(text || "").trim();
  if (!raw) {
    return true;
  }
  if (isLikelyMetadataLineText(raw, track || {})) {
    return true;
  }
  const norm = normalizeMatchText(raw);
  if (!norm) {
    return true;
  }
  if (hasChineseLyricCreditLabel(raw)) {
    return true;
  }
  if ((norm.match(/\//g) || []).length >= 2) {
    return true;
  }
  const substantiveTokens = tokens(norm).filter((token) => token.length >= 3);
  if (
    substantiveTokens.length >= 4 &&
    substantiveTokens.filter((token) => isLikelyProducerCreditToken(token))
      .length /
      substantiveTokens.length >=
      0.45
  ) {
    return true;
  }
  return false;
}

function isLikelyLeadingMetadataHeaderLine(text, track) {
  if (isLikelyMetadataLineText(text, track)) {
    return true;
  }
  const raw = String(text || "").trim();
  if (!raw) {
    return true;
  }
  const lineNorm = normalizeText(text);
  const lineNormTight = lineNorm.replace(/\s+/g, "");
  const trackCore = normalizeCoreTitle(track?.title || "");
  const trackArtist = normalizeText(track?.artist || "");
  const trackCoreTight = trackCore.replace(/\s+/g, "");
  const containsTrackTitle =
    Boolean(trackCore) &&
    (lineNorm.includes(trackCore) ||
      (trackCoreTight && lineNormTight.includes(trackCoreTight)));
  if (containsTrackTitle) {
    return false;
  }
  const trackArtistCandidates = [
    trackArtist,
    normalizeText(getSpotifyPrimaryArtist(track?.artist || "")),
    normalizeText(
      String(track?.artist || "")
        .replace(/\s*\([^)]*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  ].filter(Boolean);
  const containsTrackArtist = trackArtistCandidates.some((candidate) => {
    const candidateTight = candidate.replace(/\s+/g, "");
    return (
      lineNorm.includes(candidate) ||
      (candidateTight && lineNormTight.includes(candidateTight))
    );
  });
  if (containsTrackArtist && /[/／、|]/.test(raw)) {
    return true;
  }
  return false;
}
