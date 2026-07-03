"use strict";

// Netease, Spicy Lyrics, and LRCLib source adapters.
// This file is evaluated by ../index.js in a shared compatibility context.
// Keep behavior changes deliberate; most code here was moved verbatim from src/lyricsService.js.

async function fetchFromNetease(track) {
  const queryVariants = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  const rawSongs = [];

  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        const payload = await fetchNeteaseJson("/search", {
          params: {
            keywords: query,
            type: 1,
            limit: 30,
          },
          timeoutMs: 10_000,
        });
        const songs = Array.isArray(payload?.result?.songs)
          ? payload.result.songs
          : [];
        rawSongs.push(...songs);
      } catch {
        // Try next query variant.
      }
    }),
  );

  if (!rawSongs.length) {
    return null;
  }

  const deduped = [];
  const seen = new Set();
  for (const song of rawSongs) {
    const id = Number(song?.id || 0);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(song);
  }

  const ranked = deduped
    .map((song) => {
      const title = String(song?.name || song?.title || "").trim();
      const artist = Array.isArray(song?.artists)
        ? song.artists.map((entry) => entry?.name || "").join(" ")
        : String(song?.artist || "").trim();
      let score = scoreCandidate(track, title, artist);
      const durationMs = Number(song?.duration || song?.dt || 0);
      score += scoreDurationBonus(track, title, artist, durationMs);
      return { song, score, title, artist, durationMs };
    })
    .sort((a, b) => b.score - a.score);

  if (!ranked.length || isAmbiguousTopMatch(ranked)) {
    return null;
  }

  let bestResult = null;
  let bestScore = -1;
  const likelyNeteaseCandidates = ranked
    .filter((candidate) =>
      isLikelySameTrack(
        track,
        candidate.title,
        candidate.artist,
        candidate.durationMs,
      ),
    )
    .sort((left, right) => compareCandidateMatchQuality(track, left, right))
    .slice(0, 8);

  for (const candidate of likelyNeteaseCandidates) {
    try {
      const lyricPayload = await fetchNeteaseJson("/lyric/new", {
        params: {
          id: candidate.song.id,
        },
        timeoutMs: 10_000,
      });
      const karaokeText =
        lyricPayload?.yrc?.lyric ||
        lyricPayload?.klyric?.lyric ||
        lyricPayload?.data?.yrc?.lyric ||
        lyricPayload?.data?.klyric?.lyric ||
        "";
      const karaokeLyrics = stripLeadingMetadataLines(
        parseNeteaseYrc(cleanNeteaseSpacing(karaokeText)),
        track,
      );
      if (karaokeLyrics.length) {
        const coverage = scoreLyricsCoverage(karaokeLyrics, track.durationMs);
        const coverageRatio = getLyricsCoverageRatio(
          karaokeLyrics,
          track.durationMs,
        );
        if (coverage > bestScore) {
          bestScore = coverage;
          bestResult = { lyrics: karaokeLyrics, source: "netease-yrc" };
        }
        if (
          candidate.score >= MATCH_CONFIDENCE_SCORE &&
          coverageRatio >= EARLY_RETURN_COVERAGE_RATIO
        ) {
          return { lyrics: karaokeLyrics, source: "netease-yrc" };
        }
        continue;
      }

      const rawTimedLyrics =
        lyricPayload?.lrc?.lyric ||
        lyricPayload?.data?.lrc?.lyric ||
        lyricPayload?.lyric ||
        "";
      const lyrics = stripLeadingMetadataLines(
        parseLrc(cleanNeteaseSpacing(rawTimedLyrics)),
        track,
      );
      if (lyrics.length) {
        const coverage = scoreLyricsCoverage(lyrics, track.durationMs);
        if (coverage > bestScore) {
          bestScore = coverage;
          bestResult = { lyrics, source: "netease-lrc" };
        }
      }
    } catch {
      // Try next candidate.
    }
  }

  return bestResult;
}

