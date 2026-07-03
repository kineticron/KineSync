"use strict";

const ITUNES_NS = "http://itunes.apple.com/lyric-ttml-extensions";

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripXmlTags(value) {
  return decodeXmlEntities(
    String(value || "")
      .replace(/<[^>]+>/g, "")
      .trim(),
  );
}

function parseTtmlClock(value) {
  return parseTtmlTimeExpression(value);
}

function parseTtmlTimeExpression(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return 0;
  }

  const offsetMatch = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (offsetMatch) {
    const amount = Number(offsetMatch[1]);
    if (!Number.isFinite(amount)) {
      return 0;
    }
    switch (offsetMatch[2].toLowerCase()) {
      case "ms":
        return Math.round(amount);
      case "s":
        return Math.round(amount * 1_000);
      case "m":
        return Math.round(amount * 60_000);
      case "h":
        return Math.round(amount * 3_600_000);
      default:
        return 0;
    }
  }

  if (raw.includes(":")) {
    const frameClockMatch = raw.match(
      /^(\d+):(\d{2}):(\d{2}):(\d{1,3})$/,
    );
    if (frameClockMatch) {
      const hours = Number(frameClockMatch[1]);
      const minutes = Number(frameClockMatch[2]);
      const seconds = Number(frameClockMatch[3]);
      const frames = Number(frameClockMatch[4]);
      const frameRate = 30;
      return (
        hours * 3_600_000 +
        minutes * 60_000 +
        seconds * 1_000 +
        Math.round((frames / frameRate) * 1_000)
      );
    }

    const parts = raw.split(":");
    if (parts.length === 3) {
      const hours = Number(parts[0]);
      const minutes = Number(parts[1]);
      const secondsMatch = String(parts[2] || "").match(
        /^(\d{1,2})(?:[.:](\d{1,3}))?$/,
      );
      if (!secondsMatch) {
        return 0;
      }
      const seconds = Number(secondsMatch[1]);
      const millis = Number(
        String(secondsMatch[2] || "0")
          .padEnd(3, "0")
          .slice(0, 3),
      );
      return hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + millis;
    }

    if (parts.length === 2) {
      const minutes = Number(parts[0]);
      const secondsMatch = String(parts[1] || "").match(
        /^(\d{1,2})(?:\.(\d{1,3}))?$/,
      );
      if (!secondsMatch) {
        return 0;
      }
      const seconds = Number(secondsMatch[1]);
      const millis = Number(
        String(secondsMatch[2] || "0")
          .padEnd(3, "0")
          .slice(0, 3),
      );
      return minutes * 60_000 + seconds * 1_000 + millis;
    }
  }

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const amount = Number(raw);
    if (!Number.isFinite(amount)) {
      return 0;
    }
    // Large bare numbers are usually already milliseconds (e.g. 125000).
    if (amount >= 10_000) {
      return Math.round(amount);
    }
    return Math.round(amount * 1_000);
  }

  return 0;
}

function getLyricTimingExtents(lyrics) {
  let maxEnd = 0;
  for (const line of Array.isArray(lyrics) ? lyrics : []) {
    maxEnd = Math.max(
      maxEnd,
      Number(line?.lineEndTime || 0),
      Number(line?.lineStartTime || 0),
    );
    for (const syllable of [
      ...(Array.isArray(line?.syllables) ? line.syllables : []),
      ...(Array.isArray(line?.backgroundSyllables)
        ? line.backgroundSyllables
        : []),
    ]) {
      maxEnd = Math.max(
        maxEnd,
        Number(syllable?.endTime || 0),
        Number(syllable?.startTime || 0),
      );
    }
  }
  return { maxEnd };
}

function lyricsTimestampsLookLikeUnscaledSeconds(lyrics) {
  const lineCount = Array.isArray(lyrics) ? lyrics.length : 0;
  if (lineCount < 4) {
    return false;
  }
  const { maxEnd } = getLyricTimingExtents(lyrics);
  if (maxEnd <= 0) {
    return false;
  }
  // e.g. a 3-minute song stored as 0..180 instead of 0..180000
  if (maxEnd >= 45 && maxEnd <= 900 && lineCount >= 8) {
    return true;
  }
  if (maxEnd >= 15 && maxEnd <= 120 && lineCount >= 20) {
    return true;
  }
  return false;
}

