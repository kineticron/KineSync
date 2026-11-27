"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { mergeTtmlTranslationResult, selectTtmlTranslationTracks } = require("../src/lyricsTtmlTranslations");
const desktop = require("../src/lyricsTtmlImport");
const mobile = require("../../ExpoLyrics/lib/lyrics-ttml-import");
const { lyricsToTtml } = require("../src/lyricsTtmlExport");
const { lyricsToTtml: mobileLyricsToTtml } = require("../../ExpoLyrics/lib/lyrics-ttml-export");
const { compactLyricsForStorage, expandLyricsFromStorage } = require("../src/lyricsVault");
const captures = require("./fixtures/lrc-red/background-capture.json").recordings;

const lrcNamespace = "http://lrc.red/lyric-ttml-internal";
const modelIsrc = "KRA381702796";
const translatedIsrc = "KRA401500556";
const fixture = isrc => fs.readFileSync(path.join(__dirname, "fixtures/lrc-red", `${isrc}.ttml`), "utf8");
const joined = atoms => atoms.map(atom => atom.text).join("");
const times = atoms => Array.from(atoms, ({ startTime, endTime }) => [startTime, endTime]);

function parse(content, options) {
  const parsed = desktop.parseTtmlToLyrics(content, options);
  assert.deepEqual(mobile.parseTtmlToLyrics(content, options), parsed);
  return parsed;
}

function document(body, tracks = "", marker = "", namespace = lrcNamespace) {
  return `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:lrc="${namespace}" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" lrc:timing="Word" ${marker}>
    <head><metadata><sourceMetadata xmlns="${namespace}"><translations>${tracks}</translations></sourceMetadata></metadata></head>
    <body>${body}</body></tt>`;
}

const span = (start, end, text) => `<span begin="${start}" end="${end}">${text}</span>`;
const paragraph = (key, body) => `<p begin="1" end="6" lrc:key="${key}">${body}</p>`;
const subtitle = (language, text) => `<translation xml:lang="${language}" type="subtitle">${text}</translation>`;
const entry = (key, text) => `<text for="${key}">${text}</text>`;

test("captured model TTML moves each ad-lib atom with its original timing", () => {
  const content = fixture(modelIsrc);
  const provenance = captures[modelIsrc];
  assert.equal(createHash("sha256").update(content).digest("hex"), provenance.ttmlSha256);
  assert.equal(provenance.recording.byModel, true);
  assert.match(content, /\blrc:byModel="true"/);
  assert.equal(provenance.ttmlSubtitleTrackCount, 0);
  const before = parse(content.replaceAll(lrcNamespace, "urn:other"));
  const after = parse(content);
  const oldLine = before.lyrics.find(line => line.lineStartTime === 47925);
  const newLine = after.lyrics.find(line => line.lineStartTime === 47925);
  assert.equal(joined(oldLine.syllables), "Girl, what's your flavor? (Flavor)");
  assert.equal(joined(newLine.syllables), "Girl, what's your flavor?");
  assert.deepEqual(newLine.backgroundSyllables.map(atom => atom.text), ["Fla", "vor"]);
  assert.deepEqual(times(newLine.syllables), times(oldLine.syllables.slice(0, -2)));
  assert.deepEqual(times(newLine.backgroundSyllables), [[49371, 49795], [49795, 49816]]);
  assert.equal(newLine.backgroundSyllables[0].isPartOfWord, true);
  assert.equal(newLine.lineEndTime, oldLine.lineEndTime);
  assert.equal(after.metadata.ttml.content, content);
  assert.equal(after.lyrics.length, before.lyrics.length);
  const standaloneIndex = after.lyrics.findIndex(line => line.lineStartTime === 136147);
  const standalone = after.lyrics[standaloneIndex];
  assert.deepEqual(standalone.syllables, []);
  assert.deepEqual(times(standalone.backgroundSyllables), times(before.lyrics[standaloneIndex].syllables));

  const lineIndex = after.lyrics.findIndex(line => line.lineStartTime === 62495);
  const enriched = after.lyrics.map((line, index) => {
    if (index === lineIndex) return { ...line, translatedText: "That's our chemistry (Yeah, yeah)" };
    if (index === standaloneIndex) return { ...line, backgroundTranslatedText: "I've been waiting for this" };
    return line;
  });
  enriched.translationMeta = { provider: "Gemini", translatedLineCount: 2 };
  const translated = mergeTtmlTranslationResult(after, enriched, "English");
  const merged = translated.lyrics[lineIndex];
  assert.equal(merged.translatedText, "That's our chemistry");
  assert.equal(merged.backgroundTranslatedText, "Yeah, yeah");
  assert.deepEqual(times(merged.backgroundSyllables), [[63516, 63965], [63965, 63985]]);
  assert.deepEqual(translated.lyrics[standaloneIndex].syllables, []);
  assert.equal(translated.lyrics[standaloneIndex].translatedText, undefined);
  assert.equal(translated.lyrics[standaloneIndex].backgroundTranslatedText, "I've been waiting for this");
  assert.doesNotMatch(JSON.stringify(translated.lyrics), /\u200c/u);
  assert.equal(translated.metadata.translation.targetLanguage, "English");
  const cached = JSON.parse(JSON.stringify(translated));
  const spanish = selectTtmlTranslationTracks(cached, "Spanish");
  assert.equal(spanish.lyrics[lineIndex].translatedText, undefined);
  assert.equal(spanish.lyrics[lineIndex].backgroundTranslatedText, undefined);
  assert.equal(spanish.lyrics[standaloneIndex].backgroundTranslatedText, undefined);
  assert.equal(spanish.metadata.translation, undefined);
  assert.equal(spanish.lyrics.translationMeta, undefined);
  assert.deepEqual(selectTtmlTranslationTracks(cached, "English").lyrics[lineIndex], merged);
});

