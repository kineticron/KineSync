"use strict";

// Source registry, preferred-source ordering, lyric finalization/ranking, and createLyricsService facade.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

const SOURCE_FETCHERS = {
  "local-vault": fetchFromLocalVault,
  kugou: fetchFromKugou,
  netease: fetchFromNetease,
  "qq-direct": fetchFromQQDirect,
  musixmatch: fetchFromMusixmatch,
  lrclib: fetchFromLrcLib,
  "spicy-lyrics": fetchFromSpicyLyrics,
};

function normalizeSourceKey(source) {
  const normalized = String(source || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "";
  }
  return SOURCE_ALIASES[normalized] || normalized;
}

function getAvailableLyricsSources() {
  return Object.keys(SOURCE_FETCHERS);
}

function getTemporarilyDisabledLyricsSources() {
  return [...TEMPORARILY_DISABLED_SOURCES];
}

function countTranslatedLyricsLines(lyrics) {
  return Array.isArray(lyrics)
    ? lyrics.reduce(
        (count, line) =>
          count + (String(line?.translatedText || "").trim() ? 1 : 0),
        0,
      )
    : 0;
}

function mergeLyricsMetadata(...metadataList) {
  const merged = {};
  for (const metadata of metadataList) {
    if (!metadata || typeof metadata !== "object") {
      continue;
    }
    if (metadata.instrumental) {
      merged.instrumental = true;
    }
    if (metadata.credits && typeof metadata.credits === "object") {
      merged.credits = {
        ...(merged.credits || {}),
        ...metadata.credits,
      };
    }
    if (metadata.translation && typeof metadata.translation === "object") {
      merged.translation = {
        ...(merged.translation || {}),
        ...metadata.translation,
      };
    }
  }
  return merged;
}

async function probeLyricsSource(
  track,
  source,
  {
    musixmatchUserToken = process.env.MUSIXMATCH_USER_TOKEN || "",
    spotifyWebToken = process.env.SPOTIFY_WEB_TOKEN || "",
    spotifyAccessToken = "",
  } = {},
) {
  const normalizedSource = normalizeSourceKey(source);
  const fetcher = SOURCE_FETCHERS[normalizedSource];
  if (typeof fetcher !== "function") {
    return {
      ok: false,
      requestedSource: String(source || ""),
      source: normalizedSource || String(source || ""),
      errorType: "unknown-source",
      errorMessage: `Unknown source "${source}"`,
      result: null,
    };
  }

  try {
    const safeTrack = {
      trackId: String(track?.trackId || "probe-track"),
      title: String(track?.title || "").trim(),
      artist: String(track?.artist || "").trim(),
      durationMs: Number(track?.durationMs || 0),
      spotifyTrackId: String(track?.spotifyTrackId || "").trim(),
      album: String(track?.album || "").trim(),
    };
    if (!safeTrack.title || !safeTrack.artist) {
      return {
        ok: false,
        requestedSource: String(source || ""),
        source: normalizedSource,
        errorType: "invalid-track",
        errorMessage: "Track must include non-empty title and artist",
        result: null,
      };
    }

    const matchTrack = await buildLyricsMatchTrack(safeTrack, {
      spotifyAccessToken: String(spotifyAccessToken || "").trim(),
    });

    const result = await fetcher(matchTrack, {
      musixmatchUserToken: String(musixmatchUserToken || "").trim(),
      spotifyWebToken: String(spotifyWebToken || "").trim(),
      spotifyAccessToken: String(spotifyAccessToken || "").trim(),
    });
    if (!result?.lyrics?.length) {
      return {
        ok: false,
        requestedSource: String(source || ""),
        source: normalizedSource,
        errorType: "no-match",
        errorMessage: "No synced lyrics returned",
        result: null,
      };
    }
    return {
      ok: true,
      requestedSource: String(source || ""),
      source: normalizedSource,
      errorType: null,
      errorMessage: "",
      result,
    };
  } catch (error) {
    return {
      ok: false,
      requestedSource: String(source || ""),
      source: normalizedSource,
      errorType: describeSourceError(error),
      errorMessage:
        error instanceof Error
          ? error.message
          : String(error || "Unknown error"),
      result: null,
    };
  }
}

function sanitizePreferredSource(preferredSource) {
  const source = normalizeSourceKey(preferredSource || "auto");
  return VALID_SOURCE_KEYS.has(source) ? source : "auto";
}

