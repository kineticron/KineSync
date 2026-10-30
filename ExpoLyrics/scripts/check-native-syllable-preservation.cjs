/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/native-syllable-seesaw.json'), 'utf8'));
const output = buildSync({ entryPoints: [path.join(root, 'components/lyrics/native/native-lyrics-model.ts')], bundle: true,
  platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const moduleObject = { exports: {} };
vm.runInNewContext(output, { module: moduleObject, exports: moduleObject.exports, require });
const { buildNativeRows, buildNativeVoice } = moduleObject.exports;
const skiaVoiceSource = fs.readFileSync(path.join(root, 'components/lyrics/native/native-skia-voice.tsx'), 'utf8');
const glyphPictureSource = fs.readFileSync(path.join(root, 'components/lyrics/native/native-glyph-picture.tsx'), 'utf8');
assert.match(skiaVoiceSource, /staticLyrics \? voice\.words\.map\(w => w\.text\)\.join\(''\) : voice\.paintText/,
  'native Skia lays out AMLL paint text as one continuous paragraph');
assert.match(skiaVoiceSource, /paragraph\.getRectsForRange\(word\.offset,/,
  'native Skia maps timed segments to glyph ranges in that shared paragraph');
assert.match(skiaVoiceSource, /shapeGlyphWords\(paragraph, words, spicy\)/,
  'native glyph picture shaping receives the shared Skia paragraph and timed word ranges');
assert.match(glyphPictureSource, /paragraph\.extendedVisit\([\s\S]*?selectGlyphSlice\(selectionRun, rects\)/,
  'glyph picture slices glyphs from the shared paragraph runs instead of reshaping each timed segment');

const timing = values => Array.from(values, value => [value.start, value.end]);
const lyricText = values => Array.from(values, value => value.text).join('');

for (const provider of ['lrcRed', 'spicyLyrics']) {
  const line = fixture.liveParsedLines[provider];
  const voice = buildNativeVoice(line.syllables, line.lineStartTime, line.lineEndTime, 'amll');
  assert.equal(voice.paintText, '뒤죽박죽', `${provider}: native paint text remains continuous`);
  assert.deepEqual(timing(voice.paintWords), line.syllables.map(part => [part.startTime, part.endTime]),
    `${provider}: each captured Korean syllable keeps its exact native animation interval`);
  assert.equal(lyricText(voice.words), '뒤죽박죽', `${provider}: RN shaping text remains one contiguous run`);
  assert.deepEqual(Array.from(voice.words[0].starts), line.syllables.map(part => part.startTime),
    `${provider}: shaping item stores each source start rather than averaging the word`);
  assert.deepEqual(Array.from(voice.words[0].ends), line.syllables.map(part => part.endTime),
    `${provider}: shaping item stores each source end rather than averaging the word`);
}

const english = fixture.syntheticCases.englishMultiSyllable;
const englishVoice = buildNativeVoice(english, 1000, 1800, 'amll');
assert.equal(englishVoice.paintText, 'Hello world');
assert.deepEqual(timing(englishVoice.paintWords), [[1000, 1200], [1200, 1300], [1300, 1800]],
  'multi-syllable words keep each interval while spacing only at the group boundary');
assert.equal(lyricText(englishVoice.words), 'Hello world', 'joined English keeps one shaping run per word');
assert.deepEqual(Array.from(englishVoice.paintWords, word => word.group), [0, 0, 1],
  'timed paint segments remain assigned to the native shaping chunk they occupy');
assert.deepEqual(Array.from(englishVoice.paintWords, word => word.emphasis?.index), [0, 3, 0],
  'per-chunk emphasis indexes advance by grapheme count and reset at the next shaping chunk');
assert.deepEqual(Array.from(englishVoice.paintWords, word => word.emphasis?.count), [5, 5, 5],
  'joined timed segments share the shaping chunk grapheme count');
assert.equal(englishVoice.words[0].starts[0], 1000);
assert.equal(englishVoice.words[0].ends[0], 1200, 'the first timing atom ends at its source boundary');
assert.equal(englishVoice.words[0].starts[1], 1200, 'the second timing atom starts at its source boundary');
assert.equal(englishVoice.words[0].ends[1], 1300, 'the second timing atom ends at its source boundary');

const lineWithBackground = {
  lineStartTime: 1000, lineEndTime: 1800, syllables: english,
  backgroundSyllables: fixture.syntheticCases.background,
};
const backgroundVoice = buildNativeRows([lineWithBackground], 'amll')[0].backgrounds[0];
assert.deepEqual(timing(backgroundVoice.paintWords), [[2200, 2350], [2350, 2600]],
  'background animation retains every original timing interval');
assert.equal(backgroundVoice.paintText, 'ahha');
assert.equal(backgroundVoice.words[0].starts[0], 2200);
assert.equal(backgroundVoice.words[0].ends[0], 2350);
assert.equal(backgroundVoice.words[0].starts[1], 2350);
assert.equal(backgroundVoice.words[0].ends[1], 2600);

function native(parts, start = 0, end = 5000) {
  return buildNativeVoice(parts.map((part, index) => ({ startTime: index * 100, endTime: (index + 1) * 100, ...part })), start, end, 'amll');
}
const exactPaint = parts => timing(native(parts).paintWords);
assert.deepEqual(exactPaint([
  { text: 'Hello', isPartOfWord: false }, { text: ',', isPartOfWord: false }, { text: 'world', isPartOfWord: false },
]), [[0, 100], [100, 200], [200, 300]], 'punctuation spacing adds no timing items or shifts');
assert.equal(native([{ text: 'well-', isPartOfWord: false }, { text: 'known', isPartOfWord: false }]).paintText,
  'well-known', 'hyphens attach to the following shaping group');
assert.equal(native([{ text: 'It', isPartOfWord: false }, { text: "'s", isPartOfWord: false }]).paintText,
  "It's", 'contraction apostrophes remain attached');
assert.equal(native([{ text: "sing", isPartOfWord: false }, { text: "'cause", isPartOfWord: false }]).paintText,
  "sing 'cause", 'leading elision apostrophes keep the source group boundary');
assert.equal(native([{ text: 'han', isPartOfWord: false }, { text: 'ja', isPartOfWord: false }]).paintText,
  'han ja', 'Latin group boundaries receive a space');
assert.equal(native([{ text: '中', isPartOfWord: false }, { text: '文', isPartOfWord: false }]).paintText,
  '中文', 'CJK group boundaries remain unspaced');
assert.equal(native([{ text: '한', isPartOfWord: false }, { text: '글', isPartOfWord: false }]).paintText,
  '한 글', 'Korean group boundaries receive a space');

const literal = native([{ text: 'Hello ' }, { text: 'world' }]);
assert.equal(literal.paintText, 'Hello world', 'literal/trailing provider spaces remain unchanged');
assert.deepEqual(timing(literal.paintWords), [[0, 100], [100, 200]]);

const emptyBetweenGroups = native([
  { text: 'Hello', isPartOfWord: false }, { text: '', isPartOfWord: false }, { text: 'world', isPartOfWord: false },
]);
assert.equal(emptyBetweenGroups.paintText, 'Hello world', 'an empty timed group cannot swallow the next visible separator');
assert.deepEqual(timing(emptyBetweenGroups.paintWords), [[0, 100], [200, 300]],
  'skipping empty text does not discard neighboring timing intervals');
const emptyFinalFragment = native([
  { text: 'Hel', isPartOfWord: true }, { text: 'lo', isPartOfWord: true },
  { text: '', isPartOfWord: false }, { text: 'world', isPartOfWord: false },
]);
assert.equal(emptyFinalFragment.paintText, 'Hello world',
  'a final empty provider fragment cannot swallow the separator after its visible group');
assert.deepEqual(timing(emptyFinalFragment.paintWords), [[0, 100], [100, 200], [300, 400]],
  'spacing repair leaves each nonempty provider timing atom intact');
const zeroDuration = buildNativeVoice([{ text: 'zero', startTime: 500, endTime: 500 }], 500, 500, 'amll');
assert.deepEqual(timing(zeroDuration.paintWords), [[500, 501]],
  'zero-duration input is explicitly normalized to one millisecond, not silently treated as lost timing');
const emptyOnly = buildNativeVoice([{ text: '', startTime: 100, endTime: 100 }], 100, 200, 'amll');
assert.equal(emptyOnly.paintText, ' ', 'empty-only line retains the existing visible fallback');
assert.equal(emptyOnly.paintWords.length, 0, 'empty lyric text does not create an animated glyph');

for (const [name, text, fragments] of [
  ['Indic conjunct', 'क्षि', ['क', '्', 'षि']],
  ['Arabic shaping', 'مرحبا', ['مر', 'حبا']],
  ['Latin joined word', 'Hello', ['Hel', 'lo']],
]) {
  const input = fragments.map((fragment, index) => ({ text: fragment, startTime: index * 100, endTime: (index + 1) * 100 }));
  const voice = buildNativeVoice(input, 0, fragments.length * 100, 'amll');
  assert.equal(lyricText(voice.words), text, `${name}: native text stays in one shaping-safe run`);
  assert.equal(voice.words.length, 1, `${name}: timing atoms do not become native shaping boundaries`);
  assert.equal(voice.paintWords.map(word => word.text).join(''), text,
    `${name}: native Skia paint text remains one continuous source run`);
  assert.equal(new Set(voice.paintWords.map(word => word.group)).size, 1,
    `${name}: all timed segments share the same native shaping/layout group`);
  assert.deepEqual(Array.from(voice.paintWords, word => word.offset),
    voice.paintWords.reduce((offsets, word, index) => {
      offsets.push(index ? offsets[index - 1] + voice.paintWords[index - 1].text.length : 0);
      return offsets;
    }, []), `${name}: native paragraph glyph ranges stay adjacent across timed segments`);
  assert.equal(voice.words[0].starts[0], 0, `${name}: shaping run starts at the first source boundary`);
  assert.equal(voice.words[0].ends.at(-1), fragments.length * 100, `${name}: shaping run ends at the last source boundary`);
  const parts = name === 'Indic conjunct' ? [{ start: 0, end: 300 }]
    : input.map(part => ({ start: part.startTime, end: part.endTime }));
  assert.deepEqual(timing(voice.paintWords), parts.map(part => [part.start, part.end]),
    `${name}: only grapheme-unsafe fragments may be merged for safe shaping`);
}

const cjkSpan = buildNativeVoice([{ text: '革命道中', startTime: 1000, endTime: 3000 }], 1000, 3000, 'amll');
assert.equal(cjkSpan.paintText, '革命道中');
assert.equal(cjkSpan.paintWords.length, 1, 'one source timing item spanning AMLL CJK chunks stays one animation item');
assert.deepEqual(timing(cjkSpan.paintWords), [[1000, 3000]]);
assert.equal(cjkSpan.paintWords[0].group, 0, 'cross-chunk timing atom maps to the merged native shaping range');
assert.equal(cjkSpan.paintWords[0].emphasis.index, 0, 'cross-chunk emphasis starts at the merged range origin');
assert.equal(cjkSpan.paintWords[0].emphasis.count, 4, 'cross-chunk emphasis counts the complete shaped range');
assert.equal(lyricText(cjkSpan.words), '革命道中', 'native chunk merging retains continuous shaped text');
assert.equal(cjkSpan.paintWords[0].text, cjkSpan.paintText,
  'native Skia receives the full cross-chunk glyph run while animation retains one timing item');

console.log('Native syllable preservation checks passed for captured lrc.red/Spicy data, backgrounds, spacing, timing, and shaping continuity.');