test("trackless cache language changes restore inline source translations", () => {
  const content = document(paragraph("A", span(1, 2, "First") +
    '<span ttm:role="x-translation">Source lead only</span>') +
    paragraph("B", span(2, 3, "Second (aside)") +
    '<span ttm:role="x-translation">Source lead (source background)</span>') +
    paragraph("C", span(3, 4, "Third (aside)")));
  const base = parse(content);
  const enriched = base.lyrics.map(line => ({
    ...line, translatedText: "AI lead", backgroundTranslatedText: "AI background",
  }));
  enriched.translationMeta = { provider: "Gemini", translatedLineCount: 3 };
  const english = mergeTtmlTranslationResult(base, enriched, "English");
  assert.equal(english.lyrics[0].translatedText, "Source lead only");
  assert.equal(english.lyrics[1].backgroundTranslatedText, "source background");
  const spanish = selectTtmlTranslationTracks(english, "Spanish");
  assert.deepEqual(spanish.lyrics, base.lyrics);
  assert.equal(spanish.metadata.translation, undefined);
  assert.equal(english.lyrics[2].backgroundTranslatedText, "AI background");
});

test("a selected subtitle can supply the background lane alongside an inline lead translation", () => {
  const body = paragraph("A", span(1, 2, "Lead (aside)") +
    '<span ttm:role="x-translation">Inline lead</span>');
  const tracks = subtitle("en", entry("A", "Subtitle lead (English aside)")) +
    subtitle("es", entry("A", "Subtitle lead (Spanish aside)"));
  const english = parse(document(body, tracks));
  assert.equal(english.lyrics[0].translatedText, "Inline lead");
  assert.equal(english.lyrics[0].backgroundTranslatedText, "English aside");
  const spanish = selectTtmlTranslationTracks(english, "Spanish");
  assert.equal(spanish.lyrics[0].translatedText, "Inline lead");
  assert.equal(spanish.lyrics[0].backgroundTranslatedText, "Spanish aside");
  const french = selectTtmlTranslationTracks(spanish, "French");
  assert.equal(french.lyrics[0].translatedText, "Inline lead");
  assert.equal(french.lyrics[0].backgroundTranslatedText, undefined);
});

test("translate-only reselects the language before asking Gemini to enrich published rows", async () => {
  const body = paragraph("A", span(1, 2, "Lead (aside)"));
  const base = parse(document(body, subtitle("fr", entry("A", "Source française"))));
  const enriched = [{ ...base.lyrics[0], translatedText: "English lead", backgroundTranslatedText: "English aside" }];
  enriched.translationMeta = { provider: "Gemini", translatedLineCount: 1 };
  const english = mergeTtmlTranslationResult(base, enriched, "English");
  for (const relative of ["../src/lyrics/parts/07b-service-orchestration.js", "../../ExpoLyrics/lib/mobile-lyrics-service.js"]) {
    const source = fs.readFileSync(path.resolve(__dirname, relative), "utf8");
    const method = source.slice(source.indexOf("    async translatePublishedLyrics("), source.indexOf("    async fetchSyncedLyrics("));
    const published = [];
    const translate = vm.runInNewContext(`({${method}}).translatePublishedLyrics`, {
      selectTtmlTranslationTracks, mergeTtmlTranslationResult,
      getPublishedLyrics: () => ({ ...english, source: "lrc-red-karaoke" }),
      getGeminiApiKey: () => "",
      geminiTranslationCache: new Map(),
      enrichLyricsWithGeminiTranslations: async (track, rows, options) => {
        assert.equal(options.targetLanguage, "Spanish");
        assert.equal(rows[0].translatedText, undefined);
        assert.equal(rows[0].backgroundTranslatedText, undefined);
        return rows;
      },
      buildLyricsPacketFromBase: (track, packet) => packet,
      lastDisplayedByTrack: new Map(),
      rememberSourceLyrics: () => {},
      mergeLyricsMetadata: (metadata, patch) => ({ ...metadata, ...patch }),
      console: { log() {} },
    });
    const result = await translate({ trackId: "track", title: "Title" }, {
      translationLanguage: "Spanish", onSyncedLyrics: packet => published.push(packet),
    });
    assert.equal(published.length, 2);
    for (const packet of [...published, result]) {
      assert.equal(packet.lyrics[0].translatedText, undefined);
      assert.equal(packet.lyrics[0].backgroundTranslatedText, undefined);
    }
    assert.equal(result.metadata.translation.targetLanguage, undefined);
  }
});