function getSourceAttemptOrder(
  preferredSource,
  {
    hasMusixmatchUserToken = false,
    hasSpotifyWebToken = false,
    hasSpotifyTrackId = false,
    track = null,
  } = {},
) {
  const hasSpicy = hasSpotifyWebToken || hasSpotifyTrackId;
  const singleFeatVariant =
    track &&
    trackNeedsFeaturedVariantVerification(track) &&
    countRequestedFeaturedArtistGroups(track?.title || "") <= 1;
  const coreSources = [
    "lrclib",
    "netease",
    ...(hasMusixmatchUserToken ? ["musixmatch"] : []),
    "qq-direct",
  ];
  const apiOrder = singleFeatVariant
    ? ["kugou", ...coreSources, ...(hasSpicy ? ["spicy-lyrics"] : [])]
    : ["kugou", ...(hasSpicy ? ["spicy-lyrics"] : []), ...coreSources];
  const preferred = sanitizePreferredSource(preferredSource);
  if (preferred === "auto") {
    return ["local-vault", ...apiOrder];
  }
  if (preferred === "local-vault") {
    return ["local-vault"];
  }
  if (TEMPORARILY_DISABLED_SOURCES.has(preferred)) {
    return [];
  }
  return [preferred];
}

function classifySourceFailure(source, error) {
  if (!error) {
    return `${source}:no-match`;
  }
  if (
    typeof error?.sourceFailureReason === "string" &&
    error.sourceFailureReason
  ) {
    return error.sourceFailureReason;
  }
  const errorText =
    error instanceof Error ? error.message : String(error || "");
  if (errorText === "__NO_MATCH__") {
    return `${source}:no-match`;
  }
  return `${source}:unreachable-${describeSourceError(error)}`;
}

function mergeBackgroundSyllablesIntoLine(leadLine, bgSyllables) {
  if (!bgSyllables || !bgSyllables.length) return;
  const existing = leadLine.backgroundSyllables || [];
  leadLine.backgroundSyllables = [...existing, ...bgSyllables];
}

function markSyllableAsWordBoundary(syllable) {
  if (syllable && typeof syllable === "object") {
    syllable.isPartOfWord = false;
  }
}

function trimTrailingSyllableWhitespace(
  syllables,
  { markBoundary = true } = {},
) {
  while (syllables.length > 0) {
    const last = syllables[syllables.length - 1];
    last.text = String(last.text || "").replace(/\s+$/, "");
    if (String(last.text || "").trim()) {
      if (markBoundary) {
        markSyllableAsWordBoundary(last);
      }
      return;
    }
    syllables.pop();
  }
}

function appendBackgroundGroupSeparator(bgSyllables) {
  if (!bgSyllables.length) return;
  trimTrailingSyllableWhitespace(bgSyllables);
  const last = bgSyllables[bgSyllables.length - 1];
  if (!last) return;

  const text = String(last.text || "").replace(/\s+$/, "");
  if (!text) return;
  last.text = /[,;:!?]$/.test(text) ? text : `${text},`;
  markSyllableAsWordBoundary(last);
}

function isCensorshipBoundary(leftText, rightText) {
  const left = String(leftText || "").trim();
  const right = String(rightText || "").trim();
  if (!left || !right) {
    return false;
  }
  const censorRun = /^[*＊•·]+$/;
  return (
    (censorRun.test(left) && /^[A-Za-z0-9]/.test(right)) ||
    (/[A-Za-z0-9]$/.test(left) && censorRun.test(right))
  );
}

function applyCensorshipWordBoundaries(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) {
    return syllables;
  }
  for (let index = 0; index < syllables.length - 1; index += 1) {
    const current = syllables[index];
    const next = syllables[index + 1];
    if (!current || !next) {
      continue;
    }
    if (isCensorshipBoundary(current.text, next.text)) {
      current.isPartOfWord = false;
    }
  }
  return syllables;
}

function mergeCensorshipSyllables(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) return syllables;
  const censorGlyph = /^[*＊•·]+$/;
  const merged = [];
  let run = null;
  for (const syl of syllables) {
    const trimmed = String(syl.text || "").trim();
    if (censorGlyph.test(trimmed)) {
      if (!run) {
        run = {
          text: syl.text,
          startTime: syl.startTime,
          endTime: syl.endTime,
        };
      } else {
        run.text += syl.text;
        run.endTime = Math.max(run.endTime, syl.endTime);
      }
    } else {
      if (run) {
        merged.push(run);
        run = null;
      }
      merged.push(syl);
    }
  }
  if (run) merged.push(run);
  return applyCensorshipWordBoundaries(merged);
}

function mergeCensorshipSyllablesInLyrics(lyrics) {
  if (!Array.isArray(lyrics)) return lyrics;
  for (const line of lyrics) {
    if (line?.syllables?.length > 1) {
      line.syllables = applyCensorshipWordBoundaries(
        mergeCensorshipSyllables(line.syllables),
      );
    }
    if (line?.backgroundSyllables?.length > 1) {
      line.backgroundSyllables = applyCensorshipWordBoundaries(
        mergeCensorshipSyllables(line.backgroundSyllables),
      );
    }
  }
  return lyrics;
}

