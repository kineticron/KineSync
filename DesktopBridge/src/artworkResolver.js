const DEEZER_SEARCH_URL = "https://api.deezer.com/search/track";
const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";
const SEARCH_LIMIT = 8;
const MIN_ACCEPT_SCORE = 5;
const FETCH_TIMEOUT_MS = 8_000;
const ITUNES_MIN_INTERVAL_MS = 3_200;
const USER_AGENT =
  process.env.BRIDGE_ARTWORK_USER_AGENT ||
  "KineSyncDesktopBridge/1.0 (+https://github.com/KineSync/KineSync)";

const remoteCache = new Map();

let lastItunesRequestAt = 0;

function normalizeText(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCoreTitle(input) {
  return normalizeText(
    String(input || "").replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " "),
  );
}

function getPrimaryArtistName(input) {
  const raw = String(input || "").trim();
  const parts = raw.split(/\b(?:feat\.?|ft\.?|featuring)\b/i);
  return (parts[0] || raw).trim();
}

function getArtistOverlap(trackArtist, candidateArtist) {
  const trackPrimary = normalizeText(getPrimaryArtistName(trackArtist));
  const candidatePrimary = normalizeText(getPrimaryArtistName(candidateArtist));
  if (!trackPrimary || !candidatePrimary) {
    return 0;
  }
  if (trackPrimary === candidatePrimary) {
    return 1;
  }
  if (
    trackPrimary.includes(candidatePrimary) ||
    candidatePrimary.includes(trackPrimary)
  ) {
    return 0.72;
  }
  const trackTokens = new Set(trackPrimary.split(" ").filter(Boolean));
  const candidateTokens = candidatePrimary.split(" ").filter(Boolean);
  if (!candidateTokens.length) {
    return 0;
  }
  let hits = 0;
  for (const token of candidateTokens) {
    if (trackTokens.has(token)) {
      hits += 1;
    }
  }
  return hits / candidateTokens.length;
}

function scoreTitleMatch(trackTitle, candidateTitle) {
  const trackCore = normalizeCoreTitle(trackTitle);
  const candidateCore = normalizeCoreTitle(candidateTitle);
  if (!trackCore || !candidateCore) {
    return 0;
  }
  if (trackCore === candidateCore) {
    return 4;
  }
  if (
    trackCore.includes(candidateCore) ||
    candidateCore.includes(trackCore)
  ) {
    return 2;
  }
  return 0;
}

function scoreDurationBonus(trackDurationMs, candidateDurationMs) {
  if (!(trackDurationMs > 0 && candidateDurationMs > 0)) {
    return 0;
  }
  const delta = Math.abs(candidateDurationMs - trackDurationMs);
  if (delta < 1_200) {
    return 2.5;
  }
  if (delta < 4_000) {
    return 1.5;
  }
  if (delta > 12_000) {
    return -2.5;
  }
  return 0;
}

function scoreArtworkCandidate(track, candidate) {
  const titleScore = scoreTitleMatch(track.title, candidate.title);
  const artistOverlap = getArtistOverlap(track.artist, candidate.artist);
  if (artistOverlap < 0.42 && titleScore < 4) {
    return -1;
  }
  const artistScore = artistOverlap * 3;
  const durationScore = scoreDurationBonus(
    track.durationMs,
    candidate.durationMs,
  );
  return titleScore + artistScore + durationScore;
}

function buildSearchQueries(track) {
  const title = String(track.title || "").trim();
  const artist = String(track.artist || "").trim();
  const album = String(track.album || "").trim();
  const primaryArtist = getPrimaryArtistName(artist);
  const queries = [];
  const seen = new Set();
  const add = (value) => {
    const safe = String(value || "").trim();
    const key = safe.toLowerCase();
    if (!safe || seen.has(key)) {
      return;
    }
    seen.add(key);
    queries.push(safe);
  };
  if (primaryArtist && title) {
    add(`${primaryArtist} ${title}`);
  }
  if (artist && title) {
    add(`${artist} ${title}`);
  }
  if (primaryArtist && title && album) {
    add(`${primaryArtist} ${title} ${album}`);
  }
  if (title) {
    add(title);
  }
  return queries.slice(0, 3);
}

function pickBestCandidate(track, candidates) {
  let best = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scoreArtworkCandidate(track, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best || bestScore < MIN_ACCEPT_SCORE) {
    return null;
  }
  return { ...best, score: bestScore };
}

function upscaleItunesArtworkUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/100x100bb/g, "600x600bb")
    .replace(/60x60bb/g, "600x600bb");
}

async function fetchJson(url, { signal } = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function waitForItunesSlot() {
  const now = Date.now();
  const waitMs = ITUNES_MIN_INTERVAL_MS - (now - lastItunesRequestAt);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastItunesRequestAt = Date.now();
}

function mapDeezerCandidates(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map((row) => ({
      title: String(row?.title || ""),
      artist: String(row?.artist?.name || ""),
      durationMs: Math.max(0, Math.floor(Number(row?.duration) || 0) * 1000),
      artworkUrl: String(
        row?.album?.cover_xl ||
          row?.album?.cover_big ||
          row?.album?.cover_medium ||
          "",
      ).trim(),
      source: "deezer",
    }))
    .filter((row) => row.title && row.artworkUrl);
}

function mapItunesCandidates(payload) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  return rows
    .map((row) => ({
      title: String(row?.trackName || ""),
      artist: String(row?.artistName || ""),
      durationMs: Math.max(0, Math.floor(Number(row?.trackTimeMillis) || 0)),
      artworkUrl: upscaleItunesArtworkUrl(
        String(
          row?.artworkUrl600 ||
            row?.artworkUrl100 ||
            row?.artworkUrl60 ||
            "",
        ).trim(),
      ),
      source: "itunes",
    }))
    .filter((row) => row.title && row.artworkUrl);
}

async function searchDeezer(track) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const candidates = [];
    for (const query of buildSearchQueries(track)) {
      const url = `${DEEZER_SEARCH_URL}?limit=${SEARCH_LIMIT}&q=${encodeURIComponent(query)}`;
      const payload = await fetchJson(url, { signal: controller.signal });
      candidates.push(...mapDeezerCandidates(payload));
      const best = pickBestCandidate(track, candidates);
      if (best) {
        return best;
      }
    }
    return pickBestCandidate(track, candidates);
  } finally {
    clearTimeout(timer);
  }
}

async function searchItunes(track) {
  await waitForItunesSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const candidates = [];
    for (const query of buildSearchQueries(track)) {
      const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(query)}&entity=song&limit=${SEARCH_LIMIT}`;
      const payload = await fetchJson(url, { signal: controller.signal });
      candidates.push(...mapItunesCandidates(payload));
      const best = pickBestCandidate(track, candidates);
      if (best) {
        return best;
      }
    }
    return pickBestCandidate(track, candidates);
  } finally {
    clearTimeout(timer);
  }
}

function getCacheKey(track) {
  return String(track?.trackId || "").trim();
}

function getCachedRemoteArtwork(trackId) {
  const key = String(trackId || "").trim();
  if (!key) {
    return null;
  }
  return remoteCache.get(key) || null;
}

function clearRemoteArtworkCache(trackId) {
  const key = String(trackId || "").trim();
  if (!key) {
    return;
  }
  remoteCache.delete(key);
}

function isRemoteArtworkUrl(url) {
  return /^https:\/\//i.test(String(url || "").trim());
}

function shouldPreferRemoteArtwork(currentUrl, nextUrl) {
  const next = String(nextUrl || "").trim();
  if (!isRemoteArtworkUrl(next)) {
    return false;
  }
  const current = String(currentUrl || "").trim();
  if (!current) {
    return true;
  }
  if (current.startsWith("data:image/")) {
    return true;
  }
  return isRemoteArtworkUrl(current) && current !== next;
}

async function resolveRemoteArtworkUrl(track, { force = false } = {}) {
  const cacheKey = getCacheKey(track);
  if (!cacheKey || !String(track?.title || "").trim()) {
    return { url: "", source: "", score: 0 };
  }
  if (!force) {
    const cached = remoteCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  let match = null;
  try {
    match = await searchDeezer(track);
  } catch {
    match = null;
  }

  if (!match) {
    try {
      match = await searchItunes(track);
    } catch {
      match = null;
    }
  }

  const resolved = match
    ? {
        url: match.artworkUrl,
        source: match.source,
        score: match.score,
      }
    : { url: "", source: "", score: 0 };

  if (resolved.url) {
    remoteCache.set(cacheKey, resolved);
  }

  return resolved;
}

module.exports = {
  clearRemoteArtworkCache,
  getCachedRemoteArtwork,
  resolveRemoteArtworkUrl,
  shouldPreferRemoteArtwork,
};