test("normal immediate fetch publishes a translation that adds literal-parenthesis provenance", async () => {
  const content = document(paragraph("A", span(1, 2, "Lead") + " " + span(2, 3, "(echo)")));
  const src = path.resolve(__dirname, "../src");
  const desktopIndex = path.join(src, "lyrics/index.js");
  const mobileBundle = path.resolve(src, "../../ExpoLyrics/lib/mobile-lyrics-service.js");
  for (const platform of ["desktop", "mobile"]) {
    let geminiRequests = 0;
    const published = [];
    const track = { trackId: "immediate", title: "Example Song", artist: "Example Artist", durationMs: 6000, isrc: "GBUM71029604" };
    const context = vm.createContext({
      AbortController, Buffer, clearTimeout, setTimeout, clearInterval, setInterval, TextDecoder, URL, URLSearchParams,
      console, global: {}, module: { exports: {} }, track, published,
      process: { env: {} }, require: createRequire(path.join(src, "lyricsService.js")),
      parseLrcRedTtml: mobile.parseTtmlToLyrics, parseLrcRedTime: mobile.parseTtmlTimeExpression,
      extractLrcRedTtmlMetadata: mobile.extractTtmlMetadata,
      fetch: async (url, options) => {
        if (url.endsWith(".json")) return Response.json({});
        if (url.endsWith(".ttml")) return new Response(content);
        assert.match(url, /generativelanguage\.googleapis\.com/);
        geminiRequests++;
        const payload = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
        assert.equal(payload.targetLanguage, "Spanish");
        assert.deepEqual(payload.lines.map(line => line.text), ["Lead", "echo"]);
        const translations = payload.lines.map(({ i, text }) => ({ i, t: text === "echo" ? "(eco)" : "Principal" }));
        return Response.json({ candidates: [{ content: { parts: [
          { text: JSON.stringify({ lineCount: translations.length, translations }) },
        ] } }] });
      },
    });
    if (platform === "mobile") {
      context.CryptoJS = createRequire(mobileBundle)("crypto-js");
      const bundle = fs.readFileSync(mobileBundle, "utf8").replace(/^import .*;\r?\n/gm, "");
      vm.runInContext(bundle.slice(0, bundle.indexOf("export {")), context);
    } else {
      const partNames = fs.readFileSync(desktopIndex, "utf8").match(/const partFiles = \[([\s\S]*?)\];/)[1];
      for (const [, name] of partNames.matchAll(/"([^"]+)"/g)) {
        vm.runInContext(fs.readFileSync(path.join(src, "lyrics/parts", name), "utf8"), context);
      }
    }
    const result = await vm.runInContext(`createLyricsService({ getGeminiApiKey: () => "test-key" })
      .fetchSyncedLyrics(track, { preferredSource: "lrc-red", immediateTranslation: true, translationLanguage: "Spanish",
        onSyncedLyrics: packet => published.push(packet) })`, context);
    assert.equal(geminiRequests, 1, platform);
    assert.ok(published.some(packet => packet.lyrics[0]?.backgroundTranslatedText === "(eco)"), platform);
    const [line] = result.lyrics;
    assert.equal(line.translatedText, "Principal");
    assert.equal(line.backgroundTranslatedText, "(eco)");
    assert.equal(line.literalBackgroundParentheses, true);
    assert.deepEqual(times(line.syllables), [[1000, 2000]]);
    assert.deepEqual(times(line.backgroundSyllables), [[2000, 3000]]);
  }
});

test("captured unmarked lrc.red TTML splits both timed vocals and source subtitles", () => {
  const content = fixture(translatedIsrc);
  const provenance = captures[translatedIsrc];
  assert.equal(createHash("sha256").update(content).digest("hex"), provenance.ttmlSha256);
  assert.equal(provenance.recording.byModel, undefined);
  const before = parse(content.replaceAll(lrcNamespace, "urn:other"));
  const parsed = parse(content);
  const line = parsed.lyrics.find(line => line.ttmlKey === "L2");
  const oldLine = before.lyrics.find(oldLine => oldLine.lineStartTime === line.lineStartTime);
  assert.equal(joined(oldLine.syllables), "난 깨어나 까만 밤과 함께 (Hey)");
  assert.equal(joined(line.syllables), "난 깨어나 까만 밤과 함께");
  assert.equal(joined(line.backgroundSyllables), "Hey");
  assert.deepEqual(times(line.syllables), times(oldLine.syllables.slice(0, -1)));
  assert.deepEqual(times(line.backgroundSyllables), [[16560, 16951]]);
  assert.equal(line.translatedText, "I wake up, together with the black night");
  assert.equal(line.backgroundTranslatedText, "hey");
  const originalTranslation = parsed.metadata.ttml.translationTracks[0].lines.find(line => line.key === "L2");
  assert.equal(originalTranslation.text, "I wake up, together with the black night (hey)");
});

