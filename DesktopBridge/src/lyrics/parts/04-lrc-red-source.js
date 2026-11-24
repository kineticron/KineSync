"use strict";

// Resolve catalog ISRCs before text search. Keep supplied TTML timing intact.
const lrcRedIsrcCache = new Map();
const lrcRedHeaders = { "User-Agent": "KineSync/1.3.0 (https://github.com/Kineticron/KineSync; kineticrondev@gmail.com)", "X-Client-ID": "KineSync/1.3.0 (https://github.com/Kineticron/KineSync; kineticrondev@gmail.com)" };

async function fetchFromLrcRed(track, { spotifyAccessToken = "" } = {}) {
  track = await resolveLyricsTrackMetadata(track, ["isrc", ...lyricsTextMatchFields], { spotifyAccessToken });
  const { parseTtmlToLyrics, parseTtmlTimeExpression, extractTtmlMetadata } = require("./lyricsTtmlImport");
  const directIsrc = normalizeLyricsTrackIsrc(track.isrc);
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
        let recording = null;
        try { recording = await fetchJson(`https://lrc.red/s/${candidate.isrc}.json`, { headers: lrcRedHeaders }); }
        catch { /* JSON is optional metadata; TTML remains the source of truth. */ }
        const { recordingIdentityMatches, artistIdentityMatches, compareAuthoritativeIdentity } = require("./lyricsRecordingIdentity");
        if (compareAuthoritativeIdentity(matchTrack, { isrc: candidate.isrc }) === false) return null;
        const identityMatch = recordingIdentityMatches(matchTrack, {
          isrc: candidate.isrc,
          title: candidate.title || recording?.title,
          artist: candidate.artist || recording?.artist,
          durationMs: Number(candidate.durationMs || (Number(recording?.duration) * 1000)),
        });
        if (recording?.duration != null && !durationMatches(Number(recording.duration) * 1000)) return null;
        if (!identityMatch && recording?.title && !versionMatches(recording.title)) return null;
        const content = await fetchText(`https://lrc.red/s/${candidate.isrc}.ttml`, { headers: lrcRedHeaders });
        if (!/^\s*(?:<\?xml\b[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:(?:\w+):)?tt\b/i.test(content) || !/<(?:p|span)\b[^>]*\bbegin\s*=/i.test(content)) return null;
        const timings = [...content.matchAll(/\b(?:begin|end)\s*=\s*["']([^"']+)["']/gi)];
        if (!timings.some(match => parseTtmlTimeExpression(match[1]) > 0)) return null;
        const parsed = parseTtmlToLyrics(content);
        if (!parsed.lyrics?.some(line => Number(line.lineEndTime) > Number(line.lineStartTime))) return null;
        const ttmlTrack = extractTtmlMetadata(content);
        const textIdentityMatch = recordingIdentityMatches(matchTrack, {
          title: ttmlTrack.title || track.title,
          artist: ttmlTrack.artist || candidate.artist || matchTrack.artist,
          durationMs: Number(track.durationMs || candidate.durationMs || 0),
        });
        if (ttmlTrack.title && (!versionMatches(ttmlTrack.title) || (identityMatch ? !textIdentityMatch : !isLikelySameTrack(
          { ...matchTrack, title: stripRemaster(track.title) }, stripRemaster(ttmlTrack.title),
          ttmlTrack.artist || candidate.artist || matchTrack.artist,
        )))) return null;
        if (ttmlTrack.artist && (identityMatch ? !artistIdentityMatches(matchTrack.artist, ttmlTrack.artist) : !artistNamesLookRelated(matchTrack.artist, ttmlTrack.artist))) return null;
        const trackDuration = Number(track.durationMs) || Number(candidate.durationMs) || 0;
        if (trackDuration && parsed.durationMs > trackDuration + 10000) return null;
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

// Export-only independent lrc.red lookup. It never reads a Spicy cache or packet.
// lrc.red reports JSON durations in seconds. Identity checks convert them to
// milliseconds and use a 3 second tolerance, because catalog and TTML timing can
// differ slightly. Distinct versions (live, remix, acoustic, and so on) must
// match exactly during title normalization. Search fallback also requires
// artist corroboration and exactly one safe candidate.
const LRC_RED_EXPORT_DURATION_TOLERANCE_MS = 3000;

async function fetchLrcRedExportLyrics(track) {
  const { parseTtmlToLyrics, parseTtmlTimeExpression, extractTtmlMetadata } = require("./lyricsTtmlImport");
  const rawIsrc = String(track?.isrc || track?.metadata?.fetchOrigin?.isrc || "")
    .replace(/[-\s]/g, "").toUpperCase();
  const validIsrc = (value) => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(value);
  const stripRemaster = (title) => String(title || "")
    .replace(/\s*\([^)]*\bremaster(?:ed)?\b[^)]*\)/gi, "")
    .replace(/\s*[-–]\s*(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?\s*$/i, "").trim();
  const durationMatches = (durationMs) => {
    const wanted = Number(track?.durationMs || 0);
    const actual = Number(durationMs || 0);
    // Without an original duration, identity cannot be checked safely.
    if (!wanted) return false;
    return actual > 0 && Math.abs(wanted - actual) <= LRC_RED_EXPORT_DURATION_TOLERANCE_MS;
  };
  function versionMatches(title) {
    const explicitWanted = normalizeText(track?.title);
    const explicitActual = normalizeText(title);
    if (!explicitWanted || !explicitActual) return false;
    // Inspect version hints and remaster years before stripping suffixes.
    for (const hint of [/\blive\b|\bconcert\b|\bfirst take\b|\bunplugged\b/, /\bremix\b|\bmix\b/, /\bacoustic\b/, /\binstrumental\b|\bkaraoke\b/, /\bsped up\b/, /\bslowed\b/, /\bdemo\b/, /\bmono\b/, /\blong version\b|\bextended\b/]) {
      if (hint.test(explicitWanted) !== hint.test(explicitActual)) return false;
    }
    const years = (value) => value.match(/\b(?:19|20)\d{2}\b/g) || [];
    const wantedYears = years(explicitWanted);
    const actualYears = years(explicitActual);
    if (wantedYears.length && actualYears.length && !wantedYears.some(year => actualYears.includes(year))) return false;
    const wanted = normalizeText(stripRemaster(track?.title));
    const actual = normalizeText(stripRemaster(title));
    return Boolean(wanted && actual && wanted === actual);
  }
  const identityMatches = (title, durationMs) => versionMatches(title) && durationMatches(durationMs);
  // Search fallback has no ISRC anchor, so the primary artist must match
  // exactly after normalization. Localized aliases are only accepted on the
  // direct ISRC path, where title and duration independently agree.
  const exportArtistMatches = (candidateArtist) => {
    const wanted = normalizeArtistText(getPrimaryArtistName(track?.artist));
    const actual = normalizeArtistText(getPrimaryArtistName(candidateArtist));
    return Boolean(wanted && actual && wanted === actual);
  };
  async function fetchTtml(candidate) {
    const content = await fetchText(`https://lrc.red/s/${candidate.isrc}.ttml`, { headers: lrcRedHeaders });
    if (!/^\s*(?:<\?xml\b[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:(?:\w+):)?tt\b/i.test(content) || !/<(?:p|span)\b[^>]*\bbegin\s*=/i.test(content)) return null;
    const timings = [...content.matchAll(/\b(?:begin|end)\s*=\s*["']([^"']+)["']/gi)];
    if (!timings.some(match => parseTtmlTimeExpression(match[1]) > 0)) return null;
    const parsed = parseTtmlToLyrics(content);
    if (!parsed.lyrics?.some(line => Number(line.lineEndTime) > Number(line.lineStartTime))) return null;
    const ttmlTrack = extractTtmlMetadata(content);
    if (ttmlTrack.title && !versionMatches(ttmlTrack.title)) return null;
    // Duration is optional in TTML metadata. Validate it only when present,
    // because the JSON or search hit already passed the strict check.
    const ttmlDurationMs = Number(ttmlTrack.duration || 0) * 1000;
    if (ttmlDurationMs > 0 && !durationMatches(ttmlDurationMs)) return null;
    const trackDuration = Number(track.durationMs) || 0;
    if (trackDuration && parsed.durationMs > trackDuration + 10000) return null;
    return {
      lyrics: parsed.lyrics,
      source: parsed.useKaraokeTiming ? "lrc-red-karaoke" : "lrc-red-line",
      metadata: {
        ...(parsed.metadata || {}),
        ttml: { ...(parsed.metadata?.ttml || {}), content },
        fetchOrigin: { provider: "lrc.red", source: "lrc-red", host: "lrc.red", url: `https://lrc.red/s/${candidate.isrc}`, isrc: candidate.isrc, title: String(track.title || ""), durationMs: Number(track.durationMs || 0) },
        independentContent: { source: "lrc-red", verified: true, isrc: candidate.isrc },
        attribution: { source: "lrc-red", provider: "lrc.red", url: `https://lrc.red/s/${candidate.isrc}` },
      },
    };
  }
  if (validIsrc(rawIsrc)) {
    try {
      const recording = await fetchJson(`https://lrc.red/s/${rawIsrc}.json`, { headers: lrcRedHeaders });
      // A direct ISRC is strong evidence, but title and duration must still
      // agree. Artist localization is allowed here.
      if (recording && identityMatches(recording.title, Number(recording.duration || 0) * 1000)) {
        const result = await fetchTtml({ isrc: rawIsrc });
        if (result) return result;
      }
    } catch { /* A direct miss falls through to lrc.red search. */ }
  }
  if (!String(track?.title || "").trim() || !String(track?.artist || "").trim()) return null;
  const queries = [...new Set([`${track.title} ${track.artist || ""}`.trim(), String(track.title || "").trim()])].filter(Boolean);
  for (const query of queries) {
    let payload;
    try {
      payload = await fetchJson("https://lrc.red/search.json", {
        headers: lrcRedHeaders,
        params: { q: query },
      });
    } catch { continue; }
    const candidates = (Array.isArray(payload?.hits) ? payload.hits : [])
      .map(hit => ({ ...hit, durationMs: Number(hit.duration || 0) * 1000 }))
      .filter(hit => validIsrc(String(hit.isrc || "").replace(/[-\s]/g, "").toUpperCase()) &&
        identityMatches(hit.title, hit.durationMs) && exportArtistMatches(hit.artist))
      .map(hit => ({ ...hit, isrc: String(hit.isrc).replace(/[-\s]/g, "").toUpperCase() }));
    if (candidates.length > 1) return null;
    if (candidates.length === 1) {
      try { return await fetchTtml(candidates[0]); }
      catch { return null; }
    }
  }
  return null;
}
