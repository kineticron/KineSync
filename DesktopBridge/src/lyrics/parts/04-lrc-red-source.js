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

  let bestResult = null;
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const content = await fetchText(`https://lrc.red/s/${candidate.isrc}.ttml`);
      // Reject static lyrics, HTML error pages, and invalid payloads.
      if (!/<(?:p|span)\b[^>]*\bbegin\s*=/i.test(content)) continue;
      const timings = [...content.matchAll(/\b(?:begin|end)\s*=\s*["']([^"']+)["']/gi)];
      if (!timings.some((match) => parseTtmlTimeExpression(match[1]) > 0)) continue;
      const parsed = parseTtmlToLyrics(content);
      if (!parsed.lyrics?.some((line) =>
        Number(line.lineEndTime) > Number(line.lineStartTime),
      )) continue;
      const result = {
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
      if (parsed.useKaraokeTiming) return result;
      bestResult ||= result;
    } catch (error) {
      if (!/HTTP 404\b/.test(String(error?.message || error))) lastError = error;
    }
  }
  if (bestResult) return bestResult;
  if (lastError) throw lastError;
  return null;
}