test("full-width, nested and multiple groups keep punctuation, spacing and span boundaries", () => {
  const body = paragraph("A", [
    span(1, 1.3, "Lead"), " ", span(1.3, 1.5, "（ha"),
    span(1.5, 2.4, `${span(1.5, 1.7, "ha")} ${span(1.7, 2.4, "there）")}`),
    span(2.4, 2.5, ","), " (", span(2.5, 2.7, "sec"), span(2.7, 3, "ond"), ") ",
    span(3, 3.5, "tail (unfinished"),
  ].join("")) + paragraph("B", span(4, 5, "keep ) and (unclosed (nested)")) +
    paragraph("C", span(5, 6, "pre(one (two))fix"));
  const tracks = subtitle("en", entry("A", "Lead （first (nested)）, (second) then (extra) (open") +
    entry("B", "Keep (annotation)")) + subtitle("es", entry("A", "Principal (uno) (dos) final"));
  const parsed = parse(document(body, tracks));
  const [first, unmatched, nested] = parsed.lyrics;
  assert.equal(joined(first.syllables), "Lead, tail (unfinished");
  assert.equal(joined(first.backgroundSyllables), "haha there second");
  assert.deepEqual(times(first.syllables), [[1000, 1300], [2400, 2500], [3000, 3500]]);
  assert.deepEqual(times(first.backgroundSyllables), [[1300, 1500], [1500, 1700], [1700, 2400], [2500, 2700], [2700, 3000]]);
  assert.equal(first.translatedText, "Lead, then (extra) (open");
  assert.equal(first.backgroundTranslatedText, "first (nested) second");
  assert.equal(joined(unmatched.syllables), "keep ) and (unclosed (nested)");
  assert.equal(unmatched.backgroundSyllables, undefined);
  assert.equal(unmatched.translatedText, "Keep (annotation)");
  assert.equal(joined(nested.syllables), "prefix");
  assert.equal(joined(nested.backgroundSyllables), "one (two)");
  assert.deepEqual(times(nested.syllables), [[5000, 6000], [5000, 6000]]);
  assert.deepEqual(times(nested.backgroundSyllables), [[5000, 6000]]);

  const spanish = selectTtmlTranslationTracks(parsed, "Spanish");
  assert.equal(spanish.lyrics[0].translatedText, "Principal final");
  assert.equal(spanish.lyrics[0].backgroundTranslatedText, "uno dos");
  const french = selectTtmlTranslationTracks(spanish, "French");
  assert.equal(french.lyrics[0].translatedText, undefined);
  assert.equal(french.lyrics[0].backgroundTranslatedText, undefined);
  assert.deepEqual(selectTtmlTranslationTracks(french, "English").lyrics, parsed.lyrics);
});

test("explicit background vocals and translations survive lrc.red and Apple TTML parsing", () => {
  const body = paragraph("A", span(1, 2, "Lead (aside)") +
    `<span ttm:role="x-bg">${span(2, 3, "(sing)")}<span ttm:role="x-translation">Nested choice</span></span>` +
    '<span ttm:role="x-translation">Inline (lead)</span>' +
    '<span ttm:role="x-bg-translation">(Explicit background)</span>');
  const tracks = subtitle("en", entry("A", "Source (another background)"));
  for (const [marker, namespace] of [["", lrcNamespace], ['lrc:byModel="true"', lrcNamespace],
    ["", "http://itunes.apple.com/lyric-ttml-extensions"]]) {
    const parsed = parse(document(body, tracks, marker, namespace));
    const [line] = parsed.lyrics;
    assert.equal(joined(line.syllables), "Lead (aside)");
    assert.equal(joined(line.backgroundSyllables), "sing");
    assert.deepEqual(times(line.backgroundSyllables), [[2000, 3000]]);
    assert.equal(line.translatedText, "Inline (lead)");
    assert.equal(line.backgroundTranslatedText, "Explicit background");
    assert.equal(selectTtmlTranslationTracks(parsed, "Spanish").lyrics[0].backgroundTranslatedText, "Explicit background");
    if (namespace === lrcNamespace) {
      const enriched = [{ ...line, backgroundTranslatedText: "replacement" }];
      enriched.translationMeta = { provider: "Gemini" };
      assert.equal(mergeTtmlTranslationResult(parsed, enriched, "English").lyrics[0].backgroundTranslatedText, "Explicit background");
    }
  }
  const [other] = parse(document(paragraph("A", span(1, 2, "Lead (aside)")), "", 'lrc:byModel="true"', "urn:other")).lyrics;
  assert.equal(joined(other.syllables), "Lead (aside)");
  assert.equal(other.backgroundSyllables, undefined);
});

test("only rows with real explicit vocals skip inference, including background-only rows", () => {
  const content = document(paragraph("A", span(1, 2, "Lead (infer)") +
    '<span ttm:role="x-bg">' + span(2, 3, "( )") + '</span>') +
    paragraph("B", '<span ttm:role="x-bg">' + span(2, 3, "(sing)") +
      '<span ttm:role="x-translation">Explicit nested</span></span>') +
    '<p begin="4" end="6" ttm:role="x-bg" lrc:key="C">' + span(4, 6, "(chorus)") +
      '<span ttm:role="x-translation">Explicit chorus</span></p>');
  const parsed = parse(content);
  const [inferred, explicitSpan, explicitLine] = parsed.lyrics;
  assert.equal(joined(inferred.syllables), "Lead");
  assert.equal(joined(inferred.backgroundSyllables), "infer");
  assert.deepEqual(explicitSpan.syllables, []);
  assert.equal(joined(explicitSpan.backgroundSyllables), "sing");
  assert.equal(explicitSpan.backgroundTranslatedText, "Explicit nested");
  assert.deepEqual(explicitLine.syllables, []);
  assert.equal(joined(explicitLine.backgroundSyllables), "chorus");
  assert.equal(explicitLine.backgroundTranslatedText, "Explicit chorus");
  const enriched = parsed.lyrics.map(line => ({ ...line, backgroundTranslatedText: "replacement" }));
  const merged = mergeTtmlTranslationResult(parsed, enriched, "English");
  assert.equal(merged.lyrics[1].backgroundTranslatedText, "Explicit nested");
  assert.equal(merged.lyrics[2].backgroundTranslatedText, "Explicit chorus");
});

