const ITUNES_NS = "http://itunes.apple.com/lyric-ttml-extensions";

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatTtmlClock(ms) {
  const safeMs = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1000);
  const millis = safeMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
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

function getLyricLineText(line) {
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

function resolveLineEndTime(line, index, lyrics, durationMs) {
  const start = Math.max(0, Number(line?.lineStartTime) || 0);
  let end = Number(line?.lineEndTime);
  if (!Number.isFinite(end) || end <= start) {
    const nextLine = lyrics[index + 1];
    const nextStart = Number(nextLine?.lineStartTime);
    if (Number.isFinite(nextStart) && nextStart > start) {
      end = nextStart;
    }
  }
  if (!Number.isFinite(end) || end <= start) {
    const fallbackDuration = Number(durationMs);
    end =
      Number.isFinite(fallbackDuration) && fallbackDuration > start
        ? fallbackDuration
        : start + 3000;
  }
  return Math.max(start + 1, Math.round(end));
}

function detectLyricsTimingMode(lyrics, lyricsSource = "") {
  const safeLyrics = Array.isArray(lyrics) ? lyrics : [];
  if (!safeLyrics.length) {
    return "unknown";
  }

  const source = String(lyricsSource || "").toLowerCase();
  if (source.includes("spicy-lyrics-static")) {
    return "static";
  }
  if (source.includes("spicy-lyrics-line")) {
    return "interpolated";
  }
  if (
    source.includes("musicu-qrc") ||
    source.includes("qrc") ||
    source.includes("yrc") ||
    source.includes("spicy-lyrics-syllable")
  ) {
    return "karaoke";
  }
  if (source.includes("interpolated")) {
    return "interpolated";
  }

  let inspectedLines = 0;
  let nonUniformLines = 0;

  for (const line of safeLyrics) {
    const syllables = line.syllables || [];
    if (syllables.length < 3) {
      continue;
    }

    const durations = syllables
      .map((syllable) => Math.max(0, syllable.endTime - syllable.startTime))
      .filter((value) => Number.isFinite(value));
    if (durations.length < 3) {
      continue;
    }

    inspectedLines += 1;
    const mean =
      durations.reduce((sum, value) => sum + value, 0) / durations.length;
    const maxDelta = durations.reduce(
      (max, value) => Math.max(max, Math.abs(value - mean)),
      0,
    );
    if (maxDelta > 35) {
      nonUniformLines += 1;
    }
  }

  if (!inspectedLines) {
    return "unknown";
  }

  return nonUniformLines > 0 ? "karaoke" : "interpolated";
}

function lineHasKaraokeTiming(line) {
  const syllables = (
    Array.isArray(line?.syllables) ? line.syllables : []
  ).filter((part) => String(part?.text || "").trim());
  if (syllables.length < 2) {
    return false;
  }

  const timedSyllables = syllables.filter((part) => {
    const start = Number(part?.startTime);
    const end = Number(part?.endTime);
    return Number.isFinite(start) && Number.isFinite(end) && end > start;
  });
  if (timedSyllables.length < 2) {
    return false;
  }

  const starts = timedSyllables.map((part) => Number(part.startTime));
  if (starts.some((start, index) => index > 0 && start !== starts[index - 1])) {
    return true;
  }

  const durations = timedSyllables.map((part) =>
    Math.max(0, Number(part.endTime) - Number(part.startTime)),
  );
  const mean =
    durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const maxDelta = durations.reduce(
    (max, value) => Math.max(max, Math.abs(value - mean)),
    0,
  );
  return maxDelta > 35;
}

function lyricsUseKaraokeTiming(lyrics, source = "") {
  const mode = detectLyricsTimingMode(lyrics, source);
  if (mode === "karaoke") {
    return true;
  }
  if (mode === "interpolated") {
    return false;
  }
  return (Array.isArray(lyrics) ? lyrics : []).some((line) =>
    lineHasKaraokeTiming(line),
  );
}

function clampSyllableTime(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function formatKaraokeSpanText(syllable, nextSyllable) {
  let text = String(syllable?.text || "");
  if (!text) {
    return "";
  }

  const needsTrailingSpace =
    typeof syllable?.isPartOfWord === "boolean"
      ? syllable.isPartOfWord === false
      : Boolean(
          nextSyllable &&
          shouldInsertSyllableBoundarySpace(
            text,
            String(nextSyllable.text || ""),
          ),
        );

  if (needsTrailingSpace && nextSyllable && !/\s$/.test(text)) {
    text += " ";
  }
  return text;
}

function buildKaraokeSpanMarkup(syllables, lineStart, lineEnd) {
  const usable = syllables.filter(
    (part) => String(part?.text || "").length > 0,
  );
  const spans = [];

  for (let index = 0; index < usable.length; index += 1) {
    const syllable = usable[index];
    const nextSyllable = usable[index + 1];
    const text = formatKaraokeSpanText(syllable, nextSyllable);
    if (!text) {
      continue;
    }

    let start = Number(syllable?.startTime);
    let end = Number(syllable?.endTime);
    if (!Number.isFinite(start)) {
      start = lineStart;
    }
    if (!Number.isFinite(end) || end <= start) {
      end = nextSyllable
        ? Number(nextSyllable.startTime)
        : Math.max(start + 1, lineEnd);
    }
    if (!Number.isFinite(end) || end <= start) {
      end = Math.max(start + 1, lineEnd);
    }

    start = clampSyllableTime(start, lineStart, lineEnd - 1);
    end = clampSyllableTime(end, start + 1, lineEnd);
    spans.push(
      `<span begin="${formatTtmlClock(start)}" end="${formatTtmlClock(end)}">${escapeXml(text)}</span>`,
    );
  }

  return spans.join("");
}

function buildBackgroundVocalMarkup(backgroundSyllables, lineStart, lineEnd) {
  const usable = (
    Array.isArray(backgroundSyllables) ? backgroundSyllables : []
  ).filter((part) => String(part?.text || "").trim());
  if (!usable.length) {
    return "";
  }

  let bgStart = Number(usable[0]?.startTime);
  let bgEnd = Number(usable[usable.length - 1]?.endTime);
  if (!Number.isFinite(bgStart)) {
    bgStart = lineStart;
  }
  if (!Number.isFinite(bgEnd) || bgEnd <= bgStart) {
    bgEnd = lineEnd;
  }
  bgStart = clampSyllableTime(bgStart, lineStart, lineEnd - 1);
  bgEnd = clampSyllableTime(bgEnd, bgStart + 1, lineEnd);

  const inner = buildKaraokeSpanMarkup(usable, bgStart, bgEnd);
  if (!inner) {
    return "";
  }

  return `<span ttm:role="x-bg" begin="${formatTtmlClock(bgStart)}" end="${formatTtmlClock(bgEnd)}">${inner}</span>`;
}

function buildTranslationMarkup(line) {
  const translated = String(line?.translatedText || "").trim();
  if (!translated) {
    return "";
  }
  return `<span ttm:role="x-translation" xml:lang="en">${escapeXml(translated)}</span>`;
}

function buildKaraokeParagraphMarkup(
  line,
  index,
  lyrics,
  durationMs,
  lineNumber,
) {
  const lineStart = Math.max(0, Number(line?.lineStartTime) || 0);
  const lineEnd = resolveLineEndTime(line, index, lyrics, durationMs);
  const syllables = Array.isArray(line?.syllables) ? line.syllables : [];
  const inner =
    buildKaraokeSpanMarkup(syllables, lineStart, lineEnd) ||
    (getLyricLineText(line)
      ? `<span begin="${formatTtmlClock(lineStart)}" end="${formatTtmlClock(lineEnd)}">${escapeXml(getLyricLineText(line))}</span>`
      : "");
  if (!inner) {
    return { markup: "", endTime: lineEnd };
  }

  const background = buildBackgroundVocalMarkup(
    line.backgroundSyllables,
    lineStart,
    lineEnd,
  );
  const translation = buildTranslationMarkup(line);
  const markup = `<p begin="${formatTtmlClock(lineStart)}" end="${formatTtmlClock(lineEnd)}" itunes:key="L${lineNumber}" ttm:agent="v1">${inner}${background}${translation}</p>`;
  return { markup, endTime: lineEnd };
}

function buildLineParagraphMarkup(line, index, lyrics, durationMs, lineNumber) {
  const lineStart = Math.max(0, Number(line?.lineStartTime) || 0);
  const lineEnd = resolveLineEndTime(line, index, lyrics, durationMs);
  const plainText = getLyricLineText(line);
  if (!plainText) {
    return { markup: "", endTime: lineEnd };
  }

  const translation = buildTranslationMarkup(line);
  const markup = `<p begin="${formatTtmlClock(lineStart)}" end="${formatTtmlClock(lineEnd)}" itunes:key="L${lineNumber}" ttm:agent="v1">${escapeXml(plainText)}${translation}</p>`;
  return { markup, endTime: lineEnd };
}

function buildParagraphMarkup(
  line,
  index,
  lyrics,
  durationMs,
  lineNumber,
  useKaraoke,
) {
  if (useKaraoke) {
    return buildKaraokeParagraphMarkup(
      line,
      index,
      lyrics,
      durationMs,
      lineNumber,
    );
  }
  return buildLineParagraphMarkup(line, index, lyrics, durationMs, lineNumber);
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function buildDefaultTtmlFilename({ title = "", artist = "" } = {}) {
  const safeTitle = sanitizeFilenamePart(title) || "lyrics";
  const safeArtist = sanitizeFilenamePart(artist);
  const base = safeArtist ? `${safeTitle} - ${safeArtist}` : safeTitle;
  return `${base}.ttml`;
}

function lyricsToTtml({
  lyrics = [],
  title = "",
  artist = "",
  source = "",
  durationMs = 0,
  xmlLang = "en",
} = {}) {
  const safeLyrics = Array.isArray(lyrics) ? lyrics : [];
  const useKaraoke = lyricsUseKaraokeTiming(safeLyrics, source);
  let lineNumber = 0;
  let documentEndMs = 0;
  const paragraphs = [];

  for (let index = 0; index < safeLyrics.length; index += 1) {
    const line = safeLyrics[index];
    const plainText = getLyricLineText(line);
    if (!plainText) {
      continue;
    }
    lineNumber += 1;
    const built = buildParagraphMarkup(
      line,
      index,
      safeLyrics,
      durationMs,
      lineNumber,
      useKaraoke,
    );
    if (built.markup) {
      paragraphs.push(built.markup);
      documentEndMs = Math.max(documentEndMs, built.endTime);
    }
  }

  if (!paragraphs.length) {
    throw new Error("No lyric lines available to export.");
  }

  const fallbackDuration = Number(durationMs);
  if (Number.isFinite(fallbackDuration) && fallbackDuration > documentEndMs) {
    documentEndMs = Math.round(fallbackDuration);
  }

  const metadataBlocks = [];
  const safeTitle = String(title || "").trim();
  const safeArtist = String(artist || "").trim();
  const safeSource = String(source || "").trim();

  metadataBlocks.push(
    `<ttm:agent type="person" xml:id="v1">${safeArtist ? `<ttm:name type="full">${escapeXml(safeArtist)}</ttm:name>` : ""}</ttm:agent>`,
  );
  if (safeTitle) {
    metadataBlocks.push(`<ttm:title>${escapeXml(safeTitle)}</ttm:title>`);
  }
  if (safeSource) {
    metadataBlocks.push(
      `<ttm:copyright>${escapeXml(`Source: ${safeSource}`)}</ttm:copyright>`,
    );
  }

  const metadataXml = metadataBlocks.length
    ? `<metadata>\n      ${metadataBlocks.join("\n      ")}\n    </metadata>`
    : "";

  const itunesTiming = useKaraoke ? "Word" : "Line";
  const bodyDur =
    documentEndMs > 0 ? ` dur="${formatTtmlClock(documentEndMs)}"` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:itunes="${ITUNES_NS}" xml:lang="${escapeXml(xmlLang)}" itunes:timing="${itunesTiming}">
  <head>
    ${metadataXml}
    <styling>
      <style xml:id="defaultStyle" tts:fontSize="100%" tts:textAlign="center" />
    </styling>
    <layout>
      <region xml:id="subtitleRegion" tts:displayAlign="after" tts:textAlign="center" />
    </layout>
  </head>
  <body${bodyDur}>
    <div>
      ${paragraphs.join("\n      ")}
    </div>
  </body>
</tt>`;
}

module.exports = {
  buildDefaultTtmlFilename,
  detectLyricsTimingMode,
  escapeXml,
  formatTtmlClock,
  getLyricLineText,
  lineHasKaraokeTiming,
  lyricsToTtml,
  lyricsUseKaraokeTiming,
  sanitizeFilenamePart,
};
