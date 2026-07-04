const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const {
  clearRemoteArtworkCache,
  getCachedRemoteArtwork,
  resolveRemoteArtworkUrl,
  shouldPreferRemoteArtwork,
} = require("./artworkResolver");
const {
  resolveSpotifyCatalogTrackViaPartnerSearch,
  resolveSpotifyCatalogTrackById,
  mergeNativePlaybackArtist,
} = require("./lyrics");
const { getDotnetExecutable } = require("./dotnetExecutable");

const EMIT_INTERVAL_MS = 100;
const MAX_CAPTURE_DELAY_MS = 1_200;
const HARD_RESYNC_DRIFT_MS = 900;
const JITTER_RESISTANCE_MS = 500;
const NATIVE_STALE_POSITION_SLACK_MS = 500;
const NATIVE_STALE_IGNORE_DRIFT_MS = 700;
const NATIVE_SEEK_JUMP_MS = 300;
const GSMTC_SLIP_LEARN_ALPHA = 0.22;
const GSMTC_SLIP_MIN_DT_MS = 400;
const GSMTC_SLIP_STALE_RATIO = 0.55;
const PIPELINE_DELAY_LEARN_ALPHA = 0.2;
const SOFT_CORRECTION_RATIO = 0.25;
const MAX_SOFT_CORRECTION_MS = 50;
const ARTWORK_FALLBACK_TIMEOUT_MS = 15_000;
// Local playback snapshots may repeat artwork on this interval; relay/ngrok strips repeats.
const ARTWORK_REBROADCAST_INTERVAL_MS = Number(
  process.env.BRIDGE_ARTWORK_REBROADCAST_MS || 10 * 60_000,
);
const SPOTIFY_DETECTOR_DEBUG_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.SPOTIFY_DETECTOR_DEBUG || process.env.SPICY_DEBUG || "")
    .trim()
    .toLowerCase(),
);
const SPOTIFY_PLAYBACK_API_DISABLED = true;
const SPOTIFY_API_429_COOLDOWN_MS = 60_000;

function detectorDebugLog(message, meta = undefined) {
  if (!SPOTIFY_DETECTOR_DEBUG_ENABLED) {
    return;
  }
  if (meta === undefined) {
    console.log(`[spotify-detector-debug] ${message}`);
    return;
  }
  console.log(`[spotify-detector-debug] ${message}`, meta);
}
const SPOTIFY_API_POLL_MS = 1_500;

const SEEK_HELPER_PROJECT_DIR = path.join(
  __dirname,
  "..",
  "native",
  "spotify-seek-helper",
);
const SEEK_HELPER_DLL_PATH = path.join(
  SEEK_HELPER_PROJECT_DIR,
  "bin",
  "Release",
  "net9.0-windows10.0.19041.0",
  "spotify-seek-helper.dll",
);
let seekHelperBuildPromise = null;

function hashTrackId(title, artist) {
  return crypto.createHash("sha1").update(`${title}::${artist}`).digest("hex");
}

function isPortableArtworkUri(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    return true;
  }
  // Do not forward local Windows paths because the mobile client cannot resolve them.
  if (/^[a-z]:\\/i.test(trimmed) || /^\\\\/.test(trimmed)) {
    return false;
  }
  return false;
}

function extractArtworkUrl(snapshot) {
  const candidates = [
    snapshot?.artworkUrl,
    snapshot?.artworkUri,
    snapshot?.thumbnail,
    snapshot?.coverArtUrl,
    snapshot?.imageUrl,
  ];
  for (const candidate of candidates) {
    if (isPortableArtworkUri(candidate)) {
      return candidate.trim();
    }
  }
  return "";
}