test("generated desktop and mobile TTML round trips a background-only row", () => {
  const [row] = parse(document(paragraph("A",
    span(1, 2, "(Aside)") + '<span ttm:role="x-translation">(Translation)</span>'))).lyrics;
  assert.deepEqual(row.syllables, []);
  assert.equal(row.translatedText, undefined);
  assert.equal(row.backgroundTranslatedText, "Translation");
  for (const source of ["lrc-red-karaoke", "lrc-red-line"]) {
    const input = { lyrics: [row], source, preserveOriginal: false };
    const exported = lyricsToTtml(input);
    assert.equal(mobileLyricsToTtml(input), exported);
    assert.doesNotMatch(exported, /\u200c/u);
    assert.deepEqual(parse(exported).lyrics, [row]);
  }
});

test("background-only subtitles and inline translations use the background lane", () => {
  const inline = '<span ttm:role="x-translation">Inline translation</span>';
  const dedicated = '<span ttm:role="x-bg-translation">Dedicated (literal)</span>';
  const body = paragraph("A", span(1, 2, "(Aside)")) +
    paragraph("B", span(2, 3, "(Echo)") + inline) +
    paragraph("C", span(3, 4, "(Chorus)") + inline + dedicated);
  const english = subtitle("en", ["A", "B", "C"].map(key => entry(key, "Plain subtitle")).join(""));
  const spanish = subtitle("es", entry("A", "Otro subtítulo"));
  const parsed = parse(document(body, english + spanish));
  const translations = packet => packet.lyrics.map(line => {
    assert.deepEqual(line.syllables, []);
    assert.equal(line.translatedText, undefined);
    return line.backgroundTranslatedText;
  });
  assert.deepEqual(translations(parsed), ["Plain subtitle", "Inline translation", "Dedicated (literal)"]);
  assert.deepEqual(translations(selectTtmlTranslationTracks(parsed, "Spanish")),
    ["Otro subtítulo", "Inline translation", "Dedicated (literal)"]);
});

test("explicit background wrappers are removed once while literal parentheses survive generated TTML", () => {
  const bg = '<span ttm:role="x-bg">' + span(2, 3, "(one ") + span(3, 4, "(two))") + '</span>';
  const bt = '<span ttm:role="x-bg-translation">（first (second)）</span>';
  const rows = parse(document(
    paragraph("A", span(1, 2, "Lead") + bg + bt) +
    paragraph("B", span(4, 5, "Lead (one (two))") +
      '<span ttm:role="x-translation">Lead (first (second))</span>') +
    paragraph("C", span(5, 6, "Lead ((two))") +
      '<span ttm:role="x-translation">Lead ((second))</span>'))).lyrics;
  for (const [index, row] of rows.entries()) {
    const input = { lyrics: [row], source: "lrc-red-karaoke", preserveOriginal: false };
    const exported = lyricsToTtml(input);
    assert.equal(mobileLyricsToTtml(input), exported);
    for (const candidate of [row, parse(exported).lyrics[0]]) {
      assert.equal(joined(candidate.backgroundSyllables), index < 2 ? "one (two)" : "(two)");
      assert.deepEqual(times(candidate.backgroundSyllables), times(row.backgroundSyllables));
      assert.equal(candidate.backgroundTranslatedText, index < 2 ? "first (second)" : "(second)");
    }
  }
});

test("qualified TTML background spans respect scoped namespace aliases and block inference", () => {
  const backing = '<t:span ttm:role="x-bg" begin="2" end="3">Back</t:span>';
  const foreign = '<t:span xmlns:t="urn:other" ttm:role="x-bg" begin="4" end="5">Foreign</t:span>';
  const localAlias = '<q:span xmlns:q="http://www.w3.org/ns/ttml" ttm:role="x-bg" begin="4" end="5">Local</q:span>';
  const body = '<div xmlns:t="http://www.w3.org/ns/ttml">' +
    paragraph("A", span(1, 2, "Lead (aside)") + backing) +
    paragraph("B", span(3, 4, "Lead (kept)") + localAlias) +
    paragraph("C", span(5, 6, "Third (moved)") + foreign) + '</div>';
  const content = document(body);
  const parsed = parse(content);
  const [first, second, third] = parsed.lyrics;
  assert.equal(parsed.metadata.ttml.content, content);
  assert.equal(joined(first.syllables), "Lead (aside)");
  assert.equal(joined(first.backgroundSyllables), "Back");
  assert.deepEqual(times(first.backgroundSyllables), [[2000, 3000]]);
  assert.equal(joined(second.syllables), "Lead (kept)");
  assert.equal(joined(second.backgroundSyllables), "Local");
  assert.deepEqual(times(second.backgroundSyllables), [[4000, 5000]]);
  assert.equal(joined(third.backgroundSyllables), "moved");
  assert.deepEqual(times(third.backgroundSyllables), [[5000, 6000]]);
});

test("a foreign default namespace cannot turn a span into an explicit background", () => {
  const foreign = '<span xmlns="urn:other" ttm:role="x-bg" begin="3" end="4">Foreign</span>';
  const body = paragraph("A", span(1, 2, "Lead") + " " + span(2, 3, "(aside)") + foreign) +
    paragraph("B", span(4, 5, "Lead (kept)") + '<span ttm:role="x-bg" begin="5" end="6">Back</span>');
  const [first, second] = parse(document(body)).lyrics;
  assert.equal(joined(first.backgroundSyllables), "aside");
  assert.deepEqual(times(first.backgroundSyllables), [[2000, 3000]]);
  assert.equal(joined(second.syllables), "Lead (kept)");
  assert.equal(joined(second.backgroundSyllables), "Back");
  assert.deepEqual(times(second.backgroundSyllables), [[5000, 6000]]);
});