function scaleLyricsTimestamps(lyrics, multiplier) {
  const factor = Number(multiplier) || 1;
  if (factor === 1) {
    return lyrics;
  }
  for (const line of lyrics) {
    if (!line || typeof line !== "object") {
      continue;
    }
    if (Number.isFinite(Number(line.lineStartTime))) {
      line.lineStartTime = Math.round(Number(line.lineStartTime) * factor);
    }
    if (Number.isFinite(Number(line.lineEndTime))) {
      line.lineEndTime = Math.round(Number(line.lineEndTime) * factor);
    }
    for (const key of ["syllables", "backgroundSyllables"]) {
      if (!Array.isArray(line[key])) {
        continue;
      }
      for (const syllable of line[key]) {
        if (!syllable || typeof syllable !== "object") {
          continue;
        }
        if (Number.isFinite(Number(syllable.startTime))) {
          syllable.startTime = Math.round(Number(syllable.startTime) * factor);
        }
        if (Number.isFinite(Number(syllable.endTime))) {
          syllable.endTime = Math.round(Number(syllable.endTime) * factor);
        }
      }
    }
  }
  return lyrics;
}

function normalizeImportedLyricsTimestamps(lyrics) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return lyrics;
  }
  if (lyricsTimestampsLookLikeUnscaledSeconds(lyrics)) {
    scaleLyricsTimestamps(lyrics, 1_000);
  }
  for (const line of lyrics) {
    if (Array.isArray(line?.syllables)) {
      embedImportedSyllableSpacing(line.syllables);
    }
    if (Array.isArray(line?.backgroundSyllables)) {
      embedImportedSyllableSpacing(line.backgroundSyllables);
    }
  }
  return lyrics;
}

function readAttribute(attributes, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i");
  const match = String(attributes || "").match(pattern);
  return match ? match[1] : "";
}

const OPENING_DOUBLE_QUOTE_WORD_LEAD_RE = /^[""«"\u201c]([A-Za-z0-9])/;

function nextSyllableLeadsWithOpeningDoubleQuotedWord(leftText, nextText) {
  const leftTrim = String(leftText || "").trim();
  const nextTrim = String(nextText || "").trim();
  if (!leftTrim || !nextTrim || !/[A-Za-z0-9]$/.test(leftTrim)) {
    return false;
  }
  return OPENING_DOUBLE_QUOTE_WORD_LEAD_RE.test(nextTrim);
}

function nextSyllableLeadsWithAttachPunctuation(nextText) {
  const trimmed = String(nextText || "").trim();
  if (!trimmed) {
    return false;
  }
  if (/^[,;.!?)\]\}%\-–—]/.test(trimmed)) {
    return true;
  }
  if (/^['’‘](m|re|s|d|ll|ve|t|n|clock|all)\b/i.test(trimmed)) {
    return true;
  }
  if (/^['’‘"”]$/.test(trimmed)) {
    return true;
  }
  return false;
}

function shouldInsertSyllableBoundarySpace(leftText, rightText) {
  if (!leftText || !rightText) {
    return false;
  }
  if (/\s$/.test(leftText) || /^\s/.test(rightText)) {
    return false;
  }
  if (nextSyllableLeadsWithOpeningDoubleQuotedWord(leftText, rightText)) {
    return true;
  }
  if (nextSyllableLeadsWithAttachPunctuation(rightText)) {
    return false;
  }
  const leftChar = leftText[leftText.length - 1];
  const rightChar = rightText[0];
  const latinOrDigit = /[A-Za-z0-9]/;
  return latinOrDigit.test(leftChar) && latinOrDigit.test(rightChar);
}

function containsCjk(text) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(
    String(text || ""),
  );
}

function joinImportedSyllableText(syllables) {
  const parts = (Array.isArray(syllables) ? syllables : []).filter(
    (part) => String(part?.text || "").length > 0,
  );
  if (!parts.length) {
    return "";
  }
  let text = parts[0].text;
  for (let index = 1; index < parts.length; index += 1) {
    const nextPart = parts[index];
    const prevPart = parts[index - 1];
    const hasWhitespaceBoundary = /\s$/.test(text) || /^\s/.test(nextPart.text);
    const boundaryFromWordFlag = prevPart.isPartOfWord === false;
    const boundaryFromHeuristic =
      prevPart.isPartOfWord !== true &&
      prevPart.isPartOfWord !== false &&
      shouldInsertSyllableBoundarySpace(text, nextPart.text);
    if (
      !hasWhitespaceBoundary &&
      (boundaryFromWordFlag || boundaryFromHeuristic)
    ) {
      text += " ";
    }
    text += nextPart.text;
  }
  return text.trim();
}