function extractParenthesisToBackground(lyrics) {
  if (!Array.isArray(lyrics)) return lyrics;
  const processedLyrics = [];
  let previousLine = null;

  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i];
    const newSyllables = [];
    const bgSyllables = [];
    let inParen = false;
    let currentBackgroundGroupHasContent = false;
    let completedBackgroundGroupCount = 0;

    const closeBackgroundGroup = () => {
      if (!currentBackgroundGroupHasContent) {
        return;
      }
      trimTrailingSyllableWhitespace(bgSyllables);
      completedBackgroundGroupCount += 1;
      currentBackgroundGroupHasContent = false;
    };

    const appendLeadSyllable = (syl, text) => {
      if (!String(text || "").trim()) {
        return;
      }
      newSyllables.push({ ...syl, text });
    };

    const appendBackgroundSyllable = (syl, text) => {
      const normalizedText = currentBackgroundGroupHasContent
        ? text
        : String(text || "").replace(/^\s+/, "");
      if (!String(normalizedText || "").trim()) {
        return;
      }
      if (!currentBackgroundGroupHasContent && completedBackgroundGroupCount) {
        appendBackgroundGroupSeparator(bgSyllables);
      }
      bgSyllables.push({ ...syl, text: normalizedText });
      currentBackgroundGroupHasContent = true;
    };

    for (let j = 0; j < (line.syllables || []).length; j++) {
      const syl = line.syllables[j];
      const rawText = String(syl.text || "");
      let chunkStart = 0;

      for (let charIndex = 0; charIndex < rawText.length; charIndex += 1) {
        const char = rawText[charIndex];
        const isOpenParen = char === "(" || char === "（";
        const isCloseParen = char === ")" || char === "）";
        if (!isOpenParen && !isCloseParen) {
          continue;
        }

        const chunk = rawText.slice(chunkStart, charIndex);
        if (inParen) {
          appendBackgroundSyllable(syl, chunk);
        } else {
          appendLeadSyllable(syl, chunk);
        }

        if (isOpenParen) {
          if (!inParen) {
            trimTrailingSyllableWhitespace(newSyllables, {
              markBoundary: false,
            });
            inParen = true;
          }
        } else if (inParen) {
          closeBackgroundGroup();
          inParen = false;
        } else {
          appendLeadSyllable(syl, char);
        }
        chunkStart = charIndex + 1;
      }

      const trailingChunk = rawText.slice(chunkStart);
      if (inParen) {
        appendBackgroundSyllable(syl, trailingChunk);
      } else {
        appendLeadSyllable(syl, trailingChunk);
      }
    }
    closeBackgroundGroup();

    // Remove any lead syllables that are now empty or whitespace-only after trimming.
    const cleanedLead = newSyllables.filter(
      (syl) => String(syl.text || "").trim().length > 0,
    );

    if (cleanedLead.length === 0 && bgSyllables.length > 0) {
      if (previousLine) {
        mergeBackgroundSyllablesIntoLine(previousLine, bgSyllables);
        previousLine.lineEndTime = Math.max(
          previousLine.lineEndTime || 0,
          line.lineEndTime || 0,
        );
      } else {
        line.syllables = [];
        line.backgroundSyllables = bgSyllables;
        processedLyrics.push(line);
        previousLine = line;
      }
    } else {
      line.syllables = cleanedLead;
      if (bgSyllables.length > 0) {
        mergeBackgroundSyllablesIntoLine(line, bgSyllables);
      }
      processedLyrics.push(line);
      previousLine = line;
    }
  }
  return processedLyrics.filter(
    (line) => line?.syllables?.length || line?.backgroundSyllables?.length,
  );
}

async function finalizeFetchedLyricsResult(result) {
  if (!result) {
    return null;
  }

  if (result.lyrics?.length) {
    mergeCensorshipSyllablesInLyrics(result.lyrics);
    const source = String(result.source || "").toLowerCase();
    if (!isSpicyKaraokeSource(result.source) && !source.includes("local-vault")) {
      result.lyrics = extractParenthesisToBackground(result.lyrics);
    }
  }
  return result;
}

function getLyricsTimingTier(sourceLabel) {
  const source = String(sourceLabel || "").toLowerCase();
  if (source.includes("spicy-lyrics-static")) {
    return 0;
  }
  if (source.includes("netease-lrc")) {
    return 1;
  }
  if (
    source.includes("richsync") ||
    source.includes("musicu-qrc") ||
    source.includes("kugou-krc") ||
    source.includes("karaoke") ||
    source.includes("yrc") ||
    source.includes("spicy-lyrics-syllable")
  ) {
    return 3;
  }
  if (source.includes("spicy-lyrics-line")) {
    return 2;
  }
  if (source.includes("qrc")) {
    return 2;
  }
  return 1;
}