test("an explicit wrapper outside timed spans leaves a fully parenthesized inner vocal intact", () => {
  const backing = '<span ttm:role="x-bg">（' + span(2, 3, "(e") + span(3, 4, "cho)") + '）</span>';
  const [row] = parse(document(paragraph("A", span(1, 2, "Lead") + backing))).lyrics;
  assert.equal(joined(row.backgroundSyllables), "(echo)");
  assert.deepEqual(times(row.backgroundSyllables), [[2000, 3000], [3000, 4000]]);
});

test("encoded whitespace does not make unmatched background delimiters into wrappers", () => {
  const vocals = (start, end, text) => '<span ttm:role="x-bg">' + span(start, end, text) + '</span>';
  const body = paragraph("A", span(1, 2, "Lead") + vocals(2, 3, "&#32;(echo")) +
    paragraph("B", span(1, 2, "Lead") + vocals(2, 3, "echo)&#x20;")) +
    paragraph("C", span(1, 2, "Lead") + vocals(2, 3, "&#32;(echo)&#32;"));
  const rows = parse(document(body)).lyrics;
  assert.deepEqual(rows.map(row => joined(row.backgroundSyllables)), ["(echo", "echo)", "echo"]);
  for (const row of rows) assert.deepEqual(times(row.backgroundSyllables), [[2000, 3000]]);
});

test("whitespace-only spans separate words without introducing timed atoms", () => {
  const body = paragraph("A", span(1, 2, "Lead") + span(2, 2.5, " ") +
    span(2.5, 3, "line") + span(3, 4, "(echo)")) +
    paragraph("B", span(1, 2, "Plain") + span(2, 2.5, "&#32;") + span(2.5, 3, "line"));
  const [inferred, plain] = parse(document(body)).lyrics;
  assert.equal(joined(inferred.syllables), "Lead line");
  assert.deepEqual(times(inferred.syllables), [[1000, 2000], [2500, 3000]]);
  assert.equal(joined(inferred.backgroundSyllables), "echo");
  assert.deepEqual(times(inferred.backgroundSyllables), [[3000, 4000]]);
  assert.equal(joined(plain.syllables), "Plain line");
  assert.deepEqual(times(plain.syllables), [[1000, 2000], [2500, 3000]]);
});

test("default TTML generation preserves canonical full pairs and accepts legacy wrapped rows", () => {
  const inline = '<span ttm:role="x-translation">Lead ((second))</span>';
  const [canonical] = parse(document(paragraph("A", span(1, 2, "Lead") + " " + span(2, 3, "((two))") + inline))).lyrics;
  const legacy = {
    lineStartTime: 1000, lineEndTime: 6000,
    syllables: [{ text: "Lead", startTime: 1000, endTime: 2000 }],
    backgroundSyllables: [{ text: "(two)", startTime: 2000, endTime: 3000 }],
    backgroundTranslatedText: "(second)",
  };
  for (const options of [{}, { preserveOriginal: true }, { preserveOriginal: false }]) {
    for (const [row, text, translation] of [[canonical, "(two)", "(second)"], [legacy, "two", "second"]]) {
      const input = { lyrics: [JSON.parse(JSON.stringify(row))], ...options };
      const exported = lyricsToTtml(input);
      assert.equal(mobileLyricsToTtml(input), exported);
      const [reimported] = parse(exported).lyrics;
      assert.equal(joined(reimported.backgroundSyllables), text);
      assert.equal(reimported.backgroundTranslatedText, translation);
      assert.deepEqual(times(reimported.syllables), [[1000, 2000]]);
      assert.deepEqual(times(reimported.backgroundSyllables), [[2000, 3000]]);
    }
  }
});

test("language reselection updates literal translation provenance through desktop vault compaction", () => {
  const body = paragraph("A", span(1, 2, "Lead (echo)"));
  const tracks = subtitle("en", entry("A", "Lead (echo)")) + subtitle("es", entry("A", "Principal ((eco))"));
  const english = parse(document(body, tracks));
  assert.equal(english.lyrics[0].literalBackgroundParentheses, undefined);
  const spanish = selectTtmlTranslationTracks(english, "Spanish");
  assert.equal(spanish.lyrics[0].backgroundTranslatedText, "(eco)");
  assert.equal(spanish.lyrics[0].literalBackgroundParentheses, true);
  const storage = JSON.parse(JSON.stringify(compactLyricsForStorage(spanish.lyrics)));
  const restored = expandLyricsFromStorage(storage);
  assert.equal(restored[0].literalBackgroundParentheses, true);
  const xml = lyricsToTtml({ lyrics: restored });
  assert.equal(mobileLyricsToTtml({ lyrics: restored }), xml);
  assert.equal(parse(xml).lyrics[0].backgroundTranslatedText, "(eco)");
  const switchedBack = selectTtmlTranslationTracks({ ...spanish, lyrics: restored }, "English");
  assert.equal(switchedBack.lyrics[0].backgroundTranslatedText, "echo");
  assert.equal(switchedBack.lyrics[0].literalBackgroundParentheses, undefined);
  assert.equal(spanish.lyrics[0].literalBackgroundParentheses, true);
});