function applyImportedWordBoundaries(syllables) {
  const parts = Array.isArray(syllables) ? syllables : [];
  for (let index = 0; index < parts.length; index += 1) {
    const current = parts[index];
    const next = parts[index + 1];
    if (!next) {
      current.isPartOfWord = false;
      continue;
    }

    if (next.hadWhitespaceBefore) {
      current.isPartOfWord = false;
      continue;
    }

    const gapMs = Math.max(
      0,
      Number(next.startTime || 0) - Number(current.endTime || 0),
    );
    const timingBoundary =
      gapMs >= 120 &&
      (shouldInsertSyllableBoundarySpace(current.text, next.text) ||
        (!containsCjk(current.text) &&
          !containsCjk(next.text) &&
          gapMs >= 250));

    if (timingBoundary) {
      current.isPartOfWord = false;
      continue;
    }

    current.isPartOfWord = true;
  }

  for (const part of parts) {
    delete part.hadWhitespaceBefore;
  }
  embedImportedSyllableSpacing(parts);
  return parts;
}

function embedImportedSyllableSpacing(syllables) {
  for (let index = 0; index < syllables.length - 1; index += 1) {
    const current = syllables[index];
    const next = syllables[index + 1];
    if (!current || !next) {
      continue;
    }
    if (current.isPartOfWord !== false) {
      continue;
    }
    const currentText = String(current.text || "");
    const nextText = String(next.text || "");
    if (/\s$/.test(currentText) || /^\s/.test(nextText)) {
      continue;
    }
    if (nextSyllableLeadsWithAttachPunctuation(nextText)) {
      continue;
    }
    current.text = `${currentText} `;
  }
  return syllables;
}

function hasRole(attributes, role) {
  return readAttribute(attributes, "ttm:role").toLowerCase() === role;
}

function parseTimingSpans(content, lineStart, lineEnd) {
  const spans = [];
  const spanRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  let match = spanRe.exec(content);
  let cursor = 0;

  while (match) {
    const attributes = match[1];
    const inner = match[2];
    const matchStart = match.index;
    const between = content.slice(cursor, matchStart);
    const hadWhitespaceBefore =
      spans.length > 0 && /\s/.test(String(between || ""));

    if (hasRole(attributes, "x-translation") || hasRole(attributes, "x-bg")) {
      cursor = matchStart + match[0].length;
      match = spanRe.exec(content);
      continue;
    }
    const begin = readAttribute(attributes, "begin");
    const end = readAttribute(attributes, "end");
    const text = stripXmlTags(inner);
    if (!text) {
      cursor = matchStart + match[0].length;
      match = spanRe.exec(content);
      continue;
    }
    const startTime = begin ? parseTtmlClock(begin) : lineStart;
    let endTime = end ? parseTtmlClock(end) : lineEnd;
    if (!Number.isFinite(endTime) || endTime <= startTime) {
      endTime = Math.max(startTime + 1, lineEnd);
    }
    spans.push({
      text,
      startTime,
      endTime,
      hadWhitespaceBefore,
    });
    cursor = matchStart + match[0].length;
    match = spanRe.exec(content);
  }

  return applyImportedWordBoundaries(spans).map((part) => {
    const syllable = {
      text: part.text,
      startTime: part.startTime,
      endTime: part.endTime,
    };
    if (typeof part.isPartOfWord === "boolean") {
      syllable.isPartOfWord = part.isPartOfWord;
    }
    return syllable;
  });
}

function parseTranslationText(content) {
  const spanRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  let match = spanRe.exec(content);
  while (match) {
    if (hasRole(match[1], "x-translation")) {
      return stripXmlTags(match[2]);
    }
    match = spanRe.exec(content);
  }
  return "";
}

