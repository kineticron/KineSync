/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const output = buildSync({ entryPoints: [path.resolve(__dirname, '../components/lyrics/native/native-lyrics-model.ts')], bundle: true,
  platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const moduleObject = { exports: {} };
vm.runInNewContext(output, { module: moduleObject, exports: moduleObject.exports, require });
const { buildNativeRows, buildNativeVoice, nativeWordProgress } = moduleObject.exports;
const makePart = (text, index, isPartOfWord) => ({ text, startTime: index * 1000, endTime: (index + 1) * 1000,
  ...(isPartOfWord === undefined ? {} : { isPartOfWord }) });
for (const style of ['amll', 'spicy']) {
  for (const text of ['น้ำ', 'क्षि', 'క్షి', '👨‍👩‍👧‍👦', 'e\u0301']) {
    const parts = Array.from(text, (character, index) => makePart(character, index));
    const before = JSON.stringify(parts);
    const voice = buildNativeVoice(parts, 0, parts.length * 1000, style);
    assert.equal(voice.words.map(word => word.text).join(''), text);
    assert.equal(voice.words.length, 1, `${style}: provider splits cannot detach a grapheme`);
    assert.equal(JSON.stringify(parts), before, 'provider data must remain immutable');
    assert.equal(voice.words[0].starts[0], 0);
    assert.equal(voice.words[0].ends.at(-1), parts.length * 1000);
  }
  const parts = [makePart('Hel', 0, true), makePart('lo', 1, false), makePart('world', 2, false)];
  const voice = buildNativeVoice(parts, 0, 3000, style);
  assert.equal(voice.words.map(word => word.text).join(''), 'Hello world');
  const korean = buildNativeVoice([makePart('한', 0), makePart('글 ', 1), makePart('노래', 2)], 0, 3000, style);
  assert.equal(korean.words.map(word => word.text).join(''), '한글 노래');
  const arabic = buildNativeVoice([makePart('مر', 0), makePart('حبا ', 1), makePart('بك', 2)], 0, 3000, style);
  assert.equal(arabic.words[0].text, 'مرحبا ', 'Arabic shaping must span safe-but-joining provider syllables');
  for (const word of voice.words) {
    assert.equal(nativeWordProgress(-1000, word.starts, word.ends, word.weights), 0);
    assert.equal(nativeWordProgress(10000, word.starts, word.ends, word.weights), 1);
    let previous = 0;
    for (let time = 0; time <= 3000; time += 10) {
      const progress = nativeWordProgress(time, word.starts, word.ends, word.weights);
      assert.ok(progress >= previous && progress <= 1, 'reveal must be bounded and monotonic');
      previous = progress;
    }
  }
}
const syllables = [makePart('background', 5)];
const line = { lineStartTime: 0, lineEndTime: 3000, syllables: [makePart('lead', 0)],
  backgroundSyllables: syllables, spicyBackgrounds: [
    { lineStartTime: 4000, lineEndTime: 5000, syllables: [makePart('first', 4)] },
    { lineStartTime: 5000, lineEndTime: 6000, syllables },
  ] };
const spicy = buildNativeRows([line], 'spicy')[0];
const japanese = buildNativeVoice([{ text: '革命道中', startTime: 1000, endTime: 3000 }], 1000, 3000, 'amll');
assert.equal(japanese.paintText, '革命道中');
assert.deepEqual(Array.from(japanese.paintWords, word => word.text), ['革', '命', '道', '中']);
assert.deepEqual(Array.from(japanese.paintWords, word => [word.start, word.end]), [[1000, 1500], [1500, 2000], [2000, 2500], [2500, 3000]]);
assert.ok(japanese.paintWords.every(word => !word.emphasized), 'AMLL tests emphasis after splitting CJK into timed characters');
const emphasized = buildNativeVoice([{ text: 'sing ', startTime: 1000, endTime: 3000 }, { text: 'along', startTime: 3000, endTime: 3500 }], 1000, 3500, 'amll');
assert.equal(emphasized.paintWords.length, 2, 'Whitespace is layout text rather than an animated word');
assert.equal(emphasized.paintWords[0].letters.join(''), 'sing');
assert.equal(emphasized.paintWords[1].offset, 5, 'Paint offsets retain spaces between timing atoms');
assert.equal(emphasized.paintWords[0].emphasis.count, 4);
const flaggedGaps = buildNativeVoice([makePart('One', 0, false), makePart('two', 1, false)], 0, 2000, 'spicy');
assert.equal(flaggedGaps.paintWords[0].gapAfter, true, 'Spicy synthetic gaps need the reference ch width, not a font space');
const literalGaps = buildNativeVoice([makePart('One ', 0), makePart('two', 1)], 0, 2000, 'spicy');
assert.equal(literalGaps.paintWords[0].gapAfter, false, 'Provider spaces retain their natural glyph advances');
assert.equal(spicy.backgrounds.length, 2, 'exact Spicy background blocks must stay independent');
assert.equal(spicy.backgrounds[1].end, 6000);
assert.equal(buildNativeRows([line], 'amll')[0].backgrounds.length, 1);
assert.equal(spicy.line, line, 'line callbacks must retain the original provider object');
const staticLine = { ...line, syllables: [makePart('literal', 0, false), makePart('text', 1, false)] };
assert.equal(buildNativeRows([staticLine], 'amll', true)[0].lead.words.map(word => word.text).join(''), 'literaltext',
  'static text must match literal provider text without synthesizing word spaces');
assert.equal(nativeWordProgress(100, [100], [100], [1]), 0, 'zero-length intervals remain finite');
assert.equal(nativeWordProgress(101, [100], [100], [1]), 1);
assert.equal(nativeWordProgress(100, [], [], []), 0);
console.log('Native lyrics checks passed: immutable provider text, Unicode clusters, literal/flagged spacing, timing, seeks, independent backgrounds.');
