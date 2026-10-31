"use strict";
function createLyricsService({
  getMusixmatchUserToken = () => process.env.MUSIXMATCH_USER_TOKEN || "",
  refreshMusixmatchUserToken = null,
  invalidateMusixmatchUserToken = null,
  getSpotifyWebToken = () => process.env.SPOTIFY_WEB_TOKEN || "",
  getGeminiApiKey = () =>
    process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY || "",
  getSpotifyAccessToken = () => "",
  getSpicyLyricsPublishableKey = () => process.env.SPICY_LYRICS_PUBLISHABLE_KEY || "",
} = {}) {
  const { selectTtmlTranslationTracks, mergeTtmlTranslationResult } = require("./lyricsTtmlTranslations");
  const isExpiredSpicyPacket = (packet) => packet?.metadata?.spicyApi && !(Number(packet.metadata.spicyApi.expiresAt) > Date.now());
  const lastDisplayedByTrack = new Map();
  const geminiTranslationCache = new Map();
  const publishedToFrontendCache = new Map();
  const activeTrackSourceCache = {
    trackId: "",
    bySource: new Map(),
  };
  const sourceCachesByTrack = new Map();
  const sourceCacheExpiry = new WeakMap();
  const sourceFetchesInFlight = new Map();
  const SOURCE_CACHE_TTL_MS = 30 * 60_000;
  const AUTO_CACHE_TTL_MS = 5 * 60_000;
  const MAX_CACHED_TRACKS = 100;
  let selectionGeneration = 0;
  let selectionKey = "";
  const AUTO_TRANSLATION_QUIET_MS = 5_000;
  let cacheExpiryTimer;
  const scheduleCacheExpiry = () => {
    clearTimeout(cacheExpiryTimer);
    const caches = [lastDisplayedByTrack, publishedToFrontendCache, ...[...sourceCachesByTrack.values()].map(record => record.bySource)];
    let nextExpiry = Infinity;
    let removed = false;
    for (const cache of caches) {
      for (const [key, packet] of cache) {
        if (isExpiredSpicyPacket(packet)) { cache.delete(key); removed = true; }
        else if (packet?.metadata?.spicyApi) nextExpiry = Math.min(nextExpiry, Number(packet.metadata.spicyApi.expiresAt));
      }
    }
    if (removed) geminiTranslationCache.clear();
    if (Number.isFinite(nextExpiry)) {
      cacheExpiryTimer = setTimeout(scheduleCacheExpiry, Math.max(1, Math.min(60_000, nextExpiry - Date.now())));
      cacheExpiryTimer?.unref?.();
    }
  };

  const stripDesktopSourceSuffix = (source) =>
    String(source || "")
      .replace(/\|desktop$/i, "")
      .trim();

  /** Map fetcher-specific labels (e.g. qq-musicu-qrc) to Expo/bridge source keys (qq-direct). */
  const canonicalSourceCacheKey = (source) => {
    if (source === "auto") return "auto"
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
    lyrics.some(
      (line) =>
        String(line?.translatedText || "").trim().length > 0 ||
        String(line?.backgroundTranslatedText || "").trim().length > 0,
    );

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

  const getSourceRecord = (cacheKey) => {
    let record = sourceCachesByTrack.get(cacheKey);
    if (!record) record = { bySource: new Map(), identity: "" };
    sourceCachesByTrack.delete(cacheKey);
    sourceCachesByTrack.set(cacheKey, record);
    while (sourceCachesByTrack.size > MAX_CACHED_TRACKS) {
      const oldest = sourceCachesByTrack.keys().next().value;
      sourceCachesByTrack.delete(oldest);
      lastDisplayedByTrack.delete(oldest);
      publishedToFrontendCache.delete(oldest);
    }
    return record;
  };
  const setActiveTrack = (trackId) => {
    const cacheKey = String(trackId || "").trim();
    if (activeTrackSourceCache.trackId !== cacheKey) {
      selectionGeneration += 1;
      selectionKey = "";
    }
    activeTrackSourceCache.trackId = cacheKey;
    activeTrackSourceCache.bySource = cacheKey ? getSourceRecord(cacheKey).bySource : new Map();
  };

  const rememberSourceLyrics = (trackId, sourceKey, basePacket) => {
    const cacheKey = String(trackId || "").trim();
    const normalizedSource = canonicalSourceCacheKey(sourceKey);
    if (!cacheKey || !normalizedSource || !basePacket?.lyrics?.length) return;
    // A late old-track result may fill its own cache, but must never switch the active track.
    const record = sourceCachesByTrack.get(cacheKey);
    if (!record) return;
    const incoming = cloneSourceCachePacket(basePacket);
    const existing = record.bySource.get(normalizedSource);
    if (existing?.lyrics?.length && hasTranslatedLinesInLyrics(existing.lyrics) &&
      !hasTranslatedLinesInLyrics(incoming.lyrics) && packetLyricsSignature(existing) === packetLyricsSignature(incoming)) return;
    record.bySource.set(normalizedSource, incoming);
    sourceCacheExpiry.set(incoming, Date.now() + (normalizedSource === "auto" ? AUTO_CACHE_TTL_MS : SOURCE_CACHE_TTL_MS));
    scheduleCacheExpiry();
  };
  const getSourceBase = (trackId, source) => {
    const record = sourceCachesByTrack.get(String(trackId || ""));
    const key = canonicalSourceCacheKey(source);
    const base = record?.bySource.get(key);
    if (base && (isExpiredSpicyPacket(base) || (sourceCacheExpiry.get(base) || 0) <= Date.now())) {
      record.bySource.delete(key);
      return null;
    }
    return base || null;
  };
  const getCachedSourceLyricsPacket = (trackId, preferredSource, translationLanguage = "English") => {
    const base = getSourceBase(trackId, preferredSource);
    return base?.lyrics?.length ? buildLyricsPacketFromBase({ trackId: String(trackId) }, selectTtmlTranslationTracks(base, translationLanguage)) : null;
  };

  const cloneLyricsLinesWithoutTranslations = (lyrics) => {
    if (!Array.isArray(lyrics)) {
      return [];
    }
    return lyrics.map((line) => {
      if (!line || typeof line !== "object") {
        return line;
      }
      const {
        translatedText,
        backgroundTranslatedText,
        translationMeta,
        ...rest
      } = line;
      return rest;
    });
  };

  const rememberPublishedLyrics = (trackId, packet) => {
    const cacheKey = String(trackId || "").trim();
    if (!cacheKey || !packet) {
      return;
    }
    const hasSourceTracks = Boolean(packet.metadata?.ttml?.translationTracks?.length);
    const lyrics = hasSourceTracks ? packet.lyrics.map(line => ({ ...line }))
      : cloneLyricsLinesWithoutTranslations(packet.lyrics);
    if (!lyrics.length) {
      return;
    }
    const metadata =
      packet.metadata && typeof packet.metadata === "object"
        ? { ...packet.metadata }
        : {};
    if (!hasSourceTracks) delete metadata.translation;
    publishedToFrontendCache.set(cacheKey, {
      source:
        stripDesktopSourceSuffix(packet.source) ||
        String(packet.source || "desktop-bridge"),
      metadata,
      lyrics,
      statusMessage: String(packet.statusMessage || ""),
    });
    scheduleCacheExpiry();
  };

  const getPublishedLyrics = (trackId) => {
    const cacheKey = String(trackId || "").trim();
    if (!cacheKey) {
      return null;
    }
    const cached = publishedToFrontendCache.get(cacheKey);
    if (isExpiredSpicyPacket(cached)) {
      publishedToFrontendCache.delete(cacheKey);
      return null;
    }
    return cached || null;
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
    async translatePublishedLyrics(track, { onSyncedLyrics = null, translationLanguage = "English" } = {}) {
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
          targetLanguage: translationLanguage,
        },
      );

      const finalBase = mergeTtmlTranslationResult(basePacket, enrichedLyrics, translationLanguage);

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
        translationLanguage = "English",
        requestId = 0,
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
      const normalizedPreferredSource = sanitizePreferredSource(preferredSource);
      const recordingIdentity = [track.spotifyTrackId || "", track.isrc || "", track.title || "", track.artist || "", Number(track.durationMs || 0)].join("|");
      let sourceRecord = getSourceRecord(cacheKey);
      if (force || (sourceRecord.identity && sourceRecord.identity !== recordingIdentity)) {
        sourceRecord = { bySource: new Map(), identity: recordingIdentity };
        sourceCachesByTrack.set(cacheKey, sourceRecord);
        activeTrackSourceCache.bySource = sourceRecord.bySource;
      }
      sourceRecord.identity = recordingIdentity;
      const requestKey = `${cacheKey}|${recordingIdentity}|${normalizedPreferredSource}|${translationLanguage}`;
      if (force || selectionKey !== requestKey) { selectionKey = requestKey; selectionGeneration += 1; }
      const requestGeneration = selectionGeneration;
      const isCurrentSelection = () => selectionGeneration === requestGeneration && selectionKey === requestKey;
      let matchTrack = { ...track };

      if (!force && normalizedPreferredSource !== "auto") {
        const cachedSourcePacket = getCachedSourceLyricsPacket(
          cacheKey,
          normalizedPreferredSource,
          translationLanguage,
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
        get: source => force ? null : getSourceBase(cacheKey, source),
        set: (source, basePacket) => {
          if (sourceCachesByTrack.get(cacheKey) === sourceRecord) rememberSourceLyrics(cacheKey, source, basePacket);
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
        const { emitPickerTrace } = require("./lyricsAutoPicker");
        if (!isCurrentSelection()) {
          emitPickerTrace?.("callback-guard", {
            requestId,
            target: "service-emitPacket",
            decision: "discard",
            reason: "stale-selection-generation",
          });
          return;
        }
        if (!basePacket) {
          emitPickerTrace?.("callback-guard", {
            requestId,
            target: "service-emitPacket",
            decision: "discard",
            reason: "empty-packet",
          });
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
                count +
                (String(line?.translatedText || "").trim() ||
                String(line?.backgroundTranslatedText || "").trim()
                  ? 1
                  : 0),
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
          emitPickerTrace?.("callback-guard", {
            requestId,
            target: "service-emitPacket",
            decision: "discard",
            reason: "duplicate-signature",
          });
          return;
        }
        lastEmittedSignature = signature;
        emitPickerTrace?.("callback-guard", {
          requestId,
          target: "service-emitPacket",
          decision: "accept",
          reason: "new-signature",
          source: basePacket.source,
        });
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
        const { emitPickerTrace } = require("./lyricsAutoPicker");
        if (!isCurrentSelection()) {
          emitPickerTrace?.("callback-guard", {
            requestId,
            target: "service-registerCandidate",
            decision: "discard",
            reason: "stale-selection-generation",
          });
          return false;
        }
        candidatePacket = selectTtmlTranslationTracks(candidatePacket, translationLanguage);
        const safeCandidate = {
          ...candidatePacket,
          lyrics: Array.isArray(candidatePacket?.lyrics)
            ? candidatePacket.lyrics
            : [],
        };
        if (!safeCandidate.lyrics.length) {
          emitPickerTrace?.("comparator", {
            requestId,
            currentSource: bestBasePacket?.source || "none",
            candidateSource: safeCandidate?.source || "unknown",
            decision: "rejected",
            rule: "no-candidate-lyrics",
          });
          return false;
        }
        if (!bestBasePacket?.lyrics?.length) {
          bestBasePacket = safeCandidate;
          emitPickerTrace?.("comparator", {
            requestId,
            currentSource: "none",
            candidateSource: safeCandidate.source,
            decision: "accepted",
            rule: "initial-candidate",
          });
          return true;
        }
        const evaluation = typeof evaluateCandidateUpgrade === "function"
          ? evaluateCandidateUpgrade(matchTrack, bestBasePacket, safeCandidate)
          : { upgrade: shouldUpgradeLyricsCandidate(matchTrack, bestBasePacket, safeCandidate), rule: "upgrade-check" };
        emitPickerTrace?.("comparator", {
          requestId,
          currentSource: bestBasePacket.source,
          candidateSource: safeCandidate.source,
          decision: evaluation.upgrade ? "accepted" : "rejected",
          rule: evaluation.rule,
        });
        if (evaluation.upgrade) {
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
                count +
                (String(line?.translatedText || "").trim() ||
                String(line?.backgroundTranslatedText || "").trim()
                  ? 1
                  : 0),
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
              targetLanguage: translationLanguage,
            },
          );
          const translatedBase = mergeTtmlTranslationResult(latestBase, enrichedLyrics, translationLanguage);

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
        const { emitPickerTrace } = require("./lyricsAutoPicker");
        const upgraded = registerCandidate(candidatePacket);
        if (upgraded) {
          emitPickerTrace?.("callback-guard", {
            requestId,
            target: "service-handleProgress",
            decision: "accept",
            reason: "candidate-upgraded",
            source: bestBasePacket?.source,
          });
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
        } else {
          emitPickerTrace?.("callback-guard", {
            requestId,
            target: "service-handleProgress",
            decision: "discard",
            reason: "candidate-not-upgrade",
            candidateSource: candidatePacket?.source,
          });
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

      const resolvedSpicyLyricsPublishableKey = await getSpicyLyricsPublishableKey();
      // Credential/catalog setup can outlive a force refresh or source/track
      // switch. It must not replace the newer run's in-flight registry entry.
      if (!isCurrentSelection() || sourceCachesByTrack.get(cacheKey) !== sourceRecord) {
        return { trackId: cacheKey, lyrics: [], source: "stale-lyrics-request" };
      }
      let flight = !force ? sourceFetchesInFlight.get(requestKey) : null;
      if (!flight || flight.record !== sourceRecord) {
        flight = { record: sourceRecord, listeners: new Set(), latest: null, initial: null };
        sourceFetchesInFlight.set(requestKey, flight);
        const currentFlight = flight;
        const finishFlight = () => {
          if (sourceFetchesInFlight.get(requestKey) === currentFlight) sourceFetchesInFlight.delete(requestKey);
        };
        currentFlight.initial = fetchBestSyncedLyrics(matchTrack, {
          preferredSource,
          requestId,
          onProgress: candidate => {
            currentFlight.latest = candidate;
            for (const listener of currentFlight.listeners) listener(candidate);
          },
          // The bounded completion deadline must not release deduplication
          // while a raw pending provider can still publish a superior result.
          onAutoSettled: finishFlight,
          onSourceCached: (candidate, source) => sourceCache.set(source || candidate?.source, candidate),
          sourceCache,
          // Provision only inside the Musixmatch task: a vault/final cache hit
          // needs no issuance, and other providers never wait on token.get.
          resolveMusixmatchUserToken: getMusixmatchUserToken,
          refreshMusixmatchUserToken,
          invalidateMusixmatchUserToken,
          spotifyWebToken: String(getSpotifyWebToken() || "").trim(),
          spotifyAccessToken: resolvedSpotifyAccessToken,
          spicyLyricsPublishableKey: resolvedSpicyLyricsPublishableKey,
          waitForAutoCompletion: false,
        });
        if (normalizedPreferredSource !== "auto") currentFlight.initial.then(finishFlight, finishFlight);
      }
      flight.listeners.add(handleProgressPacket);
      if (flight.latest) handleProgressPacket(flight.latest);
      const base = await flight.initial;

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
          targetLanguage: translationLanguage,
          },
        );

        finalBase = mergeTtmlTranslationResult(inputPacket, enrichedLyrics, translationLanguage);
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
      if (isCurrentSelection()) lastDisplayedByTrack.set(cacheKey, result);
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
      if (displayed && !isExpiredSpicyPacket(displayed)) {
        return displayed;
      }
      const published = getPublishedLyrics(cacheKey);
      if (!published?.lyrics?.length) {
        return null;
      }
      return buildLyricsPacketFromBase({ trackId: cacheKey }, published);
    },
    clearCache() {
      clearTimeout(cacheExpiryTimer);
      lastDisplayedByTrack.clear();
      geminiTranslationCache.clear();
      publishedToFrontendCache.clear();
      activeTrackSourceCache.trackId = "";
      activeTrackSourceCache.bySource = new Map();
      sourceCachesByTrack.clear();
      sourceFetchesInFlight.clear();
      selectionKey = "";
      selectionGeneration += 1;
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
        buildVaultImportTrack,
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
      const mergedTrack = buildVaultImportTrack({ ...ttmlMeta, durationMs: parsed.durationMs }, track);
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
        metadata: parsed.metadata,
        sourceLabel,
        includeTranslations,
        originalSource: "ttml-import",
      });

      if (matchTrack.trackId) {
        rememberSourceLyrics(matchTrack.trackId, "local-vault", {
          lyrics: lyricsToSave,
          source: sourceLabel,
          metadata: saved.metadata || {},
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
        buildVaultImportTrack,
      } = require("./lyricsVault");
      const store = getLyricsVaultStore();
      if (!store) {
        throw new Error("Lyrics vault is not initialized.");
      }

      const parsed = parseLyricsImportFile(fileContent, filePath);
      const mergedTrack = buildVaultImportTrack(parsed, track);
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
        metadata: parsed.metadata,
        sourceLabel,
        includeTranslations,
        originalSource: `${parsed.format}-import`,
      });

      if (matchTrack.trackId) {
        rememberSourceLyrics(matchTrack.trackId, "local-vault", {
          lyrics: lyricsToSave,
          source: sourceLabel,
          metadata: saved.metadata || {},
        });
      }

      return saved;
    },
  };
}
