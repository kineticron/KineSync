"use strict";
function buildLyricsContentFingerprint(lyrics, track = null) {
  const payload = Array.isArray(lyrics) ? lyrics : [];
  const trackShape = track && typeof track === "object" ? track : {};
  const vocalLines = stripLeadingMetadataLines(payload, trackShape);
  const parts = [];
  for (const line of vocalLines) {
    const rawText = getLineText(line);
    const text = normalizeMatchText(rawText);
    if (text.length < 4) {
      continue;
    }
    if (isLikelyCreditOrMetadataLine(rawText, trackShape)) {
      continue;
    }
    parts.push(text);
    if (parts.length >= 12) {
      break;
    }
  }
  return parts.join("|");
}

function lyricsContentFingerprintsMatch(
  referenceFingerprint,
  candidateFingerprint,
) {
  const reference = String(referenceFingerprint || "");
  const candidate = String(candidateFingerprint || "");
  if (!reference || !candidate) {
    return true;
  }
  if (reference === candidate) {
    return true;
  }
  const shorter = reference.length <= candidate.length ? reference : candidate;
  const longer = reference.length <= candidate.length ? candidate : reference;
  if (shorter.length >= 28 && longer.includes(shorter)) {
    return true;
  }
  const referenceLines = reference.split("|").filter(Boolean);
  const candidateLines = candidate.split("|").filter(Boolean);
  if (!referenceLines.length || !candidateLines.length) {
    return false;
  }
  const compareCount = Math.min(
    referenceLines.length,
    candidateLines.length,
    10,
  );
  let matchedLines = 0;
  for (let index = 0; index < compareCount; index += 1) {
    const left = referenceLines[index];
    const right = candidateLines[index];
    if (
      left === right ||
      (left.length >= 8 && right.includes(left)) ||
      (right.length >= 8 && left.includes(right))
    ) {
      matchedLines += 1;
    }
  }
  if (matchedLines / compareCount >= 0.55) {
    return true;
  }

  const referenceBody = reference.replace(/\|/g, "");
  const candidateBody = candidate.replace(/\|/g, "");
  if (referenceBody.length < 16 || candidateBody.length < 16) {
    return false;
  }
  const shorterBody =
    referenceBody.length <= candidateBody.length
      ? referenceBody
      : candidateBody;
  const longerBody =
    referenceBody.length <= candidateBody.length
      ? candidateBody
      : referenceBody;
  if (shorterBody.length >= 20 && longerBody.includes(shorterBody)) {
    return true;
  }
  for (let index = 0; index <= shorterBody.length - 10; index += 3) {
    const slice = shorterBody.slice(index, index + 10);
    if (slice.length >= 8 && longerBody.includes(slice)) {
      return true;
    }
  }
  return false;
}

function trackNeedsFeaturedVariantVerification(track) {
  return collectFeaturedArtistHints(String(track?.title || "")).length > 0;
}

/** QQ cross-check only when catalogs commonly attach the wrong remix/mashup chart. */
function shouldUseQqFingerprintForSpicyVariantCheck(track) {
  if (!trackNeedsFeaturedVariantVerification(track)) {
    return false;
  }
  const title = String(track?.title || "");
  const normalizedTitle = normalizeText(title);
  if (
    /\bmash[\s-]?up\b/.test(normalizedTitle) ||
    /\bremix\b/.test(normalizedTitle)
  ) {
    return true;
  }
  const hints = collectFeaturedArtistHints(title);
  const core = normalizeCoreTitle(title);
  const hasRomanFeat = hints.some(
    (hint) => /^[a-z0-9]+$/.test(hint) && hint.length >= 6,
  );
  return (
    hasRomanFeat && core.length > 0 && core.length <= 16 && !containsCjk(core)
  );
}

function extractSpicyPayloadMetadata(payload) {
  const titles = [];
  const TITLE_KEY =
    /^(?:title|tracktitle|trackname|worktitle|songtitle|displaytitle|originaltitle|versiontitle|subtitle|albumtitle)$/i;
  const walk = (node, depth = 0, inMetadata = false) => {
    if (depth > 6 || !node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth + 1, inMetadata);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const keyText = String(key || "");
      const nextMetadata =
        inMetadata || /ttml|metadata|upload|attribution|info/i.test(keyText);
      if (typeof value === "string") {
        const safe = value.trim();
        if (safe.length < 4 || safe.length > 160) {
          continue;
        }
        if (
          TITLE_KEY.test(keyText) ||
          (nextMetadata && /title/i.test(keyText))
        ) {
          titles.push(safe);
        }
        continue;
      }
      if (value && typeof value === "object") {
        walk(value, depth + 1, nextMetadata);
      }
    }
  };
  walk(payload, 0, false);
  const deduped = [];
  const seen = new Set();
  for (const title of titles) {
    const norm = normalizeMatchText(title);
    if (!norm || seen.has(norm)) {
      continue;
    }
    seen.add(norm);
    deduped.push(title);
  }
  return { titles: deduped };
}

function extractSpicyLeadVocalPlainText(lyrics) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return "";
  }
  const lines = [];
  for (const line of lyrics) {
    if (!Array.isArray(line?.syllables) || !line.syllables.length) {
      continue;
    }
    lines.push(line.syllables.map((part) => String(part?.text || "")).join(""));
  }
  return lines.join("\n");
}

