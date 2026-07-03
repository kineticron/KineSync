"use strict";
function buildMusixmatchMatcherQueries(track) {
  const durationSec =
    Number(track?.durationMs || 0) > 0
      ? Math.max(1, Math.round(Number(track.durationMs) / 1000))
      : 0;
  const durationFilters = durationSec
    ? {
        f_subtitle_length: durationSec,
        f_subtitle_length_max_deviation: 8,
      }
    : {};
  const artistVariants = buildMusixmatchArtistVariants(track.artist);
  const primaryArtistVariants =
    artistVariants.length > 0
      ? artistVariants
      : [String(track.artist || "").trim()];
  const queries = [];

  for (const artist of primaryArtistVariants) {
    queries.push({
      q_track: track.title,
      q_artist: artist,
      q_album: track.album || undefined,
      ...durationFilters,
    });
  }

  for (const query of buildQueryVariants(track).slice(0, MAX_QUERY_VARIANTS)) {
    for (const artist of primaryArtistVariants.slice(0, 2)) {
      queries.push({
        q_track: query,
        q_artist: artist,
        ...durationFilters,
      });
    }
  }

  if (queries.length) {
    const relaxed = { ...queries[0] };
    delete relaxed.q_artist;
    queries.push(relaxed);
  }

  const deduped = [];
  const seen = new Set();
  for (const query of queries) {
    const key = JSON.stringify(query);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(query);
  }
  return deduped;
}

async function fetchMusixmatchTrackCandidates(track, requestOptions) {
  const matches = [];
  let lastError = null;

  for (const query of buildMusixmatchMatcherQueries(track)) {
    try {
      const payload = await fetchMusixmatchJson(
        "/matcher.track.get",
        query,
        requestOptions,
      );
      const matchedTrack = extractMusixmatchMatchedTrack(payload);
      if (matchedTrack) {
        matches.push(matchedTrack);
      }
    } catch (error) {
      lastError = error;
      if (shouldAbortMusixmatchTokenAttempt(error)) {
        return { matches, lastError };
      }
    }
  }

  const searchQueryVariants = buildQueryVariants(track).slice(
    0,
    MAX_QUERY_VARIANTS,
  );
  const artistVariants = buildMusixmatchArtistVariants(track.artist);
  for (const query of searchQueryVariants) {
    if (matches.length >= 16) {
      break;
    }
    const artistQueryVariants =
      artistVariants.length > 0
        ? artistVariants
        : [String(track.artist || "").trim()];
    for (const artist of artistQueryVariants.slice(0, 2)) {
      try {
        const payload = await fetchMusixmatchJson(
          "/track.search",
          {
            q_track: query,
            q_artist: artist,
            page_size: 12,
            page: 1,
            s_track_rating: "desc",
            f_has_subtitles: 1,
          },
          requestOptions,
        );
        const candidates = extractMusixmatchTracks(payload);
        matches.push(...candidates);
      } catch (error) {
        lastError = error;
        if (shouldAbortMusixmatchTokenAttempt(error)) {
          return { matches, lastError };
        }
      }
    }
  }

  // Final relaxed fallback for stubborn metadata mismatches: try title-only search.
  if (!matches.length) {
    for (const query of searchQueryVariants.slice(0, 2)) {
      try {
        const payload = await fetchMusixmatchJson(
          "/track.search",
          {
            q_track: query,
            page_size: 12,
            page: 1,
            s_track_rating: "desc",
            f_has_subtitles: 1,
          },
          requestOptions,
        );
        const candidates = extractMusixmatchTracks(payload);
        matches.push(...candidates);
      } catch (error) {
        lastError = error;
        if (shouldAbortMusixmatchTokenAttempt(error)) {
          return { matches, lastError };
        }
      }
    }
  }

  return { matches, lastError };
}

function extractMusixmatchCandidateIdentity(candidate) {
  const trackId = Number(candidate?.track_id || candidate?.id || 0);
  if (trackId > 0) {
    return `track:${trackId}`;
  }
  const commonTrackId = Number(
    candidate?.commontrack_id || candidate?.commontrackid || 0,
  );
  if (commonTrackId > 0) {
    return `common:${commonTrackId}`;
  }
  const title = normalizeText(candidate?.track_name || candidate?.name || "");
  const artist = normalizeText(
    candidate?.artist_name || candidate?.artist || "",
  );
  return `${title}|${artist}`;
}

function normalizeMusixmatchSongwriterNames(value, output = []) {
  if (value === null || value === undefined) {
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeMusixmatchSongwriterNames(item, output);
    }
    return output;
  }
  if (typeof value === "object") {
    const direct =
      value.name ||
      value.writer_name ||
      value.songwriter_name ||
      value.artist_name ||
      value.description;
    if (direct) {
      normalizeMusixmatchSongwriterNames(direct, output);
      return output;
    }
    for (const nested of Object.values(value)) {
      normalizeMusixmatchSongwriterNames(nested, output);
    }
    return output;
  }
  const text = String(value || "").trim();
  if (!text) {
    return output;
  }
  for (const part of text.split(/\s*(?:,|;|\/|\||&|\band\b)\s*/i)) {
    const safe = String(part || "").trim();
    if (safe && !output.some((entry) => entry.toLowerCase() === safe.toLowerCase())) {
      output.push(safe);
    }
  }
  return output;
}

