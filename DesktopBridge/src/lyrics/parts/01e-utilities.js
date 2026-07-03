"use strict";

function stripTimingMarkup(text) {
  return String(text || "")
    .replace(/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/g, "")
    .replace(/\(\d+,\d+(?:,[^)]*)?\)/g, "")
    .trim();
}

function parseSyllablesWithFallback(lineText, lineStart, lineEnd) {
  const enhanced = parseEnhancedLrcSyllables(lineText, lineStart, lineEnd);
  if (enhanced.length) {
    return enhanced;
  }

  const qrc = parseQrcSyllables(lineText, lineStart, lineEnd);
  if (qrc.length) {
    return qrc;
  }

  const plainText = stripTimingMarkup(lineText);
  const words = (plainText || "...").split(/\s+/).filter(Boolean);
  const durationPerWord = Math.max(
    120,
    (lineEnd - lineStart) / Math.max(1, words.length),
  );
  const syllables = words.map((word, wordIndex) => {
    const start = lineStart + wordIndex * durationPerWord;
    const end = Math.min(lineEnd, start + durationPerWord);
    return {
      text: `${word}${wordIndex < words.length - 1 ? " " : ""}`,
      startTime: start,
      endTime: end,
    };
  });
  return normalizeSyllables(syllables, lineStart, lineEnd);
}

function decodeXmlEntities(input) {
  return String(input || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeQrcLyricContentText(input) {
  return (
    String(input || "")
      // Some QQ payloads keep escaped newlines inside LyricContent.
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      // Preserve literal quotes that were escaped inside the attribute payload.
      .replace(/\\"/g, '"')
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim()
  );
}

function extractLyricContentFromLyricTag(tag) {
  const source = String(tag || "");
  if (!source) {
    return "";
  }

  // Fast path for common well-formed tags.
  const greedyTerminalMatch = source.match(
    /\bLyricContent="([\s\S]*)"\s*\/?>$/i,
  );
  if (greedyTerminalMatch?.[1]) {
    return normalizeQrcLyricContentText(
      decodeXmlEntities(greedyTerminalMatch[1]),
    );
  }

  // Fallback scanner for malformed tags where LyricContent includes escaped quotes.
  const anchor = source.search(/\bLyricContent="/i);
  if (anchor < 0) {
    return "";
  }
  const valueStart = source.indexOf('"', anchor);
  if (valueStart < 0) {
    return "";
  }
  let end = valueStart + 1;
  while (end < source.length) {
    if (source[end] === '"' && source[end - 1] !== "\\") {
      break;
    }
    end += 1;
  }
  if (end <= valueStart || end >= source.length) {
    return "";
  }
  return normalizeQrcLyricContentText(
    decodeXmlEntities(source.slice(valueStart + 1, end)),
  );
}

function extractKaraokeBody(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) {
    return "";
  }
  // QQ QRC payloads come in a few XML shapes:
  // - `<Lyric_1 ... />` (self-closing)
  // - `<Lyric_1 ...></Lyric_1>` (explicit close)
  // - `<Lyric_1 ...>` (rare; sometimes formatted strangely)
  // Extract LyricContent from any opening Lyric_N tag.
  const lyricTagMatches =
    raw.match(/<Lyric_\d+\b[^>]*\/?>/g)?.filter((tag) => !/^<\//.test(tag)) ||
    [];
  if (lyricTagMatches.length) {
    const lyricContents = lyricTagMatches
      .map((tag) => {
        if (/\bIsTitle\s*=\s*"1"/i.test(tag)) {
          return "";
        }
        return extractLyricContentFromLyricTag(tag);
      })
      .filter(Boolean);
    if (lyricContents.length) {
      return lyricContents.join("\n").trim();
    }
  }
  const cdataMatch = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch?.[1]) {
    return cdataMatch[1].trim();
  }
  const attrMatch = raw.match(/LyricContent="([\s\S]*?)"/);
  if (attrMatch?.[1]) {
    return normalizeQrcLyricContentText(decodeXmlEntities(attrMatch[1]));
  }
  if (/^\s*\[(\d{2}:\d{2}|\d+,\d+)\]/m.test(raw)) {
    return raw;
  }
  const decoded = decodeXmlEntities(raw);
  const firstBracket = decoded.search(/\[(\d{2}:\d{2}|\d+,\d+)\]/);
  if (firstBracket >= 0) {
    return decoded.slice(firstBracket).trim();
  }
  return decoded.trim();
}

function hasQqTitleFlag(input) {
  const text = String(input || "");
  return /\bIsTitle\b\s*(?:[:=]\s*"?1"?|\b)/i.test(text);
}

function parseLrc(lrc) {
  const lines = String(lrc || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = [];

  for (const line of lines) {
    if (hasQqTitleFlag(line)) {
      continue;
    }

    const lrcMatch = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)$/);
    if (lrcMatch) {
      const [, min, sec, fraction = "0", text] = lrcMatch;
      if (hasQqTitleFlag(text)) {
        continue;
      }
      const millis =
        fraction.length === 2
          ? Number(fraction) * 10
          : Number(String(fraction).padEnd(3, "0"));
      const timeMs = Number(min) * 60_000 + Number(sec) * 1_000 + millis;
      parsed.push({
        timeMs,
        text: String(text || "").trim(),
        explicitEndTime: null,
      });
      continue;
    }

    const qrcMatch = line.match(/\[(\d+),(\d+)\](.*)$/);
    if (qrcMatch) {
      const [, rawStart, rawDuration, text] = qrcMatch;
      if (hasQqTitleFlag(text)) {
        continue;
      }
      const timeMs = Number(rawStart);
      const explicitEndTime = timeMs + Math.max(0, Number(rawDuration));
      parsed.push({ timeMs, text: String(text || "").trim(), explicitEndTime });
    }
  }

  return parsed
    .map((entry, index) => {
      const next = parsed[index + 1];
      const hasExplicitLineEnd =
        Number.isFinite(entry.explicitEndTime) &&
        entry.explicitEndTime > entry.timeMs;
      const lineEnd = hasExplicitLineEnd
        ? entry.explicitEndTime
        : next
          ? next.timeMs
          : entry.timeMs + 2_000;
      const syllables = parseSyllablesWithFallback(
        entry.text,
        entry.timeMs,
        lineEnd,
      );
      if (!syllables.length) {
        return null;
      }
      const lastSyllableEnd = syllables[syllables.length - 1]?.endTime;
      const hasInlineSyllableTiming =
        /\(\d+,\d+/.test(entry.text) ||
        /<\d{1,2}:\d{2}(?:\.\d{1,3})?>/.test(entry.text);
      let resolvedLineEnd = lineEnd;
      if (Number.isFinite(lastSyllableEnd) && lastSyllableEnd > entry.timeMs) {
        if (!hasExplicitLineEnd) {
          resolvedLineEnd = lastSyllableEnd;
        } else if (hasInlineSyllableTiming && lastSyllableEnd < lineEnd) {
          // QQ QRC often pads line duration to the next line while syllable
          // tokens end earlier — keep the highlight window tight to the words.
          resolvedLineEnd = lastSyllableEnd;
        }
      }
      return {
        lineStartTime: entry.timeMs,
        lineEndTime: resolvedLineEnd,
        syllables,
      };
    })
    .filter(Boolean);
}

function cleanNeteaseSpacing(rawText) {
  return String(rawText || "")
    .replace(/\s+((?:\(\d+,\d+,-?\d+\)\s*)*)([,.?!:*\]})])/g, "$1$2")
    .replace(/([(\[{])((?:\s*\(\d+,\d+,-?\d+\))*)\s+/g, "$1$2");
}

function ensureNeteaseCensorshipSpacing(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) {
    return syllables;
  }
  const censorGlyph = /^[*＊•·]+$/;
  for (let index = 1; index < syllables.length; index += 1) {
    const previous = syllables[index - 1];
    const current = syllables[index];
    if (!previous || !current) {
      continue;
    }
    const previousText = String(previous.text || "");
    const currentTrim = String(current.text || "").trim();
    const previousTrim = previousText.trim();
    if (
      !currentTrim ||
      !previousTrim ||
      !censorGlyph.test(currentTrim) ||
      censorGlyph.test(previousTrim) ||
      /\s$/.test(previousText)
    ) {
      continue;
    }
    previous.text = `${previousTrim} `;
  }
  return syllables;
}

function mergeConsecutiveCensorSyllables(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) {
    return syllables;
  }
  const censorGlyph = /^[*＊•·]+$/;
  const merged = [];
  for (const syllable of syllables) {
    const previous = merged[merged.length - 1];
    const trimmed = String(syllable?.text || "").trim();
    const previousTrim = String(previous?.text || "").trim();
    if (
      previous &&
      censorGlyph.test(trimmed) &&
      censorGlyph.test(previousTrim)
    ) {
      const previousText = String(previous.text || "").replace(/\s+$/u, "");
      const trailingSpace = /\s$/u.test(syllable.text) ? " " : "";
      previous.text = `${previousText}${trimmed}${trailingSpace}`;
      previous.endTime = syllable.endTime;
      continue;
    }
    merged.push({ ...syllable });
  }
  return merged;
}

function parseNeteaseYrc(yrc) {
  const lines = String(yrc || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = [];

  for (const line of lines) {
    const lineMatch = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lineMatch) {
      continue;
    }
    const [, rawLineStart, rawLineDuration, body = ""] = lineMatch;
    const lineStartTime = Number(rawLineStart);
    const lineDuration = Math.max(0, Number(rawLineDuration));
    const lineEndTime = lineStartTime + lineDuration;
    const syllables = [];
    const segmentPattern = /\((\d+),(\d+),-?\d+\)([^()]*)/g;
    let segmentMatch = segmentPattern.exec(body);
    while (segmentMatch) {
      const [, rawStart, rawDuration, rawText = ""] = segmentMatch;
      const absoluteStart = Number(rawStart);
      const duration = Math.max(0, Number(rawDuration));
      const text = String(rawText || "");
      if (Number.isFinite(absoluteStart) && text.length > 0) {
        const startTime =
          absoluteStart < lineStartTime && absoluteStart <= lineDuration
            ? lineStartTime + absoluteStart
            : absoluteStart;
        syllables.push({
          text,
          startTime,
          endTime: startTime + duration,
        });
      }
      segmentMatch = segmentPattern.exec(body);
    }

    if (!syllables.length) {
      const plainText = body.replace(/\(\d+,\d+,-?\d+\)/g, "").trim();
      if (!plainText) {
        continue;
      }
      parsed.push({
        lineStartTime,
        lineEndTime: Math.max(lineStartTime + 250, lineEndTime),
        syllables: normalizeSyllables(
          [
            {
              text: plainText,
              startTime: lineStartTime,
              endTime: Math.max(lineStartTime + 250, lineEndTime),
            },
          ],
          lineStartTime,
          Math.max(lineStartTime + 250, lineEndTime),
        ),
      });
      continue;
    }

    const normalized = normalizeSyllables(
      mergeConsecutiveCensorSyllables(
        ensureNeteaseCensorshipSpacing(syllables),
      ),
      lineStartTime,
      Math.max(lineEndTime, syllables[syllables.length - 1].endTime),
    );
    if (!normalized.length) {
      continue;
    }
    parsed.push({
      lineStartTime: normalized[0].startTime,
      lineEndTime: Math.max(
        Math.max(lineStartTime + 250, lineEndTime),
        normalized[normalized.length - 1].endTime,
      ),
      syllables: normalized,
    });
  }

  return parsed.filter((line) => line?.syllables?.length);
}

function decodeKugouKrc(encodedContent) {
  const zlib = require("node:zlib");
  const bytes = Buffer.from(String(encodedContent || "").trim(), "base64");
  if (bytes.length <= 4) {
    return "";
  }
  const encrypted = bytes.subarray(4);
  const decrypted = Buffer.alloc(encrypted.length);
  for (let index = 0; index < encrypted.length; index += 1) {
    decrypted[index] = encrypted[index] ^ KUGOU_KRC_XOR_KEY[index % 16];
  }
  return zlib
    .inflateSync(decrypted)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\0/g, "");
}

