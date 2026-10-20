"use strict";

// Public API: https://lrc.red/docs. Search resolves recordings to ISRCs;
// TTML preserves supplied word/syllable timing and background vocals.
async function fetchFromLrcRed(track) {
  const { parseTtmlToLyrics, parseTtmlTimeExpression } = require("./lyricsTtmlImport");
  const directIsrc = String(track?.isrc || track?.external_ids?.isrc || "")
    .replace(/[-\s]/g, "")
    .toUpperCase();
  const validIsrc = (value) => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(value);
  let candidates = validIsrc(directIsrc) ? [{ isrc: directIsrc }] : [];
  if (!candidates.length) {
    if (!String(track?.title || "").trim()) return null;
    const payload = await fetchJson("https://lrc.red/search.json", {
      params: { q: `${track.title} ${track.artist || ""}`.trim() },
    });
    candidates = (Array.isArray(payload?.hits) ? payload.hits : [])
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

  const errors = [];
  // Start all bounded candidate requests concurrently, but consume them in
  // ranked order so a top-ranked karaoke result can return as soon as it
  // settles without waiting for lower-ranked (possibly hanging) requests.
  const candidatePromises = candidates.map(async (candidate, index) => {
    try {
      const content = await fetchText(`https://lrc.red/s/${candidate.isrc}.ttml`);
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
  let bestResult = null;
  for (const promise of candidatePromises) {
    const result = await promise;
    if (!result) continue;
    if (result.source === "lrc-red-karaoke") return result;
    bestResult ||= result;
  }
  if (bestResult) return bestResult;
  const lastError = errors.filter(Boolean).pop();
  if (lastError) throw lastError;
  return null;
}