async function resolveQqReferenceFingerprint(track) {
  if (!shouldUseQqFingerprintForSpicyVariantCheck(track)) {
    return "";
  }
  let timeoutHandle = null;
  const fetchFingerprint = async () => {
    try {
      const qqResult = await fetchFromQQDirect(track);
      if (!qqResult?.lyrics?.length) {
        return "";
      }
      return buildLyricsContentFingerprint(qqResult.lyrics, track);
    } catch {
      return "";
    }
  };
  try {
    return await Promise.race([
      fetchFingerprint(),
      new Promise((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve(""),
          SPICY_QQ_FINGERPRINT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function createSpicyFetchProfiler() {
  const enabled = ["1", "true", "yes", "on"].includes(
    String(process.env.SPICY_PROFILE || "").trim().toLowerCase(),
  );
  if (!enabled) {
    return {
      mark() {},
      finish() {
        return null;
      },
    };
  }
  const startedAt = Date.now();
  let lastAt = startedAt;
  const steps = [];
  return {
    mark(step, meta = {}) {
      const now = Date.now();
      steps.push({
        step,
        elapsedMs: now - lastAt,
        totalMs: now - startedAt,
        ...meta,
      });
      lastAt = now;
    },
    finish(meta = {}) {
      const summary = {
        steps,
        totalMs: Date.now() - startedAt,
        ...meta,
      };
      console.log("[spicy-profile]", JSON.stringify(summary));
      return summary;
    },
  };
}

async function fetchFromSpicyLyrics(
  track,
  { spotifyWebToken = "", spotifyAccessToken = "" } = {},
) {
  const profile = createSpicyFetchProfiler();
  let accessToken = "";
  const oauthToken = String(spotifyAccessToken || "").trim();
  if (oauthToken) {
    accessToken = oauthToken;
    profile.mark("1-token-resolve", { path: "oauth" });
  } else {
    try {
      accessToken = await getSpotifyWebAccessToken(spotifyWebToken);
      profile.mark("1-token-resolve", { path: "web-token-exchange" });
    } catch (error) {
      profile.finish({
        ok: false,
        failedStep: "1-token-resolve",
        error: error instanceof Error ? error.message : String(error),
      });
      throw createSourceStageError("spicy", "spotify-token", error);
    }
  }

  spicyDebugLog("Spicy source token resolved", {
    hasOAuthToken: Boolean(oauthToken),
    hasLegacySpotifyWebToken: Boolean(String(spotifyWebToken || "").trim()),
    accessTokenPreview: maskTokenPreview(accessToken),
    track: {
      trackId: String(track?.trackId || ""),
      spotifyTrackId: String(track?.spotifyTrackId || ""),
      title: String(track?.title || ""),
      artist: String(track?.artist || ""),
      durationMs: Number(track?.durationMs || 0),
    },
  });

  const directSpotifyId = String(track?.spotifyTrackId || "").trim();
  let spotifyTrackIds = [];
  let idResolvePath = directSpotifyId ? "direct-spotify-track-id" : "unknown";
  if (directSpotifyId) {
    spotifyTrackIds = [directSpotifyId];
    profile.mark("2-spotify-id-resolve", {
      path: idResolvePath,
      candidateCount: spotifyTrackIds.length,
    });
  } else {
    let strictSearchError = null;
    const strictSearchStartedAt = Date.now();
    let strictSearchIds = [];
    try {
      strictSearchIds = await searchSpotifyTrackCandidatesStrictForSpicy(
        track,
        accessToken,
      );
    } catch (error) {
      strictSearchError = error;
    }
    profile.mark("2a-strict-spotify-search", {
      candidateCount: strictSearchIds.length,
      elapsedMs: Date.now() - strictSearchStartedAt,
    });
    if (strictSearchIds.length) {
      spotifyTrackIds = strictSearchIds;
      idResolvePath = "strict-search";
    } else {
      const partnerSearchStartedAt = Date.now();
      let partnerCatalogMatch = null;
      let partnerSearchError = null;
      try {
        partnerCatalogMatch = await resolveSpotifyCatalogTrackViaPartnerSearch(
          track,
          accessToken,
        );
      } catch (error) {
        partnerSearchError = error;
      }
      profile.mark("2b-partner-catalog-search", {
        foundId: Boolean(partnerCatalogMatch?.id),
        elapsedMs: Date.now() - partnerSearchStartedAt,
      });
      if (partnerCatalogMatch?.id) {
        spotifyTrackIds = [partnerCatalogMatch.id];
        idResolvePath = "partner-catalog-search";
      } else if (strictSearchError) {
        profile.finish({
          ok: false,
          failedStep: "2a-strict-spotify-search",
          idResolvePath,
          error:
            strictSearchError instanceof Error
              ? strictSearchError.message
              : String(strictSearchError),
        });
        throw createSourceStageError(
          "spicy",
          "spotify-track-lookup",
          strictSearchError,
        );
      } else if (partnerSearchError) {
        profile.finish({
          ok: false,
          failedStep: "2b-partner-catalog-search",
          idResolvePath,
          error:
            partnerSearchError instanceof Error
              ? partnerSearchError.message
              : String(partnerSearchError),
        });
        throw createSourceStageError(
          "spicy",
          "spotify-track-lookup",
          partnerSearchError,
        );
      }
    }
    profile.mark("2-spotify-id-resolve", {
      path: idResolvePath,
      candidateCount: spotifyTrackIds.length,
    });
    if (!spotifyTrackIds.length) {
      profile.finish({ ok: false, failedStep: "2-spotify-id-resolve" });
      throw createSourceStageNoMatchError("spicy", "spotify-track-lookup");
    }
  }

  spicyDebugLog("Spicy source candidate Spotify IDs", {
    directSpotifyId,
    spotifyTrackIds,
  });

  let bestResult = null;
  let lastHardError = null;
  let lastNoMatchError = null;
  let qqReferenceFingerprintPromise = null;
  const getQqReferenceFingerprintLazy = () => {
    if (!shouldUseQqFingerprintForSpicyVariantCheck(track)) {
      return Promise.resolve("");
    }
    if (!qqReferenceFingerprintPromise) {
      qqReferenceFingerprintPromise = resolveQqReferenceFingerprint(track);
    }
    return qqReferenceFingerprintPromise;
  };

  for (const [candidateIndex, spotifyTrackId] of spotifyTrackIds.entries()) {
    let queryResults = null;
    const queryStartedAt = Date.now();
    try {
      queryResults = await fetchSpicyLyricsQueryWithQueueRetry(
        [
          {
            operation: "lyrics",
            variables: buildSpicyLyricsQueryVariables(spotifyTrackId),
          },
        ],
        {
          "SpicyLyrics-WebAuth": `Bearer ${accessToken}`,
        },
        {
          expectedOperation: "lyrics",
          expectedOperationId: "0",
          expectedTrackId: spotifyTrackId,
        },
      );
    } catch (error) {
      profile.mark(`3-spicy-api-query#${candidateIndex + 1}`, {
        spotifyTrackId,
        ok: false,
        elapsedMs: Date.now() - queryStartedAt,
      });
      lastHardError = createSourceStageError("spicy", "backend", error);
      continue;
    }
    profile.mark(`3-spicy-api-query#${candidateIndex + 1}`, {
      spotifyTrackId,
      ok: true,
      elapsedMs: Date.now() - queryStartedAt,
    });

    const parseStartedAt = Date.now();
    const lyricQueryResult = selectSpicyQueryResult(queryResults, {
      expectedOperation: "lyrics",
      expectedOperationId: "0",
      expectedTrackId: spotifyTrackId,
    });
    const firstResult = lyricQueryResult?.result || null;
    if (!firstResult || Number(firstResult.httpStatus || 0) === 404) {
      lastNoMatchError = createSourceStageNoMatchError("spicy", "backend");
      continue;
    }
    if (Number(firstResult.httpStatus || 0) !== 200) {
      const httpStatus = Number(firstResult.httpStatus || 0);
      const errorMessage =
        httpStatus === 503
          ? "Spicy Lyrics query is still queued (HTTP 503)."
          : `Spicy Lyrics query failed with status ${
              httpStatus || "unknown"
            }.`;
      lastHardError = createSourceStageError(
        "spicy",
        "backend",
        new Error(errorMessage),
      );
      continue;
    }
    if (!hasSpicyLyricsQueryPayload(firstResult)) {
      lastHardError = createSourceStageError(
        "spicy",
        "backend",
        new Error(
          `Spicy Lyrics returned empty or unsupported payload (format=${String(
            firstResult.format || "unknown",
          )}).`,
        ),
      );
      continue;
    }

    const rawSpicyData = firstResult.data;
    const wasPacked = isSpicyObjPackPayload(rawSpicyData);
    let spicyLyricsData = null;
    try {
      spicyLyricsData = normalizeSpicyLyricsQueryData(rawSpicyData);
    } catch (error) {
      profile.mark(`4-unpack-lyrics#${candidateIndex + 1}`, {
        spotifyTrackId,
        packed: wasPacked,
        ok: false,
        elapsedMs: Date.now() - parseStartedAt,
      });
      lastHardError = createSourceStageError("spicy", "backend", error);
      continue;
    }
    spicyDebugLog("Spicy source first query result", {
      spotifyTrackId,
      operationId: String(lyricQueryResult?.operationId || ""),
      operation: String(lyricQueryResult?.operation || ""),
      httpStatus: Number(firstResult.httpStatus || 0),
      format: String(firstResult.format || ""),
      packed: wasPacked,
      payload: summarizeSpicyPayload(spicyLyricsData || rawSpicyData),
    });

    const sourceLabel = getSpicySourceLabel(
      spicyLyricsData,
      track?.durationMs || 0,
    );

    const lyrics = parseSpicyLyrics(spicyLyricsData, track?.durationMs || 0);
    profile.mark(`4-parse-lyrics#${candidateIndex + 1}`, {
      spotifyTrackId,
      lineCount: lyrics.length,
      elapsedMs: Date.now() - parseStartedAt,
    });
    if (!lyrics.length) {
      lastNoMatchError = createSourceStageNoMatchError(
        "spicy",
        "payload-parse",
      );
      continue;
    }
    const songwriters = extractSpicySongwriters(spicyLyricsData);
    const spicyMetadata = extractSpicyPayloadMetadata(spicyLyricsData);
    const declaredTitleMatch = spicyDeclaredTitlesMatchPlayback(
      track,
      spicyMetadata.titles,
    );
    const variantStartedAt = Date.now();
    if (
      featuredVariantLyricsMismatch(track, lyrics, {
        source: "spicy",
        spicyDeclaredTitles: spicyMetadata.titles,
      })
    ) {
      profile.mark(`5-variant-heuristics#${candidateIndex + 1}`, {
        spotifyTrackId,
        declaredTitleMatch,
        mismatch: true,
        elapsedMs: Date.now() - variantStartedAt,
      });
      spicyDebugLog("Spicy source rejected feat/variant lyrics mismatch", {
        spotifyTrackId,
        title: String(track?.title || ""),
        spicyVariantTitles: spicyMetadata.titles,
        spicyFingerprintPreview: buildLyricsContentFingerprint(lyrics, track).slice(
          0,
          160,
        ),
      });
      lastNoMatchError = createSourceStageNoMatchError(
        "spicy",
        "featured-variant-mismatch",
      );
      continue;
    }
    profile.mark(`5-variant-heuristics#${candidateIndex + 1}`, {
      spotifyTrackId,
      declaredTitleMatch,
      mismatch: false,
      elapsedMs: Date.now() - variantStartedAt,
    });
    let qqReferenceFingerprint = "";
    if (
      shouldUseQqFingerprintForSpicyVariantCheck(track) &&
      declaredTitleMatch !== true
    ) {
      const qqStartedAt = Date.now();
      qqReferenceFingerprint = await getQqReferenceFingerprintLazy();
      profile.mark(`6-qq-fingerprint#${candidateIndex + 1}`, {
        spotifyTrackId,
        ran: true,
        hasFingerprint: Boolean(qqReferenceFingerprint),
        elapsedMs: Date.now() - qqStartedAt,
      });
      if (
        qqReferenceFingerprint &&
        !lyricsContentFingerprintsMatch(
          qqReferenceFingerprint,
          buildLyricsContentFingerprint(lyrics, track),
        )
      ) {
        spicyDebugLog("Spicy source rejected QQ fingerprint mismatch", {
          spotifyTrackId,
          title: String(track?.title || ""),
          qqReferenceFingerprintPreview: String(qqReferenceFingerprint || "").slice(
            0,
            160,
          ),
          spicyFingerprintPreview: buildLyricsContentFingerprint(
            lyrics,
            track,
          ).slice(0, 160),
        });
        lastNoMatchError = createSourceStageNoMatchError(
          "spicy",
          "featured-variant-mismatch",
        );
        continue;
      }
    } else {
      profile.mark(`6-qq-fingerprint#${candidateIndex + 1}`, {
        spotifyTrackId,
        ran: false,
        skippedReason:
          declaredTitleMatch === true
            ? "declared-titles-matched"
            : "not-required",
      });
    }

    const candidate = {
      lyrics,
      source: sourceLabel,
      metadata: {
        ...(songwriters.length ? { credits: { songwriters } } : {}),
        ...(spicyMetadata.titles.length
          ? { spicyVariantTitles: spicyMetadata.titles }
          : {}),
        ...(qqReferenceFingerprint
          ? { qqReferenceFingerprint }
          : {}),
      },
    };
    if (!Object.keys(candidate.metadata).length) {
      candidate.metadata = undefined;
    }
    spicyDebugLog("Spicy source parsed candidate", {
      spotifyTrackId,
      source: candidate.source,
      lineCount: Array.isArray(candidate.lyrics) ? candidate.lyrics.length : 0,
      coverageRatio: getLyricsCoverageRatio(
        candidate.lyrics,
        track?.durationMs || 0,
      ),
      firstLinePreview:
        Array.isArray(candidate.lyrics) && candidate.lyrics[0]
          ? String(
              (candidate.lyrics[0].syllables || [])
                .map((part) => part.text || "")
                .join(""),
            ).slice(0, 120)
          : "",
    });

    if (
      !bestResult ||
      shouldUpgradeLyricsCandidate(track, bestResult, candidate)
    ) {
      bestResult = candidate;
    }
    if (getLyricsTimingTier(candidate.source) >= 3) {
      break;
    }
  }

  if (bestResult?.lyrics?.length) {
    profile.finish({
      ok: true,
      source: bestResult.source,
      lineCount: bestResult.lyrics.length,
      idResolvePath,
      candidateCount: spotifyTrackIds.length,
    });
    return bestResult;
  }
  profile.finish({
    ok: false,
    idResolvePath,
    candidateCount: spotifyTrackIds.length,
    lastHardError: lastHardError?.message || null,
    lastNoMatchError: lastNoMatchError?.message || null,
  });
  if (lastHardError) {
    throw lastHardError;
  }
  if (lastNoMatchError) {
    throw lastNoMatchError;
  }
  throw createSourceStageNoMatchError("spicy", "backend");
}

async function fetchFromLrcLib(track) {
  const endpoints = [
    { url: "https://lrclib.net/api/search", mode: "search" },
    { url: "https://www.lrclib.net/api/search", mode: "search" },
    { url: "https://lrclib.net/api/get", mode: "get" },
    { url: "https://www.lrclib.net/api/get", mode: "get" },
  ];
  const rawTitle = String(track?.title || "").trim();
  const rawArtist = String(track?.artist || "").trim();
  const titleWithoutCommonSuffix = rawTitle
    .replace(/\s*[-:|]\s*(single|ep|album|ost|soundtrack)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const titleWithoutBrackets = rawTitle
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const primaryArtist = getPrimaryArtistName(rawArtist);
  const artistWithoutBrackets = rawArtist
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const titleVariants = [];
  const seenTitle = new Set();
  for (const value of [
    rawTitle,
    titleWithoutBrackets,
    titleWithoutCommonSuffix,
  ]) {
    const safe = String(value || "").trim();
    const key = safe.toLowerCase();
    if (!safe || seenTitle.has(key)) {
      continue;
    }
    seenTitle.add(key);
    titleVariants.push(safe);
  }

  const parenthesizedArtistTokens = Array.from(
    rawArtist.matchAll(/\(([^)]+)\)|\[([^\]]+)\]|\{([^}]+)\}/g),
  )
    .map((match) => (match[1] || match[2] || match[3] || "").trim())
    .filter(Boolean)
    .flatMap((value) =>
      value
        .split(/[,&/|]+/)
        .map((token) => token.trim())
        .filter(Boolean),
    );

  const artistVariants = [];
  const seenArtist = new Set();
  for (const value of [
    rawArtist,
    primaryArtist,
    artistWithoutBrackets,
    ...buildMusixmatchArtistVariants(rawArtist),
    ...parenthesizedArtistTokens,
  ]) {
    const safe = String(value || "").trim();
    const key = safe.toLowerCase();
    if (!safe || seenArtist.has(key)) {
      continue;
    }
    seenArtist.add(key);
    artistVariants.push(safe);
  }

  const queryVariants = [];
  const seenQuery = new Set();
  for (const title of titleVariants) {
    for (const artist of artistVariants) {
      const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
      if (seenQuery.has(key)) {
        continue;
      }
      seenQuery.add(key);
      queryVariants.push({ track_name: title, artist_name: artist });
    }
    const titleOnlyKey = `${title.toLowerCase()}|`;
    if (!seenQuery.has(titleOnlyKey)) {
      seenQuery.add(titleOnlyKey);
      queryVariants.push({ track_name: title });
    }
  }

  const candidates = [];
  const seenCandidates = new Set();
  let lastError = null;
  let sawSuccessfulResponse = false;
  let sawNotFoundResponse = false;

  for (const endpoint of endpoints) {
    for (const params of queryVariants) {
      try {
        const payload = await fetchJsonWithRetry(
          endpoint.url,
          {
            params,
            timeoutMs: 12_000,
            headers: {
              Accept: "application/json",
              "User-Agent":
                "KineSyncDesktopBridge/1.0 (+https://github.com)",
            },
          },
          { attempts: 3, backoffMs: 500 },
        );
        sawSuccessfulResponse = true;
        const batch =
          endpoint.mode === "get" ? (payload ? [payload] : []) : payload;
        for (const item of Array.isArray(batch) ? batch : []) {
          const key = `${String(item?.id || "")}|${normalizeText(
            item?.trackName || item?.name || "",
          )}|${normalizeText(item?.artistName || "")}|${String(
            item?.durationMs || item?.duration || "",
          )}`;
          if (!key || seenCandidates.has(key)) {
            continue;
          }
          seenCandidates.add(key);
          candidates.push(item);
        }
      } catch (error) {
        const message = String(error?.message || "").toLowerCase();
        if (message.includes("http 404")) {
          sawNotFoundResponse = true;
          continue;
        }
        lastError = error;
      }
    }
  }

  if (
    !candidates.length &&
    !sawSuccessfulResponse &&
    !sawNotFoundResponse &&
    lastError
  ) {
    throw lastError || new Error("Failed to reach LrcLib API");
  }

  const ranked = candidates
    .map((item) => ({
      item,
      score: scoreCandidate(
        track,
        item?.trackName || item?.name || "",
        item?.artistName || "",
      ),
    }))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length || isAmbiguousTopMatch(ranked)) {
    return null;
  }

  const lrclibMinScore = Math.max(3.5, MATCH_ACCEPTANCE_THRESHOLD - 1);
  const likelyLrcLibCandidates = ranked
    .filter(
      (candidate) =>
        candidate.score >= lrclibMinScore &&
        isLikelySameTrack(
          track,
          candidate.item?.trackName || candidate.item?.name || "",
          candidate.item?.artistName || "",
          (() => {
            const raw = Number(
              candidate.item?.durationMs || candidate.item?.duration || 0,
            );
            if (!Number.isFinite(raw) || raw <= 0) {
              return 0;
            }
            return raw < 10_000 ? raw * 1000 : raw;
          })(),
        ),
    )
    .slice(0, 8);

  for (const candidate of likelyLrcLibCandidates) {
    if (
      candidate.item?.instrumental === true ||
      String(candidate.item?.instrumental || "").toLowerCase() === "true"
    ) {
      return {
        lyrics: [],
        source: "lrclib-instrumental",
        metadata: { instrumental: true },
      };
    }
    if (!candidate.item?.syncedLyrics) {
      continue;
    }
    const lyrics = parseLrc(candidate.item.syncedLyrics);
    if (lyrics.length) {
      return { lyrics, source: "lrclib-fallback" };
    }
  }
  return null;
}

async function previewNeteaseSearchCandidates(track) {
  const queryVariants = buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS);
  const rawSongs = [];

  await Promise.all(
    queryVariants.map(async (query) => {
      try {
        const payload = await fetchNeteaseJson("/search", {
          params: {
            keywords: query,
            type: 1,
            limit: 30,
          },
          timeoutMs: 10_000,
        });
        const songs = Array.isArray(payload?.result?.songs)
          ? payload.result.songs
          : [];
        rawSongs.push(...songs);
      } catch {
        // Try next query variant.
      }
    }),
  );

  const deduped = [];
  const seen = new Set();
  for (const song of rawSongs) {
    const id = Number(song?.id || 0);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(song);
  }

  return deduped
    .map((song) => {
      const title = String(song?.name || song?.title || "").trim();
      const artist = Array.isArray(song?.artists)
        ? song.artists.map((entry) => entry?.name || "").join(" ")
        : String(song?.artist || "").trim();
      let score = scoreCandidate(track, title, artist);
      const durationMs = Number(song?.duration || song?.dt || 0);
      score += scoreDurationBonus(track, title, artist, durationMs);
      return { title, artist, score, durationMs, songId: Number(song?.id || 0) };
    })
    .sort((a, b) => b.score - a.score);
}
