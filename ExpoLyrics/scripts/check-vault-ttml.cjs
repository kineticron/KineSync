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
assert.deepEqual(parsed.lyrics[0].backgroundSyllables.map(s => [s.text, s.startTime, s.endTime]), [['Here', 2500, 4500]]);
assert.equal(parsed.lyrics[0].backgroundTranslatedText, 'Aquí');
assert.deepEqual(extractTtmlMetadata(xml), { title: 'Light & Sound', artist: 'KineSync' });
assert.equal(parseTtmlToLyrics('<tt><body/></tt>').lyrics.length, 0);
assert.equal(parseTtmlToLyrics('not lyrics').lyrics.length, 0);

// Structure and timing from GeronimoDPRLive: the background starts after the
// lead paragraph ends, with split words and parentheses across timed spans.
const geronimoBackground = `<tt><body><p begin="2:53.349" end="2:53.761">
<span begin="2:53.349" end="2:53.461">GERO</span><span begin="2:53.461" end="2:53.601">NI</span><span begin="2:53.601" end="2:53.761">MO!</span><span ttm:role="x-bg"><span begin="2:55.576" end="2:55.723">(I</span> <span begin="2:55.723" end="2:55.857">ain&apos;t</span> <span begin="2:55.857" end="2:56.156">got</span> <span begin="2:56.156" end="2:56.566">no</span><span begin="2:56.566" end="2:57.140">where</span> <span begin="2:57.140" end="2:57.304">to</span> <span begin="2:57.304" end="2:58.705">run)</span></span>
<span ttm:role="x-translation"><span>Lead translation</span></span>
<span ttm:role="x-bg-translation"><span>(Background translation)</span></span>
</p></body></tt>`;

for (const importer of [
  require('../lib/lyrics-ttml-import'),
  require('../../DesktopBridge/src/lyricsTtmlImport'),
]) {
  const result = importer.parseTtmlToLyrics(geronimoBackground);
  const line = result.lyrics[0];
  assert.equal(importer.joinImportedSyllableText(line.syllables), 'GERONIMO!');
  assert.deepEqual(line.syllables.map(s => [s.startTime, s.endTime]), [
    [173349, 173461], [173461, 173601], [173601, 173761],
  ]);
  assert.equal(importer.joinImportedSyllableText(line.backgroundSyllables), "I ain't got nowhere to run");
  assert.deepEqual(line.backgroundSyllables.map(s => [s.startTime, s.endTime]), [
    [175576, 175723], [175723, 175857], [175857, 176156],
    [176156, 176566], [176566, 177140], [177140, 177304], [177304, 178705],
  ]);
  assert.equal(line.backgroundSyllables[3].isPartOfWord, true);
  assert.equal(line.translatedText, 'Lead translation');
  assert.equal(line.backgroundTranslatedText, 'Background translation');
  assert.equal(line.lineEndTime, 173761);
  assert.equal(result.durationMs, 178705);

  const lineTimed = importer.parseTtmlToLyrics(
    geronimoBackground.replace('<tt>', '<tt itunes:timing="Line">'),
  ).lyrics[0];
  assert.equal(lineTimed.syllables[0].text, 'GERONIMO!');
  assert.deepEqual(lineTimed.backgroundSyllables, line.backgroundSyllables);

  const multiple = importer.parseTtmlToLyrics(`<tt><body><p begin="1" end="4">
<span begin="1" end="2">(Lead)</span><span ttm:role="x-bg"><span begin="2" end="3">(One)</span></span><span ttm:role="x-bg" begin="3" end="5">（Two）</span>
</p></body></tt>`).lyrics[0];
  assert.equal(multiple.syllables[0].text, '(Lead)');
  assert.deepEqual(multiple.backgroundSyllables.map(s => [s.text, s.startTime, s.endTime]), [
    ['One ', 2000, 3000], ['Two', 3000, 5000],
  ]);

  const nested = importer.parseTtmlToLyrics(`<tt><body><p begin="1" end="5"><span>
<span begin="1" end="2">Lead</span><span ttm:role="x-bg"><span><span begin="3" end="4">(Back </span><span begin="4" end="5">up)</span></span></span>
</span></p></body></tt>`).lyrics[0];
  assert.equal(importer.joinImportedSyllableText(nested.syllables), 'Lead');
  assert.equal(importer.joinImportedSyllableText(nested.backgroundSyllables), 'Back up');
  assert.deepEqual(nested.backgroundSyllables.map(s => [s.startTime, s.endTime]), [[3000, 4000], [4000, 5000]]);

  // Geronimo uses v1 for the normal lane and v2 for opposite alignment.
  // A v2 paragraph stays opposite even when it is the first paragraph, while
  // v2 on a nested background span must not flip a v1 lead paragraph.
  const agents = `<tt><head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/></metadata></head><body>
<p begin="24.317" end="24.892" ttm:agent="v2"><span begin="24.317" end="24.507">GERO</span><span begin="24.507" end="24.719">NI</span><span begin="24.719" end="24.892">MO!</span></p>
<p begin="25" end="27" ttm:agent="v1"><span begin="25" end="26">Lead</span><span ttm:role="x-bg" ttm:agent="v2"><span begin="26" end="27">(Back)</span></span></p>
<p begin="28" end="29">Unassigned</p><p begin="30" end="31" ttm:agent="v1000">Group</p>
</body></tt>`;
  for (const document of [agents, agents.replace('<tt>', '<tt itunes:timing="Line">')]) {
    const aligned = importer.parseTtmlToLyrics(document).lyrics;
    assert.deepEqual(aligned.map(line => Boolean(line.oppositeAligned)), [true, false, false, false]);
    assert.equal(importer.joinImportedSyllableText(aligned[0].syllables), 'GERONIMO!');
    assert.equal(aligned[0].lineStartTime, 24317);
    assert.equal(aligned[0].lineEndTime, 24892);
    assert.equal(importer.joinImportedSyllableText(aligned[1].backgroundSyllables), 'Back');
  }
  const oppositeBackground = importer.parseTtmlToLyrics(
    geronimoBackground.replace('end="2:53.761">', 'end="2:53.761" ttm:agent="v2">'),
  ).lyrics[0];
  assert.equal(oppositeBackground.oppositeAligned, true);
  assert.deepEqual(oppositeBackground.syllables, line.syllables);
  assert.deepEqual(oppositeBackground.backgroundSyllables, line.backgroundSyllables);
}
console.log('Vault TTML checks passed for mobile and desktop: round trip, opposite alignment, nested backgrounds, lead isolation, parentheses, timing, translations and line timing.');