function parseBackgroundSpans(content, lineStart, lineEnd) {
  const spanRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  let match = spanRe.exec(content);
  while (match) {
    if (!hasRole(match[1], "x-bg")) {
      match = spanRe.exec(content);
      continue;
    }
    const begin = readAttribute(match[1], "begin");
    const end = readAttribute(match[1], "end");
    const bgStart = begin ? parseTtmlClock(begin) : lineStart;
    const bgEnd = end ? parseTtmlClock(end) : lineEnd;
    const syllables = parseTimingSpans(match[2], bgStart, bgEnd);
    if (syllables.length) {
      return syllables;
    }
    match = spanRe.exec(content);
  }
  return [];
}

function parseParagraphs(ttmlContent, useKaraokeTiming) {
  const lyrics = [];
  const paraRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match = paraRe.exec(ttmlContent);
  let documentEndMs = 0;

  while (match) {
    const attributes = match[1];
    const inner = match[2];
    const lineStart = parseTtmlClock(readAttribute(attributes, "begin"));
    let lineEnd = parseTtmlClock(readAttribute(attributes, "end"));
    if (!Number.isFinite(lineEnd) || lineEnd <= lineStart) {
      lineEnd = lineStart + 3000;
    }
    documentEndMs = Math.max(documentEndMs, lineEnd);

    const translatedText = parseTranslationText(inner);
    const backgroundSyllables = parseBackgroundSpans(inner, lineStart, lineEnd);
    let syllables = [];

    if (useKaraokeTiming) {
      syllables = parseTimingSpans(inner, lineStart, lineEnd);
    }

    if (!syllables.length) {
      const plainText = stripXmlTags(
        inner.replace(/<span\b[^>]*ttm:role\s*=\s*"x-translation"[^>]*>[\s\S]*?<\/span>/gi, ""),
      );
      if (plainText) {
        syllables = [
          {
            text: plainText,
            startTime: lineStart,
            endTime: lineEnd,
          },
        ];
      }
    }

    if (!syllables.length) {
      match = paraRe.exec(ttmlContent);
      continue;
    }

    const line = {
      lineStartTime: lineStart,
      lineEndTime: lineEnd,
      syllables,
    };
    if (backgroundSyllables.length) {
      line.backgroundSyllables = backgroundSyllables;
    }
    if (translatedText) {
      line.translatedText = translatedText;
    }
    lyrics.push(line);
    match = paraRe.exec(ttmlContent);
  }

  return { lyrics, durationMs: documentEndMs };
}

function detectKaraokeTiming(ttmlContent) {
  const timingMatch = String(ttmlContent || "").match(
    new RegExp(`itunes:timing\\s*=\\s*"(Word|Line)"`, "i"),
  );
  if (timingMatch) {
    return timingMatch[1].toLowerCase() === "word";
  }
  return /<span\b[^>]*\bbegin\s*=/i.test(ttmlContent);
}

function parseTtmlToLyrics(ttmlContent) {
  const content = String(ttmlContent || "");
  if (!content.trim()) {
    return { lyrics: [], durationMs: 0, useKaraokeTiming: false };
  }
  const useKaraokeTiming = detectKaraokeTiming(content);
  const parsed = parseParagraphs(content, useKaraokeTiming);
  normalizeImportedLyricsTimestamps(parsed.lyrics);
  return {
    lyrics: parsed.lyrics,
    durationMs: getLyricTimingExtents(parsed.lyrics).maxEnd || parsed.durationMs,
    useKaraokeTiming,
  };
}

function extractTtmlMetadata(ttmlContent) {
  const content = String(ttmlContent || "");
  const titleMatch = content.match(/<ttm:title>([\s\S]*?)<\/ttm:title>/i);
  const artistMatch = content.match(
    /<ttm:agent[^>]*>[\s\S]*?<ttm:name[^>]*>([\s\S]*?)<\/ttm:name>/i,
  );
  return {
    title: stripXmlTags(titleMatch?.[1] || ""),
    artist: stripXmlTags(artistMatch?.[1] || ""),
  };
}

module.exports = {
  decodeXmlEntities,
  detectKaraokeTiming,
  extractTtmlMetadata,
  joinImportedSyllableText,
  normalizeImportedLyricsTimestamps,
  parseTtmlClock,
  parseTtmlTimeExpression,
  parseTtmlToLyrics,
};