test("generated TTML preserves source joins across gaps and explicit word separators", () => {
  const content = document(paragraph("A", span(1, 1.2, "Le") + span(1.5, 1.7, "ad") + " " +
    span(1.8, 2, "line") + " " + span(2, 3, "(a") + span(4, 5, "side)")));
  const [row] = parse(content).lyrics;
  const input = { lyrics: [row], source: "lrc-red-karaoke" };
  const xml = lyricsToTtml(input);
  assert.equal(mobileLyricsToTtml(input), xml);
  const [reimported] = parse(xml).lyrics;
  assert.equal(joined(reimported.syllables), "Lead line");
  assert.equal(joined(reimported.backgroundSyllables), "aside");
  assert.deepEqual(reimported.syllables, row.syllables);
  assert.deepEqual(reimported.backgroundSyllables, row.backgroundSyllables);
});

test("numeric XML parentheses resolve across timed atoms before vocal and subtitle inference", () => {
  const body = paragraph("A", span(1, 2, "Lead") + " &#40;" + span(2, 3, "a") +
    span(3, 4, "side&#x29;") + " " + span(4, 5, "&#xFF08;echo") + "&#65289;" +
    " " + span(5, 6, "&#40;unfinished"));
  const tracks = subtitle("en", entry("A", "Lead &#40;first&#41; &#xFF08;second&#xFF09;"));
  const [line] = parse(document(body, tracks)).lyrics;
  assert.equal(joined(line.syllables), "Lead (unfinished");
  assert.equal(joined(line.backgroundSyllables), "aside echo");
  assert.deepEqual(times(line.syllables), [[1000, 2000], [5000, 6000]]);
  assert.deepEqual(times(line.backgroundSyllables), [[2000, 3000], [3000, 4000], [4000, 5000]]);
  assert.equal(line.translatedText, "Lead");
  assert.equal(line.backgroundTranslatedText, "first second");
});

test("GIF serialization uses the selected background-only row's text, translation and timing", () => {
  const file = path.resolve(__dirname, "../../ExpoLyrics/app/(tabs)/index.tsx");
  const source = fs.readFileSync(file, "utf8");
  const helpers = source.slice(source.indexOf("function isCensorshipBoundary("), source.indexOf("function base64ToUint8Array("))
    .replace(/: (?:LyricLine\["syllables"\]|LyricLine|boolean|string)/g, "");
  assert.match(source, /lines: linesToShare\s*\.map\(\(line\) => serializeGifLyricLine\(line, showTranslatedText\)\)/);
  const serialize = vm.runInNewContext(`${helpers}\nserializeGifLyricLine`);
  const [row] = parse(document(paragraph("A", span(2, 3, "(A") + span(3, 4, "side)")))).lyrics;
  const selection = { ...row, backgroundTranslatedText: "Backing translation" };
  const result = serialize(selection, true);
  assert.equal(result.text, "Aside");
  assert.equal(result.translatedText, "Backing translation");
  assert.equal(result.lineStartTime, 2000);
  assert.equal(result.lineEndTime, 4000);
  assert.deepEqual(Array.from(result.syllables, atom => [atom.text, atom.startTime, atom.endTime]),
    [["A", 2000, 3000], ["side", 3000, 4000]]);
  assert.equal(serialize(selection, false).translatedText, undefined);
  assert.equal(serialize({ ...row, backgroundSyllables: [] }, true), null);
});

test("unmatched literal parentheses and lines without a matching background remain lead text", () => {
  const body = paragraph("A", span(1, 2, "Keep") + " (" + span(2, 3, "the aside")) +
    paragraph("B", span(3, 4, "前") + "（" + span(4, 5, "声") + "） " + span(5, 6, "。"));
  const tracks = subtitle("en", entry("A", "Keep (the aside)") + entry("B", "前 （声） 。 （余分）"));
  const [first, second] = parse(document(body, tracks)).lyrics;
  assert.equal(joined(first.syllables), "Keep (the aside");
  assert.equal(first.translatedText, "Keep (the aside)");
  assert.equal(first.backgroundSyllables, undefined);
  assert.equal(first.backgroundTranslatedText, undefined);
  assert.equal(joined(second.syllables), "前。");
  assert.equal(joined(second.backgroundSyllables), "声");
  assert.deepEqual(times(second.backgroundSyllables), [[4000, 5000]]);
  assert.equal(second.translatedText, "前。 （余分）");
  assert.equal(second.backgroundTranslatedText, "声");
});

test("scoped metadata aliases, explicit background and mixed-quote timings preserve literal lead text", () => {
  const body = `<div xmlns:m='http://www.w3.org/ns/ttml#metadata'>
    <p begin='1' end="6" lrc:key="A"><span begin='1' end="1.5">Lead (aside)</span> (<span begin="1.5" end='2'>unfinished</span><span m:role='x-bg'><span begin='2' end='2.5'>back</span><span m:role="x-translation">Explicit backing</span></span></p>
    <p begin="3" end='6' lrc:key="B"><span begin='3' end='3.5'>Lead</span> <span begin='3.5' end='4'>(aside)</span><span xmlns:m="urn:other" m:role="x-bg" begin='4' end='4.5'>again</span></p>
  </div>`;
  const [first, second] = parse(document(body)).lyrics;
  assert.equal(first.lineStartTime, 1000);
  assert.equal(joined(first.syllables), "Lead (aside) (unfinished");
  assert.deepEqual(times(first.syllables), [[1000, 1500], [1500, 2000]]);
  assert.equal(joined(first.backgroundSyllables), "back");
  assert.deepEqual(times(first.backgroundSyllables), [[2000, 2500]]);
  assert.equal(first.backgroundTranslatedText, "Explicit backing");
  assert.equal(joined(second.syllables), "Lead again");
  assert.deepEqual(times(second.syllables), [[3000, 3500], [4000, 4500]]);
  assert.equal(joined(second.backgroundSyllables), "aside");
  assert.deepEqual(times(second.backgroundSyllables), [[3500, 4000]]);
});