function spicyDeclaredTitlesMatchPlayback(track, declaredTitles = []) {
  if (!Array.isArray(declaredTitles) || !declaredTitles.length) {
    return null;
  }
  let sawRelevantTitle = false;
  for (const declaredTitle of declaredTitles) {
    const safeTitle = String(declaredTitle || "").trim();
    if (safeTitle.length < 4) {
      continue;
    }
    if (!titleCoreMatchesQuery(track, safeTitle)) {
      continue;
    }
    sawRelevantTitle = true;
    if (
      !hasMissingFeaturedArtistHints(track?.title || "", safeTitle) &&
      !hasExtraneousFeaturedArtistHints(track?.title || "", safeTitle) &&
      !hasLanguageVariantMismatch(track?.title || "", safeTitle)
    ) {
      return true;
    }
  }
  if (!sawRelevantTitle) {
    return null;
  }
  return false;
}

function spicyLeadDuetDensitySuggestsExtraFeat(track, lyrics) {
  if (countRequestedFeaturedArtistGroups(track?.title || "") !== 1) {
    return false;
  }
  const leadLines = (Array.isArray(lyrics) ? lyrics : []).filter(
    (line) => Array.isArray(line?.syllables) && line.syllables.length,
  );
  if (leadLines.length < 24) {
    return false;
  }
  const oppositeAlignedCount = leadLines.filter(
    (line) => line?.oppositeAligned,
  ).length;
  const backgroundHeavyCount = leadLines.filter(
    (line) =>
      Array.isArray(line?.backgroundSyllables) &&
      line.backgroundSyllables.length >= 4,
  ).length;
  const oppositeRatio = oppositeAlignedCount / leadLines.length;
  const backgroundRatio = backgroundHeavyCount / leadLines.length;
  return (
    oppositeAlignedCount >= 8 && oppositeRatio >= 0.2 && backgroundRatio >= 0.16
  );
}

function spicyFeaturedVariantLyricsMismatch(
  track,
  lyrics,
  spicyMetadata = {},
  variantOptions = {},
) {
  const queryTitle = String(track?.title || "");
  const hints = collectFeaturedArtistHints(queryTitle);
  if (!hints.length) {
    return false;
  }

  const qqReferenceFingerprint = String(
    variantOptions.qqReferenceFingerprint || "",
  );
  if (
    qqReferenceFingerprint &&
    shouldUseQqFingerprintForSpicyVariantCheck(track)
  ) {
    const spicyFingerprint = buildLyricsContentFingerprint(lyrics, track);
    return !lyricsContentFingerprintsMatch(
      qqReferenceFingerprint,
      spicyFingerprint,
    );
  }

  const declaredTitles = Array.isArray(spicyMetadata?.titles)
    ? spicyMetadata.titles
    : [];
  const declaredTitleMatch = spicyDeclaredTitlesMatchPlayback(
    track,
    declaredTitles,
  );
  if (declaredTitleMatch === true) {
    return false;
  }
  if (declaredTitleMatch === false) {
    return true;
  }

  const leadPlain = extractSpicyLeadVocalPlainText(lyrics);
  const leadNorm = normalizeMatchText(leadPlain);
  if (!leadNorm) {
    return false;
  }

  if (hasExtraneousFeatTokensInLyricBody(track, leadNorm)) {
    return true;
  }
  if (shouldRejectLyricVariant(queryTitle, queryTitle, leadPlain)) {
    return true;
  }
  if (spicyLeadDuetDensitySuggestsExtraFeat(track, lyrics)) {
    return true;
  }
  return false;
}

/**
 * True when the playback title requests a feat./bracket variant but lyric text
 * looks like the base album version (e.g. Korean CRAZY vs English PinkPantheress remix)
 * or credits reference a different feat lineup (e.g. mashup with Dashaun Wesley).
 */
function featuredVariantLyricsMismatch(track, lyrics, options = {}) {
  if (String(options?.source || "").toLowerCase() === "spicy") {
    return spicyFeaturedVariantLyricsMismatch(
      track,
      lyrics,
      {
        titles: options.spicyDeclaredTitles || [],
      },
      {
        qqReferenceFingerprint: options.qqReferenceFingerprint || "",
      },
    );
  }

  const queryTitle = String(track?.title || "");
  const hints = collectFeaturedArtistHints(queryTitle);
  if (!hints.length) {
    return false;
  }
  const plain = extractPlainTextFromParsedLyrics(lyrics);
  const norm = normalizeMatchText(plain);
  if (hasExtraneousLyricPerformerCredits(track, plain)) {
    return true;
  }
  if (hasExtraneousFeatTokensInLyricBody(track, norm)) {
    return true;
  }
  if (!norm) {
    return false;
  }
  if (shouldRejectLyricVariant(queryTitle, queryTitle, plain)) {
    return true;
  }
  if (hints.some((hint) => norm.includes(hint))) {
    return false;
  }
  const longRomanHints = hints.filter(
    (hint) => /^[a-z0-9]+$/.test(hint) && hint.length >= 6,
  );
  if (!longRomanHints.length) {
    return false;
  }
  const opening = norm.slice(0, 500);
  if (longRomanHints.some((hint) => opening.includes(hint))) {
    return false;
  }
  const latinChars = (opening.match(/[a-z]/gi) || []).length;
  const latinRatio = latinChars / Math.max(opening.length, 1);
  return latinRatio < 0.1;
}
