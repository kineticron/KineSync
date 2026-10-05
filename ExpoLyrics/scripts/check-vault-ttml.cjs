const assert = require('node:assert/strict');
const { lyricsToTtml } = require('../lib/lyrics-ttml-export');
const { parseTtmlToLyrics, extractTtmlMetadata } = require('../lib/lyrics-ttml-import');

const lyrics = [{
  lineStartTime: 1000, lineEndTime: 5000,
  syllables: [{ text: 'Stay ', startTime: 1000, endTime: 2000 }, { text: 'here', startTime: 2000, endTime: 5000 }],
  translatedText: 'Quédate aquí',
  backgroundSyllables: [{ text: '(Here)', startTime: 2500, endTime: 4500 }],
  backgroundTranslatedText: '(Aquí)',
}];
const xml = lyricsToTtml({ lyrics, title: 'Light & Sound', artist: 'KineSync', durationMs: 5000 });
const parsed = parseTtmlToLyrics(xml);
assert.equal(parsed.lyrics.length, 1);
assert.equal(parsed.lyrics[0].lineStartTime, 1000);
assert.equal(parsed.lyrics[0].lineEndTime, 5000);
assert.equal(parsed.lyrics[0].syllables.map(s => s.text).join(''), 'Stay here');
assert.equal(parsed.lyrics[0].translatedText, 'Quédate aquí');
assert.deepEqual(parsed.lyrics[0].backgroundSyllables.map(s => [s.text, s.startTime, s.endTime]), [['(Here)', 2500, 4500]]);
assert.equal(parsed.lyrics[0].backgroundTranslatedText, '(Aquí)');
assert.deepEqual(extractTtmlMetadata(xml), { title: 'Light & Sound', artist: 'KineSync' });
assert.equal(parseTtmlToLyrics('<tt><body/></tt>').lyrics.length, 0);
assert.equal(parseTtmlToLyrics('not lyrics').lyrics.length, 0);
console.log('Vault TTML round trip passed: words, sustained timing, translations, nested background vocals, metadata and invalid input.');