function getLastLyricEndTimeMs(lyrics) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return 0;
  }
  return lyrics.reduce((max, line) => {
    const end = Number(line?.lineEndTime || line?.lineStartTime || 0);
    return Number.isFinite(end) ? Math.max(max, end) : max;
  }, 0);
}

function getLyricsCoverageStats(lyrics, durationMs = 0) {
  const lineCount = Array.isArray(lyrics) ? lyrics.length : 0;
  if (!lineCount) {
    return {
      coverageRatio: 0,
      trailingGapMs: 0,
      lastTimedPointMs: 0,
      lineCount: 0,
    };
  }
  const lastTimedPointMs = getLastLyricEndTimeMs(lyrics);
  const safeDuration = Number(durationMs) > 0 ? Number(durationMs) : 0;
  if (safeDuration <= 0) {
    return {
      coverageRatio: 0.5,
      trailingGapMs: 0,
      lastTimedPointMs,
      lineCount,
    };
  }
  const trailingGapMs = Math.max(0, safeDuration - lastTimedPointMs);
  const trailingGapAllowanceMs = Math.min(
    Math.max(7_500, Math.floor(safeDuration * 0.12)),
    35_000,
  );
  const effectiveTimedPointMs = Math.min(
    safeDuration,
    lastTimedPointMs + Math.min(trailingGapMs, trailingGapAllowanceMs),
  );
  return {
    coverageRatio: Math.max(
      0,
      Math.min(1.5, effectiveTimedPointMs / safeDuration),
    ),
    trailingGapMs,
    lastTimedPointMs,
    lineCount,
  };
}

function getLyricsCoverageRatio(lyrics, durationMs = 0) {
  return getLyricsCoverageStats(lyrics, durationMs).coverageRatio;
}

function getSourcePriorityBucket(sourceLabel) {
  const source = String(sourceLabel || "").toLowerCase();
  if (source.includes("local-vault-karaoke")) {
    return 720;
  }
  if (source.includes("local-vault-line")) {
    return 380;
  }
  if (source.includes("spicy-lyrics-syllable")) {
    return 680;
  }
  if (source.includes("kugou-krc")) {
    return 620;
  }
  if (source.includes("qq-musicu-qrc")) {
    return 600;
  }
  if (source.includes("netease-yrc")) {
    return 560;
  }
  if (source.includes("musixmatch-richsync")) {
    return 520;
  }
  if (source.includes("spicy-lyrics-line")) {
    return 360;
  }
  if (source.includes("spicy-lyrics-static")) {
    return 180;
  }
  if (source.includes("lrclib")) {
    return 320;
  }
  if (source.includes("netease-lrc")) {
    return 300;
  }
  if (source.includes("musixmatch") && !source.includes("richsync")) {
    return 280;
  }
  if (source.includes("qq-")) {
    return 240;
  }
  return 200;
}

function isSpicyKaraokeSource(sourceLabel) {
  return String(sourceLabel || "")
    .toLowerCase()
    .includes("spicy-lyrics-syllable");
}

function isSpicyLyricsSource(sourceLabel) {
  return String(sourceLabel || "")
    .toLowerCase()
    .includes("spicy-lyrics");
}

function isSpicyLineSource(sourceLabel) {
  return String(sourceLabel || "")
    .toLowerCase()
    .includes("spicy-lyrics-line");
}

function isSpicyStaticSource(sourceLabel) {
  return String(sourceLabel || "")
    .toLowerCase()
    .includes("spicy-lyrics-static");
}

function isKaraokeLyricsSource(sourceLabel) {
  const source = String(sourceLabel || "").toLowerCase();
  if (source.includes("netease-lrc")) {
    return false;
  }
  return (
    isSpicyKaraokeSource(source) ||
    source.includes("kugou-krc") ||
    source.includes("qq-musicu-qrc") ||
    source.includes("netease-yrc") ||
    source.includes("musixmatch-richsync") ||
    source.includes("richsync") ||
    source.includes("karaoke") ||
    source.includes("yrc")
  );
}

function hasComparableLastLineTiming(referenceLyrics, candidateLyrics) {
  const referenceEnd = getLastLyricEndTimeMs(referenceLyrics);
  const candidateEnd = getLastLyricEndTimeMs(candidateLyrics);
  if (referenceEnd <= 0 || candidateEnd <= 0) {
    return true;
  }
  const toleranceMs = Math.max(8_000, Math.floor(referenceEnd * 0.14));
  return candidateEnd + toleranceMs >= referenceEnd;
}

function spicyLyricsFailFeaturedVariantCheck(track, result) {
  return (
    isSpicyLyricsSource(result?.source) &&
    featuredVariantLyricsMismatch(track, result?.lyrics, {
      source: "spicy",
      spicyDeclaredTitles: result?.metadata?.spicyVariantTitles,
      qqReferenceFingerprint: result?.metadata?.qqReferenceFingerprint,
    })
  );
}