function parseKugouKrc(krc) {
  const lines = String(krc || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = [];

  for (const line of lines) {
    const lineMatch = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lineMatch) {
      continue;
    }
    const [, rawLineStart, rawLineDuration, body = ""] = lineMatch;
    const lineStartTime = Number(rawLineStart);
    const lineDuration = Math.max(0, Number(rawLineDuration));
    const lineEndTime = lineStartTime + lineDuration;
    const syllables = [];
    const segmentPattern = /<(\d+),(\d+),-?\d+>([^<]*)/g;
    let segmentMatch = segmentPattern.exec(body);
    while (segmentMatch) {
      const [, rawStart, rawDuration, rawText = ""] = segmentMatch;
      const relativeStart = Number(rawStart);
      const duration = Math.max(0, Number(rawDuration));
      const text = String(rawText || "");
      if (Number.isFinite(relativeStart) && text.length > 0) {
        const startTime = lineStartTime + relativeStart;
        syllables.push({
          text,
          startTime,
          endTime: startTime + duration,
        });
      }
      segmentMatch = segmentPattern.exec(body);
    }

    if (!syllables.length) {
      const plainText = body.replace(/<\d+,\d+,-?\d+>/g, "").trim();
      if (!plainText) {
        continue;
      }
      parsed.push({
        lineStartTime,
        lineEndTime: Math.max(lineStartTime + 250, lineEndTime),
        syllables: normalizeSyllables(
          [
            {
              text: plainText,
              startTime: lineStartTime,
              endTime: Math.max(lineStartTime + 250, lineEndTime),
            },
          ],
          lineStartTime,
          Math.max(lineStartTime + 250, lineEndTime),
        ),
      });
      continue;
    }

    const normalized = normalizeSyllables(
      mergeConsecutiveCensorSyllables(
        ensureNeteaseCensorshipSpacing(syllables),
      ),
      lineStartTime,
      Math.max(lineEndTime, syllables[syllables.length - 1].endTime),
    );
    if (!normalized.length) {
      continue;
    }
    parsed.push({
      lineStartTime: normalized[0].startTime,
      lineEndTime: Math.max(
        lineStartTime + 250,
        normalized[normalized.length - 1].endTime,
      ),
      syllables: normalized,
    });
  }

  return parsed.filter((line) => line?.syllables?.length);
}

function coerceFiniteNumber(value, fallback = NaN) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/** Spicy Lyrics payloads use seconds; Spicetify applies `ConvertTime(t) => t * 1000` before playback. */
function spicyApiSecondsToMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric * 1000 : NaN;
}

function parseOptionalBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 1 || value === "1") {
    return true;
  }
  if (value === 0 || value === "0") {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function readSpicyIsPartOfWord(item = {}) {
  return parseOptionalBoolean(
    item?.IsPartOfWord ?? item?.isPartOfWord ?? item?.SyllableWithinWord,
  );
}

function isSpicyVocalEntry(item = {}) {
  return (
    String(item?.Type ?? item?.type ?? "")
      .trim()
      .toLowerCase() === "vocal"
  );
}

function collectSpicyTagTokens(rawValue, outputSet) {
  if (!rawValue) {
    return;
  }
  if (Array.isArray(rawValue)) {
    for (const part of rawValue) {
      collectSpicyTagTokens(part, outputSet);
    }
    return;
  }
  if (typeof rawValue === "object") {
    for (const value of Object.values(rawValue)) {
      collectSpicyTagTokens(value, outputSet);
    }
    return;
  }

  const text = String(rawValue || "")
    .trim()
    .toLowerCase();
  if (!text) {
    return;
  }
  outputSet.add(text);
  const compact = text.replace(/[\s_-]+/g, "");
  if (compact) {
    outputSet.add(compact);
  }

  const splitParts = text
    .split(/[\s,;|/]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of splitParts) {
    outputSet.add(part);
    outputSet.add(part.replace(/[\s_-]+/g, ""));
  }
}

function isSpicyBackgroundTaggedVocal(item = {}) {
  const explicitBackground = parseOptionalBoolean(
    item?.IsBackground ??
      item?.isBackground ??
      item?.BackgroundTag ??
      item?.backgroundTag,
  );
  if (explicitBackground === true) {
    return true;
  }

  const roleHint = String(
    item?.Role ??
      item?.role ??
      item?.VocalType ??
      item?.vocalType ??
      item?.Kind ??
      item?.kind ??
      "",
  )
    .trim()
    .toLowerCase();
  if (roleHint.includes("background") || roleHint.includes("backing")) {
    return true;
  }

  const tagTokens = new Set();
  collectSpicyTagTokens(item?.Tag, tagTokens);
  collectSpicyTagTokens(item?.Tags, tagTokens);
  collectSpicyTagTokens(item?.tag, tagTokens);
  collectSpicyTagTokens(item?.tags, tagTokens);
  collectSpicyTagTokens(item?.LineTag, tagTokens);
  collectSpicyTagTokens(item?.LineTags, tagTokens);

  return (
    tagTokens.has("background") ||
    tagTokens.has("bg") ||
    tagTokens.has("backing") ||
    tagTokens.has("backgroundvocal") ||
    tagTokens.has("backgroundvocals")
  );
}

// Spicy often encodes word gaps with zero-width or thin spaces instead of ASCII space.
const SPICY_MULTI_WORD_SEPARATOR_RE =
  /[\s\u00a0\u2009\u202f\u200b-\u200d\u2060\ufeff\r\n]+/u;

function normalizeSpicySyllableText(text) {
  return String(text || "")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, " ")
    .replace(/[\u00a0\u2009\u202f]/g, " ")
    .replace(/\r?\n/g, " ");
}

function tokenizeSpicyMultiWordSyllableText(text) {
  return String(text || "")
    .trim()
    .split(SPICY_MULTI_WORD_SEPARATOR_RE)
    .filter(Boolean);
}