function extractMusixmatchSongwriters(candidate) {
  const names = [];
  for (const value of [
    candidate?.writer_list,
    candidate?.writers,
    candidate?.songwriters,
    candidate?.songwriter_list,
    candidate?.track_writer_list,
    candidate?.lyrics_writer_list,
    candidate?.writer,
    candidate?.lyrics_writer,
  ]) {
    normalizeMusixmatchSongwriterNames(value, names);
  }
  return names.slice(0, 12);
}

function extractMusixmatchIdentifierRequests(candidate) {
  const requests = [];
  const seen = new Set();
  const pushRequest = (key, rawValue) => {
    const value = Math.floor(Number(rawValue || 0));
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }
    const signature = `${key}:${value}`;
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    requests.push({ [key]: value });
  };

  pushRequest("commontrack_id", candidate?.commontrack_id);
  pushRequest("commontrack_id", candidate?.commontrackid);
  pushRequest("track_id", candidate?.track_id);
  pushRequest("track_id", candidate?.id);
  return requests;
}

function extractMusixmatchTranslationEntries(payload, endpointLabel) {
  const { body } = assertMusixmatchSuccess(payload, endpointLabel);
  const lists = [
    ...(Array.isArray(body?.translation_list) ? [body.translation_list] : []),
    ...(Array.isArray(body?.translations_list) ? [body.translations_list] : []),
    ...(Array.isArray(body?.track_translation_list)
      ? [body.track_translation_list]
      : []),
    ...(Array.isArray(body?.lyrics_translation_list)
      ? [body.lyrics_translation_list]
      : []),
  ];

  const entries = [];
  for (const list of lists) {
    for (const item of list) {
      const node =
        item?.translation ||
        item?.track_translation ||
        item?.lyrics_translation ||
        item;
      if (!node || typeof node !== "object") {
        continue;
      }
      const language = String(
        node?.translation_language ||
          node?.selected_language ||
          node?.language ||
          node?.language_code ||
          node?.locale ||
          "",
      )
        .trim()
        .toLowerCase();
      if (
        language &&
        !language.startsWith("en") &&
        language !== "us" &&
        language !== "gb"
      ) {
        continue;
      }
      const original = String(
        node?.matched_line ||
          node?.matchedLine ||
          node?.matched_line_text ||
          node?.source_text ||
          node?.lyric ||
          node?.line ||
          "",
      ).trim();
      const translated = String(
        node?.description ||
          node?.translation_description ||
          node?.translated_line ||
          node?.translated_text ||
          node?.text ||
          "",
      ).trim();
      if (!translated) {
        continue;
      }
      entries.push({ original, translated });
    }
  }

  // Preserve repeated lines (e.g., choruses) so translation indices stay aligned.
  // Global dedupe here can collapse legitimate duplicates and shift all later lines.
  return entries;
}

async function fetchMusixmatchTranslationsForCandidate(
  candidate,
  requestOptions,
  language = MUSIXMATCH_TRANSLATION_LANGUAGE,
) {
  let lastError = null;
  const endpoints = [
    {
      path: "/crowd.track.translations.get",
      label: "crowd.track.translations.get",
    },
    { path: "/track.translations.get", label: "track.translations.get" },
  ];

  for (const identifierParams of extractMusixmatchIdentifierRequests(
    candidate,
  )) {
    for (const endpoint of endpoints) {
      for (const lang of MUSIXMATCH_TRANSLATION_LANGUAGE_FALLBACKS) {
        try {
          const payload = await fetchMusixmatchJson(
            endpoint.path,
            {
              ...identifierParams,
              selected_language: lang,
            },
            requestOptions,
          );
          const translations = extractMusixmatchTranslationEntries(
            payload,
            endpoint.label,
          );
          if (translations.length) {
            return { translations, lastError: null };
          }
        } catch (error) {
          lastError = error;
        }
      }
    }
  }
  return { translations: [], lastError };
}

function scoreTranslationLineMatch(baseText, originalText) {
  const baseNorm = normalizeText(baseText);
  const originalNorm = normalizeText(originalText);
  if (!baseNorm || !originalNorm) {
    return 0;
  }
  if (baseNorm === originalNorm) {
    return 1;
  }
  const overlap = overlapRatio(tokens(baseNorm), tokens(originalNorm));
  const containBonus =
    baseNorm.includes(originalNorm) || originalNorm.includes(baseNorm)
      ? 0.18
      : 0;
  return Math.max(0, Math.min(1, overlap + containBonus));
}

function getLineTextNormalized(line) {
  return normalizeText(getLineText(line));
}

function normalizeTranslationVisibilityText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

