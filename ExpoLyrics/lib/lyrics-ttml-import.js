"use strict";

const { segmentTimedLine } = require("../../DesktopBridge/src/lyricsLineSegmentation")

const { decodeText: decodeXmlEntities, extractTtmlTranslations, extractTimedBackgroundGroups,
  unwrapTtmlBackgroundText, resolveTtmlTranslationLanes, markLiteralBackgroundParentheses,
  selectTtmlTranslationTracks } = require("../../DesktopBridge/src/lyricsTtmlTranslations");

const ITUNES_NS = "http://itunes.apple.com/lyric-ttml-extensions";

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
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = String(attributes || "").match(pattern);
  return match?.[1] ?? match?.[2] ?? "";
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
  if (/^(['’‘](?:[mtsd]|re|ve|ll|clock|all)\b|n['’]t\b)/i.test(trimmed)) {
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
  // Prefix elisions (e.g. c', d', l', o', y') cling to the following word.
  if (/^(?:[cdjlnst]|qu|[ouy]|all|dell|nell|sant)['’]$/i.test(String(leftText || "").trim())) {
    return false;
  }
  const leftIsWord =
    /[A-Za-z0-9]/.test(leftChar) ||
    (/[A-Za-z0-9]['’]$/u.test(String(leftText || "").trim()) || /^['’][A-Za-z0-9]['’]$/u.test(String(leftText || "").trim()));
  const rightIsWord =
    /[A-Za-z0-9]/.test(rightChar) ||
    (/^['’][A-Za-z0-9]/u.test(String(rightText || "").trim()) && !nextSyllableLeadsWithAttachPunctuation(rightText));

  return leftIsWord && rightIsWord;
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

function applyImportedWordBoundaries(syllables, inferTimingBoundaries = true) {
  const parts = Array.isArray(syllables) ? syllables : [];
  for (let index = 0; index < parts.length; index += 1) {
    const current = parts[index];
    const next = parts[index + 1];
    if (!next) {
      current.isPartOfWord = false;
      continue;
    }

    if (next.hadWhitespaceBefore || current.hadTrailingWhitespace) {
      current.isPartOfWord = false;
      continue;
    }

    const gapMs = Math.max(
      0,
      Number(next.startTime || 0) - Number(current.endTime || 0),
    );
    const timingBoundary =
      inferTimingBoundaries &&
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
    delete part.hadTrailingWhitespace;
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

function readRole(attributes, offset, roles) {
  return roles ? roles.get(offset) : readAttribute(attributes, "ttm:role").trim().toLowerCase();
}

// Resolve span names without shifting the role or paragraph-key offsets.
function normalizeTtmlSpanNames(content, spanNames) {
  if (!spanNames?.size) return content;
  const chunks = [];
  let cursor = 0;
  for (const [offset, name] of [...spanNames].sort(([left], [right]) => left - right)) {
    chunks.push(content.slice(cursor, offset), name);
    cursor = offset + name.length;
  }
  chunks.push(content.slice(cursor));
  return chunks.join("");
}

// Walk balanced spans so nested background vocals retain their inner timing.
function topLevelSpans(content, context) {
  const tokens = /<\/?span(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  const result = [];
  let depth = 0;
  let opening = null;
  let token;
  while ((token = tokens.exec(content))) {
    if (/^<\//.test(token[0])) {
      if (depth === 0) continue;
      if (--depth === 0 && opening) {
        const attributes = opening[0].slice(5, -1);
        const start = context.offset + opening.index;
        result.push({
          attributes,
          role: readRole(attributes, start, context.roles),
          context: { ...context, offset: start + opening[0].length },
          inner: content.slice(opening.index + opening[0].length, token.index),
          start: opening.index,
          end: tokens.lastIndex,
        });
      }
    } else if (!/\/\s*>$/.test(token[0])) {
      if (depth++ === 0) opening = token;
    }
  }
  return result;
}

function collectTimingSpans(content, lineStart, lineEnd, context, keepLiteralText) {
  const spans = [];
  let cursor = 0;
  let prefix = "";
  const appendLiteralText = (text) => {
    const previous = spans[spans.length - 1];
    if (previous) {
      previous.text += text;
      if (text) previous.hadTrailingWhitespace = /\s$/.test(text);
    } else {
      prefix += text;
    }
  };

  for (const span of topLevelSpans(content, context)) {
    const { attributes, inner, role } = span;
    const between = content.slice(cursor, span.start);
    if (keepLiteralText) appendLiteralText(decodeXmlEntities(between.replace(/<[^>]+>/g, "")));
    const hadWhitespaceBefore = !keepLiteralText && spans.length > 0 && /\s/.test(between);

    if (
      role === "x-translation" ||
      role === "x-bg-translation" ||
      role === "x-bg"
    ) {
      cursor = span.end;
      continue;
    }
    const begin = readAttribute(attributes, "begin");
    const end = readAttribute(attributes, "end");
    const leadContent = leadLyricContent(inner, span.context);
    const literal = decodeXmlEntities(leadContent.replace(/<[^>]+>/g, ""));
    const text = keepLiteralText ? literal : literal.trim();
    if (!text.trim()) {
      if (literal) {
        if (keepLiteralText) appendLiteralText(literal);
        else if (spans.length) spans[spans.length - 1].hadTrailingWhitespace = true;
      }
      cursor = span.end;
      continue;
    }
    const startTime = begin ? parseTtmlClock(begin) : lineStart;
    let endTime = end ? parseTtmlClock(end) : lineEnd;
    if (!Number.isFinite(endTime) || endTime <= startTime) {
      endTime = Math.max(startTime + 1, lineEnd);
    }
    const nested = topLevelSpans(inner, span.context).length
      ? collectTimingSpans(inner, startTime, endTime, span.context, keepLiteralText)
      : [];
    const first = spans.length;
    if (nested.length) {
      spans.push(...nested);
      if (hadWhitespaceBefore && spans.length > nested.length) {
        spans[spans.length - nested.length].hadWhitespaceBefore = true;
      }
    } else {
      spans.push({
        text,
        startTime,
        endTime,
        hadWhitespaceBefore,
        hadTrailingWhitespace: /\s$/.test(decodeXmlEntities(inner.replace(/<[^>]+>/g, ""))),
      });
    }
    if (prefix) {
      spans[first].text = prefix + spans[first].text;
      prefix = "";
    }
    cursor = span.end;
  }
  if (keepLiteralText) appendLiteralText(decodeXmlEntities(content.slice(cursor).replace(/<[^>]+>/g, "")));

  return spans;
}

function parseTimingSpans(content, lineStart, lineEnd, context, unwrapBackground = false, inferTimingBoundaries = true, keepLiteralText = false) {
  const fullText = unwrapBackground ? stripXmlTags(leadLyricContent(content, context)).trim() : "";
  const hasWrapper = unwrapTtmlBackgroundText(fullText) !== fullText;
  // Include text between timed spans before removing the full source wrapper.
  let parts = collectTimingSpans(content, lineStart, lineEnd, context, keepLiteralText || hasWrapper);
  if (hasWrapper && parts.length) {
    parts[0].text = parts[0].text.replace(/^\s*[(（]\s*/, "");
    const last = parts[parts.length - 1];
    last.text = last.text.replace(/\s*[)）]\s*$/, "");
    parts = parts.filter(part => part.text.trim());
  }
  return applyImportedWordBoundaries(parts, inferTimingBoundaries).map((part) => {
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

function parseTranslationText(content, context, role = "x-translation") {
  for (const span of topLevelSpans(content, context)) {
    if (span.role === role) {
      const text = stripXmlTags(span.inner);
      return role === "x-bg-translation"
        ? unwrapTtmlBackgroundText(text)
        : text;
    }
    if (span.role === "x-bg" && role === "x-translation") continue;
    const nested = parseTranslationText(span.inner, span.context, role);
    if (nested) return nested;
  }
  return "";
}

function parseNestedBackgroundTranslation(content, context) {
  for (const span of topLevelSpans(content, context)) {
    const text = span.role === "x-bg"
      ? unwrapTtmlBackgroundText(parseTranslationText(span.inner, span.context))
      : parseNestedBackgroundTranslation(span.inner, span.context);
    if (text) return text;
  }
  return "";
}

function parseBackgroundSpans(content, lineStart, lineEnd, context, inferTimingBoundaries, useKaraokeTiming) {
  const backgrounds = [];
  for (const span of topLevelSpans(content, context)) {
    if (span.role !== "x-bg") {
      if (span.role !== "x-translation" && span.role !== "x-bg-translation") {
        backgrounds.push(...parseBackgroundSpans(span.inner, lineStart, lineEnd, span.context, inferTimingBoundaries, useKaraokeTiming));
      }
      continue;
    }
    const begin = readAttribute(span.attributes, "begin");
    const end = readAttribute(span.attributes, "end");
    const bgStart = begin ? parseTtmlClock(begin) : lineStart;
    const bgEnd = end ? parseTtmlClock(end) : lineEnd;
    const timed = parseTimingSpans(span.inner, bgStart, bgEnd, span.context, true, inferTimingBoundaries);
    if (timed.length) {
      backgrounds.push(timed);
      continue;
    }
    const text = unwrapTtmlBackgroundText(stripXmlTags(leadLyricContent(span.inner, span.context)));
    if (text) backgrounds.push(useKaraokeTiming
      ? [{ text, startTime: bgStart, endTime: bgEnd }]
      : segmentTimedLine(text, bgStart, bgEnd));
  }
  return backgrounds;
}

function leadLyricContent(content, context) {
  let result = "";
  let cursor = 0;
  for (const span of topLevelSpans(content, context)) {
    result += content.slice(cursor, span.start);
    if (span.role !== "x-bg" && span.role !== "x-translation" && span.role !== "x-bg-translation") {
      result += leadLyricContent(span.inner, span.context);
    }
    cursor = span.end;
  }
  return result + content.slice(cursor);
}

function parseParagraphs(ttmlContent, useKaraokeTiming, inferTimingBoundaries, paragraphKeys, roles, resolveBackground) {
  const lyrics = [];
  const backgroundGroupCounts = [];
  const preservedTranslations = [];
  const paraRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match = paraRe.exec(ttmlContent);
  let documentEndMs = 0;

  while (match) {
    const attributes = match[1];
    const inner = match[2];
    const context = { offset: match.index + match[0].indexOf(">") + 1, roles };
    const lineStart = parseTtmlClock(readAttribute(attributes, "begin"));
    let lineEnd = parseTtmlClock(readAttribute(attributes, "end"));
    if (!Number.isFinite(lineEnd) || lineEnd <= lineStart) {
      lineEnd = lineStart + 3000;
    }
    documentEndMs = Math.max(documentEndMs, lineEnd);

    const explicitBackgrounds = parseBackgroundSpans(inner, lineStart, lineEnd, context, inferTimingBoundaries, useKaraokeTiming);
    const translatedText = parseTranslationText(inner, context);
    const backgroundTranslatedText = parseTranslationText(inner, context, "x-bg-translation") ||
      (resolveBackground && explicitBackgrounds.length ? parseNestedBackgroundTranslation(inner, context) : "");
    const explicitBackgroundLine = resolveBackground && readRole(attributes, match.index, roles) === "x-bg";
    // Entity-encoded delimiters also require the literal-text timing path.
    const mayHaveDelimiters = resolveBackground && !explicitBackgroundLine && /[()（）]|&#/.test(inner);
    const leadText = mayHaveDelimiters ? stripXmlTags(leadLyricContent(inner, context)) : undefined;
    const keepParentheticalText = /[()（）]/.test(leadText ?? "");
    let syllables = [];

    if (useKaraokeTiming) {
      syllables = parseTimingSpans(inner, lineStart, lineEnd, context, explicitBackgroundLine, inferTimingBoundaries, keepParentheticalText);
    }

    if (!syllables.length) {
      const text = leadText ?? stripXmlTags(leadLyricContent(inner, context));
      const plainText = explicitBackgroundLine ? unwrapTtmlBackgroundText(text) : text;
      if (plainText) {
        syllables = useKaraokeTiming
          ? [{ text: plainText, startTime: lineStart, endTime: lineEnd }]
          : segmentTimedLine(plainText, lineStart, lineEnd);
      }
    }

    if (explicitBackgroundLine && syllables.length) {
      explicitBackgrounds.unshift(syllables);
      syllables = [];
    }

    if (!syllables.length && !explicitBackgrounds.length) {
      match = paraRe.exec(ttmlContent);
      continue;
    }

    const line = {
      lineStartTime: lineStart,
      lineEndTime: lineEnd,
      syllables,
    };
    const key = paragraphKeys.get(match.index);
    if (key) line.ttmlKey = key;
    // Apple/AMLL TTML uses v2 for the opposite vocal lane. Background
    // agents belong to their nested spans and must not change the lead lane.
    if (readAttribute(attributes, "ttm:agent").trim() === "v2") {
      line.oppositeAligned = true;
    }
    const inferred = keepParentheticalText && !explicitBackgrounds.length
      ? extractTimedBackgroundGroups(syllables) : null;
    const backgroundCount = inferred?.count || explicitBackgrounds.length;
    if (inferred) {
      line.syllables = inferred.lead;
      line.backgroundSyllables = inferred.background;
    } else if (explicitBackgrounds.length) {
      line.backgroundSyllables = explicitBackgrounds.flat();
    }
    if (resolveBackground && backgroundCount) backgroundGroupCounts[lyrics.length] = backgroundCount;
    const split = resolveTtmlTranslationLanes(line, translatedText,
      resolveBackground ? backgroundCount : 0, backgroundTranslatedText);
    if (split.text) line.translatedText = split.text;
    if (split.backgroundText) line.backgroundTranslatedText = split.backgroundText;
    if (resolveBackground && (split.text || split.backgroundText)) {
      preservedTranslations.push({
        index: lyrics.length,
        ...(split.backgroundText ? { backgroundText: split.backgroundText } : {}),
        ...(split.text ? { text: split.text } : {}),
      });
    }
    lyrics.push(markLiteralBackgroundParentheses(line));
    match = paraRe.exec(ttmlContent);
  }

  return { lyrics, durationMs: documentEndMs, backgroundGroupCounts, preservedTranslations };
}

function detectKaraokeTiming(ttmlContent) {
  const timingMatch = String(ttmlContent || "").match(
    /(?:^|\s)(?:lrc|itunes):timing\s*=\s*(["'])(Word|Line)\1/i,
  );
  if (timingMatch) {
    return timingMatch[2].toLowerCase() === "word";
  }
  return /<span\b[^>]*\bbegin\s*=/i.test(ttmlContent);
}

function parseTtmlToLyrics(ttmlContent, { translationLanguage = "English", resolveParentheticalBackground = false } = {}) {
  const content = String(ttmlContent || "");
  if (!content.trim()) {
    return { lyrics: [], durationMs: 0, useKaraokeTiming: false };
  }
  const translations = extractTtmlTranslations(content);
  const timingContent = normalizeTtmlSpanNames(content, translations.spanNames);
  const useKaraokeTiming = detectKaraokeTiming(timingContent);
  // lrc.red and generated TTML encode word boundaries in literal whitespace.
  // A pause inside a word must not split adjacent syllable spans.
  const lrcRedNamespace = translations.lrcRed || /\bxmlns:lrc\s*=\s*["']https?:\/\/lrc\.red\//i.test(content);
  const resolveBackground = resolveParentheticalBackground || lrcRedNamespace;
  const inferTimingBoundaries = !resolveBackground && !translations.explicitWordBoundaries;
  const parsed = parseParagraphs(timingContent, useKaraokeTiming, inferTimingBoundaries,
    translations.tracks.length ? translations.paragraphKeys : new Map(), translations.roles, resolveBackground);
  normalizeImportedLyricsTimestamps(parsed.lyrics);
  return selectTtmlTranslationTracks({
    lyrics: parsed.lyrics,
    durationMs: getLyricTimingExtents(parsed.lyrics).maxEnd || parsed.durationMs,
    useKaraokeTiming,
    metadata: {
      ttml: {
        content,
        ...(resolveBackground ? { parentheticalBackgroundResolved: true } : {}),
        ...(parsed.backgroundGroupCounts.length
          ? { backgroundGroupCounts: Array.from(parsed.backgroundGroupCounts, count => count || 0) } : {}),
        ...(parsed.preservedTranslations.length ? { preservedTranslations: parsed.preservedTranslations } : {}),
        ...(translations.tracks.length ? { translationTracks: translations.tracks } : {}),
      },
      ...extractTtmlCredits(content),
    },
  }, translationLanguage);
}

function extractTtmlMetadata(ttmlContent) {
  const content = String(ttmlContent || "");
  const titleMatch = content.match(/<ttm:title>([\s\S]*?)<\/ttm:title>/i);
  const artistMatch = content.match(
    /<ttm:agent[^>]*>[\s\S]*?<ttm:name[^>]*>([\s\S]*?)<\/ttm:name>/i,
  );
  const amll = {};
  for (const match of content.matchAll(/<amll:meta\b([^>]*)\/?\s*>/gi)) {
    const key = readAttribute(match[1], "key");
    const value = decodeXmlEntities(readAttribute(match[1], "value")).trim();
    if (value) (amll[key] ||= []).push(value);
  }
  const spotifyTrackId = [...(amll.spotifyId || []), ...(amll.spotifyTrackId || [])]
    .map(value => value.replace(/^spotify:track:/i, "").replace(/^https?:\/\/open\.spotify\.com\/(?:intl-[^/]+\/)?track\//i, "").split(/[?#]/)[0])
    .find(value => /^[A-Za-z0-9]{22}$/.test(value));
  return {
    title: stripXmlTags(titleMatch?.[1] || amll.musicName?.[0] || ""),
    artist: stripXmlTags(artistMatch?.[1] || amll.artists?.join(", ") || ""),
    ...(amll.album?.[0] ? { album: amll.album[0] } : {}),
    ...(spotifyTrackId ? { spotifyTrackId } : {}),
  };
}

function extractTtmlCredits(content) {
  const songwriters = [...content.matchAll(/<songwriter\b[^>]*>([\s\S]*?)<\/songwriter>/gi)]
    .map(match => stripXmlTags(match[1])).filter(Boolean);
  const metadata = songwriters.length ? { credits: { songwriters: [...new Set(songwriters)] } } : {};
  for (const match of content.matchAll(/<amll:meta\b([^>]*)\/?\s*>/gi)) {
    const key = readAttribute(match[1], "key");
    if (key !== "kinesync:attribution" && key !== "kinesync:spicyApi") continue;
    try {
      const value = JSON.parse(decodeXmlEntities(readAttribute(match[1], "value")));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (key === "kinesync:attribution") metadata.attribution = value;
        else metadata.spicyApi = value;
      }
    } catch { /* Ignore malformed optional metadata. */ }
  }
  return metadata;
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
