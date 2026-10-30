"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { selectTtmlTranslationTracks, mergeTtmlTranslationResult } = require("../src/lyricsTtmlTranslations");
const importers = [require("../src/lyricsTtmlImport"), require("../../ExpoLyrics/lib/lyrics-ttml-import")];
const baseline = require("./fixtures/lrc-red/baseline.json");
const ns = 'xmlns="http://www.w3.org/ns/ttml" xmlns:lrc="http://lrc.red/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"';
const paragraph = (key, content = "lead") => `<p begin="1" end="3" lrc:key="${key}">${content}</p>`;
const track = (language, text, attributes = "") => `<translation xml:lang="${language}" type="subtitle" ${attributes}>${text}</translation>`;
const entry = (key, text) => `<text for="${key}">${text}</text>`;
function document(tracks, paragraphs = paragraph("A") + paragraph("B", "other")) {
  return `<tt ${ns} lrc:timing="Word"><head><metadata><sourceMetadata xmlns="http://lrc.red/lyric-ttml-internal"><translations>${tracks}</translations></sourceMetadata></metadata></head><body>${paragraphs}</body></tt>`;
}
function parse(content, options) {
  const results = importers.map(importer => importer.parseTtmlToLyrics(content, options));
  assert.deepEqual(results[0], results[1], "Complete desktop/mobile parser parity");
  return results[0];
}
const texts = packet => packet.lyrics.map(line => line.translatedText);

test("real lrc.red fixtures: exact translations and unchanged complete lyric atoms", () => {
  const counts = { US5TA1500050: 54, ZZA0P2622376: 42, KRMIM2652961: 12, USUM72601821: 0, GBUM71805979: 0 };
  for (const [id, expected] of Object.entries(baseline)) {
    const content = fs.readFileSync(path.join(__dirname, `fixtures/lrc-red/${id}.ttml`), "utf8");
    const parsed = parse(content);
    assert.equal(parsed.lyrics.length, expected.lines);
    assert.equal(parsed.lyrics.filter(line => line.translatedText).length, counts[id]);
    assert.equal(parsed.lyrics.reduce((sum, line) => sum + line.syllables.length, 0), expected.lead);
    assert.equal(parsed.lyrics.reduce((sum, line) => sum + (line.backgroundSyllables?.length || 0), 0), expected.background);
    assert.equal(parsed.lyrics.filter(line => line.oppositeAligned).length, expected.opposite);
    assert.equal(parsed.durationMs, expected.durationMs);
    assert.equal(parsed.useKaraokeTiming, expected.useKaraokeTiming);
    const originalAtoms = parsed.lyrics.map(({ translatedText, ttmlKey, ...line }) => line);
    assert.equal(createHash("sha256").update(JSON.stringify(originalAtoms)).digest("hex"), expected.lyricsSha256,
      "Every lead/background atom, spacing flag, line time and alignment equals the pre-change parser output");
    assert.equal(parsed.metadata.ttml.content, content);
    for (const exporter of [require("../src/lyricsTtmlExport"), require("../../ExpoLyrics/lib/lyrics-ttml-export")]) {
      assert.equal(exporter.lyricsToTtml({ lyrics: parsed.lyrics, metadata: parsed.metadata }), content);
    }
    if (counts[id]) {
      assert.equal(parsed.metadata.ttml.translationTracks.length, 1, "Transliterations never become translation tracks");
      const source = parsed.metadata.ttml.translationTracks[0];
      assert.equal(source.language, "en-US");
      assert.equal(source.type, "subtitle");
      assert.equal(source.automaticallyCreated, id === "US5TA1500050" ? undefined : true);
      for (const line of parsed.lyrics) assert.equal(line.translatedText, source.lines.find(text => text.key === line.ttmlKey).text);
    }
  }
});