function shouldHideTranslatedText(originalText, translatedText) {
  const originalNorm = normalizeTranslationVisibilityText(originalText);
  const translatedNorm = normalizeTranslationVisibilityText(translatedText);
  return (
    Boolean(originalNorm) &&
    Boolean(translatedNorm) &&
    originalNorm === translatedNorm
  );
}

function appendTranslatedSegment(existingText, nextSegment) {
  const existing = String(existingText || "").trim();
  const next = String(nextSegment || "").trim();
  if (!next) {
    return existing;
  }
  if (!existing) {
    return next;
  }
  const existingNorm = normalizeText(existing);
  const nextNorm = normalizeText(next);
  if (!nextNorm || existingNorm.includes(nextNorm)) {
    return existing;
  }
  return `${existing} / ${next}`;
}

const TRANSLATION_MAP_MAX_SPAN = 3;
const TRANSLATION_MAP_SEARCH_WINDOW = 20;
const TRANSLATION_MAP_MIN_TEXT_SCORE = 0.5;
const TRANSLATION_MAP_MIN_COMBINED_SCORE = 0.56;
const TRANSLATION_MAP_MIN_MARGIN = 0.08;
const TRANSLATION_MAP_MAX_START_DELTA_MS = 5_200;

function parseLineTimeMs(rawValue) {
  const numeric = Number(rawValue);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : Number.NaN;
}

function getLineTimingWindow(line) {
  const start = parseLineTimeMs(line?.lineStartTime);
  const end = parseLineTimeMs(line?.lineEndTime);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return { hasTiming: true, start, end };
  }
  if (Number.isFinite(start)) {
    return { hasTiming: true, start, end: start };
  }
  if (Number.isFinite(end)) {
    return { hasTiming: true, start: end, end };
  }
  return { hasTiming: false, start: Number.NaN, end: Number.NaN };
}

function scoreTranslationTimingMatch(
  referenceLine,
  targetStartLine,
  targetEndLine,
) {
  const refWindow = getLineTimingWindow(referenceLine);
  const targetStartWindow = getLineTimingWindow(targetStartLine);
  const targetEndWindow = getLineTimingWindow(targetEndLine);
  if (
    !refWindow.hasTiming ||
    !targetStartWindow.hasTiming ||
    !targetEndWindow.hasTiming
  ) {
    return {
      hasTiming: false,
      score: 0,
      startDeltaMs: Number.POSITIVE_INFINITY,
    };
  }

  const startDeltaMs = Math.abs(targetStartWindow.start - refWindow.start);
  const overlapMs = Math.max(
    0,
    Math.min(targetEndWindow.end, refWindow.end) -
      Math.max(targetStartWindow.start, refWindow.start),
  );
  const overlapRatio =
    Math.max(targetEndWindow.end, refWindow.end) >
    Math.min(targetStartWindow.start, refWindow.start)
      ? overlapMs /
        Math.max(
          1,
          Math.max(targetEndWindow.end, refWindow.end) -
            Math.min(targetStartWindow.start, refWindow.start),
        )
      : 0;
  const startScore = Math.max(0, 1 - startDeltaMs / 3_600);
  const score = Math.max(
    0,
    Math.min(1, startScore * 0.72 + overlapRatio * 0.28),
  );
  return { hasTiming: true, score, startDeltaMs };
}