function meetsCoverageDemand(track, currentBest, candidate) {
  if (!candidate?.lyrics?.length) {
    return false;
  }
  const candidateSource = String(candidate?.source || "").toLowerCase();
  if (candidateSource.includes("local-vault")) {
    return true;
  }
  if (isSpicyStaticSource(candidateSource)) {
    if (spicyLyricsFailFeaturedVariantCheck(track, candidate)) {
      return false;
    }
    if (
      currentBest?.lyrics?.length &&
      !isSpicyStaticSource(currentBest.source)
    ) {
      return false;
    }
    return candidate.lyrics.length > 0;
  }
  if (spicyLyricsFailFeaturedVariantCheck(track, candidate)) {
    return false;
  }
  const trackDuration = Number(track?.durationMs || 0);
  const candidateCoverageStats = getLyricsCoverageStats(
    candidate.lyrics,
    trackDuration,
  );
  const candidateCoverage = candidateCoverageStats.coverageRatio;
  const candidateIsKaraoke = isKaraokeLyricsSource(candidate.source);
  const candidateIsSpicyLine =
    isSpicyLineSource(candidate.source) && !candidateIsKaraoke;
  if (candidateIsSpicyLine) {
    if (
      currentBest?.lyrics?.length &&
      isKaraokeLyricsSource(currentBest.source)
    ) {
      return false;
    }
    return true;
  }
  const minimumCoverage = candidateIsKaraoke ? 0.4 : 0.46;
  if (trackDuration > 0 && candidateCoverage < minimumCoverage) {
    const allowedTrailingGapMs = Math.min(
      45_000,
      Math.max(18_000, Math.floor(trackDuration * 0.2)),
    );
    const modestCoverageMiss =
      candidateCoverage >= minimumCoverage - 0.08 &&
      candidateCoverageStats.lineCount >= 10;
    const looksLikeTrailingInstrumentalGap =
      candidateCoverageStats.trailingGapMs <= allowedTrailingGapMs &&
      candidateCoverageStats.lastTimedPointMs >= trackDuration * 0.34;
    if (!modestCoverageMiss || !looksLikeTrailingInstrumentalGap) {
      return false;
    }
  }

  if (currentBest?.lyrics?.length) {
    if (!hasComparableLastLineTiming(currentBest.lyrics, candidate.lyrics)) {
      return false;
    }
    const currentCoverage = getLyricsCoverageRatio(
      currentBest.lyrics,
      trackDuration,
    );
    if (!candidateIsKaraoke && candidateCoverage + 0.05 < currentCoverage) {
      return false;
    }
  }
  return true;
}

function isQqDirectFamilySource(sourceLabel) {
  const source = String(sourceLabel || "").toLowerCase();
  return (
    source.includes("qq-musicu-qrc") ||
    source.includes("qq-music-direct") ||
    source.includes("qq-legacy")
  );
}

function isQqNonDirectSource(sourceLabel) {
  const source = String(sourceLabel || "").toLowerCase();
  return (
    source.includes("qq-music-openapi-fallback") ||
    source.includes("qq-openapi") ||
    source.includes("qq-music-openai") ||
    source.includes("qq-openai")
  );
}

function scoreLyricsCandidate(track, result) {
  const coverageScore = scoreLyricsCoverage(
    result?.lyrics || [],
    track?.durationMs || 0,
  );
  const lineCount = Array.isArray(result?.lyrics) ? result.lyrics.length : 0;
  const timingTier = getLyricsTimingTier(result?.source || "");
  const coverageRatio = getLyricsCoverageRatio(
    result?.lyrics || [],
    track?.durationMs || 0,
  );
  return (
    coverageScore +
    timingTier * 36 +
    getSourcePriorityBucket(result?.source || "") * 0.15 +
    Math.min(18, lineCount * 0.22) +
    coverageRatio * 12
  );
}

