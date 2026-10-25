"use strict";

// Resolve catalog ISRCs before text search. Keep supplied TTML timing intact.
const lrcRedIsrcCache = new Map();
const lrcRedHeaders = { "User-Agent": "KineSync/1.2.0 (https://github.com/Kineticron/KineSync)" };

async function fetchFromLrcRed(track) {
  const { parseTtmlToLyrics, parseTtmlTimeExpression } = require("./lyricsTtmlImport");
  const directIsrc = String(track?.isrc || track?.external_ids?.isrc || "")
    .replace(/[-\s]/g, "").toUpperCase();
  const validIsrc = (value) => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(value);
  const cacheKey = JSON.stringify([normalizeText(track?.title), normalizeArtistText(track?.artist), Number(track?.durationMs || 0)]);
  const cached = lrcRedIsrcCache.get(cacheKey);
  let matchTrack = { ...track, artist: cached?.artist || track.artist };
  let lastError = null;
  let bestResult = null;
  const attempted = new Set();
  const stripRemaster = (title) => String(title || "")
    .replace(/\s*\([^)]*\bremaster(?:ed)?\b[^)]*\)/gi, "")
    .replace(/\s*[-–]\s*(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?\s*$/i, "").trim();
  const durationMatches = (durationMs) => !(Number(track.durationMs) > 0) ||
    (Number(durationMs) > 0 && Math.abs(Number(durationMs) - Number(track.durationMs)) <= 3000);
  function versionMatches(title) {
    const wanted = normalizeText(track.title);
    const actual = normalizeText(title);
    for (const hint of [/\blive\b|\bconcert\b|\bfirst take\b|\bunplugged\b/, /\bremix\b|\bmix\b/, /\bacoustic\b/, /\binstrumental\b|\bkaraoke\b/, /\bsped up\b/, /\bslowed\b/, /\bdemo\b/, /\bmono\b/, /\blong version\b|\bextended\b/]) {
      if (hint.test(wanted) !== hint.test(actual)) return false;
    }
    // A catalog can omit a remaster suffix, but an explicitly different year is not equivalent.
    if (/\bremaster/.test(wanted) && /\bremaster/.test(actual)) {
      const years = (value) => value.match(/\b(?:19|20)\d{2}\b/g) || [];
      if (years(wanted).length && years(actual).length && !years(wanted).some(year => years(actual).includes(year))) return false;
    }
    return true;
  }
  function matches(hit, artist = hit.artist) {
    return durationMatches(hit.durationMs) && versionMatches(hit.title) &&
      isLikelySameTrack({ ...matchTrack, title: stripRemaster(track.title) }, stripRemaster(hit.title), artist, hit.durationMs) &&
      artistNamesLookRelated(matchTrack.artist, artist);
  }
  function rank(hits) {
    return hits.map(hit => ({ ...hit, score: scoreCandidate(matchTrack, hit.title, hit.artist) +
      scoreDurationBonus(matchTrack, hit.title, hit.artist, hit.durationMs) }))
      .sort((left, right) => compareCandidateMatchQuality(matchTrack, left, right));
  }
  function remember(isrc) {
    if (lrcRedIsrcCache.size >= 1000) lrcRedIsrcCache.delete(lrcRedIsrcCache.keys().next().value);
    lrcRedIsrcCache.set(cacheKey, { isrc, artist: matchTrack.artist });
  }
  async function catalogCandidates() {
    const payload = await fetchJson("https://api.deezer.com/search", {
      params: { q: `${track.artist || ""} ${track.title}`.trim() },
    });
    const hits = (Array.isArray(payload?.data) ? payload.data : [])
      .map(hit => ({ ...hit, artistId: hit.artist?.id, artist: hit.artist?.name || "", durationMs: Number(hit.duration) * 1000 }))
      .filter(hit => validIsrc(hit.isrc));
    let accepted = hits.filter(hit => matches(hit));
    if (!accepted.length && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(track.artist || "")) {
      // Corroborate translated artist names with the catalog's artist search and ID.
      // Title and duration alone must never authorize a cross-script artist match.
      const artists = await fetchJson("https://api.deezer.com/search/artist", { params: { q: track.artist } });
      const canonical = artists?.data?.[0];
      if (canonical?.id && canonical.name && hits.some(hit => Number(hit.artistId) === Number(canonical.id))) {
        matchTrack = { ...matchTrack, artist: `${track.artist} (${canonical.name})` };
        accepted = hits.filter(hit => Number(hit.artistId) === Number(canonical.id) && matches(hit));
      }
    }
    return rank(accepted).filter((hit, index, all) =>
      all.findIndex(other => other.isrc === hit.isrc) === index).slice(0, 3);
  }
  async function searchFallback() {
    if (!String(track?.title || "").trim()) return [];
    const payload = await fetchJson("https://lrc.red/search.json", {
      headers: lrcRedHeaders,
      params: { q: `${track.title} ${matchTrack.artist || ""}`.trim() },
    });
    return rank((Array.isArray(payload?.hits) ? payload.hits : [])
      .map(hit => ({ ...hit, durationMs: Number(hit.duration || 0) * 1000 }))
      .filter(hit => validIsrc(hit.isrc) && matches(hit))).slice(0, 3);
  }
  async function tryCandidates(candidates) {
    const errors = [];
    // Fetch bounded candidates concurrently, consuming results in ranked order.
    const candidatePromises = candidates.filter((candidate) => {
      if (attempted.has(candidate.isrc)) return false;
      attempted.add(candidate.isrc);
      return true;
    }).map(async (candidate, index) => {
      try {
        const recording = await fetchJson(`https://lrc.red/s/${candidate.isrc}.json`, { headers: lrcRedHeaders });
        if (recording?.duration != null && !durationMatches(Number(recording.duration) * 1000)) return null;
        if (recording?.title && !versionMatches(recording.title)) return null;
        if (!["word", "line"].includes(recording?.sync)) return null;
        const content = await fetchText(`https://lrc.red/s/${candidate.isrc}.ttml`, { headers: lrcRedHeaders });
        if (!/<(?:p|span)\b[^>]*\bbegin\s*=/i.test(content)) return null;
        const timings = [...content.matchAll(/\b(?:begin|end)\s*=\s*["']([^"']+)["']/gi)];
        if (!timings.some(match => parseTtmlTimeExpression(match[1]) > 0)) return null;
        const parsed = parseTtmlToLyrics(content);
        if (!parsed.lyrics?.some(line => Number(line.lineEndTime) > Number(line.lineStartTime))) return null;
        const result = {
          lyrics: parsed.lyrics,
          source: parsed.useKaraokeTiming ? "lrc-red-karaoke" : "lrc-red-line",
          metadata: {
            ...(parsed.metadata || {}),
            attribution: { source: "lrc-red", provider: "lrc.red", url: `https://lrc.red/s/${candidate.isrc}` },
          },
        };
        return { candidate, result };
      } catch (error) {
        if (!/HTTP 404\b/.test(String(error?.message || error))) errors[index] = error;
      }
      return null;
    });
    for (const promise of candidatePromises) {
      const entry = await promise;
      if (!entry) continue;
      const { candidate, result } = entry;
      if (!bestResult || result.source === "lrc-red-karaoke") {
        bestResult = result;
        remember(candidate.isrc);
      }
      if (result.source === "lrc-red-karaoke") return result;
    }
    lastError = errors.filter(Boolean).pop() || lastError;
    return null;
  }
  const initial = validIsrc(directIsrc) ? [{ isrc: directIsrc }] : cached ? [{ isrc: cached.isrc }] : [];
  if (await tryCandidates(initial)) return bestResult;
  if (!bestResult && String(track?.title || "").trim()) {
    try {
      if (await tryCandidates(await catalogCandidates())) return bestResult;
    } catch (error) { lastError = error; }
  }
  try {
    if (await tryCandidates(await searchFallback())) return bestResult;
  } catch (error) { lastError = error; }
  if (bestResult) return bestResult;
  if (lastError) throw lastError;
  return null;
}