function mapMusixmatchReferenceTranslationsOntoLyrics(
  targetLyrics,
  referenceLyrics,
) {
  if (
    !Array.isArray(targetLyrics) ||
    !targetLyrics.length ||
    !Array.isArray(referenceLyrics) ||
    !referenceLyrics.length
  ) {
    return targetLyrics || [];
  }

  const translatedReference = referenceLyrics
    .map((line) => ({
      line,
      originalText: getLineText(line),
      translatedText: String(line?.translatedText || "").trim(),
    }))
    .filter((entry) => entry.translatedText && entry.originalText.trim());

  if (!translatedReference.length) {
    return targetLyrics;
  }

  const next = targetLyrics.map((line) => ({ ...line }));
  let cursor = 0;

  for (const entry of translatedReference) {
    const sourceNorm = normalizeText(entry.originalText);
    if (!sourceNorm) {
      continue;
    }

    let bestStart = -1;
    let bestEnd = -1;
    let bestTextScore = 0;
    let bestCombinedScore = 0;
    let secondBestCombinedScore = 0;
    let bestTiming = {
      hasTiming: false,
      score: 0,
      startDeltaMs: Number.POSITIVE_INFINITY,
    };
    const startMin = Math.max(0, cursor - 2);
    const startMax = Math.min(
      next.length - 1,
      cursor + TRANSLATION_MAP_SEARCH_WINDOW,
    );

    for (let start = startMin; start <= startMax; start += 1) {
      let combined = "";
      for (let span = 1; span <= TRANSLATION_MAP_MAX_SPAN; span += 1) {
        const end = start + span - 1;
        if (end >= next.length) {
          break;
        }
        const part = getLineText(next[end]);
        combined = combined ? `${combined} ${part}` : part;
        const textScore = scoreTranslationLineMatch(combined, sourceNorm);
        if (textScore < 0.2) {
          continue;
        }

        const timing = scoreTranslationTimingMatch(
          entry.line,
          next[start],
          next[end],
        );
        let combinedScore = textScore;
        if (timing.hasTiming) {
          combinedScore += timing.score * 0.34;
          if (
            timing.startDeltaMs > TRANSLATION_MAP_MAX_START_DELTA_MS &&
            textScore < 0.78
          ) {
            combinedScore -= 0.32;
          }
        }

        if (combinedScore > bestCombinedScore) {
          secondBestCombinedScore = bestCombinedScore;
          bestCombinedScore = combinedScore;
          bestTextScore = textScore;
          bestStart = start;
          bestEnd = end;
          bestTiming = timing;
        } else if (combinedScore > secondBestCombinedScore) {
          secondBestCombinedScore = combinedScore;
        }
      }
    }

    const hasConfidentText = bestTextScore >= TRANSLATION_MAP_MIN_TEXT_SCORE;
    const hasConfidentCombined =
      bestCombinedScore >= TRANSLATION_MAP_MIN_COMBINED_SCORE;
    const hasUniqueBest =
      bestCombinedScore - secondBestCombinedScore >=
        TRANSLATION_MAP_MIN_MARGIN || bestTextScore >= 0.78;
    const timingAcceptable =
      !bestTiming.hasTiming ||
      bestTiming.startDeltaMs <= TRANSLATION_MAP_MAX_START_DELTA_MS ||
      bestTextScore >= 0.82;

    if (
      bestStart >= 0 &&
      bestEnd >= bestStart &&
      hasConfidentText &&
      hasConfidentCombined &&
      hasUniqueBest &&
      timingAcceptable
    ) {
      for (let index = bestStart; index <= bestEnd; index += 1) {
        if (
          shouldHideTranslatedText(
            getLineText(next[index]),
            entry.translatedText,
          )
        ) {
          continue;
        }
        next[index].translatedText = appendTranslatedSegment(
          next[index].translatedText,
          entry.translatedText,
        );
      }
      cursor = Math.max(cursor, bestEnd + 1);
    }
  }

  return next;
}

function attachTranslationsToLyrics(lyrics, translations) {
  if (
    !Array.isArray(lyrics) ||
    !lyrics.length ||
    !Array.isArray(translations)
  ) {
    return lyrics || [];
  }
  const usable = translations
    .map((entry) => ({
      original: String(entry?.original || "").trim(),
      translated: String(entry?.translated || "").trim(),
    }))
    .filter((entry) => entry.translated);

  if (!usable.length) {
    return lyrics;
  }

  const hasOriginalSignals = usable.some((entry) =>
    normalizeText(entry.original),
  );
  if (!hasOriginalSignals) {
    const limit = Math.min(lyrics.length, usable.length);
    return lyrics.map((line, index) => {
      if (index >= limit) {
        return line;
      }
      const translatedText = usable[index].translated;
      if (
        !translatedText ||
        shouldHideTranslatedText(getLineText(line), translatedText)
      ) {
        return line;
      }
      return {
        ...line,
        translatedText,
      };
    });
  }

  const next = lyrics.map((line) => ({ ...line }));
  let cursor = 0;
  const windowSize = 28;
  const usedTranslationIndexes = new Set();

  for (let lineIndex = 0; lineIndex < next.length; lineIndex += 1) {
    const line = next[lineIndex];
    const baseText = getLineText(line);
    if (!baseText) {
      continue;
    }

    let bestIndex = -1;
    let bestScore = 0;
    const start = Math.max(cursor, 0);
    const end = Math.min(usable.length - 1, start + windowSize);
    for (let index = start; index <= end; index += 1) {
      const candidate = usable[index];
      const score = scoreTranslationLineMatch(baseText, candidate.original);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex < 0 || bestScore < 0.22) {
      continue;
    }

    const translatedText = usable[bestIndex].translated;
    if (
      !translatedText ||
      shouldHideTranslatedText(getLineText(line), translatedText)
    ) {
      continue;
    }
    line.translatedText = translatedText;
    usedTranslationIndexes.add(bestIndex);
    cursor = bestIndex + 1;
  }

  const matchedCount = next.reduce(
    (count, line) =>
      count + (String(line?.translatedText || "").trim() ? 1 : 0),
    0,
  );
  void matchedCount;
  void usedTranslationIndexes;

  return next;
}

