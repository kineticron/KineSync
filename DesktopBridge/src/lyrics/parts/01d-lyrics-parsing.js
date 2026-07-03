"use strict";

function stripSearchDecoratorsFromTitle(input) {
  // Spotify passes the full display title (including feat. credits in brackets).
  // Only strip production/lyricist credits — never feat./ft. segments, since those
  // are not duplicated in the primary-artist field from native playback metadata.
  return String(input || "")
    .replace(
      /\s*[\(\[]\s*(?:prod(?:\.|uced)?\s*by|produced\s*by|arr(?:\.|anged)?\s*by|arranger|composed\s*by|written\s*by|lyrics?\s*by|lyricist)\b[^)\]]*[\)\]]/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Native/Spotify playback supplies primary artist only; featured artists live in title. */
function getSpotifyPrimaryArtist(input) {
  const primary = getPrimaryArtistName(input);
  const primaryTokens = tokens(normalizeArtistText(primary));
  const fromIndex = primaryTokens.indexOf("from");
  if (fromIndex > 0) {
    return primaryTokens.slice(0, fromIndex).join(" ");
  }
  return primary;
}

function buildQueryVariants(track) {
  const rawTitle = String(track?.title || "").trim();
  const rawArtist = String(track?.artist || "").trim();
  const titleBase = stripSearchDecoratorsFromTitle(rawTitle) || rawTitle;
  const artistPrimary = getSpotifyPrimaryArtist(rawArtist);
  const artistSearchFriendly = rawArtist
    .replace(/[,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const titleFeatHints = collectFeaturedArtistHints(rawTitle);
  const titleBracketHints = extractBracketedTitleSegments(rawTitle);

  const variants = [
    `${rawTitle} ${artistPrimary}`.trim(),
    `${rawTitle} ${rawArtist}`.trim(),
    `${rawTitle} ${artistSearchFriendly}`.trim(),
    `${titleBase || rawTitle} ${artistPrimary}`.trim(),
    `${rawTitle} ${track?.album || ""} ${artistPrimary}`.trim(),
    rawTitle,
    `${titleBase || rawTitle} ${rawArtist}`.trim(),
  ];
  for (const hint of titleFeatHints) {
    variants.push(`${titleBase || rawTitle} ${hint} ${artistPrimary}`.trim());
  }
  for (const segment of titleBracketHints) {
    if (!collectVersionHints(segment).length) {
      variants.push(
        `${titleBase || rawTitle} ${segment} ${artistPrimary}`.trim(),
      );
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const value of variants) {
    const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(value);
  }
  return deduped;
}

function containsCjk(input) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    String(input || ""),
  );
}

function isAmbiguousTopMatch(ranked) {
  const top = ranked[0];
  const second = ranked[1];
  if (!top || !second) {
    return false;
  }
  return (
    top.score < MATCH_CONFIDENCE_SCORE &&
    top.score - second.score < AMBIGUITY_MAX_SCORE_GAP
  );
}

function parseTimestampMs(raw) {
  const value = String(raw || "").trim();
  const matched = value.match(/^(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!matched) {
    return Number.NaN;
  }
  const [, min, sec, fraction = "0"] = matched;
  const millis =
    fraction.length === 1
      ? Number(fraction) * 100
      : fraction.length === 2
        ? Number(fraction) * 10
        : Number(String(fraction).slice(0, 3));
  return Number(min) * 60_000 + Number(sec) * 1_000 + millis;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeSyllables(syllables, lineStartTime, lineEndTime) {
  const safeLineEnd = Math.max(lineStartTime + 250, lineEndTime);
  const next = [];
  for (const part of syllables) {
    if (!part || typeof part.text !== "string" || !part.text.trim()) {
      continue;
    }
    const start = Number.isFinite(part.startTime)
      ? clampNumber(part.startTime, lineStartTime, safeLineEnd)
      : lineStartTime;
    const end = Number.isFinite(part.endTime)
      ? clampNumber(part.endTime, start, safeLineEnd)
      : safeLineEnd;
    const safeEnd = end > start ? end : Math.min(safeLineEnd, start + 120);
    const hasIsPartOfWord = typeof part.isPartOfWord === "boolean";
    next.push({
      text: part.text,
      startTime: start,
      endTime: safeEnd,
      ...(hasIsPartOfWord ? { isPartOfWord: part.isPartOfWord } : {}),
    });
  }
  return next;
}

function parseEnhancedLrcSyllables(text, lineStartTime, lineEndTime) {
  const tagRegex = /<(\d{1,2}:\d{2}(?:\.\d{1,3})?)>/g;
  const tags = [];
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    const timeMs = parseTimestampMs(match[1]);
    if (!Number.isFinite(timeMs)) {
      continue;
    }
    tags.push({
      timeMs,
      tokenEnd: tagRegex.lastIndex,
      tokenStart: match.index,
    });
  }
  if (!tags.length) {
    return [];
  }

  const syllables = [];
  const leadingChunk = text.slice(0, tags[0].tokenStart);
  const shouldMergeLeadingChunk =
    leadingChunk.trim() &&
    tags[0].timeMs - lineStartTime <= LEADING_PREFIX_MERGE_THRESHOLD_MS;
  if (leadingChunk.trim() && !shouldMergeLeadingChunk) {
    syllables.push({
      text: leadingChunk,
      startTime: lineStartTime,
      endTime: tags[0].timeMs,
    });
  }

  for (let index = 0; index < tags.length; index += 1) {
    const current = tags[index];
    const next = tags[index + 1];
    const baseChunk = text.slice(
      current.tokenEnd,
      next ? next.tokenStart : text.length,
    );
    const chunk =
      index === 0 && shouldMergeLeadingChunk
        ? `${leadingChunk}${baseChunk}`
        : baseChunk;
    if (!chunk.trim()) {
      continue;
    }
    const endTime = next ? next.timeMs : lineEndTime;
    syllables.push({
      text: chunk,
      startTime: current.timeMs,
      endTime,
    });
  }

  return normalizeSyllables(syllables, lineStartTime, lineEndTime);
}

function getGraphemeCount(text) {
  const value = String(text || "");
  const Segmenter = Intl?.Segmenter;
  if (Segmenter) {
    return [
      ...new Segmenter(undefined, { granularity: "grapheme" }).segment(value),
    ].length;
  }
  return [...value].length;
}

const QRC_ACCENT_VOWEL_FRAGMENT_RE = /^[áéíóúüñÁÉÍÓÚÜÑ]$/u;
const QRC_POST_ACCENT_LETTER_RE = /^[a-zñ]$/i;
const QRC_POST_ACCENT_WORD_BREAK_RE =
  /^(?:y|o|a|e|de|el|la|los|las|en|un|una|que|por|con|se|es|al|del|yo|tu|no|si)$/i;

function isQrcAccentVowelFragment(text) {
  const trimmed = String(text || "").trim();
  return (
    trimmed.length > 0 &&
    getGraphemeCount(trimmed) === 1 &&
    QRC_ACCENT_VOWEL_FRAGMENT_RE.test(trimmed)
  );
}

function endsWithQrcAccentVowel(text) {
  return QRC_ACCENT_VOWEL_FRAGMENT_RE.test(
    String(text || "")
      .replace(/\s+$/u, "")
      .slice(-1),
  );
}

function isQrcPostAccentLetterFragment(text) {
  const trimmed = String(text || "").trim();
  return (
    trimmed.length > 0 &&
    getGraphemeCount(trimmed) === 1 &&
    QRC_POST_ACCENT_LETTER_RE.test(trimmed)
  );
}

function hasSingleLetterBeforeAccentVowel(text) {
  const core = String(text || "").replace(/\s+$/u, "");
  return /(?:^|\s)([a-zñ])[áéíóúüñÁÉÍÓÚÜÑ]$/u.test(core);
}

function isQrcPostAccentSyllableTail(text, maxLength) {
  const trimmed = String(text || "").trim();
  if (!trimmed || QRC_POST_ACCENT_WORD_BREAK_RE.test(trimmed)) {
    return false;
  }
  if (isQrcPostAccentLetterFragment(trimmed)) {
    return true;
  }
  return /^[a-zñ]+$/i.test(trimmed) && trimmed.length <= maxLength;
}

function hasQrcAccentWordBoundary(text) {
  // QQ QRC puts a space after a completed accented word token (e.g. "é ").
  return /[áéíóúüñÁÉÍÓÚÜÑ]\s+$/u.test(String(text || ""));
}

function shouldMergeQrcPostAccentTail(previousText, fragmentText) {
  const previous = String(previousText || "");
  if (hasQrcAccentWordBoundary(previous)) {
    return false;
  }
  const previousCore = previous.replace(/\s+$/u, "");
  if (!endsWithQrcAccentVowel(previousCore)) {
    return false;
  }
  const trimmed = String(fragmentText || "").trim();
  if (isQrcPostAccentLetterFragment(trimmed)) {
    return true;
  }
  if (hasSingleLetterBeforeAccentVowel(previousCore)) {
    return isQrcPostAccentSyllableTail(trimmed, 8);
  }
  return isQrcPostAccentSyllableTail(trimmed, 4);
}

function appendQrcSyllableText(previousText, fragmentText) {
  const previous = String(previousText || "");
  const fragment = String(fragmentText || "");
  const previousCore = previous.replace(/\s+$/u, "");
  const fragmentCore = fragment.trim();
  const trailingSpace = /\s$/u.test(fragment)
    ? " "
    : /\s$/u.test(previous)
      ? " "
      : "";
  return `${previousCore}${fragmentCore}${trailingSpace}`;
}

function mergeQrcTimedTextSyllables(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) {
    return syllables;
  }

  const merged = [];
  for (const syllable of syllables) {
    const previous = merged[merged.length - 1];
    const rawText = String(syllable?.text || "");
    const trimmed = rawText.trim();
    if (!previous || !trimmed) {
      merged.push({ ...syllable, text: rawText });
      continue;
    }

    const shouldMergeAccent = isQrcAccentVowelFragment(trimmed);
    const shouldMergePostAccent = shouldMergeQrcPostAccentTail(
      previous.text,
      rawText,
    );

    if (!shouldMergeAccent && !shouldMergePostAccent) {
      merged.push({ ...syllable, text: rawText });
      continue;
    }

    previous.text = appendQrcSyllableText(previous.text, rawText);
    previous.endTime = syllable.endTime;
  }

  return merged;
}

function appendQrcWhitespaceOnlyChunk(syllables, chunk) {
  const whitespace = String(chunk || "");
  if (!whitespace.trim() && whitespace && syllables.length) {
    syllables[syllables.length - 1].text += whitespace;
    return true;
  }
  return false;
}

function parseQrcSyllables(text, lineStartTime, lineEndTime) {
  const tokenRegex = /\((\d+),(\d+)(?:,[^)]*)?\)/g;
  const tokens = [];
  let match;
  while ((match = tokenRegex.exec(text)) !== null) {
    tokens.push({
      rawStart: Number(match[1]),
      rawDuration: Number(match[2]),
      tokenEnd: tokenRegex.lastIndex,
      tokenStart: match.index,
    });
  }
  if (!tokens.length) {
    return [];
  }

  const lineDuration = Math.max(1, lineEndTime - lineStartTime);
  const isRelative = tokens.every(
    (token) => token.rawStart <= lineDuration * 2,
  );
  const resolveStart = (rawStart) =>
    isRelative ? lineStartTime + rawStart : rawStart;

  const syllables = [];
  const leadingChunk = text.slice(0, tokens[0].tokenStart);
  const firstTokenStart = resolveStart(tokens[0].rawStart);
  const trailingTokenMode =
    leadingChunk.trim() &&
    Math.abs(firstTokenStart - lineStartTime) <=
      LEADING_PREFIX_MERGE_THRESHOLD_MS;

  if (trailingTokenMode) {
    // Some QQ-QRC lines place timing tokens after each word segment.
    for (let index = 0; index < tokens.length; index += 1) {
      const current = tokens[index];
      const next = tokens[index + 1];
      const chunk =
        index === 0
          ? leadingChunk
          : text.slice(tokens[index - 1].tokenEnd, current.tokenStart);
      if (appendQrcWhitespaceOnlyChunk(syllables, chunk)) {
        continue;
      }
      if (!chunk.trim()) {
        continue;
      }
      const startTime = resolveStart(current.rawStart);
      const endTime =
        current.rawDuration > 0
          ? startTime + current.rawDuration
          : next
            ? resolveStart(next.rawStart)
            : lineEndTime;
      syllables.push({
        text: chunk,
        startTime,
        endTime,
      });
    }
  } else {
    if (leadingChunk.trim()) {
      syllables.push({
        text: leadingChunk,
        startTime: lineStartTime,
        endTime: firstTokenStart,
      });
    }

    for (let index = 0; index < tokens.length; index += 1) {
      const current = tokens[index];
      const next = tokens[index + 1];
      const chunk = text.slice(
        current.tokenEnd,
        next ? next.tokenStart : text.length,
      );
      if (appendQrcWhitespaceOnlyChunk(syllables, chunk)) {
        continue;
      }
      if (!chunk.trim()) {
        continue;
      }
      const startTime = resolveStart(current.rawStart);
      const endTime =
        current.rawDuration > 0
          ? startTime + current.rawDuration
          : next
            ? resolveStart(next.rawStart)
            : lineEndTime;
      syllables.push({
        text: chunk,
        startTime,
        endTime,
      });
    }
  }

  return normalizeSyllables(
    mergeQrcTimedTextSyllables(syllables),
    lineStartTime,
    lineEndTime,
  );
}