test("key join ignores order, missing keys, orphans and conflicting duplicates", () => {
  const content = document(track("en-US", entry("B", "second") + entry("absent", "orphan") + entry("A", "first")));
  assert.deepEqual(texts(parse(content)), ["first", "second"]);
  assert.deepEqual(texts(parse(document(track("en", entry("B", "only B"))))), [undefined, "only B"]);
  assert.deepEqual(texts(parse(document(track("en", entry("A", "same") + entry("A", "same"))))), ["same", undefined]);
  const duplicate = document(track("en", entry("A", "one") + entry("A", "two") + entry("A", "one")));
  assert.deepEqual(texts(parse(duplicate)), [undefined, undefined]);
  const duplicateParagraph = document(track("en", entry("A", "ambiguous")), paragraph("A") + paragraph("A"));
  assert.deepEqual(texts(parse(duplicateParagraph)), [undefined, undefined]);
  assert.deepEqual(texts(parse(document(track("en", entry("A", "keyed")), '<p begin="1" end="3">no key</p>'))), [undefined]);
});

test("target language, exact tag, manual provenance and alternate-track preservation", () => {
  const tracks = track("es", entry("A", "español")) + track("en-US", entry("A", "automatic"), 'automaticallyCreated="true"') +
    track("en-GB", entry("A", "manual"), 'automaticallyCreated="false"');
  const content = document(tracks);
  const english = parse(content);
  assert.equal(english.lyrics[0].translatedText, "manual");
  assert.equal(english.metadata.ttml.translationTracks.length, 3);
  assert.equal(parse(content, { translationLanguage: "en-US" }).lyrics[0].translatedText, "automatic");
  assert.equal(parse(content, { translationLanguage: "Spanish" }).lyrics[0].translatedText, "español");
  assert.equal(parse(content, { translationLanguage: "French" }).lyrics[0].translatedText, undefined,
    "No foreign-language fallback blocks the existing target-language AI path");
  assert.equal(selectTtmlTranslationTracks(english, "Spanish").lyrics[0].translatedText, "español");
  assert.equal(selectTtmlTranslationTracks(english, "French").lyrics[0].translatedText, undefined);
  assert.equal(english.lyrics[0].translatedText, "manual", "Cache reselection does not mutate the original packet");
  const chinese = document(track("zh-TW", entry("A", "繁體")) + track("zh-CN", entry("A", "简体")));
  assert.equal(parse(chinese, { translationLanguage: "Chinese (Simplified)" }).lyrics[0].translatedText, "简体");
  assert.equal(parse(chinese, { translationLanguage: "Chinese (Traditional)" }).lyrics[0].translatedText, "繁體");
});

test("inline lead/background choices are preserved while source subtitles win over AI", () => {
  const body = paragraph("A", 'lead<span ttm:role="x-translation">inline</span><span ttm:role="x-bg">(back)</span><span ttm:role="x-bg-translation">(background inline)</span>');
  const result = parse(document(track("en", entry("A", "metadata")) + track("es", entry("A", "español")), body));
  assert.equal(result.lyrics[0].translatedText, "inline");
  assert.equal(result.lyrics[0].backgroundTranslatedText, "background inline");
  assert.equal(selectTtmlTranslationTracks(result, "Spanish").lyrics[0].translatedText, "inline");
  const base = parse(document(track("en", entry("A", "metadata"))));
  const better = { ...base, lyrics: [{ ...base.lyrics[0], translatedText: "better existing source" }] };
  assert.equal(selectTtmlTranslationTracks(better).lyrics[0].translatedText, "better existing source");
  const ai = { ...base, metadata: { ...base.metadata, translation: { provider: "Gemini", translatedLineCount: 1 } } };
  assert.equal(selectTtmlTranslationTracks(ai, "Spanish").lyrics[0].translatedText, undefined);
  const enriched = { ...ai, lyrics: base.lyrics.map(line => ({ ...line, translatedText: "AI fallback" })) };
  assert.deepEqual(texts(selectTtmlTranslationTracks(enriched)), ["metadata", "AI fallback"]);
  assert.deepEqual(selectTtmlTranslationTracks(enriched).metadata.ttml.translationTracks, base.metadata.ttml.translationTracks);
});

