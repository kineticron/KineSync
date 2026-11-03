"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const importers = [
  ["desktop", require("../src/lyricsTtmlImport")],
  ["mobile", require("../../ExpoLyrics/lib/lyrics-ttml-import")],
];

function document(timing, paragraph) {
  return `<tt xmlns:lrc="http://lrc.red/lyric-ttml-internal" xmlns:itunes="http://itunes.apple.com/lyric-ttml-extensions" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ${timing}><body><div>${paragraph}</div></body></tt>`;
}

// Rewind's first line, extended with timed background vocals after the lead.
const lineParagraph = `<p begin="20.370" end="23.317" lrc:key="L1" ttm:agent="v1">미처 몰랐던 네 모습<span ttm:role="x-bg"><span begin="23.400" end="23.600">(Re</span><span begin="23.900" end="24.300">wind)</span></span></p>`;
const wordFallback = [
  { text: "미처 몰랐던 네 모습", startTime: 20370, endTime: 23317 },
];
const lineSyllables = ["미처 ", "몰랐던 ", "네 ", "모습"].map((text, i) => ({
  text,
  startTime: 20370 + (23317 - 20370) * i / 4,
  endTime: 20370 + (23317 - 20370) * (i + 1) / 4,
  isPartOfWord: false,
}))
const lineBackground = [
  { text: "Re", startTime: 23400, endTime: 23600, isPartOfWord: true },
  { text: "wind", startTime: 23900, endTime: 24300, isPartOfWord: false },
];

// ew's split "e-w" retains literal whitespace boundaries and clock timings.
const wordParagraph = `<p begin="1:06.819" end="1:13.151" lrc:key="L9" ttm:agent="v1"><span begin="1:06.819" end="1:07.159">Babe</span> <span begin="1:07.159" end="1:07.339">you</span> <span begin="1:07.339" end="1:07.599">got</span> <span begin="1:07.599" end="1:07.859">me</span> <span begin="1:07.859" end="1:08.319">shaking</span> <span begin="1:08.335" end="1:08.599">e</span><span begin="1:08.599" end="1:13.151">-w</span><span ttm:role="x-bg"><span begin="1:08.335" end="1:08.599">(e</span><span begin="1:08.950" end="1:13.151">-w)</span></span></p>`;

for (const [platform, importer] of importers) {
  for (const namespace of ["lrc", "itunes"]) {
    for (const quote of ['"', "'"]) {
      test(`${platform}: ${namespace}:timing=${quote}Line${quote} overrides timed spans and preserves background joins`, () => {
        const declaration = `${namespace}:timing = ${quote}Line${quote}`;
        for (const paragraph of [
          lineParagraph,
          lineParagraph.replace(
            "미처 몰랐던 네 모습",
            '<span begin="20.370" end="21.000">미처 몰랐던</span> <span begin="21.500" end="23.317">네 모습</span>',
          ),
        ]) {
          const content = document(declaration, paragraph);
          const parsed = importer.parseTtmlToLyrics(content);
          assert.equal(parsed.useKaraokeTiming, false);
          assert.equal(parsed.lyrics.length, 1);
          const line = parsed.lyrics[0];
          assert.deepEqual(line.syllables, lineSyllables);
          assert.deepEqual(line.backgroundSyllables, lineBackground);
          assert.equal(importer.joinImportedSyllableText(line.backgroundSyllables), "Rewind");
          assert.equal(line.lineStartTime, 20370);
          assert.equal(line.lineEndTime, 23317);
          assert.equal(parsed.durationMs, 24300);
          assert.equal(parsed.metadata.ttml.content, content);
        }
      });

      test(`${platform}: ${namespace}:timing=${quote}Word${quote} preserves syllable timings and joins`, () => {
        const declaration = `${namespace}:timing = ${quote}Word${quote}`;
        const parsed = importer.parseTtmlToLyrics(document(declaration, wordParagraph));
        assert.equal(parsed.useKaraokeTiming, true);
        const line = parsed.lyrics[0];
        assert.equal(line.syllables.map(part => part.text).join(""), "Babe you got me shaking e-w");
        assert.equal(importer.joinImportedSyllableText(line.syllables), "Babe you got me shaking e-w");
        assert.deepEqual(line.syllables.map(part => [part.startTime, part.endTime]), [
          [66819, 67159], [67159, 67339], [67339, 67599], [67599, 67859],
          [67859, 68319], [68335, 68599], [68599, 73151],
        ]);
        assert.equal(line.syllables[4].isPartOfWord, false);
        assert.equal(line.syllables[5].isPartOfWord, true);
        assert.deepEqual(line.backgroundSyllables, [
          { text: "e", startTime: 68335, endTime: 68599, isPartOfWord: true },
          { text: "-w", startTime: 68950, endTime: 73151, isPartOfWord: false },
        ]);
        assert.equal(importer.joinImportedSyllableText(line.backgroundSyllables), "e-w");

        const withoutSpans = importer.parseTtmlToLyrics(document(
          declaration,
          '<p begin="20.370" end="23.317">미처 몰랐던 네 모습</p>',
        ));
        assert.equal(withoutSpans.useKaraokeTiming, true);
        assert.deepEqual(withoutSpans.lyrics[0].syllables, wordFallback);
      });
    }
  }

  test(`${platform}: undeclared timing still follows timed-span detection`, () => {
    const withSpans = importer.parseTtmlToLyrics(document("", wordParagraph));
    assert.equal(withSpans.useKaraokeTiming, true);
    assert.equal(withSpans.lyrics[0].syllables.length, 7);

    const withoutSpans = importer.parseTtmlToLyrics(document(
      "",
      '<p begin="20.370" end="23.317">미처 몰랐던 네 모습</p>',
    ));
    assert.equal(withoutSpans.useKaraokeTiming, false);
    assert.deepEqual(withoutSpans.lyrics[0].syllables, lineSyllables);
  });
}