const ATTACHED_OPENING_QUOTE_TOKEN_RE = /^([A-Za-z0-9]+)([""«"\u201c][^\s]*)$/;

function splitTokenAtAttachedOpeningQuote(token) {
  const value = String(token || "");
  const trimmed = value.trim();
  if (!trimmed) {
    return [value];
  }
  const match = trimmed.match(ATTACHED_OPENING_QUOTE_TOKEN_RE);
  if (!match) {
    return [value];
  }
  const start = value.indexOf(trimmed);
  const end = start + trimmed.length;
  const lead = value.slice(0, start);
  const trail = value.slice(end);
  return [`${lead}${match[1]}${trail}`, `${lead}${match[2]}${trail}`];
}

function expandSpicyAttachedQuoteSyllables(syllables) {
  if (!Array.isArray(syllables) || !syllables.length) {
    return syllables;
  }

  const expanded = [];
  for (const part of syllables) {
    const tokens = splitTokenAtAttachedOpeningQuote(part?.text);
    if (!tokens || tokens.length <= 1) {
      expanded.push(part);
      continue;
    }

    const startTime = Number(part?.startTime) || 0;
    const endTime = Number(part?.endTime) || startTime + 220;
    const slotMs = Math.max(1, endTime - startTime) / tokens.length;
    for (let index = 0; index < tokens.length; index += 1) {
      const isLast = index >= tokens.length - 1;
      expanded.push({
        ...part,
        text: tokens[index],
        startTime: startTime + slotMs * index,
        endTime: isLast ? endTime : startTime + slotMs * (index + 1),
        ...(isLast && typeof part?.isPartOfWord === "boolean"
          ? { isPartOfWord: part.isPartOfWord }
          : { isPartOfWord: true }),
      });
    }
  }

  return expanded.length ? expanded : syllables;
}

function shouldExpandSpicyMultiWordSyllable(text) {
  const words = tokenizeSpicyMultiWordSyllableText(text);
  if (words.length <= 1) {
    return false;
  }
  return !words.some((word) => isLikelySyllableFragmentWord(word));
}

function splitSpicyMultiWordSyllableText(rawText) {
  const value = String(rawText || "");
  const words = tokenizeSpicyMultiWordSyllableText(value).flatMap(
    splitTokenAtAttachedOpeningQuote,
  );
  if (words.length <= 1) {
    return null;
  }
  const leadPrefix = value.slice(0, value.search(/\S/));
  const trailSuffix = value.slice(value.trimEnd().length);
  return words.map((word, index) => {
    let text = word;
    if (index === 0 && leadPrefix) {
      text = `${leadPrefix}${word}`;
    }
    if (index < words.length - 1) {
      text += " ";
    } else if (trailSuffix) {
      text += trailSuffix;
    }
    return text;
  });
}

function isLikelySyllableFragmentWord(word) {
  const trimmed = String(word || "").trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length === 1 && /^[a-zA-Z]$/.test(trimmed)) {
    return !/^[aAiI]$/.test(trimmed);
  }
  return false;
}

function isStandaloneWordToken(text) {
  return /^(a|i|an|am|as|at|be|by|do|go|he|if|in|is|it|me|my|no|of|oh|ok|on|or|ow|so|to|up|us|we)$/i.test(
    String(text || "").trim(),
  );
}

function isSyllableWordContinuation(leftText, rightText) {
  const left = String(leftText || "").trim();
  const right = String(rightText || "").trim();
  if (!left || !right) {
    return false;
  }
  if (
    /\s$/.test(String(leftText || "")) ||
    /^\s/.test(String(rightText || ""))
  ) {
    return false;
  }
  if (isStandaloneWordToken(left) || isStandaloneWordToken(right)) {
    return false;
  }
  if (left.length !== 1 || !/^[a-z]$/.test(left)) {
    return false;
  }
  return /^[a-z]/.test(right);
}

function inferMissingSyllableWordFlags(syllables) {
  if (!Array.isArray(syllables)) {
    return;
  }
  for (let index = 0; index < syllables.length; index += 1) {
    const current = syllables[index];
    const next = syllables[index + 1];
    if (typeof current?.isPartOfWord === "boolean") {
      continue;
    }
    current.isPartOfWord =
      next && isSyllableWordContinuation(current.text, next.text);
  }
}

function expandSpicyMultiWordTimedSyllables(syllables) {
  if (!Array.isArray(syllables) || !syllables.length) {
    return syllables;
  }

  const expanded = [];
  for (const part of syllables) {
    if (!part || typeof part.text !== "string") {
      continue;
    }

    const rawText = part.text;
    if (!shouldExpandSpicyMultiWordSyllable(rawText)) {
      expanded.push(part);
      continue;
    }

    const wordTexts = splitSpicyMultiWordSyllableText(rawText);
    if (!wordTexts?.length) {
      expanded.push(part);
      continue;
    }
    const startTime = Number(part.startTime) || 0;
    const endTime = Number(part.endTime) || startTime + 220;
    const slotMs = Math.max(1, endTime - startTime) / wordTexts.length;

    for (let index = 0; index < wordTexts.length; index += 1) {
      const isLast = index >= wordTexts.length - 1;
      const syllableStart = startTime + slotMs * index;
      const syllableEnd = isLast ? endTime : startTime + slotMs * (index + 1);
      expanded.push({
        text: wordTexts[index],
        startTime: syllableStart,
        endTime: syllableEnd,
        isPartOfWord: false,
      });
    }
  }

  return expanded.length ? expanded : syllables;
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
  // Apostrophe-led contractions (e.g. 'm, 's) stay tight with the previous syllable.
  if (/^['’‘](m|re|s|d|ll|ve|t|n|clock|all)\b/i.test(trimmed)) {
    return true;
  }
  // Standalone closing quote syllables attach to the previous word.
  if (/^['’‘"”]$/.test(trimmed)) {
    return true;
  }
  return false;
}

function shouldInsertSpaceBeforeNextSyllable(
  syllable,
  nextSyllable,
  { ignoreWordFlags = false } = {},
) {
  const text = String(syllable?.text || "");
  const nextText = String(nextSyllable?.text || "");
  if (!text || !nextText) {
    return false;
  }
  if (/\s$/.test(text) || /^\s/.test(nextText)) {
    return false;
  }
  if (nextSyllableLeadsWithOpeningDoubleQuotedWord(text, nextText)) {
    return true;
  }
  if (nextSyllableLeadsWithAttachPunctuation(nextText)) {
    return false;
  }
  if (/[(\[{]$/.test(text.trim())) {
    return false;
  }
  if (!ignoreWordFlags && typeof syllable?.isPartOfWord === "boolean") {
    if (syllable.isPartOfWord === true) {
      return false;
    }
    return true;
  }
  if (/[,.;:!?…](?:['"’”])?$/.test(text.trim())) {
    return true;
  }
  return shouldInsertSyllableBoundarySpace(text, nextText);
}

function ensureSyllableDisplaySpacing(syllables) {
  if (!Array.isArray(syllables) || syllables.length <= 1) {
    return syllables;
  }

  const hasWordFlags = syllables.some(
    (part) => typeof part?.isPartOfWord === "boolean",
  );
  const hasWordBoundaryFlags = syllables.some(
    (part) => part?.isPartOfWord === false,
  );
  const ignoreWordFlags =
    hasWordFlags &&
    !hasWordBoundaryFlags &&
    syllables.every((part) => part?.isPartOfWord === true);

  return syllables.map((syllable, index) => {
    const next = syllables[index + 1];
    if (
      !next ||
      !shouldInsertSpaceBeforeNextSyllable(syllable, next, { ignoreWordFlags })
    ) {
      return syllable;
    }
    const text = String(syllable?.text || "");
    if (/\s$/.test(text)) {
      return syllable;
    }
    return { ...syllable, text: `${text} ` };
  });
}

function readSpicyOppositeAligned(entry) {
  return Boolean(entry?.OppositeAligned ?? entry?.oppositeAligned);
}

function createSingleTextLine(text, startTime, endTime) {
  const safeStart = Math.max(0, coerceFiniteNumber(startTime, 0));
  const safeEnd = Math.max(
    safeStart + 250,
    coerceFiniteNumber(endTime, safeStart + 1_800),
  );
  return {
    lineStartTime: safeStart,
    lineEndTime: safeEnd,
    syllables: normalizeSyllables(
      [{ text: String(text || ""), startTime: safeStart, endTime: safeEnd }],
      safeStart,
      safeEnd,
    ),
  };
}

function createInterpolatedWordLine(text, startTime, endTime) {
  const safeStart = Math.max(0, coerceFiniteNumber(startTime, 0));
  const safeEnd = Math.max(
    safeStart + 250,
    coerceFiniteNumber(endTime, safeStart + 1_800),
  );
  const rawText = String(text || "").trim();
  if (!rawText) {
    return createSingleTextLine(rawText, safeStart, safeEnd);
  }

  const words = rawText.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return createSingleTextLine(rawText, safeStart, safeEnd);
  }

  const slotMs = (safeEnd - safeStart) / words.length;
  const rawSyllables = words.map((word, index) => {
    const syllableStart = safeStart + slotMs * index;
    const syllableEnd =
      index >= words.length - 1 ? safeEnd : safeStart + slotMs * (index + 1);
    return {
      text: `${word}${index < words.length - 1 ? " " : ""}`,
      startTime: syllableStart,
      endTime: syllableEnd,
    };
  });

  const syllables = normalizeSyllables(rawSyllables, safeStart, safeEnd);
  if (!syllables.length) {
    return createSingleTextLine(rawText, safeStart, safeEnd);
  }

  return {
    lineStartTime: safeStart,
    lineEndTime: safeEnd,
    syllables,
  };
}

function hasSpicyStaticLineTiming(lines = []) {
  return (Array.isArray(lines) ? lines : []).some((line) => {
    const startTime = Number(line?.StartTime ?? line?.Time ?? NaN);
    const endTime = Number(line?.EndTime ?? NaN);
    return Number.isFinite(startTime) || Number.isFinite(endTime);
  });
}

function readSpicyStaticLineText(line) {
  return String(line?.Text ?? line?.text ?? "").trim();
}

function parseSpicyPlainStaticLyrics(lines = []) {
  const vocals = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      text: readSpicyStaticLineText(line),
      oppositeAligned: readSpicyOppositeAligned(line),
    }))
    .filter((line) => line.text);
  if (!vocals.length) {
    return [];
  }

  return vocals.map((entry) => {
    const line = {
      lineStartTime: 0,
      lineEndTime: 0,
      syllables: [
        {
          text: entry.text,
          startTime: 0,
          endTime: 0,
        },
      ],
    };
    if (entry.oppositeAligned) {
      line.oppositeAligned = true;
    }
    return line;
  });
}

function parseSpicyStaticLyrics(lines = [], durationMs = 0) {
  void durationMs;
  return parseSpicyPlainStaticLyrics(lines);
}

function parseSpicyLineLyrics(payload = {}) {
  const content = Array.isArray(payload?.Content) ? payload.Content : [];
  const vocals = content.filter((item) => isSpicyVocalEntry(item));
  const payloadStartMs = spicyApiSecondsToMs(
    payload?.StartTime ?? payload?.Time,
  );
  const payloadEndMs = spicyApiSecondsToMs(payload?.EndTime);
  const parsed = [];
  const pendingBackgroundLines = [];

  const attachBackgroundLine = (backgroundLine) => {
    if (!backgroundLine?.syllables?.length) {
      return;
    }
    const leadLine = parsed.length ? parsed[parsed.length - 1] : null;
    if (leadLine) {
      mergeSpicyBackgroundLineIntoLeadLine(leadLine, backgroundLine);
      return;
    }
    pendingBackgroundLines.push(backgroundLine);
  };

  for (let index = 0; index < vocals.length; index += 1) {
    const line = vocals[index];
    const next = vocals[index + 1];
    const text = String(line?.Text || "").trim();
    if (!text) {
      continue;
    }
    const rawStart = line?.StartTime ?? line?.Time;
    const hasApiStart = Number.isFinite(Number(rawStart));
    const fallbackStart =
      Number.isFinite(payloadStartMs) && index === 0
        ? payloadStartMs
        : index * 2_000;
    const startTime = hasApiStart
      ? spicyApiSecondsToMs(rawStart)
      : fallbackStart;
    const safeStart = Number.isFinite(startTime) ? startTime : fallbackStart;
    const hasApiEnd = Number.isFinite(Number(line?.EndTime));
    const rawNextStart = next ? (next?.StartTime ?? next?.Time) : NaN;
    const hasNextApiStart = Number.isFinite(Number(rawNextStart));
    let endTime;
    if (hasApiEnd) {
      endTime = spicyApiSecondsToMs(line.EndTime);
    } else if (hasNextApiStart) {
      endTime = spicyApiSecondsToMs(rawNextStart);
    } else if (Number.isFinite(payloadEndMs) && payloadEndMs > safeStart) {
      endTime = payloadEndMs;
    } else {
      endTime = safeStart + 2_000;
    }

    const lineCandidate = createInterpolatedWordLine(text, safeStart, endTime);
    if (readSpicyOppositeAligned(line)) {
      lineCandidate.oppositeAligned = true;
    }
    if (isSpicyBackgroundTaggedVocal(line)) {
      attachBackgroundLine(lineCandidate);
      continue;
    }

    parsed.push(lineCandidate);
    if (pendingBackgroundLines.length) {
      while (pendingBackgroundLines.length) {
        const pending = pendingBackgroundLines.shift();
        mergeSpicyBackgroundLineIntoLeadLine(lineCandidate, pending);
      }
    }
  }

  if (pendingBackgroundLines.length) {
    if (parsed.length) {
      const fallbackLeadLine = parsed[parsed.length - 1];
      while (pendingBackgroundLines.length) {
        const pending = pendingBackgroundLines.shift();
        mergeSpicyBackgroundLineIntoLeadLine(fallbackLeadLine, pending);
      }
    } else {
      while (pendingBackgroundLines.length) {
        const pending = pendingBackgroundLines.shift();
        if (pending?.syllables?.length) {
          parsed.push(pending);
        }
      }
    }
  }

  return parsed.filter((line) => line?.syllables?.length);
}

function spicyBuildKaraokeLineFromWordSyllables(vocal, block) {
  const words = block?.Syllables;
  if (!Array.isArray(words) || !words.length) {
    return null;
  }
  const rawSyllables = [];
  for (let index = 0; index < words.length; index += 1) {
    const syllable = words[index];
    const next = words[index + 1];
    const baseText = normalizeSpicySyllableText(syllable?.Text);
    if (!baseText) {
      continue;
    }
    const isPartOfWord = readSpicyIsPartOfWord(syllable);
    const text = baseText;
    const fallbackStartSec =
      block?.StartTime ?? vocal?.Lead?.StartTime ?? vocal?.StartTime;
    const startTime = Number.isFinite(Number(syllable?.StartTime))
      ? spicyApiSecondsToMs(syllable.StartTime)
      : Number.isFinite(Number(fallbackStartSec))
        ? spicyApiSecondsToMs(fallbackStartSec)
        : 0;
    let endTime;
    if (Number.isFinite(Number(syllable?.EndTime))) {
      endTime = spicyApiSecondsToMs(syllable.EndTime);
    } else if (Number.isFinite(Number(next?.StartTime))) {
      endTime = spicyApiSecondsToMs(next.StartTime);
    } else if (Number.isFinite(Number(block?.EndTime))) {
      endTime = spicyApiSecondsToMs(block.EndTime);
    } else if (Number.isFinite(Number(vocal?.Lead?.EndTime))) {
      endTime = spicyApiSecondsToMs(vocal.Lead.EndTime);
    } else if (Number.isFinite(Number(vocal?.EndTime))) {
      endTime = spicyApiSecondsToMs(vocal.EndTime);
    } else {
      endTime = startTime + 220;
    }
    rawSyllables.push({ text, startTime, endTime, isPartOfWord });
  }
  if (!rawSyllables.length) {
    return null;
  }
  const expandedRawSyllables = expandSpicyMultiWordTimedSyllables(
    expandSpicyAttachedQuoteSyllables(rawSyllables),
  );
  inferMissingSyllableWordFlags(expandedRawSyllables);
  const lineStart = Math.max(
    0,
    Number.isFinite(Number(block?.StartTime))
      ? spicyApiSecondsToMs(block.StartTime)
      : rawSyllables[0].startTime,
  );
  const lineEnd = Math.max(
    rawSyllables[rawSyllables.length - 1].endTime,
    Number.isFinite(Number(block?.EndTime))
      ? spicyApiSecondsToMs(block.EndTime)
      : rawSyllables[rawSyllables.length - 1].endTime,
  );
  const syllables = ensureSyllableDisplaySpacing(
    normalizeSyllables(expandedRawSyllables, lineStart, lineEnd),
  );
  if (!syllables.length) {
    return null;
  }
  return {
    lineStartTime: syllables[0].startTime,
    lineEndTime: Math.max(lineEnd, syllables[syllables.length - 1].endTime),
    syllables,
    ...(readSpicyOppositeAligned(vocal) || readSpicyOppositeAligned(block)
      ? { oppositeAligned: true }
      : {}),
  };
}

function mergeSpicyBackgroundLineIntoLeadLine(leadLine, backgroundLine) {
  if (
    !leadLine ||
    !Array.isArray(backgroundLine?.syllables) ||
    !backgroundLine.syllables.length
  ) {
    return false;
  }

  const existingBackground = Array.isArray(leadLine.backgroundSyllables)
    ? leadLine.backgroundSyllables
    : [];
  const mergedRaw = [...existingBackground, ...backgroundLine.syllables]
    .map((syllable) => {
      const next = {
        text: String(syllable?.text || ""),
        startTime: Number(syllable?.startTime || 0),
        endTime: Number(syllable?.endTime || 0),
      };
      if (typeof syllable?.isPartOfWord === "boolean") {
        next.isPartOfWord = syllable.isPartOfWord;
      }
      return next;
    })
    .filter((syllable) => syllable.text.trim().length > 0);

  if (!mergedRaw.length) {
    return false;
  }

  const leadStart = Number(leadLine.lineStartTime || 0);
  const bgStart = Number(backgroundLine.lineStartTime || leadStart);
  const firstBgStart = Number(mergedRaw[0].startTime || 0);
  const mergedStart = Math.max(
    0,
    Math.min(
      Number.isFinite(leadStart) ? leadStart : firstBgStart,
      Number.isFinite(bgStart) ? bgStart : firstBgStart,
      firstBgStart,
    ),
  );

  const leadEnd = Number(leadLine.lineEndTime || mergedStart + 250);
  const bgEnd = Number(backgroundLine.lineEndTime || leadEnd);
  const lastBgEnd = Number(mergedRaw[mergedRaw.length - 1].endTime || leadEnd);
  const mergedEnd = Math.max(
    mergedStart + 250,
    Number.isFinite(leadEnd) ? leadEnd : mergedStart,
    Number.isFinite(bgEnd) ? bgEnd : mergedStart,
    Number.isFinite(lastBgEnd) ? lastBgEnd : mergedStart,
  );

  const normalizedBackground = normalizeSyllables(
    mergedRaw,
    mergedStart,
    mergedEnd,
  );
  if (!normalizedBackground.length) {
    return false;
  }

  leadLine.backgroundSyllables = normalizedBackground;
  leadLine.lineStartTime = Math.min(
    Number.isFinite(leadStart) ? leadStart : normalizedBackground[0].startTime,
    normalizedBackground[0].startTime,
  );
  leadLine.lineEndTime = Math.max(
    Number.isFinite(leadEnd)
      ? leadEnd
      : normalizedBackground[normalizedBackground.length - 1].endTime,
    normalizedBackground[normalizedBackground.length - 1].endTime,
  );
  return true;
}

function parseSpicySyllableLyrics(content = []) {
  const vocals = (Array.isArray(content) ? content : []).filter((item) =>
    isSpicyVocalEntry(item),
  );
  const parsed = [];
  const pendingBackgroundLines = [];

  const attachBackgroundLine = (backgroundLine, preferredLeadLine = null) => {
    if (!backgroundLine?.syllables?.length) {
      return;
    }
    if (preferredLeadLine) {
      mergeSpicyBackgroundLineIntoLeadLine(preferredLeadLine, backgroundLine);
      return;
    }
    const fallbackLeadLine = parsed.length ? parsed[parsed.length - 1] : null;
    if (fallbackLeadLine) {
      mergeSpicyBackgroundLineIntoLeadLine(fallbackLeadLine, backgroundLine);
      return;
    }
    pendingBackgroundLines.push(backgroundLine);
  };

  const flushPendingBackgroundLines = (leadLine) => {
    if (!leadLine || !pendingBackgroundLines.length) {
      return;
    }
    while (pendingBackgroundLines.length) {
      const pending = pendingBackgroundLines.shift();
      mergeSpicyBackgroundLineIntoLeadLine(leadLine, pending);
    }
  };

  for (const vocal of vocals) {
    const leadLine = vocal?.Lead?.Syllables?.length
      ? spicyBuildKaraokeLineFromWordSyllables(vocal, vocal.Lead)
      : null;
    const fallbackText = String(vocal?.Text || "").trim();
    const fallbackLine = fallbackText
      ? createSingleTextLine(
          fallbackText,
          Number.isFinite(Number(vocal?.StartTime))
            ? spicyApiSecondsToMs(vocal.StartTime)
            : 0,
          Number.isFinite(Number(vocal?.EndTime))
            ? spicyApiSecondsToMs(vocal.EndTime)
            : Number.isFinite(Number(vocal?.StartTime))
              ? spicyApiSecondsToMs(vocal.StartTime) + 2_000
              : 2_000,
        )
      : null;
    const lineCandidate = leadLine || fallbackLine;
    if (lineCandidate && readSpicyOppositeAligned(vocal)) {
      lineCandidate.oppositeAligned = true;
    }
    const backgroundTagged = isSpicyBackgroundTaggedVocal(vocal);

    let currentLeadLine = null;
    if (!backgroundTagged && lineCandidate) {
      parsed.push(lineCandidate);
      currentLeadLine = lineCandidate;
      flushPendingBackgroundLines(currentLeadLine);
    } else if (backgroundTagged && lineCandidate) {
      attachBackgroundLine(
        lineCandidate,
        parsed.length ? parsed[parsed.length - 1] : null,
      );
    }

    const backgrounds = vocal?.Background;
    if (!Array.isArray(backgrounds)) {
      continue;
    }
    for (const bg of backgrounds) {
      const bgLine = spicyBuildKaraokeLineFromWordSyllables(vocal, bg);
      if (bgLine) {
        attachBackgroundLine(bgLine, currentLeadLine);
      }
    }
  }

  if (pendingBackgroundLines.length) {
    if (parsed.length) {
      const fallbackLeadLine = parsed[parsed.length - 1];
      for (const pendingBackgroundLine of pendingBackgroundLines) {
        mergeSpicyBackgroundLineIntoLeadLine(
          fallbackLeadLine,
          pendingBackgroundLine,
        );
      }
    } else {
      for (const pendingBackgroundLine of pendingBackgroundLines) {
        if (pendingBackgroundLine?.syllables?.length) {
          parsed.push(pendingBackgroundLine);
        }
      }
    }
  }

  return parsed.filter((line) => line?.syllables?.length);
}

function resolveSpicyPayloadType(payload = {}) {
  const typeLabel = String(payload?.Type || "")
    .trim()
    .toLowerCase();
  if (typeLabel === "syllable") {
    return "syllable";
  }
  if (typeLabel === "line") {
    return "line";
  }
  if (typeLabel === "static") {
    return "static";
  }
  if (Array.isArray(payload?.Lines) && payload.Lines.length) {
    return "static";
  }
  return "";
}

function getSpicySourceLabel(payload, _durationMs = 0) {
  const payloadType = resolveSpicyPayloadType(payload);
  if (payloadType === "syllable") {
    return "spicy-lyrics-syllable";
  }
  if (payloadType === "line") {
    return "spicy-lyrics-line";
  }
  if (payloadType === "static") {
    return "spicy-lyrics-static";
  }
  return "spicy-lyrics-static";
}

function parseSpicyLyrics(payload, durationMs = 0) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const payloadType = resolveSpicyPayloadType(payload);
  if (payloadType === "syllable") {
    return parseSpicySyllableLyrics(payload.Content);
  }
  if (payloadType === "line") {
    return parseSpicyLineLyrics(payload);
  }
  if (payloadType === "static") {
    return parseSpicyStaticLyrics(payload.Lines, durationMs);
  }
  return [];
}

function normalizeCreditNameParts(value, output = []) {
  if (value === null || value === undefined) {
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeCreditNameParts(item, output);
    }
    return output;
  }
  if (typeof value === "object") {
    for (const key of [
      "Name",
      "name",
      "FullName",
      "fullName",
      "DisplayName",
      "displayName",
      "ArtistName",
      "artistName",
      "WriterName",
      "writerName",
      "ComposerName",
      "composerName",
    ]) {
      if (value?.[key]) {
        normalizeCreditNameParts(value[key], output);
        return output;
      }
    }
    return output;
  }
  const text = String(value || "")
    .replace(
      /\b(?:written|writer|writers|songwriter|songwriters|composer|composers|lyrics|lyricist|lyricists)\s*(?:by)?\s*[:=-]\s*/gi,
      "",
    )
    .trim();
  if (!text) {
    return output;
  }
  for (const part of text.split(/\s*(?:,|;|\/|\||&|\band\b|\+)\s*/i)) {
    const safe = String(part || "")
      .replace(/^\s*(?:by|and)\s+/i, "")
      .trim();
    if (
      safe &&
      safe.length <= 80 &&
      !/^(?:unknown|n\/a|null|undefined)$/i.test(safe) &&
      !output.some((entry) => entry.toLowerCase() === safe.toLowerCase())
    ) {
      output.push(safe);
    }
  }
  return output;
}

function extractSpicySongwritersFromNode(node, output, depth = 0) {
  if (depth > 5 || !node || typeof node !== "object") {
    return output;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      extractSpicySongwritersFromNode(item, output, depth + 1);
    }
    return output;
  }

  for (const [key, value] of Object.entries(node)) {
    const normalizedKey = String(key || "").toLowerCase();
    const isCreditKey =
      normalizedKey.includes("songwriter") ||
      normalizedKey.includes("writer") ||
      normalizedKey.includes("composer") ||
      normalizedKey.includes("lyricist") ||
      normalizedKey === "writtenby" ||
      normalizedKey === "written_by";
    if (isCreditKey) {
      normalizeCreditNameParts(value, output);
      continue;
    }
    const isMetadataContainer =
      normalizedKey.includes("credit") ||
      normalizedKey.includes("metadata") ||
      normalizedKey.includes("info") ||
      normalizedKey.includes("attribution");
    if (isMetadataContainer && value && typeof value === "object") {
      extractSpicySongwritersFromNode(value, output, depth + 1);
    }
  }
  return output;
}

function extractSpicySongwriters(payload) {
  const songwriters = extractSpicySongwritersFromNode(payload, []);
  return songwriters.slice(0, 12);
}

function trimLeadingMetaLines(lyrics, startTs) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return [];
  }
  const start = Number(startTs);
  if (!Number.isFinite(start) || start <= 0) {
    return lyrics;
  }
  // QQ musicu returns intro/title/credits before the true vocal start in some tracks.
  const preludeCutoff = start - 250;
  const trimmed = lyrics.filter((line) => {
    const lineStart = Number(line?.lineStartTime || 0);
    const lineEnd = Number(line?.lineEndTime || 0);
    return lineEnd >= preludeCutoff && lineStart >= preludeCutoff;
  });
  return trimmed.length ? trimmed : lyrics;
}