test("namespace URI and scoped aliases, entities, nested text and CDATA", () => {
  const content = `<tt ${ns} lrc:timing="Word"><head><metadata>
    <r:sourceMetadata xmlns:r="http://lrc.red/lyric-ttml-internal"><r:translations>
      <r:translation xml:lang='en-US' type='subtitle'><r:text for='A&amp;1'>Fish &amp; chips &lt;3 &#x1F600; &#33; <span>nested</span><![CDATA[ &amp; literal]]></r:text></r:translation>
    </r:translations></r:sourceMetadata></metadata></head><body>
    <p xmlns:k="http://lrc.red/lyric-ttml-internal" k:key='A&amp;1' begin="1" end="3">lead</p>
    </body></tt>`;
  const result = parse(content);
  assert.equal(result.lyrics[0].ttmlKey, "A&1");
  assert.equal(result.lyrics[0].translatedText, "Fish & chips <3 😀 ! nested &amp; literal");
  assert.equal(parse(content.replaceAll('xmlns:r="http://lrc.red/lyric-ttml-internal"', 'xmlns:r="urn:wrong"')).lyrics[0].translatedText, undefined);
  assert.equal(parse(content.replace('xmlns:k="http://lrc.red/lyric-ttml-internal"', 'xmlns:k="urn:wrong"')).lyrics[0].translatedText, undefined);
  assert.equal(parse(content.replace("for='A&amp;1'", "unbound:for='A&amp;1'")).lyrics[0].translatedText, undefined);
  assert.equal(parse(content.replace("for='A&amp;1'", "xmlns:for='A&amp;1'")).lyrics[0].translatedText, undefined);
  const inherited = document(track('', entry('A', 'inherited')).replace('xml:lang=""', '')).replace('<translations>', '<translations xml:lang="en-US">');
  assert.equal(parse(inherited).lyrics[0].translatedText, 'inherited');
});

test("empty/malformed optional metadata and nonmetadata TTML remain usable", () => {
  for (const tracks of ["", "<translation/>", track("en", ""), track("en", entry("A", "  ")),
    track("en", '<text>no key</text>'), '<translation xml:lang="en"><text for="A">broken</translation>',
    '<translation xml:lang="en" type="other"><text for="A">not subtitle</text></translation>']) {
    const content = document(tracks);
    const result = parse(content);
    assert.deepEqual(texts(result), [undefined, undefined]);
    assert.equal(result.lyrics[0].syllables[0].text, "lead");
    assert.equal(result.lyrics[0].lineStartTime, 1000);
  }
  const outside = document("").replace('</head>', `</head><sourceMetadata xmlns="http://lrc.red/lyric-ttml-internal"><translations>${track("en", entry("A", "outside"))}</translations></sourceMetadata>`);
  assert.equal(parse(outside).lyrics[0].translatedText, undefined);
  const dtd = '<!DOCTYPE tt [<!ENTITY remote SYSTEM "https://example.invalid/entity">]>' + document(track("en", entry("A", "&remote;")));
  assert.equal(parse(dtd).lyrics[0].translatedText, undefined, "DTD entities are never resolved");
  const inline = `<tt ${ns}><body>${paragraph("A", 'lead<span ttm:role="x-translation">inline</span>')}</body></tt>`;
  assert.equal(parse(inline).lyrics[0].translatedText, "inline");
  assert.equal(parse(inline).metadata.ttml.translationTracks, undefined);
});

test("AI merge preserves inline lead/background choices and leaves nonmetadata packets alone", () => {
  const body = paragraph("A", 'lead<span ttm:role="x-translation">inline lead</span><span ttm:role="x-bg">(back)</span><span ttm:role="x-bg-translation">(inline background)</span>');
  const base = parse(document(track("en", entry("A", "metadata"), 'automaticallyCreated="true"'), body));
  const enriched = base.lyrics.map(line => ({ ...line, translatedText: "AI lead", backgroundTranslatedText: "AI background" }));
  enriched.translationMeta = { provider: "Gemini", translatedLineCount: 1 };
  const merged = mergeTtmlTranslationResult(base, enriched, "English");
  assert.equal(merged.lyrics[0].translatedText, "inline lead");
  assert.equal(merged.lyrics[0].backgroundTranslatedText, "inline background");
  assert.equal(merged.metadata.ttml.translationTracks[0].automaticallyCreated, true);
  assert.deepEqual(merged.metadata.ttml.appliedTranslations, []);
  const plain = { lyrics: [{ text: "original" }], source: "manual-selected-other-source", metadata: { attribution: { source: "other" } } };
  const result = mergeTtmlTranslationResult(plain, enriched, "English");
  assert.equal(result.lyrics, enriched);
  assert.equal(result.source, plain.source);
  assert.deepEqual(result.metadata.attribution, plain.metadata.attribution);
});