function attachTranslationsToMusixmatchSourceLyrics(lyrics, translations) {
  if (
    !Array.isArray(lyrics) ||
    !lyrics.length ||
    !Array.isArray(translations) ||
    !translations.length
  ) {
    return lyrics || [];
  }

  const usable = translations
    .map((entry) => ({
      original: String(entry?.original || "").trim(),
      translated: String(entry?.translated || "").trim(),
    }))
    .filter((entry) => entry.translated);
  if (!usable.length) {
    return lyrics;
  }

  const next = lyrics.map((line) => ({ ...line }));
  const buckets = new Map();
  for (let index = 0; index < next.length; index += 1) {
    const key = normalizeText(getLineText(next[index]));
    if (!key) {
      continue;
    }
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push(index);
  }

  let cursor = 0;
  for (const entry of usable) {
    const originalKey = normalizeText(entry.original);
    if (!originalKey) {
      continue;
    }
    const queue = buckets.get(originalKey);
    if (!Array.isArray(queue) || !queue.length) {
      continue;
    }

    let targetIndex = -1;
    for (let pos = 0; pos < queue.length; pos += 1) {
      if (queue[pos] >= cursor) {
        targetIndex = queue.splice(pos, 1)[0];
        break;
      }
    }
    if (targetIndex < 0 && queue.length) {
      targetIndex = queue.shift();
    }
    if (!(targetIndex >= 0 && targetIndex < next.length)) {
      continue;
    }

    if (
      shouldHideTranslatedText(getLineText(next[targetIndex]), entry.translated)
    ) {
      continue;
    }

    next[targetIndex].translatedText = appendTranslatedSegment(
      next[targetIndex].translatedText,
      entry.translated,
    );
    cursor = Math.max(cursor, targetIndex + 1);
  }

  return next;
}

function isMusixmatchSourceLabel(source) {
  const normalized = normalizeText(source);
  return normalized.includes("musixmatch");
}

function parseMusixmatchTimeMs(raw, { assumeSeconds = true } = {}) {
  if (raw === null || raw === undefined || raw === "") {
    return Number.NaN;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return Number.NaN;
    }
    return assumeSeconds ? Math.max(0, raw * 1000) : Math.max(0, raw);
  }
  const text = String(raw).trim();
  if (!text) {
    return Number.NaN;
  }
  const timestampMs = parseTimestampMs(text);
  if (Number.isFinite(timestampMs)) {
    return timestampMs;
  }
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) {
    return Number.NaN;
  }
  return assumeSeconds ? Math.max(0, numeric * 1000) : Math.max(0, numeric);
}