function runDotnetCommand(args, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const child = spawn(getDotnetExecutable(), args, {
      cwd: SEEK_HELPER_PROJECT_DIR,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`dotnet command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          stderr.trim() || stdout.trim() || `dotnet exited with code ${code}`,
        ),
      );
    });
  });
}

function ensureSeekHelperBuilt({ force = false } = {}) {
  if (!force && fs.existsSync(SEEK_HELPER_DLL_PATH)) {
    return Promise.resolve();
  }
  if (!seekHelperBuildPromise) {
    seekHelperBuildPromise = runDotnetCommand(
      ["build", "-c", "Release"],
      90_000,
    ).finally(() => {
      seekHelperBuildPromise = null;
    });
  }
  return seekHelperBuildPromise.then(() => {
    if (!fs.existsSync(SEEK_HELPER_DLL_PATH)) {
      throw new Error(
        "Seek helper build completed but output DLL was not found.",
      );
    }
  });
}

async function fetchArtworkFallbackDataUri() {
  await ensureSeekHelperBuilt();
  let output = "";
  try {
    output = await runDotnetCommand(
      [SEEK_HELPER_DLL_PATH, "artwork"],
      ARTWORK_FALLBACK_TIMEOUT_MS,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error || "");
    const looksLikeOldHelper =
      message.includes("Usage: spotify-seek-helper <targetPositionMs>") ||
      message.includes("Unsupported command");
    if (!looksLikeOldHelper) {
      throw error;
    }
    // Existing DLL is stale; rebuild and retry once with artwork command support.
    await ensureSeekHelperBuilt({ force: true });
    output = await runDotnetCommand(
      [SEEK_HELPER_DLL_PATH, "artwork"],
      ARTWORK_FALLBACK_TIMEOUT_MS,
    );
  }
  const firstLine =
    String(output || "")
      .split(/\r?\n/)[0]
      ?.trim() || "";
  if (!isPortableArtworkUri(firstLine)) {
    return "";
  }
  return firstLine;
}

function loadNativeWatcherClass() {
  const nativeModulePath = path.join(
    __dirname,
    "..",
    "native",
    "windows-media-session",
  );
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const nativeModule = require(nativeModulePath);
  return nativeModule.WindowsMediaSessionWatcher;
}

function clampPosition(positionMs, durationMs) {
  const numericPosition = Number(positionMs);
  const safePosition = Number.isFinite(numericPosition)
    ? Math.max(0, numericPosition)
    : 0;
  const safeDuration = Number(durationMs);
  if (Number.isFinite(safeDuration) && safeDuration > 0) {
    return Math.min(safePosition, safeDuration);
  }
  return safePosition;
}

function createEmptyTrack() {
  return {
    trackId: "",
    spotifyTrackId: "",
    title: "",
    artist: "",
    album: "",
    artworkUrl: "",
    durationMs: 0,
    anchorPositionMs: 0,
    anchorMonotonicMs: 0,
    capturedAtMs: 0,
    isPlaying: false,
    source: "none",
  };
}

async function fetchSpotifyPlaybackState(accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch("https://api.spotify.com/v1/me/player", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (response.status === 204) {
      return null;
    }
    if (response.status === 401) {
      throw new Error("Spotify access token expired or invalid.");
    }
    if (!response.ok) {
      throw new Error(`Spotify API HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function createSpotifyDetector() {
  const emitter = new EventEmitter();
  let running = false;
  let statusError = "";
  let artworkStatus = {
    mode: "none",
    fallbackState: "idle",
    fallbackError: "",
  };
  let nativeWatcher = null;
  let emitTimer = null;
  let spotifyApiTimer = null;
  let getSpotifyAccessToken = null;
  let track = createEmptyTrack();
  let lastArtworkTrackId = "";
  let lastArtworkValue = "";
  let lastArtworkBroadcastAt = 0;
  let spotifyApiActive = false;
  let spotifyApiLastError = "";
  let spotifyApiCooldownUntil = 0;
  let catalogEnrichInFlightFor = "";
  let catalogEnrichCompletedFor = "";
  const fallbackArtworkCache = new Map();
  const fallbackArtworkInFlight = new Set();
  const fallbackArtworkFailed = new Set();
  let lastNativeSample = {
    trackId: "",
    positionMs: 0,
    atMono: 0,
    wasPlaying: false,
  };
  let lastRawGsmtcSample = {
    trackId: "",
    positionMs: 0,
    capturedAtMs: 0,
  };
  let measuredPipelineMs = 0;
  let estimatedForwardBiasMs = 0;
  let nativeExtrapolationEnabled = false;

  const shouldApplyForwardBias = () => !nativeExtrapolationEnabled;

  const buildTimingDiagnostics = (nowMono = performance.now()) => {
    const biasFreePositionMs = Math.floor(
      computeBiasFreeProjectedPosition(nowMono),
    );
    const projectedPositionMs = Math.floor(computeProjectedPosition(nowMono));
    const recommendedPhoneCompensationMs = Math.max(
      0,
      nativeExtrapolationEnabled
        ? measuredPipelineMs
        : measuredPipelineMs + estimatedForwardBiasMs,
    );
    return {
      measuredPipelineMs,
      estimatedForwardBiasMs,
      recommendedPhoneCompensationMs,
      projectedPositionMs,
      biasFreePositionMs,
      lastRawGsmtcPositionMs: lastRawGsmtcSample.positionMs,
      nativeExtrapolationEnabled,
      anchorPositionMs: Math.floor(track.anchorPositionMs || 0),
      isPlaying: Boolean(track.isPlaying),
    };
  };

  const clearTrack = () => {
    track = createEmptyTrack();
    lastArtworkTrackId = "";
    lastArtworkValue = "";
    lastArtworkBroadcastAt = 0;
    catalogEnrichInFlightFor = "";
    catalogEnrichCompletedFor = "";
    lastNativeSample = {
      trackId: "",
      positionMs: 0,
      atMono: 0,
      wasPlaying: false,
    };
    lastRawGsmtcSample = {
      trackId: "",
      positionMs: 0,
      capturedAtMs: 0,
    };
    measuredPipelineMs = 0;
    estimatedForwardBiasMs = 0;
    nativeExtrapolationEnabled = false;
    artworkStatus = {
      mode: "none",
      fallbackState: "idle",
      fallbackError: "",
    };
  };

  const rememberNativeSample = (trackId, positionMs, atMono, wasPlaying) => {
    lastNativeSample = {
      trackId: String(trackId || ""),
      positionMs: Number(positionMs) || 0,
      atMono: Number(atMono) || 0,
      wasPlaying: Boolean(wasPlaying),
    };
  };

  const isStaleNativePositionRead = (
    trackId,
    incomingPosition,
    incomingIsPlaying,
    nowMono,
    projectedNow,
  ) => {
    if (
      !incomingIsPlaying ||
      !track.isPlaying ||
      lastNativeSample.trackId !== trackId
    ) {
      return false;
    }

    const jumpFromLastNative =
      incomingPosition - lastNativeSample.positionMs;
    if (Math.abs(jumpFromLastNative) >= NATIVE_SEEK_JUMP_MS) {
      return false;
    }

    const elapsedSinceNative = Math.max(0, nowMono - lastNativeSample.atMono);
    const expectedMinPosition =
      lastNativeSample.positionMs +
      (lastNativeSample.wasPlaying ? elapsedSinceNative : 0) -
      NATIVE_STALE_POSITION_SLACK_MS;

    if (incomingPosition >= expectedMinPosition) {
      return false;
    }

    return projectedNow - incomingPosition >= NATIVE_STALE_IGNORE_DRIFT_MS;
  };

  const requestCatalogEnrichment = () => {
    const trackId = String(track.trackId || "").trim();
    const hasAlbum = Boolean(String(track.album || "").trim());
    if (!trackId || !getSpotifyAccessToken) {
      return;
    }
    if (catalogEnrichInFlightFor === trackId) {
      return;
    }
    if (
      catalogEnrichCompletedFor === trackId &&
      track.spotifyTrackId &&
      hasAlbum
    ) {
      return;
    }
    if (track.spotifyTrackId && hasAlbum) {
      return;
    }

    catalogEnrichInFlightFor = trackId;
    void (async () => {
      try {
        const token = await getSpotifyAccessToken();
        if (!token || track.trackId !== trackId) {
          return;
        }
        const match = track.spotifyTrackId
          ? await resolveSpotifyCatalogTrackById(track.spotifyTrackId, token)
          : await resolveSpotifyCatalogTrackViaPartnerSearch(
              {
                title: track.title,
                artist: track.artist,
                album: track.album,
                durationMs: track.durationMs,
              },
              token,
            );
        if (!match?.id || track.trackId !== trackId) {
          return;
        }

        track = {
          ...track,
          spotifyTrackId: match.id,
          artist: mergeNativePlaybackArtist(track.artist, match.artist),
          album: track.album || match.album || "",
          ...(Number(match.durationMs || 0) > 0
            ? { durationMs: Number(match.durationMs) }
            : {}),
        };
        catalogEnrichCompletedFor = trackId;
        detectorDebugLog("Catalog enrichment applied", {
          trackId,
          spotifyTrackId: match.id,
          artist: track.artist,
          album: track.album,
          catalogTitle: match.title,
        });
        emitPlayback();
      } catch (error) {
        detectorDebugLog("Catalog enrichment failed", {
          trackId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (catalogEnrichInFlightFor === trackId) {
          catalogEnrichInFlightFor = "";
        }
      }
    })();
  };

  const applyResolvedArtwork = (
    trackId,
    artworkUrl,
    mode,
    { force = false } = {},
  ) => {
    if (track.trackId !== trackId || !artworkUrl) {
      return false;
    }
    if (
      !force &&
      track.artworkUrl &&
      !shouldPreferRemoteArtwork(track.artworkUrl, artworkUrl)
    ) {
      return false;
    }
    track = { ...track, artworkUrl };
    fallbackArtworkCache.set(trackId, artworkUrl);
    artworkStatus = {
      mode: mode || artworkStatus.mode || "resolved",
      fallbackState: "success",
      fallbackError: "",
    };
    emitPlayback();
    return true;
  };

  const requestNativeSessionArtwork = (trackId) =>
    fetchArtworkFallbackDataUri()
      .then((dataUri) => {
        if (track.trackId !== trackId) {
          return false;
        }
        if (!dataUri) {
          fallbackArtworkFailed.add(trackId);
          artworkStatus = {
            ...artworkStatus,
            fallbackState: "empty",
            fallbackError: "",
          };
          return false;
        }
        fallbackArtworkCache.set(trackId, dataUri);
        return applyResolvedArtwork(trackId, dataUri, "native-session");
      })
      .catch((error) => {
        fallbackArtworkFailed.add(trackId);
        artworkStatus = {
          ...artworkStatus,
          fallbackState: "error",
          fallbackError:
            error instanceof Error
              ? error.message
              : String(error || "Unknown native artwork error"),
        };
        return false;
      });

  const requestArtworkResolution = (trackId, { force = false } = {}) => {
    if (!trackId) {
      artworkStatus = {
        mode: "none",
        fallbackState: "idle",
        fallbackError: "",
      };
      return;
    }

    if (force) {
      clearRemoteArtworkCache(trackId);
      fallbackArtworkFailed.delete(trackId);
    }

    if (!force) {
      const remoteCached = getCachedRemoteArtwork(trackId);
      if (
        remoteCached?.url &&
        applyResolvedArtwork(trackId, remoteCached.url, remoteCached.source)
      ) {
        return;
      }
      const cached = fallbackArtworkCache.get(trackId);
      if (cached && isPortableArtworkUri(cached)) {
        if (!track.artworkUrl && track.trackId === trackId) {
          applyResolvedArtwork(trackId, cached, "cache");
        }
        if (String(cached).startsWith("https://")) {
          return;
        }
      }
    }

    if (fallbackArtworkInFlight.has(trackId)) {
      artworkStatus = {
        ...artworkStatus,
        fallbackState: "in-progress",
      };
      return;
    }
    if (!force && fallbackArtworkFailed.has(trackId)) {
      artworkStatus = {
        ...artworkStatus,
        fallbackState: "failed",
      };
      return;
    }

    artworkStatus = {
      ...artworkStatus,
      fallbackState: "in-progress",
      fallbackError: "",
    };
    fallbackArtworkInFlight.add(trackId);

    const lookupTrack = {
      trackId,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs,
    };

    void resolveRemoteArtworkUrl(lookupTrack, { force })
      .then((remote) => {
        if (track.trackId !== trackId) {
          return false;
        }
        if (
          remote.url &&
          applyResolvedArtwork(trackId, remote.url, remote.source, { force })
        ) {
          fallbackArtworkFailed.delete(trackId);
          return true;
        }
        if (track.artworkUrl && String(track.artworkUrl).startsWith("https://")) {
          return true;
        }
        return requestNativeSessionArtwork(trackId);
      })
      .catch(() => requestNativeSessionArtwork(trackId))
      .finally(() => {
        fallbackArtworkInFlight.delete(trackId);
      });
  };

  const measurePipelineDelayMs = (captureTimeMs, nowWall, isPlaying) => {
    if (!isPlaying) {
      return 0;
    }
    const sample = Math.max(
      0,
      Math.min(MAX_CAPTURE_DELAY_MS, nowWall - captureTimeMs),
    );
    if (sample > 0) {
      measuredPipelineMs = Math.round(
        measuredPipelineMs * (1 - PIPELINE_DELAY_LEARN_ALPHA) +
          sample * PIPELINE_DELAY_LEARN_ALPHA,
      );
    }
    return sample;
  };

  const learnGsmtcSlipBias = ({
    trackId,
    rawPositionMs,
    captureTimeMs,
    incomingIsPlaying,
    learnAlpha = GSMTC_SLIP_LEARN_ALPHA,
  }) => {
    // Native extrapolation already compensates for stalled GSMTC timeline reads.
    if (nativeExtrapolationEnabled) {
      return;
    }
    if (
      !incomingIsPlaying ||
      !Number.isFinite(rawPositionMs) ||
      lastRawGsmtcSample.trackId !== trackId ||
      lastRawGsmtcSample.capturedAtMs <= 0
    ) {
      return;
    }

    const dt = captureTimeMs - lastRawGsmtcSample.capturedAtMs;
    const rawAdvance = rawPositionMs - lastRawGsmtcSample.positionMs;
    if (dt < GSMTC_SLIP_MIN_DT_MS || rawAdvance < 0) {
      return;
    }

    // Spotify often leaves timeline.Position unchanged while audio advances.
    if (rawAdvance >= dt * GSMTC_SLIP_STALE_RATIO) {
      return;
    }

    const slipMs = Math.max(0, dt - rawAdvance - measuredPipelineMs);
    if (slipMs < 60) {
      return;
    }

    const alpha = Math.max(0.05, Math.min(0.6, learnAlpha));
    estimatedForwardBiasMs = Math.max(
      0,
      Math.min(
        3_000,
        Math.round(
          estimatedForwardBiasMs * (1 - alpha) + slipMs * alpha,
        ),
      ),
    );
    detectorDebugLog("Learned GSMTC slip", {
      dt,
      rawAdvance,
      slipMs,
      estimatedForwardBiasMs,
      measuredPipelineMs,
    });
  };

  const rememberRawGsmtcSample = (trackId, rawPositionMs, capturedAtMs) => {
    if (!Number.isFinite(rawPositionMs)) {
      return;
    }
    lastRawGsmtcSample = {
      trackId: String(trackId || ""),
      positionMs: Number(rawPositionMs) || 0,
      capturedAtMs: Number(capturedAtMs) || 0,
    };
  };

  const computeBiasFreeProjectedPosition = (atMonotonicMs = performance.now()) => {
    if (!track.isPlaying) {
      return clampPosition(track.anchorPositionMs, track.durationMs);
    }
    const elapsedMs = Math.max(0, atMonotonicMs - track.anchorMonotonicMs);
    return clampPosition(track.anchorPositionMs + elapsedMs, track.durationMs);
  };

  const computeProjectedPosition = (atMonotonicMs = performance.now()) => {
    const forwardBiasMs =
      track.isPlaying && shouldApplyForwardBias() ? estimatedForwardBiasMs : 0;
    return clampPosition(
      computeBiasFreeProjectedPosition(atMonotonicMs) + forwardBiasMs,
      track.durationMs,
    );
  };

  const applyNativeSnapshot = (snapshot) => {
    if (!snapshot || !snapshot.title) {
      clearTrack();
      return;
    }

    const nowWall = Date.now();
    const nowMono = performance.now();

    const incomingTrackId = hashTrackId(snapshot.title, snapshot.artist || "");
    const incomingDuration = Number(snapshot.durationMs || 0);
    const incomingIsPlaying = Boolean(snapshot.isPlaying);
    const captureTimeMs = Number(snapshot.capturedAtMs || nowWall);
    const pipelineDelayMs = measurePipelineDelayMs(
      captureTimeMs,
      nowWall,
      incomingIsPlaying,
    );
    const incomingPosition = clampPosition(
      snapshot.positionMs,
      incomingDuration,
    );
    const rawPositionMs = clampPosition(
      Number.isFinite(Number(snapshot.rawPositionMs))
        ? Number(snapshot.rawPositionMs)
        : incomingPosition,
      incomingDuration,
    );
    const timelineSync = Boolean(snapshot.timelineSync);
    if (Number.isFinite(Number(snapshot.positionBasisMs))) {
      if (!nativeExtrapolationEnabled) {
        estimatedForwardBiasMs = 0;
      }
      nativeExtrapolationEnabled = true;
    }
    const correctedIncomingPosition = clampPosition(
      incomingPosition + (incomingIsPlaying ? pipelineDelayMs : 0),
      incomingDuration,
    );
    const changedTrack = incomingTrackId !== track.trackId;
    const projectedForSync = computeBiasFreeProjectedPosition(nowMono);
    const projectedNow = computeProjectedPosition(nowMono);

    const trackAgeMs =
      track.anchorMonotonicMs > 0 ? Math.max(0, nowMono - track.anchorMonotonicMs) : 0;
    learnGsmtcSlipBias({
      trackId: incomingTrackId,
      rawPositionMs,
      captureTimeMs,
      incomingIsPlaying,
      learnAlpha: trackAgeMs < 8_000 ? 0.4 : GSMTC_SLIP_LEARN_ALPHA,
    });

    if (
      shouldApplyForwardBias() &&
      timelineSync &&
      !changedTrack &&
      incomingIsPlaying &&
      track.isPlaying
    ) {
      const syncGap = correctedIncomingPosition - projectedForSync;
      if (syncGap > 80) {
        estimatedForwardBiasMs = Math.max(
          0,
          Math.min(
            3_000,
            Math.round(estimatedForwardBiasMs * 0.7 + syncGap * 0.3),
          ),
        );
      }
    }
    rememberRawGsmtcSample(incomingTrackId, rawPositionMs, captureTimeMs);

    if (changedTrack) {
      const incomingArtworkUrl = extractArtworkUrl(snapshot);
      track = {
        trackId: incomingTrackId,
        title: snapshot.title,
        artist: snapshot.artist || "",
        album: snapshot.album || "",
        artworkUrl: incomingArtworkUrl,
        durationMs: incomingDuration,
        anchorPositionMs: correctedIncomingPosition,
        anchorMonotonicMs: nowMono,
        capturedAtMs: captureTimeMs,
        isPlaying: incomingIsPlaying,
        source: snapshot.source || "windows-media-session-native",
      };
      rememberNativeSample(
        incomingTrackId,
        incomingPosition,
        nowMono,
        incomingIsPlaying,
      );
      artworkStatus = incomingArtworkUrl
        ? { mode: "native", fallbackState: "checking", fallbackError: "" }
        : { mode: "none", fallbackState: "checking", fallbackError: "" };
      requestArtworkResolution(incomingTrackId);
      requestCatalogEnrichment();
      return;
    }

    if (
      isStaleNativePositionRead(
        incomingTrackId,
        incomingPosition,
        incomingIsPlaying,
        nowMono,
        projectedForSync,
      )
    ) {
      detectorDebugLog("Ignoring stale GSMTC position behind projection", {
        incomingPosition,
        projectedNow: projectedForSync,
        expectedMinPosition:
          lastNativeSample.positionMs +
          (lastNativeSample.wasPlaying
            ? Math.max(0, nowMono - lastNativeSample.atMono)
            : 0) -
          NATIVE_STALE_POSITION_SLACK_MS,
      });
      return;
    }

    const driftMs = correctedIncomingPosition - projectedForSync;
    const playbackStateChanged = incomingIsPlaying !== track.isPlaying;
    const isMinorSporadicDrift =
      !timelineSync &&
      incomingIsPlaying &&
      track.isPlaying &&
      !playbackStateChanged &&
      Math.abs(driftMs) < JITTER_RESISTANCE_MS;

    // Ignore tiny native jitter so the local monotonic clock can continue smoothly.
    if (isMinorSporadicDrift) {
      track = {
        ...track,
        title: snapshot.title,
        artist: mergeNativePlaybackArtist(snapshot.artist, track.artist),
        album: snapshot.album || track.album,
        artworkUrl: extractArtworkUrl(snapshot) || track.artworkUrl,
        durationMs: incomingDuration,
        anchorPositionMs: clampPosition(
          track.anchorPositionMs,
          incomingDuration,
        ),
        source:
          snapshot.source || track.source || "windows-media-session-native",
      };
      if (extractArtworkUrl(snapshot)) {
        artworkStatus = {
          mode: "native",
          fallbackState: "not-needed",
          fallbackError: "",
        };
      }
      if (!track.artworkUrl && track.trackId) {
        requestArtworkResolution(track.trackId);
      }
      if (!track.spotifyTrackId || !String(track.album || "").trim()) {
        requestCatalogEnrichment();
      }
      return;
    }

    let nextAnchorPosition = projectedForSync;
    const shouldHardResync =
      timelineSync ||
      playbackStateChanged ||
      (driftMs >= HARD_RESYNC_DRIFT_MS) ||
      (driftMs <= -HARD_RESYNC_DRIFT_MS && incomingPosition < projectedForSync);
    if (shouldHardResync) {
      nextAnchorPosition = correctedIncomingPosition;
    } else if (Math.abs(driftMs) > 1) {
      const correctionMs = Math.max(
        -MAX_SOFT_CORRECTION_MS,
        Math.min(MAX_SOFT_CORRECTION_MS, driftMs * SOFT_CORRECTION_RATIO),
      );
      nextAnchorPosition = projectedForSync + correctionMs;
    }

    track = {
      ...track,
      title: snapshot.title,
      artist: mergeNativePlaybackArtist(snapshot.artist, track.artist),
      album: snapshot.album || track.album,
      artworkUrl: extractArtworkUrl(snapshot) || track.artworkUrl,
      durationMs: incomingDuration,
      anchorPositionMs: clampPosition(nextAnchorPosition, incomingDuration),
      anchorMonotonicMs: nowMono,
      capturedAtMs: captureTimeMs,
      isPlaying: incomingIsPlaying,
      source: snapshot.source || track.source || "windows-media-session-native",
    };
    rememberNativeSample(
      incomingTrackId,
      incomingPosition,
      nowMono,
      incomingIsPlaying,
    );
    if (extractArtworkUrl(snapshot)) {
      artworkStatus = {
        mode: "native",
        fallbackState: "not-needed",
        fallbackError: "",
      };
    }
    if (!track.artworkUrl && track.trackId) {
      requestArtworkResolution(track.trackId);
    }
    if (!track.spotifyTrackId || !String(track.album || "").trim()) {
      requestCatalogEnrichment();
    }
  };

  const applySpotifyApiState = (state) => {
    if (!state || !state.item) {
      detectorDebugLog("Spotify API returned no active item", {
        hasState: Boolean(state),
        stateKeys:
          state && typeof state === "object"
            ? Object.keys(state).slice(0, 12)
            : [],
      });
      clearTrack();
      spotifyApiActive = true;
      return;
    }

    const nowWall = Date.now();
    const nowMono = performance.now();
    const item = state.item;
    const incomingTitle = item.name || "";
    const incomingArtist = (item.artists || []).map((a) => a.name).join(", ");
    const incomingAlbum = item.album?.name || "";
    const incomingDuration = Number(item.duration_ms || 0);
    const incomingIsPlaying = Boolean(state.is_playing);
    const incomingPosition = clampPosition(
      Number(state.progress_ms || 0),
      incomingDuration,
    );
    const spotifyId = item.id || "";
    const incomingTrackId = spotifyId
      ? hashTrackId(incomingTitle, incomingArtist)
      : "";
    detectorDebugLog("Applying Spotify API state", {
      spotifyId,
      incomingTrackId,
      title: incomingTitle,
      artist: incomingArtist,
      album: incomingAlbum,
      durationMs: incomingDuration,
      isPlaying: incomingIsPlaying,
      progressMs: incomingPosition,
      previousTrackId: track.trackId,
      previousSpotifyTrackId: track.spotifyTrackId || "",
      changedTrack: incomingTrackId !== track.trackId,
    });

    const artworkImages = item.album?.images || [];
    const bestImage = artworkImages.reduce((best, img) => {
      if (!best) return img;
      return (img.width || 0) > (best.width || 0) ? img : best;
    }, null);
    const incomingArtworkUrl = bestImage?.url || "";

    const changedTrack = incomingTrackId !== track.trackId;
    const apiDelay = Math.max(
      0,
      Math.min(MAX_CAPTURE_DELAY_MS, SPOTIFY_API_POLL_MS / 2),
    );
    const correctedPosition = clampPosition(
      incomingPosition + (incomingIsPlaying ? apiDelay : 0),
      incomingDuration,
    );

    if (changedTrack) {
      track = {
        trackId: incomingTrackId,
        spotifyTrackId: spotifyId,
        title: incomingTitle,
        artist: incomingArtist,
        album: incomingAlbum,
        artworkUrl: incomingArtworkUrl,
        durationMs: incomingDuration,
        anchorPositionMs: correctedPosition,
        anchorMonotonicMs: nowMono,
        capturedAtMs: nowWall,
        isPlaying: incomingIsPlaying,
        source: "spotify-api",
      };
      artworkStatus = incomingArtworkUrl
        ? {
            mode: "spotify-api",
            fallbackState: "not-needed",
            fallbackError: "",
          }
        : { mode: "none", fallbackState: "idle", fallbackError: "" };
      spotifyApiActive = true;
      catalogEnrichCompletedFor = incomingTrackId;
      detectorDebugLog("Spotify API replaced track state", {
        trackId: track.trackId,
        spotifyTrackId: track.spotifyTrackId || "",
        source: track.source,
      });
      return;
    }

    const projectedNow = computeProjectedPosition(nowMono);
    const driftMs = correctedPosition - projectedNow;
    const playbackStateChanged = incomingIsPlaying !== track.isPlaying;
    const isMinorDrift =
      incomingIsPlaying &&
      track.isPlaying &&
      !playbackStateChanged &&
      Math.abs(driftMs) < JITTER_RESISTANCE_MS;

    if (isMinorDrift) {
      track = {
        ...track,
        spotifyTrackId: spotifyId,
        artworkUrl: incomingArtworkUrl || track.artworkUrl,
        durationMs: incomingDuration,
        source: "spotify-api",
      };
      spotifyApiActive = true;
      return;
    }

    let nextAnchorPosition = projectedNow;
    if (playbackStateChanged || Math.abs(driftMs) >= HARD_RESYNC_DRIFT_MS) {
      nextAnchorPosition = correctedPosition;
    } else if (Math.abs(driftMs) > 1) {
      const correctionMs = Math.max(
        -MAX_SOFT_CORRECTION_MS,
        Math.min(MAX_SOFT_CORRECTION_MS, driftMs * SOFT_CORRECTION_RATIO),
      );
      nextAnchorPosition = projectedNow + correctionMs;
    }

    track = {
      ...track,
      spotifyTrackId: spotifyId,
      artworkUrl: incomingArtworkUrl || track.artworkUrl,
      durationMs: incomingDuration,
      anchorPositionMs: clampPosition(nextAnchorPosition, incomingDuration),
      anchorMonotonicMs: nowMono,
      capturedAtMs: nowWall,
      isPlaying: incomingIsPlaying,
      source: "spotify-api",
    };
    spotifyApiActive = true;
    detectorDebugLog("Spotify API updated existing track state", {
      trackId: track.trackId,
      spotifyTrackId: track.spotifyTrackId || "",
      source: track.source,
    });
  };

  const pollSpotifyApi = async () => {
    if (SPOTIFY_PLAYBACK_API_DISABLED) {
      detectorDebugLog("Spotify API polling disabled by environment flag");
      return;
    }
    if (spotifyApiCooldownUntil > Date.now()) {
      detectorDebugLog("Spotify API polling skipped during cooldown", {
        remainingMs: Math.max(0, spotifyApiCooldownUntil - Date.now()),
      });
      return;
    }
    if (!getSpotifyAccessToken) {
      detectorDebugLog(
        "Spotify API polling skipped because token getter is missing",
      );
      return;
    }
    let token = "";
    try {
      token = await getSpotifyAccessToken();
    } catch {
      detectorDebugLog("Spotify API polling failed while obtaining token");
      return;
    }
    if (!token) {
      detectorDebugLog("Spotify API polling skipped because token was empty");
      return;
    }
    try {
      const state = await fetchSpotifyPlaybackState(token);
      spotifyApiLastError = "";
      spotifyApiCooldownUntil = 0;
      detectorDebugLog("Spotify API polling succeeded", {
        hasItem: Boolean(state?.item),
        isPlaying: Boolean(state?.is_playing),
        itemId: String(state?.item?.id || ""),
        itemName: String(state?.item?.name || ""),
      });
      applySpotifyApiState(state);
      emitPlayback();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spotifyApiLastError = message;
      if (message.includes("HTTP 429")) {
        spotifyApiCooldownUntil = Date.now() + SPOTIFY_API_429_COOLDOWN_MS;
      }
      detectorDebugLog("Spotify API polling failed", {
        error: message,
        cooldownRemainingMs: Math.max(0, spotifyApiCooldownUntil - Date.now()),
      });
      if (message.includes("expired or invalid")) {
        try {
          const refreshed = await getSpotifyAccessToken({
            forceRefresh: true,
            interactiveOnFailure: true,
          });
          if (refreshed) {
            const state = await fetchSpotifyPlaybackState(refreshed);
            spotifyApiLastError = "";
            spotifyApiCooldownUntil = 0;
            detectorDebugLog(
              "Spotify API polling succeeded after token refresh",
              {
                hasItem: Boolean(state?.item),
                isPlaying: Boolean(state?.is_playing),
                itemId: String(state?.item?.id || ""),
                itemName: String(state?.item?.name || ""),
              },
            );
            applySpotifyApiState(state);
            emitPlayback();
          }
        } catch {
          // Keep the original error message; refresh will be retried next poll.
        }
      }
    }
  };

  const emitPlayback = () => {
    const nowWall = Date.now();
    const nowMono = performance.now();
    const elapsedMs = track.isPlaying
      ? Math.max(0, nowMono - track.anchorMonotonicMs)
      : 0;
    const artworkChanged =
      track.trackId !== lastArtworkTrackId ||
      track.artworkUrl !== lastArtworkValue;
    const artworkNeedsRebroadcast =
      Boolean(track.artworkUrl) &&
      nowWall - lastArtworkBroadcastAt >= ARTWORK_REBROADCAST_INTERVAL_MS;
    const shouldIncludeArtwork =
      Boolean(track.artworkUrl) && (artworkChanged || artworkNeedsRebroadcast);
    if (shouldIncludeArtwork) {
      lastArtworkTrackId = track.trackId;
      lastArtworkValue = track.artworkUrl;
      lastArtworkBroadcastAt = nowWall;
    }

    const timing = buildTimingDiagnostics(nowMono);
    emitter.emit("snapshot", {
      trackId: track.trackId,
      spotifyTrackId: track.spotifyTrackId || "",
      title: track.title,
      artist: track.artist,
      album: track.album,
      artworkUrl: shouldIncludeArtwork ? track.artworkUrl : undefined,
      durationMs: track.durationMs,
      positionMs: timing.projectedPositionMs,
      isPlaying: track.isPlaying,
      timestamp: nowWall,
      capturedAtMs: nowWall,
      timing,
    });
  };

  const refetchArtwork = () => {
    if (!track.trackId) {
      return;
    }
    lastArtworkTrackId = "";
    lastArtworkValue = "";
    lastArtworkBroadcastAt = 0;
    fallbackArtworkFailed.delete(track.trackId);
    requestArtworkResolution(track.trackId, { force: true });
    emitPlayback();
  };

  const onNativeSnapshot = (snapshot) => {
    statusError = "";
    if (spotifyApiActive && track.source === "spotify-api") {
      return;
    }
    applyNativeSnapshot(snapshot);
    emitPlayback();
  };

  const onNativeError = (message) => {
    statusError = String(message || "Unknown native watcher error");
    emitter.emit("error", new Error(statusError));
  };

  return Object.assign(emitter, {
    setSpotifyAccessTokenGetter(getter) {
      getSpotifyAccessToken = typeof getter === "function" ? getter : null;
    },
    refetchArtwork,
    start() {
      if (running) {
        return;
      }

      running = true;
      clearTrack();

      try {
        const WatcherClass = loadNativeWatcherClass();
        nativeWatcher = new WatcherClass(onNativeSnapshot, onNativeError);
        nativeWatcher.start();
      } catch (error) {
        statusError =
          error instanceof Error
            ? `Native watcher unavailable: ${error.message}`
            : `Native watcher unavailable: ${String(error)}`;
        emitter.emit("error", new Error(statusError));
      }

      emitTimer = setInterval(() => {
        emitPlayback();
      }, EMIT_INTERVAL_MS);

      if (!SPOTIFY_PLAYBACK_API_DISABLED) {
        spotifyApiTimer = setInterval(() => {
          void pollSpotifyApi();
        }, SPOTIFY_API_POLL_MS);
        void pollSpotifyApi();
      }

      emitPlayback();
    },
    stop() {
      running = false;
      if (emitTimer) {
        clearInterval(emitTimer);
        emitTimer = null;
      }
      if (spotifyApiTimer) {
        clearInterval(spotifyApiTimer);
        spotifyApiTimer = null;
      }
      if (nativeWatcher && typeof nativeWatcher.stop === "function") {
        nativeWatcher.stop();
      }
      nativeWatcher = null;
      clearTrack();
      spotifyApiActive = false;
    },
    getTimingDiagnostics() {
      return buildTimingDiagnostics();
    },
    getStatus() {
      const artwork = track.artworkUrl || "";
      const timing = buildTimingDiagnostics();
      return {
        detectorRunning: running,
        source: track.source,
        detectorError: statusError,
        spotifyApiActive,
        spotifyApiLastError: spotifyApiLastError,
        spotifyApiCooldownRemainingMs: Math.max(
          0,
          spotifyApiCooldownUntil - Date.now(),
        ),
        spotifyPlaybackApiDisabled: SPOTIFY_PLAYBACK_API_DISABLED,
        ...timing,
        artworkMode: artworkStatus.mode,
        artworkFallbackState: artworkStatus.fallbackState,
        artworkFallbackError: artworkStatus.fallbackError,
        artworkHasValue: Boolean(artwork),
        artworkValueLength: artwork.length,
        artworkPreview: artwork ? artwork.slice(0, 48) : "",
        artworkUrl: artwork,
      };
    },
  });
}

module.exports = {
  createSpotifyDetector,
};
