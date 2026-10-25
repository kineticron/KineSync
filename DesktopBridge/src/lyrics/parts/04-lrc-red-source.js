"use strict";

// Public API: https://lrc.red/docs. Resolve ISRCs before using text search;
// TTML preserves supplied word/syllable timing and background vocals.
const lrcRedIsrcCache = new Map();
const lrcRedHeaders = { "User-Agent": "KineSync/1.2.0 (https://github.com/Kineticron/KineSync)" };

async function fetchFromLrcRed(track) {
  const { parseTtmlToLyrics, parseTtmlTimeExpression } = require("./lyricsTtmlImport");
  const directIsrc = String(track?.isrc || track?.external_ids?.isrc || "")
    .replace(/[-\s]/g, "")
    .toUpperCase();
  const validIsrc = (value) => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(value);
  const cacheKey = JSON.stringify([normalizeText(track?.title), normalizeArtistText(track?.artist), Number(track?.durationMs || 0)]);
  let candidates = validIsrc(directIsrc) ? [{ isrc: directIsrc }] : [];
  let lastError = null;
  if (!candidates.length) {
    const cached = lrcRedIsrcCache.get(cacheKey);
    if (cached) candidates = [{ isrc: cached }];
    else if (String(track?.title || "").trim()) {
      try {
        const payload = await fetchJson("https://api.deezer.com/search", {
          params: { q: `${track.artist || ""} ${track.title}`.trim() },
        });
        candidates = (Array.isArray(payload?.data) ? payload.data : [])
          .map((hit) => ({ ...hit, artist: hit.artist?.name || "", durationMs: Number(hit.duration) * 1000 }))
          .filter((hit) => validIsrc(hit.isrc) &&
            isLikelySameTrack(track, hit.title, hit.artist, hit.durationMs) &&
            (!(Number(track.durationMs) > 0) || Math.abs(hit.durationMs - Number(track.durationMs)) <= 3000))
          .map((hit) => ({ ...hit, score: scoreCandidate(track, hit.title, hit.artist) +
            scoreDurationBonus(track, hit.title, hit.artist, hit.durationMs) }))
          .sort((left, right) => compareCandidateMatchQuality(track, left, right))
          .slice(0, 1);
        if (candidates.length) {
          // Bound the per-track cache for long-running sessions. Do not cache misses.
          if (lrcRedIsrcCache.size >= 1000) lrcRedIsrcCache.delete(lrcRedIsrcCache.keys().next().value);
          lrcRedIsrcCache.set(cacheKey, candidates[0].isrc);
        }
      } catch (error) { lastError = error; }
    }
  }
  async function searchFallback() {
    if (!String(track?.title || "").trim()) return [];
    const payload = await fetchJson("https://lrc.red/search.json", {
      headers: lrcRedHeaders,
      params: { q: `${track.title} ${track.artist || ""}`.trim() },
    });
    return (Array.isArray(payload?.hits) ? payload.hits : [])
      .map((hit) => ({
        ...hit,
        durationMs: Number(hit.duration || 0) * 1000,
        score: scoreCandidate(track, hit.title, hit.artist) +
          scoreDurationBonus(track, hit.title, hit.artist, Number(hit.duration || 0) * 1000),
      }))
      .filter((hit) =>
        validIsrc(hit.isrc) &&
        isLikelySameTrack(track, hit.title, hit.artist, hit.durationMs),
      )
      .sort((left, right) => compareCandidateMatchQuality(track, left, right))
      .slice(0, 3);
  }

  let bestResult = null;
  const attempted = new Set();
  for (let phase = 0; phase < 2; phase++) {
    if (phase === 1) {
      try { candidates = await searchFallback(); } catch (error) { lastError = error; candidates = []; }
    }
    const errors = [];
    // Start all bounded candidate requests concurrently, but consume them in
    // ranked order so a top-ranked karaoke result can return as soon as it
    // settles without waiting for lower-ranked (possibly hanging) requests.
    const candidatePromises = candidates.filter((candidate) => {
      if (attempted.has(candidate.isrc)) return false;
      attempted.add(candidate.isrc);
      return true;
    }).map(async (candidate, index) => {
      try {
        const recording = await fetchJson(`https://lrc.red/s/${candidate.isrc}.json`, { headers: lrcRedHeaders });
        if (!["word", "line"].includes(recording?.sync)) return null;
        const content = await fetchText(`https://lrc.red/s/${candidate.isrc}.ttml`, { headers: lrcRedHeaders });
        // Reject static lyrics, HTML error pages, and invalid payloads.
        if (!/<(?:p|span)\b[^>]*\bbegin\s*=/i.test(content)) return null;
        const timings = [...content.matchAll(/\b(?:begin|end)\s*=\s*["']([^"']+)["']/gi)];
        if (!timings.some((match) => parseTtmlTimeExpression(match[1]) > 0)) return null;
        const parsed = parseTtmlToLyrics(content);
        if (!parsed.lyrics?.some((line) =>
          Number(line.lineEndTime) > Number(line.lineStartTime),
        )) return null;
        return {
          lyrics: parsed.lyrics,
          source: parsed.useKaraokeTiming ? "lrc-red-karaoke" : "lrc-red-line",
          metadata: {
            ...(parsed.metadata || {}),
            attribution: {
              source: "lrc-red",
              provider: "lrc.red",
              url: `https://lrc.red/s/${candidate.isrc}`,
            },
          },
        };
      } catch (error) {
        if (!/HTTP 404\b/.test(String(error?.message || error))) errors[index] = error;
        return null;
      }
    });
    for (const promise of candidatePromises) {
      const result = await promise;
      if (!result) continue;
      if (result.source === "lrc-red-karaoke") return result;
      bestResult ||= result;
    }
    if (bestResult) return bestResult;
    lastError = errors.filter(Boolean).pop() || lastError;
  }
  if (lastError) throw lastError;
  return null;
}