function shouldInsertSpaceBetweenRichsyncSegments(currentText, nextText) {
  const current = String(currentText || "");
  const next = String(nextText || "");
  if (!current || !next) {
    return false;
  }
  if (/\s$/.test(current) || /^\s/.test(next)) {
    return false;
  }
  // Keep punctuation tight without adding synthetic spacing.
  if (/^[,.;:!?)\]\}%]/.test(next)) {
    return false;
  }
  if (/[(\[{]$/.test(current)) {
    return false;
  }
  return true;
}

function extractMusixmatchRichsyncBody(
  payload,
  endpointLabel = "track.richsync.get",
) {
  const { body } = assertMusixmatchSuccess(payload, endpointLabel);
  const direct = body?.richsync?.richsync_body;
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }
  const list = Array.isArray(body?.richsync_list) ? body.richsync_list : [];
  for (const entry of list) {
    const nextBody = entry?.richsync?.richsync_body;
    if (typeof nextBody === "string" && nextBody.trim()) {
      return nextBody;
    }
  }
  const nested = findFirstNestedStringByKey(body, "richsync_body");
  return nested || "";
}

function getRichsyncSegmentText(segment) {
  return String(
    segment?.c ?? segment?.text ?? segment?.t ?? segment?.token ?? "",
  );
}

function isRichsyncWhitespaceSegment(text) {
  return /^\s+$/.test(String(text || ""));
}

function findNextNonWhitespaceRichsyncSegment(segments, startIndex) {
  if (!Array.isArray(segments)) {
    return null;
  }
  for (let index = startIndex; index < segments.length; index += 1) {
    const rawText = getRichsyncSegmentText(segments[index]);
    if (rawText && !isRichsyncWhitespaceSegment(rawText)) {
      return { segment: segments[index], rawText, index };
    }
  }
  return null;
}

function unwrapMusixmatchRichsyncLines(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  for (const key of ["lines", "richsync", "richsyncs", "body", "data"]) {
    if (Array.isArray(parsed[key])) {
      return parsed[key];
    }
  }
  return [];
}

function parseMusixmatchRichsyncLyrics(richsyncBody) {
  const parsed =
    typeof richsyncBody === "string"
      ? parseJsonLenient(richsyncBody)
      : richsyncBody;
  const lines = unwrapMusixmatchRichsyncLines(parsed);
  const output = [];

  for (const line of lines) {
    const lineStart = parseMusixmatchTimeMs(
      line?.ts ?? line?.start ?? line?.time ?? line?.line_start,
      { assumeSeconds: true },
    );
    const lineEndCandidate = parseMusixmatchTimeMs(
      line?.te ?? line?.end ?? line?.line_end,
      { assumeSeconds: true },
    );
    if (!Number.isFinite(lineStart)) {
      continue;
    }
    const segments = Array.isArray(line?.l)
      ? line.l
      : Array.isArray(line?.words)
        ? line.words
        : Array.isArray(line?.tokens)
          ? line.tokens
          : [];

    if (!segments.length) {
      const text =
        String(line?.x ?? line?.text ?? line?.tx ?? line?.line ?? "").trim() ||
        "";
      if (!text) {
        continue;
      }
      const fallbackEnd = Number.isFinite(lineEndCandidate)
        ? lineEndCandidate
        : lineStart + 1800;
      output.push({
        lineStartTime: lineStart,
        lineEndTime: Math.max(lineStart + 250, fallbackEnd),
        syllables: normalizeSyllables(
          [{ text, startTime: lineStart, endTime: fallbackEnd }],
          lineStart,
          Math.max(lineStart + 250, fallbackEnd),
        ),
      });
      continue;
    }

    const syllables = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const rawText = getRichsyncSegmentText(segment);
      if (!rawText || isRichsyncWhitespaceSegment(rawText)) {
        continue;
      }
      const nextSegment = segments[index + 1];
      const nextNonWhitespace = findNextNonWhitespaceRichsyncSegment(
        segments,
        index + 1,
      );
      const hasExplicitSpaceToken = isRichsyncWhitespaceSegment(
        getRichsyncSegmentText(nextSegment),
      );
      let text = rawText;
      if (
        (hasExplicitSpaceToken ||
          (nextNonWhitespace &&
            shouldInsertSpaceBetweenRichsyncSegments(
              rawText,
              nextNonWhitespace.rawText,
            ))) &&
        !/\s$/.test(text)
      ) {
        text += " ";
      }
      const startOffset = parseMusixmatchTimeMs(
        segment?.o ?? segment?.offset ?? segment?.ts ?? segment?.start,
        { assumeSeconds: true },
      );
      const nextOffset = parseMusixmatchTimeMs(
        nextSegment?.o ??
          nextSegment?.offset ??
          nextSegment?.ts ??
          nextSegment?.start ??
          nextNonWhitespace?.segment?.o ??
          nextNonWhitespace?.segment?.offset ??
          nextNonWhitespace?.segment?.ts ??
          nextNonWhitespace?.segment?.start,
        { assumeSeconds: true },
      );
      const durationOffset = parseMusixmatchTimeMs(
        segment?.d ?? segment?.duration,
        { assumeSeconds: true },
      );
      const startTime = Number.isFinite(startOffset)
        ? lineStart + startOffset
        : lineStart;
      const endTime = Number.isFinite(nextOffset)
        ? lineStart + nextOffset
        : Number.isFinite(durationOffset)
          ? startTime + durationOffset
          : Number.isFinite(lineEndCandidate)
            ? lineEndCandidate
            : startTime + 220;

      syllables.push({ text, startTime, endTime });
    }

    if (!syllables.length) {
      continue;
    }
    const normalized = ensureSyllableDisplaySpacing(
      normalizeSyllables(
        syllables,
        lineStart,
        Number.isFinite(lineEndCandidate)
          ? lineEndCandidate
          : syllables[syllables.length - 1].endTime,
      ),
    );
    if (!normalized.length) {
      continue;
    }
    output.push({
      lineStartTime: normalized[0].startTime,
      lineEndTime: normalized[normalized.length - 1].endTime,
      syllables: normalized,
    });
  }

  return output.filter((line) => line?.syllables?.length);
}

async function fetchMusixmatchRichsyncForCandidate(
  candidate,
  track,
  requestOptions,
) {
  let lastError = null;
  for (const identifierParams of extractMusixmatchIdentifierRequests(
    candidate,
  )) {
    try {
      const richsyncPayload = await fetchMusixmatchJson(
        "/track.richsync.get",
        {
          ...identifierParams,
          richsync_format: "json",
        },
        requestOptions,
      );
      const richsyncBody = extractMusixmatchRichsyncBody(
        richsyncPayload,
        "track.richsync.get",
      );
      if (!richsyncBody) {
        continue;
      }
      const lyrics = parseMusixmatchRichsyncLyrics(richsyncBody);
      if (lyrics.length) {
        return { lyrics, lastError: null };
      }
    } catch (error) {
      lastError = error;
    }
  }

  const matcherDurationSec =
    toMusixmatchDurationMs(candidate) > 0
      ? Math.max(1, Math.round(toMusixmatchDurationMs(candidate) / 1000))
      : Number(track?.durationMs || 0) > 0
        ? Math.max(1, Math.round(Number(track.durationMs) / 1000))
        : 0;
  const matcherDurationFilters = matcherDurationSec
    ? {
        f_subtitle_length: matcherDurationSec,
        f_subtitle_length_max_deviation: 8,
      }
    : {};

  try {
    const matcherPayload = await fetchMusixmatchJson(
      "/matcher.richsync.get",
      {
        q_track: String(candidate?.track_name || track?.title || "").trim(),
        q_artist: String(candidate?.artist_name || track?.artist || "").trim(),
        ...matcherDurationFilters,
      },
      requestOptions,
    );
    const richsyncBody = extractMusixmatchRichsyncBody(
      matcherPayload,
      "matcher.richsync.get",
    );
    if (!richsyncBody) {
      return { lyrics: [], lastError: null };
    }
    const lyrics = parseMusixmatchRichsyncLyrics(richsyncBody);
    if (lyrics.length) {
      return { lyrics, lastError: null };
    }
  } catch (error) {
    lastError = error;
  }
  return { lyrics: [], lastError };
}