test("line-level lyrics reuse the same intervals as the original line segmentation", () => {
  const content = document(paragraph("A", "Line lead (background phrase) tail"))
    .replace('lrc:timing="Word"', 'lrc:timing="Line"');
  const [before] = parse(content.replaceAll(lrcNamespace, "urn:other")).lyrics;
  const [after] = parse(content).lyrics;
  assert.equal(joined(after.syllables), "Line lead tail");
  assert.equal(joined(after.backgroundSyllables), "background phrase");
  assert.deepEqual(times(after.syllables), [times(before.syllables)[0], times(before.syllables)[1], times(before.syllables)[4]]);
  assert.deepEqual(times(after.backgroundSyllables), times(before.syllables).slice(2, 4));
});

function loadProvider(platform, content) {
  const file = path.resolve(__dirname, platform === "desktop"
    ? "../src/lyrics/parts/04-lrc-red-source.js" : "../../ExpoLyrics/lib/mobile-lyrics-service.js");
  let source = fs.readFileSync(file, "utf8");
  if (platform === "mobile") {
    const start = source.indexOf("// ---- DesktopBridge/src/lyrics/parts/04-lrc-red-source.js ----");
    source = source.slice(start, source.indexOf("// ---- DesktopBridge/src/lyrics/parts/", start + 1));
  }
  const track = { title: "Example Song", artist: "Example Artist", durationMs: 6000, isrc: "GBUM71029604" };
  return vm.runInNewContext(`${source}\nfetchFromLrcRed(track)`, {
    track,
    require: createRequire(platform === "desktop" ? path.resolve(__dirname, "../src/lyricsService.js") : file),
    lyricsTextMatchFields: ["title", "artist", "durationMs"],
    resolveLyricsTrackMetadata: async value => value,
    normalizeLyricsTrackIsrc: value => value,
    normalizeText: value => value.toLowerCase(),
    normalizeArtistText: value => value.toLowerCase(),
    fetchJson: async () => ({ title: track.title, artist: track.artist, duration: 6, isrc: track.isrc }),
    fetchText: async () => content,
    parseLrcRedTtml: mobile.parseTtmlToLyrics,
    parseLrcRedTime: mobile.parseTtmlTimeExpression,
    extractLrcRedTtmlMetadata: mobile.extractTtmlMetadata,
  });
}

test("provider fetch resolves parentheses in TTML that omits lrc.red's namespace", async () => {
  const content = '<tt><body><p begin="1" end="5">' +
    span(1, 2, "Lead") + " " + span(2, 3, "(a") + span(4, 5, "side)") + '</p></body></tt>';
  for (const platform of ["desktop", "mobile"]) {
    const result = await loadProvider(platform, content);
    assert.equal(result.source, "lrc-red-karaoke");
    assert.equal(result.metadata.ttml.content, content);
    assert.equal(joined(result.lyrics[0].syllables), "Lead");
    assert.equal(joined(result.lyrics[0].backgroundSyllables), "aside");
    assert.deepEqual(times(result.lyrics[0].backgroundSyllables), [[2000, 3000], [4000, 5000]]);
  }
});

function loadFinalizer(platform) {
  const file = path.resolve(__dirname, platform === "desktop"
    ? "../src/lyrics/parts/07a-source-scoring.js" : "../../ExpoLyrics/lib/mobile-lyrics-service.js");
  const source = fs.readFileSync(file, "utf8");
  return vm.runInNewContext(`(() => {
    ${source.slice(source.indexOf("function mergeBackgroundSyllablesIntoLine("), source.indexOf("function getLyricsTimingTier("))}
    ${source.slice(source.indexOf("function isSpicyKaraokeSource("), source.indexOf("function isSpicyLyricsSource("))}
    return finalizeFetchedLyricsResult;
  })()`, { require: createRequire(file) });
}

test("desktop and mobile provider finalization preserve lrc.red atoms and other provider behavior", async () => {
  const content = document(paragraph("A", span(1, 2, "Lead") + " " +
    span(2, 3, "(＊") + span(3, 4, "＊") + span(4, 5, "＊)")));
  for (const platform of ["desktop", "mobile"]) {
    const finalize = loadFinalizer(platform);
    const parsed = parse(content);
    const result = await finalize({ ...parsed, source: "lrc-red-karaoke" });
    assert.deepEqual(times(result.lyrics[0].backgroundSyllables), [[2000, 3000], [3000, 4000], [4000, 5000]]);
    const legacy = await finalize({ source: "netease-yrc", lyrics: [
      { syllables: [{ text: "Lead ", startTime: 1, endTime: 2 }, { text: "(aside)", startTime: 2, endTime: 3 }] },
    ] });
    assert.equal(joined(legacy.lyrics[0].syllables), "Lead");
    assert.equal(joined(legacy.lyrics[0].backgroundSyllables), "aside");
    const other = { source: "lrclib-word", lyrics: [{ syllables: [{ text: "Lead (aside)", startTime: 1, endTime: 2 }] }] };
    assert.equal(await finalize(other), other);
    assert.equal(joined(other.lyrics[0].syllables), "Lead (aside)");
  }
});
