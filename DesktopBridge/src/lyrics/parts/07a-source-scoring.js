"use strict";

// Source registry, preferred-source ordering, lyric finalization/ranking, and createLyricsService facade.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

const SOURCE_FETCHERS = {
  "local-vault": fetchFromLocalVault,
  "lrc-red": fetchFromLrcRed,
  kugou: fetchFromKugou,
  netease: fetchFromNetease,
  "qq-direct": fetchFromQQ,
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
          count +
          (String(line?.translatedText || "").trim() ||
          String(line?.backgroundTranslatedText || "").trim()
            ? 1
            : 0),
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
    if (metadata.spicyApi && typeof metadata.spicyApi === "object") {
      merged.spicyApi = { ...metadata.spicyApi };
    }
    if (metadata.ttml && typeof metadata.ttml === "object") {
      merged.ttml = { ...metadata.ttml };
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
    if (metadata.attribution && typeof metadata.attribution === "object") {
      merged.attribution = {
        ...(merged.attribution || {}),
        ...metadata.attribution,
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
    spicyLyricsPublishableKey = process.env.SPICY_LYRICS_PUBLISHABLE_KEY || "",
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
      spicyLyricsPublishableKey,
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
    hasSpicyLyricsPublishableKey = false,
    hasSpotifyTrackId = false,
    track = null,
  } = {},
) {
  const hasSpicy = hasSpicyLyricsPublishableKey && hasSpotifyTrackId;
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
    ? ["lrc-red", "kugou", ...coreSources, ...(hasSpicy ? ["spicy-lyrics"] : [])]
    : ["lrc-red", "kugou", ...(hasSpicy ? ["spicy-lyrics"] : []), ...coreSources];
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
    if (
      !isSpicyKaraokeSource(result.source) &&
      !source.includes("local-vault") &&
      !source.includes("lrc-red")
    ) {
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
  if (source.includes("lrc-red-line") || source.includes("spicy-lyrics-line")) {
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
  if (source.includes("lrc-red-karaoke")) {
    return 700;
  }
  if (source.includes("lrc-red-line")) {
    return 370;
  }
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

function isSpicyStaticSource(sourceLabel) {
  return String(sourceLabel || "")
    .toLowerCase()
    .includes("spicy-lyrics-static");
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

function isValidLyricsCandidate(track, candidate) {
  if (!candidate?.lyrics?.length || spicyLyricsFailFeaturedVariantCheck(track, candidate)) return false;
  if (String(candidate.source || "").includes("local-vault")) return true;
  if (isSpicyStaticSource(candidate.source)) return true;
  return candidate.lyrics.every(line =>
    Number.isFinite(line?.lineStartTime) && Number.isFinite(line?.lineEndTime) &&
    line.lineStartTime >= 0 && line.lineEndTime >= line.lineStartTime);
}

function shouldUpgradeLyricsCandidate(track, currentBest, candidate) {
  if (!isValidLyricsCandidate(track, candidate)) return false;
  if (currentBest?.lyrics?.length && spicyLyricsFailFeaturedVariantCheck(track, currentBest)) return true;
  return require("./lyricsAutoPicker").shouldPreferAutoCandidate(track, currentBest, candidate);
}

async function fetchBestSyncedLyrics(
  track,
  {
    preferredSource = "auto",
    onProgress = null,
    onSourceCached = null,
    sourceCache = null,
    musixmatchUserToken = "",
    refreshMusixmatchUserToken = null,
    spotifyWebToken = "",
    spicyLyricsPublishableKey = process.env.SPICY_LYRICS_PUBLISHABLE_KEY || "",
    spotifyAccessToken = "",
    waitForAutoCompletion = false,
    autoSourceTimeoutMs = 3000,
    onAutoComplete = null,
    onAutoSettled = null,
  } = {},
) {
  const failures = [];
  let safeMusixmatchUserToken = String(musixmatchUserToken || "").trim();
  const safeSpotifyWebToken = String(spotifyWebToken || "").trim();
  const safeSpotifyAccessToken = String(spotifyAccessToken || "").trim();
  const hasSpotifyTrackId = Boolean(String(track?.spotifyTrackId || "").trim());
  const attemptOrder = getSourceAttemptOrder(preferredSource, {
    hasMusixmatchUserToken: Boolean(safeMusixmatchUserToken),
    hasSpotifyWebToken:
      Boolean(safeSpotifyWebToken) || Boolean(safeSpotifyAccessToken),
    hasSpotifyTrackId,
    hasSpicyLyricsPublishableKey: /^sl_pk_\S+$/.test(String(spicyLyricsPublishableKey || "").trim()),
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
          if (isValidLyricsCandidate(track, finalizedVault)) {
            if (typeof sourceCache?.set === "function") {
              sourceCache.set("local-vault", finalizedVault);
            }
            if (typeof onSourceCached === "function") {
              onSourceCached(finalizedVault, "local-vault");
            }
            if (preferred === "auto") { onAutoComplete?.(); onAutoSettled?.(); }
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
    if (preferred === "auto") { onAutoComplete?.(); onAutoSettled?.(); }
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

  const invokeSourceFetcher = async (source, fetcher) => {
    const fetchWithCurrentToken = () =>
      fetcher(track, {
        musixmatchUserToken: safeMusixmatchUserToken,
        spotifyWebToken: safeSpotifyWebToken,
        spotifyAccessToken: safeSpotifyAccessToken,
        spicyLyricsPublishableKey,
      });
    try {
      return await fetchWithCurrentToken();
    } catch (error) {
      if (
        source !== "musixmatch" ||
        describeSourceError(error) !== "unauthorized" ||
        typeof refreshMusixmatchUserToken !== "function"
      ) {
        throw error;
      }
      const refreshedToken = String(
        (await refreshMusixmatchUserToken(safeMusixmatchUserToken)) || "",
      ).trim();
      if (!refreshedToken || refreshedToken === safeMusixmatchUserToken) {
        throw error;
      }
      safeMusixmatchUserToken = refreshedToken;
      return fetchWithCurrentToken();
    }
  };

  if (preferred === "auto") {
    const { autoCandidateCouldOutrank } = require("./lyricsAutoPicker");
    const cachedDecision = sourceCache?.get?.("auto");
    if (cachedDecision?.lyrics?.length && isValidLyricsCandidate(track, cachedDecision)) {
      onAutoComplete?.();
      onAutoSettled?.();
      return cachedDecision;
    }
    const pending = new Set(apiAttemptOrder);
    const boundedPending = new Set(apiAttemptOrder);
    const outcomes = new Map();
    const timers = new Map();
    let best = null;
    let allStarted = false;
    let initialResolved = false;
    let completionResolved = false;
    let finalCached = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      onAutoSettled?.();
    };
    let resolveInitial, resolveCompletion;
    const initialResult = new Promise(resolve => { resolveInitial = resolve; });
    const completionResult = new Promise(resolve => { resolveCompletion = resolve; });
    const unavailable = () => {
      const completed = [...outcomes.values()];
      const instrumental = completed.find(outcome => outcome.instrumental);
      return instrumental
        ? { lyrics: [], source: `${instrumental.source}-instrumental`, metadata: { ...(instrumental.result?.metadata || {}), instrumental: true } }
        : { lyrics: [], source: completed.map(outcome => outcome.failureReason).filter(Boolean).join(" | ") || "lyrics-unavailable" };
    };
    const complete = result => {
      if (completionResolved) return;
      completionResolved = true;
      for (const timer of timers.values()) clearTimeout(timer);
      resolveCompletion(result);
      onAutoComplete?.();
    };
    const consider = candidate => {
      if (!shouldUpgradeLyricsCandidate(track, best, candidate)) return;
      best = candidate;
      // First usable lyrics are delivered immediately; pending superior sources
      // affect finalization only, and may publish a later guarded upgrade.
      if (typeof onProgress === "function") onProgress(best);
      if (!initialResolved) { initialResolved = true; resolveInitial(best); }
    };
    const maybeFinalize = () => {
      if (!allStarted) return;
      const pendingWinner = best && [...pending].some(source => autoCandidateCouldOutrank(track, best, source));
      if (best && !pendingWinner) {
        const transientSuperiorFailure = [...outcomes.values()].some(outcome => !outcome.ok &&
          !outcome.instrumental && outcome.failureReason !== `${outcome.source}:no-match` &&
          autoCandidateCouldOutrank(track, best, outcome.source));
        if (!finalCached && !transientSuperiorFailure) {
          finalCached = true;
          sourceCache?.set?.("auto", best);
        }
        complete(best);
        settle();
      }
      if (!boundedPending.size) {
        const result = best || unavailable();
        if (!initialResolved) { initialResolved = true; resolveInitial(result); }
        complete(result);
      }
      if (!pending.size) settle();
    };
    // Every eligible fetch is scheduled before considering any completion.
    for (const source of apiAttemptOrder) {
      let timer;
      const timeoutMs = source === "lrc-red" || source === "spicy-lyrics"
        ? autoSourceTimeoutMs : Math.max(autoSourceTimeoutMs, 15_000);
      timer = setTimeout(() => {
        boundedPending.delete(source);
        outcomes.set(source, { source, ok: false, timedOut: true, failureReason: `${source}:timeout` });
        // Keep the raw source pending: a late possible winner must not poison
        // the final cache, and may still upgrade while this auto run is active.
        maybeFinalize();
      }, timeoutMs);
      timers.set(source, timer);
      Promise.resolve().then(async () => {
        const fetcher = SOURCE_FETCHERS[source];
        if (typeof fetcher !== "function") return { source, ok: false, failureReason: `${source}:unknown-source` };
        const cached = sourceCache?.get?.(source);
        if (cached?.lyrics?.length && isValidLyricsCandidate(track, cached)) return { source, ok: true, result: cached };
        try {
          const result = await invokeSourceFetcher(source, fetcher);
          if (!result) return { source, ok: false, failureReason: `${source}:no-match` };
          if (result.metadata?.instrumental && !result.lyrics?.length) return { source, ok: false, result, instrumental: true, failureReason: `${source}:instrumental` };
          const candidate = await finalizeFetchedLyricsResult(result);
          if (!isValidLyricsCandidate(track, candidate)) return { source, ok: false, failureReason: `${source}:invalid-candidate` };
          cacheSourceResult(source, candidate);
          return { source, ok: true, result: candidate };
        } catch (error) { return { source, ok: false, failureReason: classifySourceFailure(source, error) }; }
      }).then(outcome => {
        clearTimeout(timer);
        pending.delete(source);
        boundedPending.delete(source);
        outcomes.set(source, outcome);
        if (outcome.ok) consider(outcome.result);
        maybeFinalize();
      });
    }
    allStarted = true;
    maybeFinalize();
    return waitForAutoCompletion ? completionResult : initialResult;
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
      const result = await invokeSourceFetcher(source, fetcher);
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
        if (isValidLyricsCandidate(track, finalized)) {
          cacheSourceResult(source, finalized);
          return finalized;
        }
        failures.push(`${source}:invalid-candidate`);
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
  if (track?.spotifyTrackId || !spotifyAccessToken || !track?.title || !track?.artist) return track;
  try {
    const resolved = await resolveSpotifyCatalogTrackViaPartnerSearch(
      { ...track, durationMs: 0 }, spotifyAccessToken, { enrichFromWebApi: false, strictImportMatch: true },
    );
    return resolved?.id ? { ...track, spotifyTrackId: resolved.id } : track;
  } catch { return track; }
}