function shouldUpgradeLyricsCandidate(track, currentBest, candidate) {
  if (
    !candidate?.lyrics?.length ||
    !meetsCoverageDemand(track, currentBest, candidate)
  ) {
    return false;
  }
  if (!currentBest?.lyrics?.length) {
    return true;
  }
  if (spicyLyricsFailFeaturedVariantCheck(track, candidate)) {
    return false;
  }
  if (spicyLyricsFailFeaturedVariantCheck(track, currentBest)) {
    return true;
  }
  const currentIsSpicyStatic = isSpicyStaticSource(currentBest.source);
  const nextIsSpicyStatic = isSpicyStaticSource(candidate.source);
  if (currentIsSpicyStatic && !nextIsSpicyStatic) {
    return true;
  }
  if (nextIsSpicyStatic && !currentIsSpicyStatic) {
    return false;
  }
  const currentIsSpicyKaraoke = isSpicyKaraokeSource(currentBest.source);
  const nextIsSpicyKaraoke = isSpicyKaraokeSource(candidate.source);
  if (currentIsSpicyKaraoke && !nextIsSpicyKaraoke) {
    return false;
  }
  if (nextIsSpicyKaraoke && !currentIsSpicyKaraoke) {
    return true;
  }

  const currentIsKaraoke = isKaraokeLyricsSource(currentBest.source);
  const nextIsKaraoke = isKaraokeLyricsSource(candidate.source);
  const currentIsSpicyLine = isSpicyLineSource(currentBest.source);
  const nextIsSpicyLine = isSpicyLineSource(candidate.source);
  if (currentIsSpicyLine && !nextIsSpicyLine && !nextIsKaraoke) {
    return false;
  }
  if (nextIsSpicyLine && !currentIsSpicyLine && !currentIsKaraoke) {
    return true;
  }
  const currentPriority = getSourcePriorityBucket(currentBest.source);
  const nextPriority = getSourcePriorityBucket(candidate.source);
  const currentTimingTier = getLyricsTimingTier(currentBest.source);
  const nextTimingTier = getLyricsTimingTier(candidate.source);
  const currentCoverage = getLyricsCoverageRatio(
    currentBest.lyrics,
    track?.durationMs || 0,
  );
  const nextCoverage = getLyricsCoverageRatio(
    candidate.lyrics,
    track?.durationMs || 0,
  );
  const currentScore = scoreLyricsCandidate(track, currentBest);
  const nextScore = scoreLyricsCandidate(track, candidate);

  // Karaoke upgrades should win quickly when they satisfy coverage demands.
  if (nextIsKaraoke && !currentIsKaraoke) {
    return true;
  }
  // Explicit karaoke priority order: spicy-lyrics-syllable > kugou-krc > qq-musicu-qrc > netease-yrc > musixmatch-richsync.
  if (nextIsKaraoke && currentIsKaraoke && nextPriority > currentPriority) {
    return true;
  }
  if (
    !nextIsKaraoke &&
    !currentIsKaraoke &&
    nextPriority > currentPriority &&
    nextCoverage >= currentCoverage - 0.04
  ) {
    return true;
  }
  // If both are karaoke, prefer QQ direct family over non-direct fallbacks.
  if (
    nextTimingTier >= 3 &&
    currentTimingTier >= 3 &&
    isQqDirectFamilySource(candidate.source) &&
    isQqNonDirectSource(currentBest.source)
  ) {
    return true;
  }
  // Prefer qq-direct over non-direct QQ fallbacks when coverage is comparable.
  if (
    isQqDirectFamilySource(candidate.source) &&
    isQqNonDirectSource(currentBest.source) &&
    nextCoverage >= currentCoverage - 0.08
  ) {
    return true;
  }
  // Significant coverage improvement should win.
  if (nextCoverage >= currentCoverage + 0.12) {
    return true;
  }
  if (nextCoverage >= 0.92 && currentCoverage <= 0.78) {
    return true;
  }
  return nextScore >= currentScore + 14;
}