async function fetchMusixmatchSubtitleForCandidate(
  candidate,
  track,
  requestOptions,
) {
  let lastError = null;
  for (const identifierParams of extractMusixmatchIdentifierRequests(
    candidate,
  )) {
    try {
      const subtitlePayload = await fetchMusixmatchJson(
        "/track.subtitle.get",
        {
          ...identifierParams,
          subtitle_format: "lrc",
        },
        requestOptions,
      );
      const subtitleBody = extractMusixmatchSubtitleBody(
        subtitlePayload,
        "track.subtitle.get",
      );
      if (subtitleBody) {
        return { subtitleBody, lastError: null };
      }
    } catch (error) {
      lastError = error;
    }
  }

  const matcherDurationSec =
    toMusixmatchDurationMs(candidate) > 0
      ? Math.max(1, Math.round(toMusixmatchDurationMs(candidate) / 1000))
      : Number(track?.durationMs || 0) > 0
        ? Math.max(1, Math.round(Number(track.durationMs) / 1000))
        : 0;
  const matcherDurationFilters = matcherDurationSec
    ? {
        f_subtitle_length: matcherDurationSec,
        f_subtitle_length_max_deviation: 8,
      }
    : {};

  try {
    const matcherPayload = await fetchMusixmatchJson(
      "/matcher.subtitle.get",
      {
        q_track: String(candidate?.track_name || track?.title || "").trim(),
        q_artist: String(candidate?.artist_name || track?.artist || "").trim(),
        ...matcherDurationFilters,
        subtitle_format: "lrc",
      },
      requestOptions,
    );
    const subtitleBody = extractMusixmatchSubtitleBody(
      matcherPayload,
      "matcher.subtitle.get",
    );
    if (subtitleBody) {
      return { subtitleBody, lastError: null };
    }
  } catch (error) {
    lastError = error;
  }

  for (const identifierParams of extractMusixmatchIdentifierRequests(
    candidate,
  )) {
    try {
      const macroPayload = await fetchMusixmatchJson(
        "/macro.subtitles.get",
        {
          ...identifierParams,
          subtitle_format: "lrc",
        },
        requestOptions,
      );
      const subtitleBody = extractMusixmatchSubtitleBody(
        macroPayload,
        "macro.subtitles.get",
      );
      if (subtitleBody) {
        return { subtitleBody, lastError: null };
      }
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const macroMatcherPayload = await fetchMusixmatchJson(
      "/macro.subtitles.get",
      {
        q_track: String(candidate?.track_name || track?.title || "").trim(),
        q_artist: String(candidate?.artist_name || track?.artist || "").trim(),
        ...matcherDurationFilters,
        subtitle_format: "lrc",
      },
      requestOptions,
    );
    const subtitleBody = extractMusixmatchSubtitleBody(
      macroMatcherPayload,
      "macro.subtitles.get",
    );
    if (subtitleBody) {
      return { subtitleBody, lastError: null };
    }
  } catch (error) {
    lastError = error;
  }

  return { subtitleBody: "", lastError };
}

async function fetchFromMusixmatch(track, { musixmatchUserToken = "" } = {}) {
  const rawToken = String(musixmatchUserToken || "").trim();
  if (!rawToken) {
    throw new Error(
      "Missing Musixmatch user token. Set one in desktop bridge settings.",
    );
  }
  const clientCandidates = prioritizeMusixmatchClientCandidates(
    resolveMusixmatchClientCandidates(rawToken),
    rawToken,
  );
  if (!clientCandidates.length) {
    throw new Error(
      "Musixmatch user token format is invalid. Paste the user token itself or the musixmatchUserToken cookie JSON payload.",
    );
  }

  const cached = getMusixmatchCachedResult(track, rawToken);
  if (cached) {
    return cached;
  }

  const cooldownInfo = getMusixmatchCooldownInfo();
  if (cooldownInfo.active) {
    const remainingSec = Math.ceil(cooldownInfo.remainingMs / 1000);
    const reason = cooldownInfo.reason || "captcha";
    throw new Error(
      `Musixmatch cooldown active (${reason}). Retry in ${remainingSec}s.`,
    );
  }

  let lastError = null;
  let sawNoMatchPath = false;

  for (const client of clientCandidates) {
    const requestOptions = {
      appId: client.appId,
      userToken: client.userToken,
      userAgent: client.userAgent,
      userLanguage: client.userLanguage,
      cookieHeader: client.cookieHeader,
      baseUrls: client.baseUrls,
      defaultParams: client.defaultParams || {},
    };

    const { matches, lastError: trackCandidateError } =
      await fetchMusixmatchTrackCandidates(track, requestOptions);
    if (trackCandidateError) {
      lastError = trackCandidateError;
      if (describeSourceError(trackCandidateError) === "unauthorized") {
        rememberMusixmatchRejectedClient(rawToken, client.appId);
      }
      if (describeSourceError(trackCandidateError) === "rate-limited") {
        activateMusixmatchCooldown("captcha");
        throw trackCandidateError;
      }
      if (describeSourceError(trackCandidateError) !== "unauthorized") {
        sawNoMatchPath = true;
      }
    }
    if (!matches.length) {
      if (describeSourceError(trackCandidateError) !== "unauthorized") {
        sawNoMatchPath = true;
      }
      continue;
    }

    const seenCandidates = new Set();
    const ranked = matches
      .filter((candidate) => {
        const identity = extractMusixmatchCandidateIdentity(candidate);
        if (!identity || seenCandidates.has(identity)) {
          return false;
        }
        seenCandidates.add(identity);
        return true;
      })
      .map((candidate) => {
        const title = String(
          candidate?.track_name || candidate?.name || "",
        ).trim();
        const artist = String(
          candidate?.artist_name || candidate?.artist || "",
        ).trim();
        let score = scoreCandidate(track, title, artist);
        const candidateDurationMs = toMusixmatchDurationMs(candidate);
        score += scoreDurationBonus(track, title, artist, candidateDurationMs);
        return { candidate, score, title, artist, candidateDurationMs };
      })
      .sort((a, b) => b.score - a.score);

    if (!ranked.length || isAmbiguousTopMatch(ranked)) {
      sawNoMatchPath = true;
      continue;
    }

    const likelyMusixmatchCandidates = ranked
      .filter((entry) =>
        isLikelySameTrack(
          track,
          entry.title,
          entry.artist,
          entry.candidateDurationMs,
        ),
      )
      .sort((left, right) => compareCandidateMatchQuality(track, left, right))
      .slice(0, 8);

    for (const entry of likelyMusixmatchCandidates) {
      const { lyrics: richsyncLyrics, lastError: richsyncError } =
        await fetchMusixmatchRichsyncForCandidate(
          entry.candidate,
          track,
          requestOptions,
        );
      if (richsyncError) {
        lastError = richsyncError;
        if (describeSourceError(richsyncError) === "unauthorized") {
          rememberMusixmatchRejectedClient(rawToken, client.appId);
        }
        if (describeSourceError(richsyncError) === "rate-limited") {
          activateMusixmatchCooldown("captcha");
          throw richsyncError;
        }
        if (describeSourceError(richsyncError) !== "unauthorized") {
          sawNoMatchPath = true;
        }
      }
      if (richsyncLyrics.length) {
        const songwriters = extractMusixmatchSongwriters(entry.candidate);
        const richsyncResult = {
          lyrics: richsyncLyrics,
          source: `musixmatch-richsync-user-token-${client.appId}`,
          metadata: songwriters.length
            ? { credits: { songwriters } }
            : undefined,
        };
        rememberMusixmatchPreferredClient(rawToken, client.appId);
        setMusixmatchCachedResult(track, rawToken, richsyncResult);
        return {
          ...richsyncResult,
        };
      }
      const { subtitleBody, lastError: subtitleError } =
        await fetchMusixmatchSubtitleForCandidate(
          entry.candidate,
          track,
          requestOptions,
        );
      if (subtitleError) {
        lastError = subtitleError;
        if (describeSourceError(subtitleError) === "unauthorized") {
          rememberMusixmatchRejectedClient(rawToken, client.appId);
        }
        if (describeSourceError(subtitleError) === "rate-limited") {
          activateMusixmatchCooldown("captcha");
          throw subtitleError;
        }
        if (describeSourceError(subtitleError) !== "unauthorized") {
          sawNoMatchPath = true;
        }
      }
      if (!subtitleBody) {
        sawNoMatchPath = true;
        continue;
      }
      const lyrics = parseLrc(subtitleBody);
      if (lyrics.length) {
        const songwriters = extractMusixmatchSongwriters(entry.candidate);
        const subtitleResult = {
          lyrics,
          source: `musixmatch-user-token-${client.appId}`,
          metadata: songwriters.length
            ? { credits: { songwriters } }
            : undefined,
        };
        rememberMusixmatchPreferredClient(rawToken, client.appId);
        setMusixmatchCachedResult(track, rawToken, subtitleResult);
        return {
          ...subtitleResult,
        };
      }
      sawNoMatchPath = true;
    }
  }

  if (lastError) {
    if (sawNoMatchPath && describeSourceError(lastError) === "unauthorized") {
      throw createSourceStageNoMatchError("musixmatch", "catalog");
    }
    throw lastError;
  }
  return null;
}

