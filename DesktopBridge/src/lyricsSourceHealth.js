const {
  getAvailableLyricsSources,
  getTemporarilyDisabledLyricsSources,
  normalizeLyricsSourceKey,
  probeLyricsSource,
} = require("./lyrics");

const DEFAULT_PROBE_TRACKS = Object.freeze([
  {
    trackId: "probe-1",
    title: "稻香",
    artist: "周杰伦",
    durationMs: 223_000,
  },
  {
    trackId: "probe-2",
    title: "晴天",
    artist: "周杰伦",
    durationMs: 269_000,
  },
  {
    trackId: "probe-3",
    title: "See You Again",
    artist: "Wiz Khalifa",
    durationMs: 229_000,
  },
]);

function resolveRequestedSources(requestedSources = []) {
  const availableSources = getAvailableLyricsSources();
  const normalizedRequested = (Array.isArray(requestedSources)
    ? requestedSources
    : []
  )
    .map((source) => String(source || "").trim())
    .filter(Boolean);

  if (
    normalizedRequested.length === 0 ||
    normalizedRequested.some((source) => source.toLowerCase() === "all")
  ) {
    return {
      selectedSources: availableSources,
      unknownSources: [],
      availableSources,
    };
  }

  const selectedSources = [];
  const unknownSources = [];
  const seen = new Set();
  for (const source of normalizedRequested) {
    const normalized = normalizeLyricsSourceKey(source);
    if (!availableSources.includes(normalized)) {
      unknownSources.push(source);
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    selectedSources.push(normalized);
  }

  return { selectedSources, unknownSources, availableSources };
}

function createSafeProbeTrack(track, index) {
  return {
    trackId: String(track?.trackId || `probe-${index + 1}`),
    title: String(track?.title || "").trim(),
    artist: String(track?.artist || "").trim(),
    durationMs: Number(track?.durationMs || 0),
  };
}

async function runLyricsSourceHealthCheck({
  sources = [],
  tracks = DEFAULT_PROBE_TRACKS,
  minPasses = 1,
} = {}) {
  const { selectedSources, unknownSources, availableSources } =
    resolveRequestedSources(sources);
  const safeTracks = (Array.isArray(tracks) ? tracks : []).map((track, index) =>
    createSafeProbeTrack(track, index),
  );
  const safeMinPasses = Math.max(1, Number(minPasses) || 1);

  const sourceResults = [];
  for (const source of selectedSources) {
    const trackResults = [];
    for (const track of safeTracks) {
      const probeResult = await probeLyricsSource(track, source);
      trackResults.push({
        track,
        ...probeResult,
      });
    }

    const passCount = trackResults.filter((result) => result.ok).length;
    sourceResults.push({
      source,
      passCount,
      totalTracks: trackResults.length,
      isHealthy: passCount >= safeMinPasses,
      trackResults,
    });
  }

  return {
    selectedSources,
    unknownSources,
    availableSources,
    disabledSources: getTemporarilyDisabledLyricsSources(),
    minPasses: safeMinPasses,
    sourceResults,
    allHealthy: sourceResults.every((result) => result.isHealthy),
  };
}

module.exports = {
  DEFAULT_PROBE_TRACKS,
  resolveRequestedSources,
  runLyricsSourceHealthCheck,
};