async function fetchBestSyncedLyrics(
  track,
  {
    preferredSource = "auto",
    onProgress = null,
    onSourceCached = null,
    sourceCache = null,
    musixmatchUserToken = "",
    spotifyWebToken = "",
    spotifyAccessToken = "",
    waitForAutoCompletion = false,
  } = {},
) {
  const failures = [];
  const safeMusixmatchUserToken = String(musixmatchUserToken || "").trim();
  const safeSpotifyWebToken = String(spotifyWebToken || "").trim();
  const safeSpotifyAccessToken = String(spotifyAccessToken || "").trim();
  const hasSpotifyTrackId = Boolean(String(track?.spotifyTrackId || "").trim());
  const attemptOrder = getSourceAttemptOrder(preferredSource, {
    hasMusixmatchUserToken: Boolean(safeMusixmatchUserToken),
    hasSpotifyWebToken:
      Boolean(safeSpotifyWebToken) || Boolean(safeSpotifyAccessToken),
    hasSpotifyTrackId,
    track,
  });
  if (!attemptOrder.length) {
    return { lyrics: [], source: "all-selected-sources-disabled" };
  }

  const preferred = sanitizePreferredSource(preferredSource);
  const tryLocalVaultOnly =
    preferred === "local-vault" ||
    (preferred === "auto" && attemptOrder.includes("local-vault"));

  if (tryLocalVaultOnly) {
    const vaultFetcher = SOURCE_FETCHERS["local-vault"];
    if (typeof vaultFetcher === "function") {
      try {
        const vaultResult = await vaultFetcher(track, {
          musixmatchUserToken: safeMusixmatchUserToken,
          spotifyWebToken: safeSpotifyWebToken,
          spotifyAccessToken: safeSpotifyAccessToken,
        });
        if (vaultResult?.lyrics?.length) {
          const finalizedVault = await finalizeFetchedLyricsResult(vaultResult);
          if (meetsCoverageDemand(track, null, finalizedVault)) {
            if (typeof sourceCache?.set === "function") {
              sourceCache.set("local-vault", finalizedVault);
            }
            if (typeof onSourceCached === "function") {
              onSourceCached(finalizedVault, "local-vault");
            }
            return finalizedVault;
          }
        }
      } catch {
        // Vault miss or read error — fall through to API sources when auto.
      }
      if (preferred === "local-vault") {
        return { lyrics: [], source: "local-vault:no-match" };
      }
    }
  }

  const apiAttemptOrder = attemptOrder.filter((source) => source !== "local-vault");
  if (!apiAttemptOrder.length) {
    return { lyrics: [], source: "local-vault:no-match" };
  }

  const cacheSourceResult = (source, candidate) => {
    if (!candidate?.lyrics?.length) {
      return;
    }
    if (typeof sourceCache?.set === "function") {
      sourceCache.set(source, candidate);
    }
    if (typeof onSourceCached === "function") {
      onSourceCached(candidate, source);
    }
  };

  if (sanitizePreferredSource(preferredSource) === "auto") {
    const failureBySource = new Map();

    const sourceTasks = apiAttemptOrder.map(async (source) => {
      const fetcher = SOURCE_FETCHERS[source];
      if (typeof fetcher !== "function") {
        const reason = `${source}:unknown-source`;
        failureBySource.set(source, reason);
        return {
          source,
          ok: false,
          failureReason: reason,
          result: null,
        };
      }
      const cachedResult =
        typeof sourceCache?.get === "function" ? sourceCache.get(source) : null;
      if (cachedResult?.lyrics?.length) {
        cacheSourceResult(source, cachedResult);
        return {
          source,
          ok: true,
          failureReason: "",
          result: cachedResult,
          fromCache: true,
        };
      }
      try {
        const result = await fetcher(track, {
          musixmatchUserToken: safeMusixmatchUserToken,
          spotifyWebToken: safeSpotifyWebToken,
          spotifyAccessToken: safeSpotifyAccessToken,
        });
        if (!result) {
          const reason = classifySourceFailure(
            source,
            new Error("__NO_MATCH__"),
          );
          failureBySource.set(source, reason);
          return {
            source,
            ok: false,
            failureReason: reason,
            result: null,
          };
        }
        if (result?.metadata?.instrumental && !result?.lyrics?.length) {
          const reason = `${source}:instrumental`;
          failureBySource.set(source, reason);
          return {
            source,
            ok: false,
            failureReason: reason,
            result,
          };
        }
        const quickCandidate = await finalizeFetchedLyricsResult(result);
        if (!meetsCoverageDemand(track, null, quickCandidate)) {
          const reason = `${source}:insufficient-coverage`;
          failureBySource.set(source, reason);
          return {
            source,
            ok: false,
            failureReason: reason,
            result: null,
          };
        }
        cacheSourceResult(source, quickCandidate);
        return {
          source,
          ok: true,
          failureReason: "",
          result: quickCandidate,
        };
      } catch (error) {
        const reason = classifySourceFailure(source, error);
        failureBySource.set(source, reason);
        return {
          source,
          ok: false,
          failureReason: reason,
          result: null,
        };
      }
    });
    try {
      if (waitForAutoCompletion) {
        const settled = await Promise.all(sourceTasks);
        const successful = settled
          .filter((outcome) => outcome.ok && outcome.result?.lyrics?.length)
          .map((outcome) => outcome.result);
        if (!successful.length) {
          const instrumentalOutcome = settled.find(
            (outcome) => outcome.result?.metadata?.instrumental,
          );
          if (instrumentalOutcome) {
            return {
              lyrics: [],
              source: `${instrumentalOutcome.source}-instrumental`,
              metadata: {
                ...(instrumentalOutcome.result?.metadata || {}),
                instrumental: true,
              },
            };
          }
          const failures = apiAttemptOrder.map(
            (source) => failureBySource.get(source) || `${source}:no-match`,
          );
          return {
            lyrics: [],
            source: failures.join(" | ") || "lyrics-unavailable",
          };
        }
        let bestFinal = successful[0];
        for (const candidate of successful.slice(1)) {
          if (shouldUpgradeLyricsCandidate(track, bestFinal, candidate)) {
            bestFinal = candidate;
          }
        }
        return bestFinal;
      }

      const raceTasks = sourceTasks.map(async (taskPromise) => {
        const outcome = await taskPromise;
        if (!outcome.ok || !outcome.result?.lyrics?.length) {
          throw new Error(outcome.failureReason || "__NO_MATCH__");
        }
        return outcome;
      });

      let quickestOutcome = null;
      try {
        quickestOutcome = await Promise.any(raceTasks);
      } catch {
        quickestOutcome = null;
      }

      if (!quickestOutcome) {
        const settled = await Promise.all(sourceTasks);
        const successful = settled
          .filter((outcome) => outcome.ok && outcome.result?.lyrics?.length)
          .map((outcome) => outcome.result);
        if (!successful.length) {
          const instrumentalOutcome = settled.find(
            (outcome) => outcome.result?.metadata?.instrumental,
          );
          if (instrumentalOutcome) {
            return {
              lyrics: [],
              source: `${instrumentalOutcome.source}-instrumental`,
              metadata: {
                ...(instrumentalOutcome.result?.metadata || {}),
                instrumental: true,
              },
            };
          }
          const failures = apiAttemptOrder.map(
            (source) => failureBySource.get(source) || `${source}:no-match`,
          );
          return {
            lyrics: [],
            source: failures.join(" | ") || "lyrics-unavailable",
          };
        }
        let bestFinal = successful[0];
        for (const candidate of successful.slice(1)) {
          if (shouldUpgradeLyricsCandidate(track, bestFinal, candidate)) {
            bestFinal = candidate;
          }
        }
        return bestFinal;
      }
      let bestResult = quickestOutcome.result;

      // Continue probing in background; cache every successful source and upgrade when better.
      if (apiAttemptOrder.length > 1) {
        for (const taskPromise of sourceTasks) {
          void taskPromise
            .then(async (outcome) => {
              if (!outcome.ok || !outcome.result?.lyrics?.length) {
                return;
              }
              const finalizedCandidate = outcome.fromCache
                ? outcome.result
                : await finalizeFetchedLyricsResult(outcome.result);
              cacheSourceResult(outcome.source, finalizedCandidate);
              if (typeof onProgress !== "function") {
                return;
              }
              if (
                shouldUpgradeLyricsCandidate(
                  track,
                  bestResult,
                  finalizedCandidate,
                )
              ) {
                bestResult = finalizedCandidate;
                onProgress(finalizedCandidate);
              }
            })
            .catch(() => {
              // Individual background source failures are expected and ignored.
            });
        }
      }

      return bestResult || { lyrics: [], source: "lyrics-unavailable" };
    } catch {
      const failures = apiAttemptOrder.map(
        (source) => failureBySource.get(source) || `${source}:no-match`,
      );
      return {
        lyrics: [],
        source: failures.join(" | ") || "lyrics-unavailable",
      };
    }
  }

  for (const source of apiAttemptOrder) {
    const fetcher = SOURCE_FETCHERS[source];
    if (typeof fetcher !== "function") {
      continue;
    }
    const cachedResult =
      typeof sourceCache?.get === "function" ? sourceCache.get(source) : null;
    if (cachedResult?.lyrics?.length) {
      cacheSourceResult(source, cachedResult);
      return cachedResult;
    }
    try {
      const result = await fetcher(track, {
        musixmatchUserToken: safeMusixmatchUserToken,
        spotifyWebToken: safeSpotifyWebToken,
        spotifyAccessToken: safeSpotifyAccessToken,
      });
      if (result) {
        if (result?.metadata?.instrumental && !result?.lyrics?.length) {
          return {
            lyrics: [],
            source: `${source}-instrumental`,
            metadata: {
              ...(result.metadata || {}),
              instrumental: true,
            },
          };
        }
        const finalized = await finalizeFetchedLyricsResult(result);
        if (meetsCoverageDemand(track, null, finalized)) {
          cacheSourceResult(source, finalized);
          return finalized;
        }
        failures.push(`${source}:insufficient-coverage`);
        continue;
      }
      failures.push(classifySourceFailure(source, new Error("__NO_MATCH__")));
    } catch (error) {
      failures.push(classifySourceFailure(source, error));
    }
  }

  return { lyrics: [], source: failures.join(" | ") || "lyrics-unavailable" };
}

async function enrichTrackForVaultMatch(track, spotifyAccessToken = "") {
  let matchTrack = await buildLyricsMatchTrack(track, { spotifyAccessToken });
  if (String(matchTrack?.spotifyTrackId || "").trim() || !spotifyAccessToken) {
    return matchTrack;
  }
  if (!String(matchTrack?.title || "").trim()) {
    return matchTrack;
  }
  try {
    const resolved = await resolveSpotifyCatalogTrackViaPartnerSearch(
      matchTrack,
      spotifyAccessToken,
    );
    if (!resolved?.id) {
      return matchTrack;
    }
    return buildLyricsMatchTrack(
      { ...matchTrack, spotifyTrackId: resolved.id },
      { spotifyAccessToken },
    );
  } catch {
    return matchTrack;
  }
}
