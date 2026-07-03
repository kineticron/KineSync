"use strict";
function createLyricsService({
  getMusixmatchUserToken = () => process.env.MUSIXMATCH_USER_TOKEN || "",
  getSpotifyWebToken = () => process.env.SPOTIFY_WEB_TOKEN || "",
  getGeminiApiKey = () =>
    process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY || "",
  getSpotifyAccessToken = () => "",
  getSpicyLyricsUseCorsProxy = null,
} = {}) {
  setSpicyLyricsNetworkOptions({ getSpicyLyricsUseCorsProxy });
  const lastDisplayedByTrack = new Map();
  const geminiTranslationCache = new Map();
  const publishedToFrontendCache = new Map();
  const activeTrackSourceCache = {
    trackId: "",
    bySource: new Map(),
  };
  const AUTO_TRANSLATION_QUIET_MS = 5_000;

  const stripDesktopSourceSuffix = (source) =>
    String(source || "")
      .replace(/\|desktop$/i, "")
      .trim();

  /** Map fetcher-specific labels (e.g. qq-musicu-qrc) to Expo/bridge source keys (qq-direct). */
  const canonicalSourceCacheKey = (source) => {
    const stripped = stripDesktopSourceSuffix(source).replace(
      /-instrumental$/i,
      "",
    );
    if (!stripped) {
      return "";
    }
    const aliased = normalizeSourceKey(stripped);
    if (VALID_SOURCE_KEYS.has(aliased) && aliased !== "auto") {
      return aliased;
    }
    const lower = stripped.toLowerCase();
    if (lower.includes("qq")) {
      return "qq-direct";
    }
    if (lower.includes("netease") || lower === "163") {
      return "netease";
    }
    if (lower.includes("musixmatch") || lower === "mxm") {
      return "musixmatch";
    }
    if (lower.includes("lrclib")) {
      return "lrclib";
    }
    if (lower.includes("spicy")) {
      return "spicy-lyrics";
    }
    if (lower.includes("kugou")) {
      return "kugou";
    }
    if (lower.includes("local-vault")) {
      return "local-vault";
    }
    const preferred = sanitizePreferredSource(stripped);
    return preferred === "auto" ? "" : preferred;
  };

  const hasTranslatedLinesInLyrics = (lyrics) =>
    Array.isArray(lyrics) &&
    lyrics.some((line) => String(line?.translatedText || "").trim().length > 0);

  const packetLyricsSignature = (packet) => {
    const lyrics = Array.isArray(packet?.lyrics) ? packet.lyrics : [];
    const first = lyrics[0];
    const last = lyrics[lyrics.length - 1];
    return [
      lyrics.length,
      Number(first?.lineStartTime || -1),
      Number(last?.lineEndTime || -1),
    ].join("|");
  };

  const cloneSourceCachePacket = (basePacket) => {
    const safeLyrics = Array.isArray(basePacket?.lyrics)
      ? basePacket.lyrics.map((line) =>
          line && typeof line === "object"
            ? JSON.parse(JSON.stringify(line))
            : line,
        )
      : [];
    if (basePacket?.lyrics?.translationMeta) {
      safeLyrics.translationMeta = JSON.parse(
        JSON.stringify(basePacket.lyrics.translationMeta),
      );
    }
    return {
      source:
        stripDesktopSourceSuffix(basePacket?.source) ||
        String(basePacket?.source || "desktop-bridge"),
      metadata:
        basePacket?.metadata && typeof basePacket.metadata === "object"
          ? JSON.parse(JSON.stringify(basePacket.metadata))
          : {},
      lyrics: safeLyrics,
      statusMessage: String(basePacket?.statusMessage || ""),
    };
  };

  const setActiveTrack = (trackId) => {
    const cacheKey = String(trackId || "").trim();
    if (!cacheKey) {
      activeTrackSourceCache.trackId = "";
      activeTrackSourceCache.bySource = new Map();
      return;
    }
    if (activeTrackSourceCache.trackId === cacheKey) {
      return;
    }
    activeTrackSourceCache.trackId = cacheKey;
    activeTrackSourceCache.bySource = new Map();
    for (const publishedTrackId of [...publishedToFrontendCache.keys()]) {
      if (publishedTrackId !== cacheKey) {
        publishedToFrontendCache.delete(publishedTrackId);
      }
    }
    for (const displayedTrackId of [...lastDisplayedByTrack.keys()]) {
      if (displayedTrackId !== cacheKey) {
        lastDisplayedByTrack.delete(displayedTrackId);
      }
    }
  };

  const rememberSourceLyrics = (trackId, sourceKey, basePacket) => {
    const cacheKey = String(trackId || "").trim();
    const normalizedSource = canonicalSourceCacheKey(sourceKey);
    if (!cacheKey || !normalizedSource) {
      return;
    }
    if (!basePacket?.lyrics?.length) {
      return;
    }
    if (activeTrackSourceCache.trackId !== cacheKey) {
      setActiveTrack(cacheKey);
    }
    const incoming = cloneSourceCachePacket(basePacket);
    const existing = activeTrackSourceCache.bySource.get(normalizedSource);
    if (
      existing?.lyrics?.length &&
      hasTranslatedLinesInLyrics(existing.lyrics) &&
      !hasTranslatedLinesInLyrics(incoming.lyrics) &&
      packetLyricsSignature(existing) === packetLyricsSignature(incoming)
    ) {
      return;
    }
    activeTrackSourceCache.bySource.set(normalizedSource, incoming);
  };

  const getCachedSourceLyricsPacket = (trackId, preferredSource) => {
    const cacheKey = String(trackId || "").trim();
    const normalizedSource = canonicalSourceCacheKey(preferredSource);
    if (!cacheKey || !normalizedSource) {
      return null;
    }
    if (activeTrackSourceCache.trackId !== cacheKey) {
      return null;
    }
    const base = activeTrackSourceCache.bySource.get(normalizedSource);
    if (!base?.lyrics?.length) {
      return null;
    }
    return buildLyricsPacketFromBase({ trackId: cacheKey }, base);
  };

  const cloneLyricsLinesWithoutTranslations = (lyrics) => {
    if (!Array.isArray(lyrics)) {
      return [];
    }
    return lyrics.map((line) => {
      if (!line || typeof line !== "object") {
        return line;
      }
      const { translatedText, translationMeta, ...rest } = line;
      return rest;
    });
  };

  const rememberPublishedLyrics = (trackId, packet) => {
    const cacheKey = String(trackId || "").trim();
    if (!cacheKey || !packet) {
      return;
    }
    const lyrics = cloneLyricsLinesWithoutTranslations(packet.lyrics);
    if (!lyrics.length) {
      return;
    }
    const metadata =
      packet.metadata && typeof packet.metadata === "object"
        ? { ...packet.metadata }
        : {};
    delete metadata.translation;
    publishedToFrontendCache.set(cacheKey, {
      source:
        stripDesktopSourceSuffix(packet.source) ||
        String(packet.source || "desktop-bridge"),
      metadata,
      lyrics,
      statusMessage: String(packet.statusMessage || ""),
    });
  };

  const getPublishedLyrics = (trackId) => {
    const cacheKey = String(trackId || "").trim();
    if (!cacheKey) {
      return null;
    }
    return publishedToFrontendCache.get(cacheKey) || null;
  };

  const buildLyricsPacketFromBase = (track, basePacket) => {
    const safeLyrics = Array.isArray(basePacket?.lyrics) ? basePacket.lyrics : [];
    const sourceRoot =
      stripDesktopSourceSuffix(basePacket?.source) || "desktop-bridge";
    return {
      trackId: track.trackId,
      lyrics: safeLyrics,
      source: `${sourceRoot}|desktop`,
      metadata: mergeLyricsMetadata(basePacket?.metadata, {
        translation:
          safeLyrics.translationMeta || basePacket?.metadata?.translation,
      }),
      statusMessage: safeLyrics.length
        ? basePacket?.statusMessage ||
          `Loaded ${safeLyrics.length} synced lines from ${sourceRoot} on desktop.`
        : basePacket?.statusMessage ||
          (basePacket?.metadata?.instrumental
            ? "This song is an instrumental."
            : `No synced lyrics found (${sourceRoot}).`),
    };
  };

  const getMusixmatchRuntimeStatus = () => {
    const cooldown = getMusixmatchCooldownInfo();
    const geminiCooldown = getGeminiCooldownInfo();
    cleanupExpiredMusixmatchResultCache();
    return {
      musixmatchCooldownActive: cooldown.active,
      musixmatchCooldownRemainingMs: cooldown.remainingMs,
      musixmatchCooldownReason: cooldown.reason || "",
      musixmatchCooldownStartedAt: cooldown.startedAt || 0,
      musixmatchCacheEntries: musixmatchRuntimeState.resultCache.size,
      musixmatchTranslationCacheEntries:
        musixmatchRuntimeState.translationCache.size,
      geminiTranslationCacheEntries: geminiTranslationCache.size,
      publishedLyricsCacheEntries: publishedToFrontendCache.size,
      activeTrackSourceCacheEntries: activeTrackSourceCache.bySource.size,
      activeTrackSourceCacheTrackId: activeTrackSourceCache.trackId || "",
      geminiCooldownActive: geminiCooldown.active,
      geminiCooldownRemainingMs: geminiCooldown.remainingMs,
      geminiCooldownReason: geminiCooldown.reason || "",
      geminiCooldownStartedAt: geminiCooldown.startedAt || 0,
      musixmatchCacheTtlMs: MUSIXMATCH_RESULT_CACHE_TTL_MS,
      musixmatchCooldownTtlMs: MUSIXMATCH_COOLDOWN_MS,
      geminiCooldownTtlMs: GEMINI_RATE_LIMIT_COOLDOWN_MS,
    };
  };

  return {
    setActiveTrack,
    rememberPublishedLyrics,
    getPublishedLyrics,
    getCachedSourceLyricsPacket,
    async translatePublishedLyrics(track, { onSyncedLyrics = null } = {}) {
      if (!track?.trackId || !track?.title) {
        const empty = {
          trackId: "",
          lyrics: [],
          source: "desktop-bridge",
          statusMessage: "No active track.",
        };
        if (typeof onSyncedLyrics === "function") {
          onSyncedLyrics(empty);
        }
        return empty;
      }

      const cacheKey = track.trackId;
      const published = getPublishedLyrics(cacheKey);
      if (!published?.lyrics?.length) {
        const empty = {
          trackId: cacheKey,
          lyrics: [],
          source: "desktop-bridge",
          statusMessage:
            "No lyrics on screen to translate yet. Wait for lyrics to load, then try again.",
        };
        if (typeof onSyncedLyrics === "function") {
          onSyncedLyrics(empty);
        }
        return empty;
      }

      const basePacket = {
        source: published.source,
        metadata: published.metadata,
        lyrics: published.lyrics,
        statusMessage: published.statusMessage,
      };

      const emitToFrontend = (packetBase) => {
        const packet = buildLyricsPacketFromBase(track, packetBase);
        lastDisplayedByTrack.set(cacheKey, packet);
        if (typeof onSyncedLyrics === "function") {
          onSyncedLyrics(packet);
        }
      };

      console.log(
        `[lyrics-translate] translate-only for ${String(track.title || "unknown title")} using ${published.lyrics.length} published lines (source=${String(published.source || "unknown")})`,
      );

      emitToFrontend({
        ...basePacket,
        metadata: mergeLyricsMetadata(basePacket.metadata, {
          translation: {
            isLoading: true,
            provider: "Gemini",
            requestedAt: Date.now(),
          },
        }),
      });

      const enrichedLyrics = await enrichLyricsWithGeminiTranslations(
        track,
        basePacket.lyrics,
        {
          geminiApiKey: String(getGeminiApiKey() || "").trim(),
          geminiCache: geminiTranslationCache,
        },
      );

      const finalBase = {
        ...basePacket,
        lyrics: enrichedLyrics,
        metadata: mergeLyricsMetadata(basePacket.metadata, {
          translation: enrichedLyrics.translationMeta,
        }),
      };

      emitToFrontend(finalBase);
      rememberSourceLyrics(cacheKey, published.source, finalBase);
      return buildLyricsPacketFromBase(track, finalBase);
    },
    async fetchSyncedLyrics(
      track,
      {
        force = false,
        preferredSource = "auto",
        onSyncedLyrics = null,
        immediateTranslation = false,
      } = {},
    ) {
      if (!track?.trackId || !track?.title) {
        return {
          trackId: "",
          lyrics: [],
          source: "desktop-bridge",
          statusMessage: "No active track.",
        };
      }
      const cacheKey = track.trackId;
      setActiveTrack(cacheKey);
      const normalizedPreferredSource =
        sanitizePreferredSource(preferredSource);

      let matchTrack = { ...track };

      if (!force && normalizedPreferredSource !== "auto") {
        const cachedSourcePacket = getCachedSourceLyricsPacket(
          cacheKey,
          normalizedPreferredSource,
        );
        if (cachedSourcePacket) {
          console.log(
            `[bridge-lyrics] per-source cache hit track=${cacheKey} source=${normalizedPreferredSource} lines=${cachedSourcePacket.lyrics.length}`,
          );
          lastDisplayedByTrack.set(cacheKey, cachedSourcePacket);
          if (typeof onSyncedLyrics === "function") {
            onSyncedLyrics(cachedSourcePacket);
          }
          return cachedSourcePacket;
        }
      }

      const sourceCache = {
        get: (source) => {
          if (activeTrackSourceCache.trackId !== cacheKey) {
            return null;
          }
          return (
            activeTrackSourceCache.bySource.get(
              sanitizePreferredSource(source),
            ) || null
          );
        },
        set: (source, basePacket) => {
          rememberSourceLyrics(cacheKey, source, basePacket);
        },
      };

      let lastEmittedSignature = "";
      let bestBasePacket = null;

      const buildCachedPacket = (basePacket) => {
        const safeLyrics = Array.isArray(basePacket?.lyrics)
          ? basePacket.lyrics
          : [];
        return {
          trackId: track.trackId,
          lyrics: safeLyrics,
          source: `${String(basePacket?.source || "desktop-bridge")}|desktop`,
          metadata: mergeLyricsMetadata(basePacket?.metadata, {
            translation: safeLyrics.translationMeta,
          }),
          statusMessage: safeLyrics.length
            ? `Loaded ${safeLyrics.length} synced lines from ${String(basePacket?.source || "desktop-bridge")} on desktop.`
            : basePacket?.metadata?.instrumental
              ? "This song is an instrumental."
              : `No synced lyrics found (${String(basePacket?.source || "unknown reason")}).`,
        };
      };

      const cacheDisplayedPacket = (basePacket) => {
        if (!basePacket) {
          return;
        }
        const packet = buildCachedPacket(basePacket);
        lastDisplayedByTrack.set(cacheKey, packet);
        rememberSourceLyrics(cacheKey, basePacket?.source, basePacket);
      };

      const emitPacket = (basePacket) => {
        if (!basePacket) {
          return;
        }
        const safeLyrics = Array.isArray(basePacket?.lyrics)
          ? basePacket.lyrics
          : [];
        cacheDisplayedPacket(basePacket);
        if (typeof onSyncedLyrics !== "function") {
          return;
        }
        const first = safeLyrics[0];
        const last = safeLyrics[safeLyrics.length - 1];
        const translatedLineCount = Array.isArray(safeLyrics)
          ? safeLyrics.reduce(
              (count, line) =>
                count + (String(line?.translatedText || "").trim() ? 1 : 0),
              0,
            )
          : 0;
        const signature = [
          String(basePacket.source || ""),
          Number(safeLyrics.length || 0),
          Number(first?.lineStartTime || -1),
          Number(last?.lineEndTime || -1),
          translatedLineCount,
          Boolean(basePacket?.metadata?.translation?.isLoading),
          String(basePacket?.metadata?.translation?.model || ""),
        ].join("|");
        if (signature === lastEmittedSignature) {
          return;
        }
        lastEmittedSignature = signature;
        onSyncedLyrics({
          trackId: track.trackId,
          lyrics: safeLyrics,
          source: `${basePacket.source}|desktop`,
          metadata: mergeLyricsMetadata(basePacket?.metadata, {
            translation: safeLyrics.translationMeta,
          }),
          statusMessage: safeLyrics.length
            ? `Loaded ${safeLyrics.length} synced lines from ${basePacket.source} on desktop.`
            : basePacket?.metadata?.instrumental
              ? "This song is an instrumental."
              : `No synced lyrics found (${basePacket.source || "unknown reason"}).`,
        });
      };

      const registerCandidate = (candidatePacket) => {
        const safeCandidate = {
          ...candidatePacket,
          lyrics: Array.isArray(candidatePacket?.lyrics)
            ? candidatePacket.lyrics
            : [],
        };
        if (!safeCandidate.lyrics.length) {
          return false;
        }
        if (!bestBasePacket?.lyrics?.length) {
          bestBasePacket = safeCandidate;
          return true;
        }
        if (
          shouldUpgradeLyricsCandidate(matchTrack, bestBasePacket, safeCandidate)
        ) {
          bestBasePacket = safeCandidate;
          return true;
        }
        return false;
      };

      const getBasePacketSignature = (packet) => {
        const first = packet?.lyrics?.[0];
        const last = packet?.lyrics?.[packet?.lyrics?.length - 1];
        return [
          String(packet?.source || ""),
          Number(packet?.lyrics?.length || 0),
          Number(first?.lineStartTime || -1),
          Number(last?.lineEndTime || -1),
        ].join("|");
      };

      const countTranslatedLines = (lyrics) =>
        Array.isArray(lyrics)
          ? lyrics.reduce(
              (count, line) =>
                count + (String(line?.translatedText || "").trim() ? 1 : 0),
              0,
            )
          : 0;

      const hasTranslatedLines = (lyrics) => countTranslatedLines(lyrics) > 0;

      const attemptedTranslationSignatures = new Set();
      let sourceStableTranslationTimer = null;
      let sourceStableTranslationInFlight = false;
      let initialBaseCandidate = null;
      let initialBase = null;

      const getLatestBasePacket = () =>
        bestBasePacket || initialBase || initialBaseCandidate;

      const isCurrentBestPacket = (packet) => {
        if (!packet?.lyrics?.length) {
          return false;
        }
        const currentBest = getLatestBasePacket();
        if (!currentBest?.lyrics?.length) {
          return false;
        }
        return (
          getBasePacketSignature(packet) === getBasePacketSignature(currentBest)
        );
      };

      const emitTranslatedPacketIfCurrentBest = (packet) => {
        if (!packet?.lyrics?.length) {
          return false;
        }
        if (!hasTranslatedLines(packet.lyrics)) {
          emitPacket(packet);
          return true;
        }
        if (!isCurrentBestPacket(packet)) {
          return false;
        }
        emitPacket(packet);
        return true;
      };

      const runTranslationForLatestBasePacket = async () => {
        if (sourceStableTranslationInFlight) {
          return;
        }
        const latestBase = getLatestBasePacket();
        if (!latestBase?.lyrics?.length) {
          return;
        }

        sourceStableTranslationInFlight = true;
        try {
          const latestSignature = getBasePacketSignature(latestBase);
          emitPacket({
            ...latestBase,
            metadata: mergeLyricsMetadata(latestBase.metadata, {
              translation: {
                isLoading: true,
                provider: "Gemini",
                requestedAt: Date.now(),
              },
            }),
          });
          const enrichedLyrics = await enrichLyricsWithGeminiTranslations(
            track,
            latestBase.lyrics,
            {
              geminiApiKey: String(getGeminiApiKey() || "").trim(),
              geminiCache: geminiTranslationCache,
            },
          );
          const translatedBase = {
            ...latestBase,
            lyrics: enrichedLyrics,
            metadata: mergeLyricsMetadata(latestBase.metadata, {
              translation: enrichedLyrics.translationMeta,
            }),
          };

          const currentBest = getLatestBasePacket();
          if (
            getBasePacketSignature(currentBest) === latestSignature &&
            bestBasePacket?.lyrics?.length
          ) {
            bestBasePacket = translatedBase;
          }
          emitTranslatedPacketIfCurrentBest(translatedBase);
        } finally {
          sourceStableTranslationInFlight = false;
        }
      };

      const scheduleStableSourceTranslation = ({ immediate = false } = {}) => {
        const latestBase = getLatestBasePacket();
        if (!latestBase?.lyrics?.length) {
          return;
        }
        if (hasTranslatedLines(latestBase.lyrics)) {
          return;
        }
        const signature = getBasePacketSignature(latestBase);
        if (!immediate) {
          return;
        }
        if (attemptedTranslationSignatures.has(signature)) {
          return;
        }

        if (sourceStableTranslationTimer) {
          clearTimeout(sourceStableTranslationTimer);
        }

        sourceStableTranslationTimer = setTimeout(
          () => {
            sourceStableTranslationTimer = null;
            const currentBase = getLatestBasePacket();
            if (!currentBase?.lyrics?.length) {
              return;
            }
            const currentSignature = getBasePacketSignature(currentBase);
            if (currentSignature !== signature) {
              scheduleStableSourceTranslation();
              return;
            }
            attemptedTranslationSignatures.add(currentSignature);
            void runTranslationForLatestBasePacket();
          },
          immediate ? 0 : AUTO_TRANSLATION_QUIET_MS,
        );
      };

      const isAutoPreferredSource =
        sanitizePreferredSource(preferredSource) === "auto";
      let autoTranslationTimer = null;
      let resolveAutoTranslationReady = null;
      const autoTranslationReadyPromise = new Promise((resolve) => {
        resolveAutoTranslationReady = resolve;
      });
      let autoTranslationReadyResolved = false;
      let sourceChangedAfterAutoReady = false;

      const shouldTranslate = () => Boolean(immediateTranslation);

      const resolveAutoTranslationReadyNow = () => {
        if (autoTranslationReadyResolved) {
          return;
        }
        autoTranslationReadyResolved = true;
        if (autoTranslationTimer) {
          clearTimeout(autoTranslationTimer);
          autoTranslationTimer = null;
        }
        resolveAutoTranslationReady?.();
      };

      const scheduleAutoTranslationQuietWindow = () => {
        if (!isAutoPreferredSource || !bestBasePacket?.lyrics?.length) {
          return;
        }
        if (autoTranslationTimer) {
          clearTimeout(autoTranslationTimer);
        }
        resolveAutoTranslationReadyNow();
      };

      const handleProgressPacket = (candidatePacket) => {
        const upgraded = registerCandidate(candidatePacket);
        if (upgraded) {
          emitPacket(bestBasePacket);
          const shouldTranslateImmediately = shouldTranslate();
          if (
            isAutoPreferredSource &&
            !hasTranslatedLines(bestBasePacket?.lyrics || []) &&
            shouldTranslateImmediately
          ) {
            scheduleStableSourceTranslation({
              immediate: shouldTranslateImmediately,
            });
          }
          if (autoTranslationReadyResolved) {
            sourceChangedAfterAutoReady = true;
          } else if (shouldTranslateImmediately) {
            resolveAutoTranslationReadyNow();
          } else {
            scheduleAutoTranslationQuietWindow();
          }
        }
      };

      let resolvedSpotifyAccessToken = "";
      try {
        resolvedSpotifyAccessToken = String(
          (typeof getSpotifyAccessToken === "function"
            ? await getSpotifyAccessToken()
            : "") || "",
        ).trim();
      } catch {
        // Spotify OAuth token unavailable; continue without it.
      }

      matchTrack = await buildLyricsMatchTrack(track, {
        spotifyAccessToken: resolvedSpotifyAccessToken,
      });

      const base = await fetchBestSyncedLyrics(matchTrack, {
        preferredSource,
        onProgress: handleProgressPacket,
        onSourceCached: (candidate, source) => {
          rememberSourceLyrics(
            cacheKey,
            source || candidate?.source,
            candidate,
          );
        },
        sourceCache,
        musixmatchUserToken: String(getMusixmatchUserToken() || "").trim(),
        spotifyWebToken: String(getSpotifyWebToken() || "").trim(),
        spotifyAccessToken: resolvedSpotifyAccessToken,
        waitForAutoCompletion: false,
      });
      initialBaseCandidate = {
        ...base,
        lyrics: Array.isArray(base.lyrics) ? base.lyrics : [],
      };
      if (!bestBasePacket?.lyrics?.length) {
        registerCandidate(initialBaseCandidate);
      } else {
        registerCandidate(initialBaseCandidate);
      }

      initialBase = bestBasePacket || initialBaseCandidate;
      emitPacket(initialBase);

      if (
        isAutoPreferredSource &&
        !hasTranslatedLines(initialBase?.lyrics || []) &&
        shouldTranslate()
      ) {
        scheduleStableSourceTranslation({
          immediate: shouldTranslate(),
        });
      }

      if (isAutoPreferredSource) {
        // ponytail: both branches resolved immediately; simplified from dead conditional
        resolveAutoTranslationReadyNow();
        await autoTranslationReadyPromise;
      }

      const MAX_POST_QUIET_RETRANSLATES = 3;
      let translationBase = bestBasePacket || initialBase;
      let translationPass = 0;
      let finalBase = {
        ...translationBase,
        lyrics: Array.isArray(translationBase?.lyrics)
          ? translationBase.lyrics
          : [],
      };

      while (translationPass <= MAX_POST_QUIET_RETRANSLATES) {
        const inputPacket = translationBase || initialBase;
        if (!shouldTranslate()) {
          finalBase = {
            ...inputPacket,
            lyrics: Array.isArray(inputPacket?.lyrics)
              ? inputPacket.lyrics
              : [],
          };
          break;
        }
        const inputSignature = getBasePacketSignature(inputPacket);
        attemptedTranslationSignatures.add(inputSignature);
        sourceChangedAfterAutoReady = false;
        emitPacket({
          ...inputPacket,
          metadata: mergeLyricsMetadata(inputPacket?.metadata, {
            translation: {
              isLoading: true,
              provider: "Gemini",
              requestedAt: Date.now(),
            },
          }),
        });

        const enrichedLyrics = await enrichLyricsWithGeminiTranslations(
          track,
          inputPacket.lyrics,
          {
            geminiApiKey: String(getGeminiApiKey() || "").trim(),
            geminiCache: geminiTranslationCache,
          },
        );

        finalBase = {
          ...inputPacket,
          lyrics: enrichedLyrics,
          metadata: mergeLyricsMetadata(inputPacket?.metadata, {
            translation: enrichedLyrics.translationMeta,
          }),
        };
        emitTranslatedPacketIfCurrentBest(finalBase);

        if (!isAutoPreferredSource) {
          break;
        }

        const latestBase = bestBasePacket || initialBase;
        const latestSignature = getBasePacketSignature(latestBase);
        const shouldRetranslate =
          latestSignature !== inputSignature || sourceChangedAfterAutoReady;
        if (!shouldRetranslate) {
          break;
        }

        translationPass += 1;
        translationBase = latestBase;
      }

      const latestBaseAtCompletion = getLatestBasePacket();
      const finalOutputBase =
        latestBaseAtCompletion?.lyrics?.length &&
        getBasePacketSignature(latestBaseAtCompletion) !==
          getBasePacketSignature(finalBase)
          ? latestBaseAtCompletion
          : finalBase;

      emitTranslatedPacketIfCurrentBest(finalOutputBase);
      const finalLyrics = Array.isArray(finalOutputBase?.lyrics)
        ? finalOutputBase.lyrics
        : [];
      const result = {
        trackId: track.trackId,
        lyrics: finalLyrics,
        source: `${finalOutputBase.source}|desktop`,
        metadata: mergeLyricsMetadata(finalOutputBase?.metadata, {
          translation: finalLyrics.translationMeta,
        }),
        statusMessage: finalLyrics.length
          ? `Loaded ${finalLyrics.length} synced lines from ${finalOutputBase.source} on desktop.`
          : finalOutputBase?.metadata?.instrumental
            ? "This song is an instrumental."
            : `No synced lyrics found (${finalOutputBase.source || "unknown reason"}).`,
      };
      lastDisplayedByTrack.set(cacheKey, result);
      if (autoTranslationTimer) {
        clearTimeout(autoTranslationTimer);
      }
      return result;
    },
    getCachedLyrics(trackId) {
      const cacheKey = String(trackId || "");
      if (!cacheKey) {
        return null;
      }
      const displayed = lastDisplayedByTrack.get(cacheKey);
      if (displayed) {
        return displayed;
      }
      const published = getPublishedLyrics(cacheKey);
      if (!published?.lyrics?.length) {
        return null;
      }
      return buildLyricsPacketFromBase({ trackId: cacheKey }, published);
    },
    clearCache() {
      lastDisplayedByTrack.clear();
      geminiTranslationCache.clear();
      publishedToFrontendCache.clear();
      activeTrackSourceCache.trackId = "";
      activeTrackSourceCache.bySource = new Map();
      clearMusixmatchRuntimeState();
      geminiRuntimeState.cooldownUntil = 0;
      geminiRuntimeState.cooldownReason = "";
      geminiRuntimeState.lastRateLimitAt = 0;
    },
    getMusixmatchRuntimeStatus,
    async saveCurrentLyricsToVault(
      track,
      lyrics,
      { includeTranslations = false, source = "", metadata = null } = {},
    ) {
      const {
        getLyricsVaultStore,
        resolveVaultSourceLabel,
      } = require("./lyricsVault");
      const store = getLyricsVaultStore();
      if (!store) {
        throw new Error("Lyrics vault is not initialized.");
      }
      if (!Array.isArray(lyrics) || !lyrics.length) {
        throw new Error("No lyrics available to save.");
      }

      let lyricsToSave = cloneSourceCachePacket({ lyrics }).lyrics;
      const matchTrack = await buildLyricsMatchTrack(track, {
        spotifyAccessToken: String(
          (typeof getSpotifyAccessToken === "function"
            ? await getSpotifyAccessToken()
            : "") || "",
        ).trim(),
      });

      if (
        includeTranslations &&
        !hasTranslatedLinesInLyrics(lyricsToSave)
      ) {
        const translated = await enrichLyricsWithGeminiTranslations(
          matchTrack,
          lyricsToSave,
          {
            geminiApiKey: String(getGeminiApiKey() || "").trim(),
            geminiCache: geminiTranslationCache,
          },
        );
        lyricsToSave = Array.isArray(translated) ? translated : lyricsToSave;
      }

      const strippedSource = stripDesktopSourceSuffix(source);
      const sourceLabel = strippedSource.startsWith("local-vault-")
        ? strippedSource
        : resolveVaultSourceLabel(lyricsToSave, strippedSource);

      const saved = store.save({
        track: matchTrack,
        lyrics: lyricsToSave,
        sourceLabel,
        includeTranslations,
        originalSource: stripDesktopSourceSuffix(source),
        metadata,
      });

      rememberSourceLyrics(matchTrack.trackId, "local-vault", {
        lyrics: lyricsToSave,
        source: sourceLabel,
        metadata: saved.metadata || {},
      });

      return saved;
    },
    async importTtmlToVault(
      ttmlContent,
      track,
      { includeTranslations = false } = {},
    ) {
      const { parseTtmlToLyrics, extractTtmlMetadata } = require("./lyricsTtmlImport");
      const {
        getLyricsVaultStore,
        resolveVaultSourceLabel,
      } = require("./lyricsVault");
      const store = getLyricsVaultStore();
      if (!store) {
        throw new Error("Lyrics vault is not initialized.");
      }

      const parsed = parseTtmlToLyrics(ttmlContent);
      if (!parsed?.lyrics?.length) {
        throw new Error("TTML file did not contain any lyric lines.");
      }

      const ttmlMeta = extractTtmlMetadata(ttmlContent);
      const mergedTrack = {
        trackId: String(track?.trackId || track?.spotifyTrackId || "").trim(),
        title: String(track?.title || ttmlMeta.title || "").trim(),
        artist: String(track?.artist || ttmlMeta.artist || "").trim(),
        album: String(track?.album || "").trim(),
        durationMs: Number(
          track?.durationMs || parsed.durationMs || 0,
        ),
        spotifyTrackId: String(track?.spotifyTrackId || "").trim(),
      };
      if (!mergedTrack.title) {
        throw new Error(
          "Could not determine song title. Play the track on Spotify or use a TTML with title metadata.",
        );
      }

      const matchTrack = await enrichTrackForVaultMatch(
        mergedTrack,
        String(
          (typeof getSpotifyAccessToken === "function"
            ? await getSpotifyAccessToken()
            : "") || "",
        ).trim(),
      );

      let lyricsToSave = cloneSourceCachePacket({ lyrics: parsed.lyrics }).lyrics;
      if (
        includeTranslations &&
        !hasTranslatedLinesInLyrics(lyricsToSave)
      ) {
        const translated = await enrichLyricsWithGeminiTranslations(
          matchTrack,
          lyricsToSave,
          {
            geminiApiKey: String(getGeminiApiKey() || "").trim(),
            geminiCache: geminiTranslationCache,
          },
        );
        lyricsToSave = Array.isArray(translated) ? translated : lyricsToSave;
      }

      const sourceLabel = resolveVaultSourceLabel(
        lyricsToSave,
        parsed.useKaraokeTiming ? "local-vault-karaoke" : "local-vault-line",
      );

      const saved = store.save({
        track: matchTrack,
        lyrics: lyricsToSave,
        sourceLabel,
        includeTranslations,
        originalSource: "ttml-import",
      });

      if (matchTrack.trackId) {
        rememberSourceLyrics(matchTrack.trackId, "local-vault", {
          lyrics: lyricsToSave,
          source: sourceLabel,
          metadata: {},
        });
      }

      return saved;
    },
    async importLyricsFileToVault(
      fileContent,
      filePath,
      track,
      { includeTranslations = false } = {},
    ) {
      const { parseLyricsImportFile } = require("./lyricsVault");
      const {
        getLyricsVaultStore,
        resolveVaultSourceLabel,
      } = require("./lyricsVault");
      const store = getLyricsVaultStore();
      if (!store) {
        throw new Error("Lyrics vault is not initialized.");
      }

      const parsed = parseLyricsImportFile(fileContent, filePath);
      const mergedTrack = {
        trackId: String(track?.trackId || track?.spotifyTrackId || "").trim(),
        title: String(track?.title || parsed.title || "").trim(),
        artist: String(track?.artist || parsed.artist || "").trim(),
        album: String(track?.album || parsed.album || "").trim(),
        durationMs: Number(track?.durationMs || parsed.durationMs || 0),
        spotifyTrackId: String(track?.spotifyTrackId || parsed.spotifyTrackId || "").trim(),
      };
      if (!mergedTrack.title) {
        throw new Error(
          "Could not determine song title. Play the track on Spotify or include title metadata in the file.",
        );
      }

      const matchTrack = await enrichTrackForVaultMatch(
        mergedTrack,
        String(
          (typeof getSpotifyAccessToken === "function"
            ? await getSpotifyAccessToken()
            : "") || "",
        ).trim(),
      );

      let lyricsToSave = cloneSourceCachePacket({ lyrics: parsed.lyrics }).lyrics;
      if (
        includeTranslations &&
        !hasTranslatedLinesInLyrics(lyricsToSave)
      ) {
        const translated = await enrichLyricsWithGeminiTranslations(
          matchTrack,
          lyricsToSave,
          {
            geminiApiKey: String(getGeminiApiKey() || "").trim(),
            geminiCache: geminiTranslationCache,
          },
        );
        lyricsToSave = Array.isArray(translated) ? translated : lyricsToSave;
      }

      const sourceLabel = resolveVaultSourceLabel(
        lyricsToSave,
        parsed.sourceLabel ||
          (parsed.useKaraokeTiming ? "local-vault-karaoke" : "local-vault-line"),
      );

      const saved = store.save({
        track: matchTrack,
        lyrics: lyricsToSave,
        sourceLabel,
        includeTranslations,
        originalSource: `${parsed.format}-import`,
      });

      if (matchTrack.trackId) {
        rememberSourceLyrics(matchTrack.trackId, "local-vault", {
          lyrics: lyricsToSave,
          source: sourceLabel,
          metadata: {},
        });
      }

      return saved;
    },
  };
}