function isCjkBoundaryChar(char) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    String(char || ""),
  );
}

function shouldInsertSyllableBoundarySpace(leftText, rightText) {
  const left = String(leftText || "");
  const right = String(rightText || "");
  if (!left || !right) {
    return false;
  }
  if (/\s$/.test(left) || /^\s/.test(right)) {
    return false;
  }
  if (nextSyllableLeadsWithOpeningDoubleQuotedWord(left, right)) {
    return true;
  }
  if (nextSyllableLeadsWithAttachPunctuation(right)) {
    return false;
  }

  const leftChar = left.slice(-1);
  const rightChar = right.slice(0, 1);
  if (!leftChar || !rightChar) {
    return false;
  }
  if (isCjkBoundaryChar(leftChar) || isCjkBoundaryChar(rightChar)) {
    return false;
  }

  if (isCensorshipBoundary(left, right)) {
    return true;
  }

  const latinOrDigit = /[A-Za-z0-9]/;
  return latinOrDigit.test(leftChar) && latinOrDigit.test(rightChar);
}

function getLineText(line) {
  const parts = (line?.syllables || [])
    .map((s) => ({
      text: String(s?.text || ""),
      isPartOfWord:
        typeof s?.isPartOfWord === "boolean" ? s.isPartOfWord : undefined,
    }))
    .filter((part) => part.text.length > 0);
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

function getSyllableText(syllables = []) {
  const parts = (Array.isArray(syllables) ? syllables : [])
    .map((s) => ({
      text: String(s?.text || ""),
      isPartOfWord:
        typeof s?.isPartOfWord === "boolean" ? s.isPartOfWord : undefined,
    }))
    .filter((part) => part.text.length > 0);
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

function getBackgroundLineText(line) {
  return getSyllableText(line?.backgroundSyllables || []);
}

function appendBackgroundTranslatedSegment(existingText, backgroundTranslated) {
  const existing = String(existingText || "").trim();
  const segment = String(backgroundTranslated || "").trim();
  if (!segment) {
    return existing;
  }

  const wrapped = `(${segment})`;
  if (!existing) {
    return wrapped;
  }

  const existingNorm = normalizeTranslationVisibilityText(existing);
  const wrappedNorm = normalizeTranslationVisibilityText(wrapped);
  const segmentNorm = normalizeTranslationVisibilityText(segment);
  if (
    (wrappedNorm && existingNorm.includes(wrappedNorm)) ||
    (segmentNorm && existingNorm.includes(segmentNorm))
  ) {
    return existing;
  }
  return `${existing} ${wrapped}`.trim();
}

function buildTranslatedTextForLineFromLookup(line, translatedByText = {}) {
  let translatedText = "";
  const leadText = String(getLineText(line) || "").trim();
  if (leadText) {
    const leadTranslated = String(translatedByText[leadText] || "").trim();
    if (leadTranslated && !shouldHideTranslatedText(leadText, leadTranslated)) {
      translatedText = appendTranslatedSegment(translatedText, leadTranslated);
    }
  }

  const backgroundText = String(getBackgroundLineText(line) || "").trim();
  if (backgroundText) {
    const backgroundTranslated = String(
      translatedByText[backgroundText] || "",
    ).trim();
    if (
      backgroundTranslated &&
      !shouldHideTranslatedText(backgroundText, backgroundTranslated)
    ) {
      translatedText = appendBackgroundTranslatedSegment(
        translatedText,
        backgroundTranslated,
      );
    }
  }

  return translatedText;
}

function isLikelyMetadataLineText(text, track) {
  const raw = String(text || "").trim();
  if (!raw) {
    return true;
  }
  if (hasChineseLyricCreditLabel(raw) || hasProductionRoleLabel(raw)) {
    return true;
  }

  const normalized = normalizeText(text).replace(/\s+/g, "");
  if (!normalized) {
    return true;
  }

  const metadataKeywordRegex =
    /(writtenby|writer|writers|songwriter|songwriters|composedby|composer|composers|producedby|producer|producers|arrangedby|arranger|arrangers|masteredby|mastering|mixedby|recordedby|engineer|engineers|lyricist|lyricists|credits?|credit|作词|作曲|编曲|制作人|词[:：]|曲[:：]|编[:：]|唱[:：]|lyrics?[:：]|music[:：]|prod(?:uced)?\.?by|arr\.?by|master(?:ed)?\.?by|mix(?:ed)?\.?by|record(?:ed)?\.?by)/i;
  if (metadataKeywordRegex.test(normalized)) {
    return true;
  }

  const metadataTagLineRegex =
    /^\s*[\[(](?:ti|ar|al|by|offset|re|ve|au|tool|kana|language|trans(?:lation)?|roma)[\]:=]/i;
  if (metadataTagLineRegex.test(String(text || ""))) {
    return true;
  }

  const bracketedCreditRegex =
    /^\s*[\[(](?:作词|作曲|编曲|制作人|词|曲|编|监制|lyric(?:s|ist)?|composer|arranger|producer|credit)[\]）)]?\s*[:：-]/i;
  if (bracketedCreditRegex.test(String(text || ""))) {
    return true;
  }

  const lineCore = normalizeCoreTitle(text);
  const trackCore = normalizeCoreTitle(track?.title || "");
  const trackArtist = normalizeText(track?.artist || "");
  const lineNorm = normalizeText(text);
  const lineNormTight = lineNorm.replace(/\s+/g, "");
  const trackCoreTight = trackCore.replace(/\s+/g, "");
  const trackArtistTight = trackArtist.replace(/\s+/g, "");
  const containsTrackTitle =
    Boolean(trackCore) &&
    (lineCore.includes(trackCore) ||
      lineNorm.includes(trackCore) ||
      (trackCoreTight && lineNormTight.includes(trackCoreTight)));
  const trackArtistCandidates = [
    trackArtist,
    normalizeText(getSpotifyPrimaryArtist(track?.artist || "")),
    normalizeText(
      String(track?.artist || "")
        .replace(/\s*\([^)]*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  ].filter(Boolean);
  const containsTrackArtist = trackArtistCandidates.some((candidate) => {
    const candidateTight = candidate.replace(/\s+/g, "");
    return (
      lineNorm.includes(candidate) ||
      (candidateTight && lineNormTight.includes(candidateTight))
    );
  });
  if (containsTrackTitle && containsTrackArtist) {
    return true;
  }

  return false;
}

function isSkippableLeadingLine(text, line, track) {
  if (!String(text || "").trim()) {
    return true;
  }
  if (isLikelyLeadingMetadataHeaderLine(text, track)) {
    return true;
  }
  if (hasChineseLyricCreditLabel(text)) {
    return true;
  }
  if (hasProductionRoleLabel(text)) {
    return true;
  }
  const norm = normalizeMatchText(String(text || "").trim());
  if ((norm.match(/\//g) || []).length >= 2) {
    return true;
  }
  if (
    isTimingCompressedPreludeLine(line) &&
    (hasProductionRoleLabel(text) ||
      (String(text || "")
        .trim()
        .startsWith("(") &&
        (String(text || "").match(/\//g) || []).length >= 2))
  ) {
    return true;
  }
  return false;
}

function stripLeadingMetadataLines(lyrics, track) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return [];
  }

  const isPreludeWindowLine = (line) =>
    Number(line?.lineEndTime || 0) <= 90_000;

  // Detect whether this payload begins with a metadata header block.
  // When QQ/Netease embed credits at the top, those lines are typically short/tight
  // in time and can exceed 4 lines, so scan a wider window than before.
  const metadataProbeLimit = Math.min(20, lyrics.length);
  let metadataLikePrefixCount = 0;
  for (let index = 0; index < metadataProbeLimit; index += 1) {
    const line = lyrics[index];
    const text = getLineText(line);
    if (
      !text ||
      (isPreludeWindowLine(line) && isSkippableLeadingLine(text, line, track))
    ) {
      metadataLikePrefixCount += 1;
      continue;
    }
    break;
  }

  const aggressiveTrimEnabled = metadataLikePrefixCount >= 3;
  let startIndex = 0;
  const maxScan = aggressiveTrimEnabled
    ? Math.min(24, lyrics.length)
    : Math.min(6, lyrics.length);
  while (startIndex < lyrics.length && startIndex < maxScan) {
    const line = lyrics[startIndex];
    const text = getLineText(line);
    if (!text) {
      startIndex += 1;
      continue;
    }
    if (!isPreludeWindowLine(line)) {
      break;
    }
    if (!isSkippableLeadingLine(text, line, track)) {
      break;
    }
    startIndex += 1;
  }

  while (
    startIndex < lyrics.length &&
    startIndex < Math.min(24, lyrics.length)
  ) {
    const line = lyrics[startIndex];
    const text = getLineText(line);
    if (!isPreludeWindowLine(line)) {
      break;
    }
    const lineDuration = Math.max(
      0,
      Number(line?.lineEndTime || 0) - Number(line?.lineStartTime || 0),
    );
    const medianSyllableDuration = getMedianSyllableDurationMs(line);
    const vocalLike =
      lineDuration >= 500 &&
      medianSyllableDuration >= 100 &&
      !isSkippableLeadingLine(text, line, track);
    if (vocalLike) {
      break;
    }
    if (!isTimingCompressedPreludeLine(line)) {
      break;
    }
    if (!isSkippableLeadingLine(text, line, track)) {
      break;
    }
    startIndex += 1;
  }

  const stripped = lyrics.slice(startIndex);
  return stripped.length ? stripped : lyrics;
}

function scoreCandidate(track, title, artist) {
  const titleTokens = tokens(title);
  const targetTitleTokens = tokens(track.title);
  const titleOverlap = overlapRatio(titleTokens, targetTitleTokens);
  const artistOverlap = getBestArtistOverlap(
    getSpotifyPrimaryArtist(track.artist),
    artist,
  );

  const t = normalizeMatchText(title);
  const targetT = normalizeMatchText(track.title);
  const coreT = normalizeCoreTitle(title);
  const targetCoreT = normalizeCoreTitle(track.title);
  let score = 0;
  if (t && targetT && t === targetT) {
    score += 6;
  } else if (coreT && targetCoreT && coreT === targetCoreT) {
    score += 4;
  } else if (targetT && hasWholeTextContainment(t, targetT)) {
    score += 1.5;
  }
  if (artistOverlap >= 0.95) {
    score += 5;
  } else if (artistOverlap >= 0.55) {
    score += 3;
  } else if (artistOverlap >= 0.35) {
    score += 1.5;
  } else if (artistOverlap > 0 && artistOverlap < 0.2) {
    score -= 2;
  }

  score += titleOverlap * 3.5;
  score += artistOverlap * 4;

  if (hasExtraneousTitleWords(track.title, title)) {
    score -= needsExactShortTextMatch(targetCoreT) ? 5 : 2.5;
  }

  const queryHasFeaturing =
    featuringRegex.test(String(track?.artist || "")) ||
    featuringRegex.test(String(track?.title || ""));
  const candidateHasFeaturing =
    featuringRegex.test(String(artist || "")) ||
    featuringRegex.test(String(title || ""));
  if (!queryHasFeaturing && candidateHasFeaturing) {
    score -= needsExactShortTextMatch(targetCoreT) ? 3 : 1.5;
  }
  if (
    hasMissingFeaturedArtistHints(track.title, title) &&
    !featuredArtistHintsPresentInCandidate(track.title, title, artist)
  ) {
    score -= 4;
  }

  const queryHints = collectVersionHints(track.title);
  const candidateHints = collectVersionHints(title);
  const unmatchedCandidateHints = candidateHints.filter(
    (hint) => !queryHints.includes(hint),
  );
  score -= unmatchedCandidateHints.length * 2.5;
  if (!queryHints.length && candidateHints.length) {
    score -= 1.5;
  }

  const queryHasCjk = containsCjk(track.title);
  const candidateHasCjk = containsCjk(title);
  if (!queryHasCjk && candidateHasCjk) {
    score -= 2.5;
  }

  const queryArtistLatin = normalizeMatchText(track.artist);
  const candidateArtistHasCjk = containsCjk(artist);
  if (queryArtistLatin && !containsCjk(track.artist) && candidateArtistHasCjk) {
    if (artistOverlap < 0.35) {
      score -= 1.5;
    }
  }

  return score;
}

function titleMatchesViaBracketedAlias(trackCore, candidateTitle) {
  if (!trackCore || !candidateTitle) {
    return false;
  }
  return extractBracketedTitleSegments(candidateTitle).some((segment) => {
    if (segment === trackCore) {
      return true;
    }
    return (
      hasWholeTextContainment(trackCore, segment) ||
      hasWholeTextContainment(segment, trackCore) ||
      overlapRatio(tokens(trackCore), tokens(segment)) >= 0.62
    );
  });
}

function titleCoreMatchesQuery(track, candidateTitle) {
  const trackCore = normalizeCoreTitle(track?.title || "");
  const candidateCore = normalizeCoreTitle(candidateTitle);
  if (!trackCore || !candidateCore) {
    return false;
  }
  if (trackCore === candidateCore) {
    return true;
  }
  if (needsExactShortTextMatch(trackCore)) {
    if (candidateCore === trackCore) {
      return true;
    }
    return titleMatchesViaBracketedAlias(trackCore, candidateTitle);
  }
  if (
    hasWholeTextContainment(trackCore, candidateCore) ||
    hasWholeTextContainment(candidateCore, trackCore) ||
    overlapRatio(tokens(trackCore), tokens(candidateCore)) >= 0.62
  ) {
    return true;
  }
  // QQ/Korean catalogs often list tracks as "Hangul (English)" while Spotify uses English.
  if (!containsCjk(trackCore) && containsCjk(candidateCore)) {
    return titleMatchesViaBracketedAlias(trackCore, candidateTitle);
  }
  return false;
}

function featuredArtistHintsPresentInCandidate(
  queryTitle,
  candidateTitle,
  candidateArtist,
) {
  const hints = collectFeaturedArtistHints(queryTitle);
  if (!hints.length) {
    return true;
  }
  const haystack = normalizeMatchText(`${candidateTitle} ${candidateArtist}`);
  return hints.every((hint) => haystack.includes(hint));
}

function candidateMeetsClearWinnerGuards(track, title, artist) {
  if (hasLanguageVariantMismatch(track.title, title)) {
    return false;
  }
  if (!titleCoreMatchesQuery(track, title)) {
    return false;
  }
  const queryCore = normalizeCoreTitle(track?.title || "");
  const candidateCore = normalizeCoreTitle(title);
  if (!queryCore || !candidateCore || queryCore !== candidateCore) {
    return false;
  }
  if (hasMissingFeaturedArtistHints(track.title, title)) {
    if (!featuredArtistHintsPresentInCandidate(track.title, title, artist)) {
      return false;
    }
  }
  if (hasExtraneousFeaturedArtistHints(track.title, title)) {
    return false;
  }
  return true;
}

function isDurationAcceptableForClearWinner(track, durationMs = 0) {
  if (!(track.durationMs > 0 && durationMs > 0)) {
    return true;
  }
  const durationDelta = Math.abs(durationMs - track.durationMs);
  const trackCore = normalizeCoreTitle(track?.title || "");
  const exactShortTitleMatchRequired = needsExactShortTextMatch(trackCore);
  const durationToleranceMs = exactShortTitleMatchRequired
    ? 35_000
    : Math.max(
        14_000,
        Math.min(90_000, Math.floor((track.durationMs || 0) * 0.45)),
      );
  return durationDelta <= durationToleranceMs;
}

function findClearWinnerAmongTitleMatched(track, candidates) {
  const titleMatched = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      ...candidate,
      overlap: getBestArtistOverlap(track.artist, candidate.artist),
    }))
    .filter((candidate) =>
      candidateMeetsClearWinnerGuards(track, candidate.title, candidate.artist),
    );

  if (!titleMatched.length) {
    return null;
  }

  const maxOverlap = Math.max(
    ...titleMatched.map((candidate) => candidate.overlap),
  );
  if (maxOverlap > ARTIST_OVERLAP_CONFIDENT_THRESHOLD) {
    return null;
  }

  titleMatched.sort((left, right) => {
    if (right.overlap !== left.overlap) {
      return right.overlap - left.overlap;
    }
    return Number(right.score || 0) - Number(left.score || 0);
  });

  const top = titleMatched[0];
  const second = titleMatched[1];
  if (!top || top.overlap < CLEAR_WINNER_MIN_OVERLAP) {
    return null;
  }
  if (second && top.overlap - second.overlap < CLEAR_WINNER_MIN_OVERLAP_GAP) {
    return null;
  }
  if (!isDurationAcceptableForClearWinner(track, top.durationMs || 0)) {
    return null;
  }
  return top;
}

function filterLikelySameTrackCandidates(
  track,
  rankedCandidates,
  accessors = {},
) {
  const getTitle =
    typeof accessors.getTitle === "function"
      ? accessors.getTitle
      : (candidate) => candidate.title || "";
  const getArtist =
    typeof accessors.getArtist === "function"
      ? accessors.getArtist
      : (candidate) => candidate.artist || "";
  const getDurationMs =
    typeof accessors.getDurationMs === "function"
      ? accessors.getDurationMs
      : (candidate) => Number(candidate.durationMs || 0);
  const getScore =
    typeof accessors.getScore === "function"
      ? accessors.getScore
      : (candidate) => Number(candidate.score || 0);

  const entries = (Array.isArray(rankedCandidates) ? rankedCandidates : []).map(
    (raw) => ({
      raw,
      title: String(getTitle(raw) || "").trim(),
      artist: String(getArtist(raw) || "").trim(),
      durationMs: Number(getDurationMs(raw) || 0),
      score: Number(getScore(raw) || 0),
    }),
  );

  const strictMatches = entries.filter((entry) =>
    isLikelySameTrack(track, entry.title, entry.artist, entry.durationMs),
  );
  if (strictMatches.length) {
    return strictMatches.map((entry) => entry.raw);
  }

  const clearWinner = findClearWinnerAmongTitleMatched(track, entries);
  if (!clearWinner) {
    return [];
  }

  return entries
    .filter(
      (entry) =>
        normalizeCoreTitle(entry.title) ===
          normalizeCoreTitle(clearWinner.title) &&
        normalizeMatchText(entry.artist) ===
          normalizeMatchText(clearWinner.artist),
    )
    .map((entry) => entry.raw);
}

function isLikelySameTrack(track, title, artist, durationMs = 0) {
  if (hasLanguageVariantMismatch(track.title, title)) {
    return false;
  }
  if (hasMissingFeaturedArtistHints(track.title, title)) {
    if (!featuredArtistHintsPresentInCandidate(track.title, title, artist)) {
      return false;
    }
  }
  if (!titleCoreMatchesQuery(track, title)) {
    return false;
  }
  const trackCore = normalizeCoreTitle(track.title);
  const candidateCore = normalizeCoreTitle(title);
  const titleTokenOverlap = overlapRatio(
    tokens(trackCore),
    tokens(candidateCore),
  );
  const artistOverlap = getBestArtistOverlap(track.artist, artist);
  const artistLooksRelated = artistNamesLookRelated(track.artist, artist);

  if (!trackCore || !candidateCore) {
    return false;
  }

  const queryTitleCandidates = [
    trackCore,
    ...extractBracketedTitleSegments(track?.title || ""),
  ].filter(Boolean);
  const candidateTitleCandidates = [
    candidateCore,
    ...extractBracketedTitleSegments(title),
  ].filter(Boolean);
  const exactShortTitleMatchRequired = needsExactShortTextMatch(trackCore);
  let strongestTitleOverlap = 0;
  let titleContainmentMatch = false;
  const titleLooksRelated = queryTitleCandidates.some((queryCandidate) =>
    candidateTitleCandidates.some((candidateOption) => {
      if (!queryCandidate || !candidateOption) {
        return false;
      }
      const overlap = overlapRatio(
        tokens(queryCandidate),
        tokens(candidateOption),
      );
      strongestTitleOverlap = Math.max(strongestTitleOverlap, overlap);
      if (queryCandidate === candidateOption) {
        titleContainmentMatch = true;
        return true;
      }
      if (exactShortTitleMatchRequired) {
        if (
          queryCandidate === candidateOption ||
          (queryCandidate === trackCore &&
            candidateOption === candidateCore &&
            !hasMissingFeaturedArtistHints(track.title, title))
        ) {
          titleContainmentMatch = true;
          return true;
        }
        return false;
      }
      if (hasWholeTextContainment(queryCandidate, candidateOption)) {
        titleContainmentMatch = true;
        return true;
      }
      return overlap >= 0.62;
    }),
  );

  if (!titleLooksRelated) {
    return false;
  }

  if (exactShortTitleMatchRequired && !titleContainmentMatch) {
    return false;
  }

  if (
    exactShortTitleMatchRequired &&
    hasExtraneousTitleWords(track.title, title)
  ) {
    return false;
  }

  const durationDelta =
    track.durationMs > 0 && durationMs > 0
      ? Math.abs(durationMs - track.durationMs)
      : 0;
  const hasDurationComparison = track.durationMs > 0 && durationMs > 0;
  if (exactShortTitleMatchRequired && !artistLooksRelated) {
    return false;
  }
  const strongShortTitleArtistMatch =
    exactShortTitleMatchRequired && titleContainmentMatch && artistLooksRelated;
  const exactTitleArtistMatch =
    titleContainmentMatch && artistLooksRelated && trackCore === candidateCore;
  const durationToleranceMs = strongShortTitleArtistMatch
    ? 35_000
    : exactTitleArtistMatch
      ? Math.max(
          14_000,
          Math.min(90_000, Math.floor((track.durationMs || 0) * 0.45)),
        )
      : 12_000;
  const durationCloseEnough = hasDurationComparison
    ? durationDelta <= durationToleranceMs
    : true;

  if (artistLooksRelated) {
    if (exactShortTitleMatchRequired && !titleContainmentMatch) {
      return false;
    }
    return durationCloseEnough;
  }

  if (!artistLooksRelated) {
    if (artistOverlap < 0.12) {
      return false;
    }
    if (!durationCloseEnough) {
      return false;
    }
    const titleStrongEnough =
      titleContainmentMatch || strongestTitleOverlap >= 0.9;
    if (!titleStrongEnough) {
      return false;
    }
    if (!hasDurationComparison) {
      return false;
    }
    const queryCoreTokens = tokens(trackCore);
    if (queryCoreTokens.length < 2 && String(trackCore || "").length < 10) {
      return false;
    }
    const strictDurationMatch = durationDelta <= 6_000;
    const ultraCloseDurationMatch = durationDelta <= 2_500;
    const queryHasSpecificBracketDetail =
      extractBracketedTitleSegments(track?.title || "").length > 0;
    const queryTitleCoreLength = String(trackCore || "").length;
    const multiTokenTitle = tokens(trackCore).length >= 2;
    if (
      ultraCloseDurationMatch ||
      (strictDurationMatch &&
        (queryHasSpecificBracketDetail ||
          multiTokenTitle ||
          queryTitleCoreLength >= 8))
    ) {
      return true;
    }
    return false;
  }
  return durationCloseEnough;
}

function computeCandidateMatchRank(
  track,
  title,
  artist,
  durationMs = 0,
  searchScore = 0,
) {
  const trackCore = normalizeCoreTitle(track?.title || "");
  const candidateCore = normalizeCoreTitle(title);
  let rank = Number(searchScore || 0);
  rank += getBestArtistOverlap(track.artist, artist) * 12;
  if (trackCore && candidateCore && trackCore === candidateCore) {
    rank += 22;
  }
  if (needsExactShortTextMatch(trackCore)) {
    const bracketHasCore = extractBracketedTitleSegments(title).some(
      (segment) =>
        segment === trackCore ||
        tokens(segment).includes(trackCore) ||
        hasWholeTextContainment(segment, trackCore),
    );
    if (bracketHasCore || candidateCore === trackCore) {
      rank += 18;
    } else {
      rank -= 50;
    }
  }
  rank += scoreDurationBonus(track, title, artist, durationMs) * 0.4;
  return rank;
}

function shouldPreferLyricsCandidate(
  track,
  current,
  candidate,
  currentCoverage,
  candidateCoverage,
) {
  const currentRank = computeCandidateMatchRank(
    track,
    current.title,
    current.artist,
    current.durationMs,
    current.searchScore,
  );
  const candidateRank = computeCandidateMatchRank(
    track,
    candidate.title,
    candidate.artist,
    candidate.durationMs,
    candidate.searchScore,
  );
  if (candidateRank > currentRank + 0.5) {
    return true;
  }
  if (currentRank > candidateRank + 0.5) {
    return false;
  }
  return candidateCoverage > currentCoverage;
}

function explainTrackMatch(track, title, artist, durationMs = 0) {
  const trackCore = normalizeCoreTitle(track?.title || "");
  const candidateCore = normalizeCoreTitle(title);
  const featuredHints = collectFeaturedArtistHints(track?.title || "");
  const candidateNorm = normalizeMatchText(title);
  return {
    likely: isLikelySameTrack(track, title, artist, durationMs),
    languageVariantMismatch: hasLanguageVariantMismatch(track.title, title),
    missingFeaturedArtistHints:
      hasMissingFeaturedArtistHints(track.title, title) &&
      !featuredArtistHintsPresentInCandidate(track.title, title, artist),
    extraneousTitleWords: hasExtraneousTitleWords(track.title, title),
    featuredHints,
    featuredHintChecks: featuredHints.map((hint) => ({
      hint,
      present: candidateNorm.includes(hint),
    })),
    candidateNorm,
    artistOverlap: getBestArtistOverlap(track.artist, artist),
    artistLooksRelated: artistNamesLookRelated(track.artist, artist),
    trackCore,
    candidateCore,
    exactShortTitle: needsExactShortTextMatch(trackCore),
    titleCoreMatchesQuery: titleCoreMatchesQuery(track, title),
  };
}

async function fetchJson(
  url,
  { params = {}, headers = {}, timeoutMs = 8_000 } = {},
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && `${value}`.length > 0) {
      query.set(key, String(value));
    }
  }
  const finalUrl = query.size ? `${url}?${query.toString()}` : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(finalUrl, {
      method: "GET",
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "KineSyncDesktopBridge/1.0",
        ...headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    return parseJsonLenient(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLenient(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    throw new Error("Empty response body");
  }
  const direct = tryParseJson(text);
  if (direct.ok) {
    return direct.value;
  }

  const jsonpMatch = text.match(/^[^(]+\(([\s\S]+)\)\s*;?\s*$/);
  if (jsonpMatch?.[1]) {
    const parsedJsonp = tryParseJson(jsonpMatch[1].trim());
    if (parsedJsonp.ok) {
      return parsedJsonp.value;
    }
  }

  const prefixed = text.replace(/^\)\]\}',?\s*/, "");
  const parsedPrefixed = tryParseJson(prefixed);
  if (parsedPrefixed.ok) {
    return parsedPrefixed.value;
  }

  throw new Error(`Invalid JSON response (${text.slice(0, 80)})`);
}

function tryParseJson(input) {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false, value: null };
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryRequest(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    error?.name === "AbortError" ||
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("timeout") ||
    message.includes("econn") ||
    message.includes("etimedout")
  );
}

async function fetchJsonWithRetry(
  url,
  options = {},
  { attempts = 3, backoffMs = 350 } = {},
) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetryRequest(error)) {
        throw error;
      }
      await wait(backoffMs * attempt);
    }
  }
  throw lastError || new Error("Request failed");
}

function normalizeJsososoSongs(searchData) {
  const list =
    searchData?.data?.song?.itemlist ||
    searchData?.data?.list ||
    searchData?.data?.body?.song?.list ||
    searchData?.data?.song?.list ||
    searchData?.data?.song?.items ||
    searchData?.data?.song?.songlist ||
    searchData?.song?.itemlist ||
    searchData?.song?.list ||
    [];
  return Array.isArray(list) ? list : [];
}

function extractJsososoLyricText(lyricData) {
  return (
    lyricData?.data?.qrc ||
    lyricData?.data?.lyric ||
    lyricData?.data?.body?.lyric ||
    lyricData?.data?.body?.qrc ||
    lyricData?.qrc ||
    lyricData?.lyric ||
    ""
  );
}

function describeSourceError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("cooldown active")) {
    return "rate-limited";
  }
  if (message === "__no_match__" || message.includes("no match")) {
    return "no-match";
  }
  if (message.includes("url blocked") || message.includes("error 54113")) {
    return "url-blocked";
  }
  if (
    message.includes("token was rejected") ||
    message.includes("unauthorized")
  ) {
    return "unauthorized";
  }
  if (
    message.includes("missing musixmatch") ||
    message.includes("token format is invalid") ||
    message.includes("missing spotify web token")
  ) {
    return "missing-config";
  }
  if (
    message.includes("spotify web token exchange") ||
    message.includes("access token")
  ) {
    return "unauthorized";
  }
  if (message.includes("captcha")) {
    return "rate-limited";
  }
  if (error?.name === "AbortError" || message.includes("timeout")) {
    return "timeout";
  }
  if (message.includes("http 403") || message.includes("http 429")) {
    return "rate-limited";
  }
  if (message.includes("http ")) {
    return "http";
  }
  if (message.includes("invalid json")) {
    return "invalid-json";
  }
  if (
    message.includes("unsupported payload") ||
    message.includes("unsupported format")
  ) {
    return "unsupported-format";
  }
  if (message.includes("slobjpack unpack")) {
    return "unpack-failed";
  }
  if (
    message.includes("still queued") ||
    /\bstatus 503\b/.test(message) ||
    message.includes("http 503")
  ) {
    return "queued";
  }
  if (message.includes("static results") || message.includes("stale catalog")) {
    return "stale-catalog";
  }
  return "network";
}

function createSourceStageError(source, stage, error) {
  const wrapped =
    error instanceof Error
      ? error
      : new Error(String(error || `${source} ${stage} failed`));
  wrapped.sourceFailureReason = `${source}:${stage}-${describeSourceError(error)}`;
  return wrapped;
}

function createSourceStageNoMatchError(source, stage) {
  const error = new Error(`${source} ${stage} returned no match`);
  error.sourceFailureReason = `${source}:${stage}-no-match`;
  return error;
}
