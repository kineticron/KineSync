// Sync Studio engine: line marks, tap and swipe word timing, ad-libs, and the
// lyrics/TTML it produces for the vault and for Spicy Lyrics uploads.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const bundled = await build({ entryPoints: [path.join(root, 'lib/sync-studio/engine.ts')], bundle: true, format: 'esm',
  platform: 'node', write: false, logLevel: 'silent' });
const S = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const swipeBundle = await build({ entryPoints: [path.join(root, 'lib/sync-studio/swipe.ts')], bundle: true, format: 'esm',
  platform: 'node', write: false, logLevel: 'silent' });
const SW = await import(`data:text/javascript;base64,${Buffer.from(swipeBundle.outputFiles[0].text).toString('base64')}`);
const syllableBundle = await build({ entryPoints: [path.join(root, 'lib/sync-studio/syllables.ts')], bundle: true, format: 'esm',
  platform: 'node', write: false, logLevel: 'silent' });
const SY = await import(`data:text/javascript;base64,${Buffer.from(syllableBundle.outputFiles[0].text).toString('base64')}`);
const { lyricsToTtml } = require('../lib/lyrics-ttml-export.js');
const { parseTtmlToLyrics, extractTtmlMetadata } = require('../lib/lyrics-ttml-import.js');

const meta = { title: 'Night Drive', artist: 'Test Artist', spotifyTrackId: '4uLU6hMCjMI75M1A2tKUQC', durationMs: 60_000 };
const words = (line) => line.words.map((w) => [w.text.trim(), w.start, w.end]);

// Pasted lyrics: words keep their spaces, "(...)" lines become ad-libs, CJK splits per character.
let p = S.projectFromPlainText('Hold me close\n(hold me)\n\nWe are dancing', meta);
assert.deepEqual(p.lines.map((l) => [S.lineText(l), l.background]), [['Hold me close', false], ['hold me', true], ['We are dancing', false]]);
assert.deepEqual(S.splitWords('Hold me').map((w) => w.text), ['Hold ', 'me']);
assert.deepEqual(S.splitWords('夜空').map((w) => w.text), ['夜', '空']);
assert.deepEqual(S.splitWords('तुम ही हो').map((w) => w.text), ['तुम ', 'ही ', 'हो']);

// Lines stage: a tap starts the line and ends the lead line before it.
p = S.markLineStart(p, 0, 1000);
p = S.markLineStart(p, 2, 5000);
assert.equal(p.lines[0].end, 5000, 'the next line start ends the previous lead line');
assert.equal(p.lines[1].start, null, 'ad-libs are skipped by the lines stage');
p = S.markLineEnd(p, 2, 9000);
assert.equal(S.nextIndexToSync(p, 0, 'lines'), -1, 'all lead lines have a start');

// Tap mode: each tap starts the next word and ends the one before. The last word
// stays open (being sung) until a tap ends it, which finishes the line.
let r = S.tapWord(p, 0, 1100);
r = S.tapWord(r.project, 0, 1600);
assert.deepEqual(words(r.project.lines[0]).slice(0, 2), [['Hold', 1100, 1600], ['me', 1600, null]], 'a tap ends the previous word');
assert.equal(r.project.lines[0].start, 1100, 'the first word sets the line start');
assert.equal(r.finished, false);
r = S.tapWord(r.project, 0, 2000);
assert.equal(r.finished, false, 'starting the last word does not finish the line');
assert.equal(S.openUnit(r.project.lines[0]), 2, 'the last word is being sung (blue)');
r = S.tapWord(r.project, 0, 3200);
assert.equal(r.finished, true, 'the next tap ends it and the line');
assert.deepEqual(words(r.project.lines[0]), [['Hold', 1100, 1600], ['me', 1600, 2000], ['close', 2000, 3200]]);
assert.equal(S.isLineWordSynced(r.project.lines[0]), true);
p = r.project;

// End (H) on the last word ends the line too; endLastWord re-ends it later.
let open = S.projectFromPlainText('one two\nthree', meta);
open = S.tapWord(S.tapWord(open, 0, 1000).project, 0, 1500).project;
assert.deepEqual(S.tapEnd(open, 0, 2100).finished, true);
open = S.endLastWord(S.tapEnd(open, 0, 2100).project, 0, 2300);
assert.deepEqual(words(open.lines[0]), [['one', 1000, 1500], ['two', 1500, 2300]], 'End with nothing started on the next line re-ends this one');

// Resync one picked word: Start moves its start (and the word before ends there), Commit ends it and joins the next word.
let resync = S.projectFromPlainText('a bc de', meta);
for (const t of [1000, 1500, 2000]) resync = S.tapWord(resync, 0, t).project;
resync = S.tapWord(resync, 0, 2600).project;
resync = S.restartUnit(resync, 0, 1, 1700);
assert.deepEqual(words(resync.lines[0]), [['a', 1000, 1700], ['bc', 1700, null], ['de', 2000, 2600]], 'picked word restarts; the word before ends there');
resync = S.endUnit(resync, 0, 1, 2150, true);
assert.deepEqual(words(resync.lines[0]), [['a', 1000, 1700], ['bc', 1700, 2150], ['de', 2150, 2600]], 'Commit joins the next word to it');
resync = S.restartUnit(resync, 0, 2, 2200);
resync = S.endUnit(resync, 0, 2, 2500, false);
assert.deepEqual(words(resync.lines[0]).at(-1), ['de', 2200, 2500]);
assert.equal(resync.lines[0].end, 2500, 'the last word sets the line end');
assert.equal(S.restartUnit(resync, 0, 0, 900).lines[0].start, 900, 'the first word sets the line start');

// Double taps never collapse a word to zero length.
let quick = S.tapWord(S.tapWord(S.projectFromPlainText('a b', meta), 0, 500).project, 0, 500).project;
assert.ok(quick.lines[0].words[1].start - quick.lines[0].words[0].start >= S.MIN_WORD_MS);

// Swipe mode: a word starts when the finger enters it; skipped words share the gap.
p = S.clearLineWords(p, 2);
p = S.swipeEnterWord(p, 2, 0, -1, 5100);
assert.deepEqual(words(p.lines[2])[0], ['We', 5100, null], 'entering the first word starts it');
p = S.swipeEnterWord(p, 2, 2, 0, 5700);
assert.deepEqual(words(p.lines[2]), [['We', 5100, 5400], ['are', 5400, 5700], ['dancing', 5700, null]], 'a fast swipe over "are" splits the time');
let swipe = S.swipeFinish(p, 2, 1, 6400);
assert.equal(swipe.finished, false, 'lifting before the last word does not finish the line');
swipe = S.swipeFinish(p, 2, 2, 6400);
assert.equal(swipe.finished, true, 'reaching the last word counts, even short of its right edge');
assert.deepEqual(words(swipe.project.lines[2])[2], ['dancing', 5700, 6400]);
p = swipe.project;

// Ad-lib rows are word-synced the same way and may overlap the lead line.
r = S.tapWord(p, 1, 2400); r = S.tapWord(r.project, 1, 2700); r = S.tapWord(r.project, 1, 3400);
assert.equal(r.finished, true);
p = r.project;

// Output for the vault/preview: ad-libs become the lead line's background vocals.
const lyrics = S.lyricsFromProject(p);
assert.equal(lyrics.length, 2);
assert.deepEqual(lyrics[0].syllables.map((s) => [s.text, s.startTime, s.endTime]), [['Hold ', 1100, 1600], ['me ', 1600, 2000], ['close', 2000, 3200]]);
assert.deepEqual(lyrics[0].backgroundSyllables.map((s) => [s.text, s.startTime, s.endTime]), [['hold ', 2400, 2700], ['me', 2700, 3400]]);
assert.equal(lyrics[1].lineStartTime, 5100);

// TTML for Spicy Lyrics: word spans, x-bg span, title/artist and the Spotify track ID.
const ttml = lyricsToTtml({ lyrics, title: meta.title, artist: meta.artist, spotifyTrackId: meta.spotifyTrackId, preserveOriginal: false });
assert.match(ttml, /itunes:timing="Word"/);
assert.match(ttml, /<span ttm:role="x-bg"/);
assert.match(ttml, /<amll:meta key="spotifyId" value="4uLU6hMCjMI75M1A2tKUQC"\/>/);
const reparsed = parseTtmlToLyrics(ttml);
assert.deepEqual(reparsed.lyrics.map((l) => l.syllables.map((s) => s.text).join('')), ['Hold me close', 'We are dancing']);
assert.deepEqual(reparsed.lyrics[0].backgroundSyllables.map((s) => [s.text.trim(), s.startTime, s.endTime]), [['hold', 2400, 2700], ['me', 2700, 3400]]);
assert.deepEqual(extractTtmlMetadata(ttml), { title: meta.title, artist: meta.artist, spotifyTrackId: meta.spotifyTrackId });

// Starting from KineSync's line-synced lyrics keeps their line timing.
const fromSource = S.projectFromLyrics([
  { lineStartTime: 1000, lineEndTime: 4000, syllables: [{ text: 'Hello there friend', startTime: 1000, endTime: 4000 }],
    backgroundSyllables: [{ text: '(Hey)', startTime: 2000, endTime: 2500 }] },
  { lineStartTime: 4000, lineEndTime: 7000, syllables: [{ text: 'Word ', startTime: 4000, endTime: 5000 }, { text: 'timed', startTime: 5000, endTime: 7000 }] },
], meta);
assert.deepEqual(fromSource.lines.map((l) => [S.lineText(l), l.background, l.start, l.end]),
  [['Hello there friend', false, 1000, 4000], ['Hey', true, 2000, 2500], ['Word timed', false, 4000, 7000]]);
assert.equal(fromSource.lines[0].words[0].start, null, 'line-synced lines still need word timing');
assert.deepEqual(words(fromSource.lines[2]), [['Word', 4000, 5000], ['timed', 5000, 7000]], 'word timing is kept for fixing');
assert.equal(S.nextIndexToSync(fromSource, -1, 'words'), 0);
assert.equal(S.leadInPosition(fromSource, 2, 1500), 2500);

// Untimed words in a timed line are spread evenly for the preview and export.
const partial = S.lyricsFromProject(S.tapWord(fromSource, 0, 1000).project)[0];
assert.deepEqual(partial.syllables.map((s) => s.startTime), [1000, 2000, 3000]);

// Nudging and editing.
const shifted = S.shiftAll(p, -200);
assert.equal(shifted.lines[0].words[0].start, 900);
assert.equal(S.shiftAll(p, -5000).lines[0].start, 0, 'never before 0');
const edited = S.setLineText(p, 0, 'Hold me closer');
assert.equal(edited.lines[0].words.every((w) => w.start == null), true, 'editing the text resets that line\'s word timing');
assert.equal(S.insertLineAfter(p, 0, '(ooh)').lines[1].background, true);
assert.equal(S.deleteLine(p, 1).lines.length, 2);
assert.equal(S.lineAtTime(p, 5200), 2);

// Slide bar: the whole bar spans the whole line; a word is synced when its last character lights.
const plan = SW.scrubPlan(['Dreams ', 'are ', "nothin' ", 'more']);
assert.deepEqual(plan.counts, [6, 3, 7, 4]);
assert.equal(plan.total, 20);
assert.equal(SW.reachedWord(plan, 0), -1, 'nothing before the bar moves');
assert.equal(SW.reachedWord(plan, 0.5), 0, 'the first word starts as soon as the highlighter moves');
assert.equal(SW.reachedWord(plan, 5.9), 0, '"Dreams" is not synced until its last letter lights');
assert.equal(SW.reachedWord(plan, 6), 1, 'lighting the "s" ends "Dreams" and starts "are"');
assert.equal(SW.reachedWord(plan, SW.highlightedCharacters(plan, 0.5)), 2, 'half the bar is half the characters, whatever the line length');
assert.equal(SW.lineComplete(plan, 19.5), false);
assert.equal(SW.lineComplete(plan, SW.highlightedCharacters(plan, 1)), true, 'the right end of the bar syncs the last word');
const long = SW.scrubPlan(Array.from({ length: 14 }, (_, i) => `word${i} `));
assert.equal(SW.reachedWord(long, SW.highlightedCharacters(long, 1)), 13, 'a long line also fits one full slide');
assert.equal(SW.barPosition(30, 30, 330), 0);
assert.equal(SW.barPosition(330, 30, 330), 1, 'from where the finger lands to the right edge is the whole bar');
assert.equal(SW.barPosition(10, 30, 330), 0, 'never below 0');
assert.equal(SW.lineProgress(SW.barPosition(30 + SW.FREE_ZONE_PX - 1, 30, 330), 30, 330), 0, 'the free zone at the start lights nothing');
assert.ok(SW.lineProgress(SW.barPosition(30 + SW.FREE_ZONE_PX + 20, 30, 330), 30, 330) > 0, 'past it, the line starts lighting');
assert.equal(SW.lineProgress(1, 30, 330), 1, 'the right end still lights the whole line');
assert.deepEqual(SW.characters('क्षमा'), ['क्ष', 'मा'], 'Hindi conjuncts and vowel signs stay whole');
assert.deepEqual(SW.characters('नमस्ते'), ['न', 'म', 'स्ते']);
assert.deepEqual(SW.characters("I'm"), ['I', "'", 'm']);

// A full slide through the engine: each word's start is when the one before it is fully lit.
let slide = S.clearLineWords(S.projectFromPlainText("Dreams are nothin' more", meta), 0);
const slideTimes = [[0.5, 1000], [6, 1600], [9, 1900], [16, 2500]];
let last = -1;
for (const [lit, time] of slideTimes) {
  const reached = SW.reachedWord(plan, lit);
  if (reached > last) { slide = S.swipeEnterWord(slide, 0, reached, last, time); last = reached; }
}
slide = S.swipeFinish(slide, 0, last, 3100);
assert.equal(slide.finished, true);
assert.deepEqual(words(slide.project.lines[0]), [['Dreams', 1000, 1600], ['are', 1600, 1900], ["nothin'", 1900, 2500], ['more', 2500, 3100]]);

// Word spacing: Spicy-style syllables flag word boundaries instead of carrying spaces.
const flaggedLine = S.projectFromLyrics([{ lineStartTime: 0, lineEndTime: 3000, syllables: [
  { text: 'Dre', startTime: 0, endTime: 300, isPartOfWord: true }, { text: 'ams', startTime: 300, endTime: 800, isPartOfWord: false },
  { text: 'are', startTime: 800, endTime: 1200, isPartOfWord: false }, { text: 'gold', startTime: 1200, endTime: 3000, isPartOfWord: false }] }], meta);
assert.equal(S.lineText(flaggedLine.lines[0]), 'Dreams are gold', 'flagged word boundaries become spaces');
const flaggedOut = S.lyricsFromProject(flaggedLine)[0].syllables;
assert.deepEqual(flaggedOut.map((x) => [x.text, x.isPartOfWord]), [['Dre', true], ['ams ', false], ['are ', false], ['gold', false]]);
const flaggedTtml = parseTtmlToLyrics(lyricsToTtml({ lyrics: S.lyricsFromProject(flaggedLine), title: 't', artist: 'a', preserveOriginal: false }));
assert.equal(flaggedTtml.lyrics[0].syllables.map((x) => x.text).join(''), 'Dreams are gold', 'export keeps "Dre"+"ams" together and words apart');
assert.equal(S.lineText(S.projectFromLyrics([{ lineStartTime: 0, lineEndTime: 900, syllables: [
  { text: 'Hey ', startTime: 0, endTime: 400 }, { text: 'you', startTime: 400, endTime: 900 }] }], meta).lines[0]), 'Hey you', 'spaces already in the text are kept');
const cjkOut = S.lyricsFromProject(S.tapWord(S.projectFromPlainText('夜空', meta), 0, 100).project)[0].syllables;
assert.deepEqual(cjkOut.map((x) => x.isPartOfWord), [true, false], 'CJK characters export without spaces between them');

// Instrumental breaks: pasted markers, gaps and "♪" lines in existing lyrics, and their "…" gap on export.
const pastedBreak = S.projectFromPlainText('First line\n#INSTRUMENTAL\nSecond line\n[Instrumental]\n♪\n(instrumental)', meta);
assert.deepEqual(pastedBreak.lines.map((l) => l.instrumental ? 'I' : S.lineText(l)), ['First line', 'I', 'Second line', 'I', 'I', 'I']);
const gapped = S.projectFromLyrics([
  { lineStartTime: 1000, lineEndTime: 3000, syllables: [{ text: 'Before the solo', startTime: 1000, endTime: 3000 }] },
  { lineStartTime: 12000, lineEndTime: 14000, syllables: [{ text: 'After the solo', startTime: 12000, endTime: 14000 }] },
  { lineStartTime: 15000, lineEndTime: 16000, syllables: [{ text: '♪', startTime: 15000, endTime: 16000 }] },
  { lineStartTime: 20000, lineEndTime: 22000, syllables: [{ text: 'Last line', startTime: 20000, endTime: 22000 }] },
], meta);
assert.deepEqual(gapped.lines.map((l) => l.instrumental ? `I@${l.start}` : S.lineText(l)), ['Before the solo', 'I@3000', 'After the solo', 'I@15000', 'Last line'],
  'a 3 s+ gap and a "♪" line both show as instrumental rows');
assert.equal(S.progress(gapped).lines, 3);
assert.equal(S.progress(gapped).instrumentals, 2);
assert.equal(S.nextIndexToSync(gapped, 2, 'words'), 4, 'timed instrumental breaks need nothing more');
assert.equal(S.nextIndexToSync(S.projectFromPlainText('a\n#INSTRUMENTAL\nb', meta), 0, 'words'), 1, 'an untimed break is visited so its start can be tapped');

// A break marked in the Lines stage ends the line before it, leaving the gap that shows "…".
let withBreak = S.projectFromPlainText('Verse line\n#INSTRUMENTAL\nChorus line', meta);
withBreak = S.markLineStart(withBreak, 0, 1000);
withBreak = S.markLineStart(withBreak, 1, 4000);
withBreak = S.markLineStart(withBreak, 2, 20000);
assert.equal(withBreak.lines[0].end, 4000, 'the instrumental start ends the line before it');
const breakOut = S.lyricsFromProject(withBreak);
assert.equal(breakOut.length, 2, 'instrumental rows are not lyric lines');
assert.equal(breakOut[0].lineEndTime, 4000);
assert.ok(breakOut[1].lineStartTime - breakOut[0].lineEndTime >= S.INSTRUMENTAL_GAP_MS);
// Word timings that run past the break are cut at it.
let overrunProject = S.markLineEnd(S.markLineStart(S.projectFromPlainText('a b\nc', meta), 0, 0), 0, 8000);
overrunProject = S.insertInstrumentalAfter(overrunProject, 0);
overrunProject = S.markLineStart(S.markLineStart(overrunProject, 1, 5000), 2, 9000);
const overrun = S.lyricsFromProject(overrunProject);
assert.equal(overrun[0].lineEndTime, 5000);
assert.ok(overrun[0].syllables.every((x) => x.endTime <= 5000));
assert.equal(S.setLineText(withBreak, 0, '#instrumental').lines[0].instrumental, true);
assert.equal(S.setLineText(withBreak, 1, 'Now a lyric').lines[1].instrumental, false);

// Moving on always goes to the very next line (synced or not); syncing it again overwrites it.
const order = S.projectFromPlainText('One\n#INSTRUMENTAL\nTwo\n(ad-lib)', meta);
assert.equal(S.nextWordRow(order, 0), 1, 'instrumental breaks are visited in the words stage too');
assert.equal(S.nextWordRow(order, 2), 3, 'ad-libs come next even when already synced');
assert.equal(S.nextWordRow(order, 3), -1);
let again = S.tapWord(S.tapWord(S.tapWord(S.projectFromPlainText('re do', meta), 0, 100).project, 0, 300).project, 0, 600).project;
again = S.tapWord(S.clearLineWords(again, 0), 0, 5000).project;
assert.deepEqual(words(again.lines[0]), [['re', 5000, null], ['do', null, null]], 'a new first tap starts the line over');

// Turning words of a main line into an ad-lib keeps every timing, including around a middle ad-lib.
let mixed = S.projectFromPlainText("I said (yeah yeah) let's go", meta);
for (const [i, t] of [[0, 1000], [0, 1300], [0, 1700], [0, 2000], [0, 2300], [0, 2700], [0, 3200]]) mixed = S.tapWord(mixed, i, t).project;
assert.deepEqual(S.bracketedWords(mixed.lines[0]), { from: 2, to: 3 }, 'bracketed words are suggested');
const split = S.extractAdLib(mixed, 0, 2, 3);
assert.deepEqual(split.lines.map((l) => [S.lineText(l), l.background]), [["I said let's go", false], ['yeah yeah', true]]);
assert.deepEqual(words(split.lines[0]), [['I', 1000, 1300], ['said', 1300, 1700], ["let's", 2300, 2700], ['go', 2700, 3200]], 'the main line keeps both sides\' timing');
assert.deepEqual(words(split.lines[1]), [['yeah', 1700, 2000], ['yeah', 2000, 2300]], 'the ad-lib keeps its words\' timing');
assert.equal(split.lines[0].start, 1000);
assert.equal(split.lines[0].end, 3200);
assert.deepEqual([split.lines[1].start, split.lines[1].end], [1700, 2300]);
const splitOut = S.lyricsFromProject(split);
assert.equal(splitOut.length, 1);
assert.equal(splitOut[0].syllables.map((x) => x.text).join(''), "I said let's go");
assert.deepEqual(splitOut[0].backgroundSyllables.map((x) => [x.text, x.startTime, x.endTime]), [['yeah ', 1700, 2000], ['yeah', 2000, 2300]]);
// At the end of a line the main line now ends at its new last word; untimed words move too.
const endSplit = S.extractAdLib(S.tapWord(S.tapWord(S.projectFromPlainText('Go now (go)', meta), 0, 100).project, 0, 400).project, 0, 2, 2);
assert.deepEqual(endSplit.lines.map((l) => S.lineText(l)), ['Go now', 'go']);
assert.equal(endSplit.lines[0].words.at(-1).text, 'now', 'no trailing space on the new last word');
assert.equal(endSplit.lines[1].start, null, 'an untimed word stays untimed, ready to sync');
assert.equal(S.extractAdLib(mixed, 0, 0, 6), mixed, 'moving every word is refused (use "Make it an ad-lib")');

// Preview fixes: first-word nudge, mark to fix (cleared by syncing again), and row windows for live highlight.
let fix = S.projectFromPlainText('Hello world', meta);
for (const t of [1000, 1500, 2200]) fix = S.tapWord(fix, 0, t).project;
let nudged = S.nudgeFirstWord(fix, 0, -50);
assert.deepEqual(words(nudged.lines[0]), [['Hello', 950, 1500], ['world', 1500, 2200]], 'only the first word moves');
assert.equal(nudged.lines[0].start, 950);
assert.equal(S.nudgeFirstWord(fix, 0, 2000).lines[0].words[0].start, 1500 - S.MIN_WORD_MS, 'never past its own end');
fix = S.setFlagged(fix, 0, true);
assert.equal(fix.lines[0].flagged, true);
let redone = S.clearLineWords(fix, 0);
for (const t of [3000, 3400, 3900]) redone = S.tapWord(redone, 0, t).project;
assert.equal(redone.lines[0].flagged, false, 'syncing the line again clears the mark');
const windows = S.rowWindows(S.projectFromPlainText('a\n(b)\nc', meta));
assert.deepEqual(windows, [null, null, null]);
assert.deepEqual(S.rowWindows(fix)[0], { start: 1000, end: 2200 });

// Sliding back: words whose letters all went dark lose their timing; the word reached stays open.
let back = S.clearLineWords(S.projectFromPlainText("Dreams are nothin' more", meta), 0);
back = S.swipeEnterWord(back, 0, 0, -1, 1000);
back = S.swipeEnterWord(back, 0, 1, 0, 1600);
back = S.swipeEnterWord(back, 0, 2, 1, 1900);
assert.equal(SW.reachedWord(plan, 9), 2, '"nothin\'" is reached once "are" is fully lit');
assert.equal(SW.reachedWord(plan, 9.5), 2, 'backing into "nothin\'" but not off it keeps it');
assert.equal(SW.reachedWord(plan, 8.9), 1, 'backing off every letter of "nothin\'" drops it');
back = S.swipeRetreat(back, 0, 1);
assert.deepEqual(words(back.lines[0]), [['Dreams', 1000, 1600], ['are', 1600, null], ["nothin'", null, null], ['more', null, null]]);
back = S.swipeEnterWord(back, 0, 2, 1, 2100);
assert.deepEqual(words(back.lines[0]).slice(1, 3), [['are', 1600, 2100], ["nothin'", 2100, null]], 'sliding forward again re-times it');
assert.equal(S.swipeRetreat(back, 0, -1).lines[0].words.every((w) => w.start == null), true, 'back into the free zone clears the line');

// A line lasts until its ad-lib ends, so the player does not see a gap and skip to "…" during it.
let tail = S.projectFromPlainText("Baby you'll get\n(I know you want it)\nAnd I can promise", meta);
for (const t of [40000, 41000, 42000, 44800]) tail = S.tapWord(tail, 0, t).project;
for (const t of [44500, 45500, 46500, 47000, 47500, 48000]) tail = S.tapWord(tail, 1, t).project;
tail = S.markLineStart(tail, 2, 49000);
const tailOut = S.lyricsFromProject(tail);
assert.equal(tailOut[0].lineEndTime, 48000, 'the main line ends with its ad-lib');
assert.ok(tailOut[1].lineStartTime - tailOut[0].lineEndTime < S.INSTRUMENTAL_GAP_MS, 'no instrumental gap while the ad-lib is sung');
assert.equal(parseTtmlToLyrics(lyricsToTtml({ lyrics: tailOut, title: 't', artist: 'a', preserveOriginal: false })).lyrics[0].lineEndTime, 48000);

// Word-by-word timing by hand.
let manual = S.projectFromPlainText('one two three', meta);
for (const t of [1000, 2000, 3000, 4000]) manual = S.tapWord(manual, 0, t).project;
manual = S.setWordTiming(manual, 0, 1, { start: 2250 });
assert.deepEqual(words(manual.lines[0]), [['one', 1000, 2000], ['two', 2250, 3000], ['three', 3000, 4000]], 'only that word changes');
manual = S.setWordTiming(manual, 0, 0, { start: 750 });
assert.equal(manual.lines[0].start, 750, 'the first word moves the line start');
manual = S.setWordTiming(manual, 0, 2, { end: 4500 });
assert.equal(manual.lines[0].end, 4500, 'the last word moves the line end');
assert.deepEqual(words(S.setWordTiming(manual, 0, 1, { end: 1000 }).lines[0])[1], ['two', 1000 - S.MIN_WORD_MS, 1000], 'an end before the start pulls the start back');
const respelled = S.setWordText(manual, 0, 1, 'too');
assert.deepEqual(words(respelled.lines[0]), [['one', 750, 2000], ['too', 2250, 3000], ['three', 3000, 4500]], 'a spelling fix keeps the timing');
assert.equal(S.lineText(respelled.lines[0]), 'one too three', 'and the spacing');
assert.equal(S.setWordText(manual, 0, 1, '   '), manual, 'an empty word is refused');
assert.equal(S.parseTimeInput('1:23.45'), 83450);
assert.equal(S.parseTimeInput('83.45'), 83450);
assert.equal(S.parseTimeInput('2.5s'), 2500);
assert.equal(S.parseTimeInput('1200ms'), 1200);
assert.equal(S.parseTimeInput('abc'), null);

// Several words moved at once.
const several = S.shiftWords(manual, 0, [1, 2], -100);
assert.deepEqual(words(several.lines[0]), [['one', 750, 2000], ['two', 2150, 2900], ['three', 2900, 4400]]);
assert.equal(several.lines[0].end, 4400, 'moving the last word moves the line end');

// Apply timing to all similar lines: exact wording, same kind, each keeps its own place.
let chorus = S.projectFromPlainText('Hold on tight\n(hold on tight)\nSomething else\nHold on tight\nhold on tight\nHold on tight', meta);
for (const t of [10000, 10400, 11000, 12000]) chorus = S.tapWord(chorus, 0, t).project;
chorus = S.markLineStart(chorus, 3, 30000);
chorus = S.tapWord(chorus, 1, 50000).project;
assert.deepEqual(S.matchingLines(chorus, 0), [3, 5], 'same words, main lines only (not the ad-lib, not different case)');
const copied = S.applyTimingToMatchingLines(chorus, 0);
assert.equal(copied.applied, 1);
assert.equal(copied.skipped, 1, 'a match with no timing yet is skipped');
assert.deepEqual(words(copied.project.lines[3]), [['Hold', 30000, 30400], ['on', 30400, 31000], ['tight', 31000, 32000]], 'same rhythm, at its own start');
assert.equal(copied.project.lines[3].end, 32000);
assert.equal(copied.project.lines[1].words[1].start, null, 'the ad-lib with the same words is untouched');
assert.deepEqual(S.matchingLines(chorus, 1), [], 'ad-libs only match ad-libs');
assert.equal(S.applyTimingToMatchingLines(chorus, 3).applied, 0, 'a line without full word timing cannot be copied');
// Lines that are already word-synced keep their timing unless included.
let resynced = copied.project;
for (const t of [60000, 60200, 60300, 61000]) resynced = S.tapWord(resynced, 5, t).project;
const kept = S.applyTimingToMatchingLines(resynced, 0);
assert.equal(kept.applied, 0);
assert.equal(kept.keptSynced, 2, 'synced matches are left alone by default');
assert.equal(kept.project, resynced);
const included = S.applyTimingToMatchingLines(resynced, 0, { includeSynced: true });
assert.equal(included.applied, 2);
assert.deepEqual(words(included.project.lines[5]), [['Hold', 60000, 60400], ['on', 60400, 61000], ['tight', 61000, 62000]], 'included lines get the copied rhythm');

// Songs that open on an ad-lib: a line with only background vocals stays an ad-lib row.
const opener = S.projectFromLyrics([
  { lineStartTime: 2000, lineEndTime: 3500, syllables: [], backgroundSyllables: [
    { text: '(Ooh ', startTime: 2000, endTime: 2600 }, { text: 'yeah)', startTime: 2600, endTime: 3500 }] },
  { lineStartTime: 6000, lineEndTime: 8000, syllables: [{ text: 'First line', startTime: 6000, endTime: 8000 }] },
], meta);
assert.deepEqual(opener.lines.map((row) => [S.lineText(row), row.background, Boolean(row.instrumental)]),
  [['Ooh yeah', true, false], ['First line', false, false]], 'the opening ad-lib is kept, not turned into a break');
const openerOut = S.lyricsFromProject(opener);
assert.equal(openerOut.length, 1);
assert.equal(openerOut[0].lineStartTime, 2000, 'the first line starts when its opening ad-lib does');
assert.deepEqual(openerOut[0].backgroundSyllables.map((x) => x.startTime), [2000, 2600]);
const openerTtml = lyricsToTtml({ lyrics: openerOut, title: 'x', artist: 'y', preserveOriginal: false });
assert.match(openerTtml, /<p begin="00:00:02.000"/);
const bgOnly = parseTtmlToLyrics('<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word"><body><div>'
  + '<p begin="00:02.000" end="00:03.500"><span ttm:role="x-bg"><span begin="00:02.000" end="00:03.500">(Ooh)</span></span></p>'
  + '<p begin="00:06.000" end="00:08.000"><span begin="00:06.000" end="00:08.000">First</span></p></div></body></tt>');
const bgLyrics = bgOnly.lyrics ?? bgOnly;
assert.equal(bgLyrics.length, 2, 'a paragraph with only an ad-lib is imported');
assert.equal(S.projectFromLyrics(bgLyrics, meta).lines[0].background, true);

// Lines stage: re-tapping a word-synced line moves the whole line (2:13 → 2:08).
let moved = S.projectFromPlainText('a b', meta);
for (const t of [133000, 133500]) moved = S.tapWord(moved, 0, t).project;
moved = S.endLastWord(moved, 0, 134000);
const retapped = S.markLineStart(moved, 0, 128000);
assert.deepEqual(words(retapped.lines[0]), [['a', 128000, 128500], ['b', 128500, 129000]]);
assert.equal(S.rowStart(retapped.lines[0]), 128000);
assert.equal(retapped.lines[0].end, 129000);

// "Adjust timing": set a line's start and end by hand.
const typed = S.setLineTiming(moved, 0, { start: 128000 });
assert.deepEqual(words(typed.lines[0]), words(retapped.lines[0]), 'a typed start moves a word-synced line as a whole');
const ended = S.setLineTiming(typed, 0, { end: 130000 });
assert.equal(ended.lines[0].end, 130000);
assert.equal(ended.lines[0].words[1].end, 130000, 'the last word ends with the line');
assert.equal(S.setLineTiming(typed, 0, { end: 100 }).lines[0].end, 128500 + S.MIN_WORD_MS, 'an end never falls before the last word starts');
let plainRow = S.markLineStart(S.projectFromPlainText('x y', meta), 0, 5000);
plainRow = S.setLineTiming(plainRow, 0, { end: 7000 });
plainRow = S.setLineTiming(plainRow, 0, { start: 4000 });
assert.deepEqual([plainRow.lines[0].start, plainRow.lines[0].end], [4000, 7000], 'a line-synced row keeps its end when the start moves');

// Syllables: split a word, time each part, export as one word (isPartOfWord).
let syl = S.projectFromPlainText('say something', meta);
assert.deepEqual(S.wordGroups(syl.lines[0]), [{ from: 0, to: 0 }, { from: 1, to: 1 }]);
syl = S.toggleSplit(syl, 0, { from: 1, to: 1 }, 4);
assert.deepEqual(syl.lines[0].words.map((w) => [w.text, Boolean(w.joinNext)]), [['say ', false], ['some', true], ['thing', false]]);
assert.equal(S.unitSeparator(syl.lines[0], 1), '·', 'shown as some·thing');
assert.equal(S.unitSeparator(syl.lines[0], 0), ' ');
assert.deepEqual(S.wordGroups(syl.lines[0]), [{ from: 0, to: 0 }, { from: 1, to: 2 }]);
assert.equal(S.lineText(syl.lines[0]), 'say something', 'splitting never changes the text');
assert.equal(S.toggleSplit(syl, 0, { from: 1, to: 2 }, 4).lines[0].words.length, 2, 'toggling the same place joins it again');
const sylTimed = S.splitUnit(S.setWordTiming(S.setWordTiming(S.projectFromPlainText('abcd', meta), 0, 0, { start: 1000 }), 0, 0, { end: 2000 }), 0, 0, 1);
assert.deepEqual(words(sylTimed.lines[0]), [['a', 1000, 1250], ['bcd', 1250, 2000]], 'a timed word shares its time by letters');
for (const t of [100, 400, 700]) syl = S.tapWord(syl, 0, t).project;
const sylOut = S.lyricsFromProject(syl)[0].syllables;
assert.deepEqual(sylOut.map((x) => [x.text, x.isPartOfWord]), [['say ', false], ['some', true], ['thing', false]]);
assert.match(S.lyricsFromProject(syl).length ? lyricsToTtml({ lyrics: S.lyricsFromProject(syl), title: 't', artist: 'a', preserveOriginal: false }) : '', />some<\/span><span[^>]*>thing</, 'no space inside the word in TTML');
assert.equal(S.unitSeparator(S.projectFromPlainText('夜空', meta).lines[0], 0), '', 'no dots between CJK characters');

// Tap keys: F starts, G commits (ends and starts the next), H ends (leaving a gap).
let keys = S.projectFromPlainText('one two three', meta);
keys = S.tapWord(keys, 0, 1000).project;                  // F: one starts
assert.equal(S.openUnit(keys.lines[0]), 0);
let hEnd = S.tapEnd(keys, 0, 1400);                      // H: one ends
assert.deepEqual([hEnd.ended, hEnd.finished], [true, false]);
keys = hEnd.project;
assert.equal(S.openUnit(keys.lines[0]), -1);
keys = S.tapWord(keys, 0, 2000).project;                  // F after a gap: two starts
keys = S.tapWord(keys, 0, 2500).project;                  // G: two ends, three starts
assert.deepEqual(words(keys.lines[0]), [['one', 1000, 1400], ['two', 2000, 2500], ['three', 2500, null]], 'the gap after H is kept');
assert.equal(S.tapEnd(S.projectFromPlainText('x', meta), 0, 10).ended, false, 'H with nothing open does nothing here');
const lastEnd = S.tapEnd(S.tapWord(S.tapWord(S.projectFromPlainText('a b', meta), 0, 100).project, 0, 300).project, 0, 900);
assert.deepEqual([lastEnd.ended, lastEnd.finished, lastEnd.project.lines[0].end], [true, true, 900], 'H on the last unit finishes the line');

// Batch: several picked lines (main lines and ad-libs) each copy to their own kind; picked lines are never overwritten.
let batch = S.projectFromPlainText('A b c\n(x y)\nD e\nA b c\n(x y)\nD e\nx y', meta);
for (const t of [1000, 1200, 1400]) batch = S.tapWord(batch, 0, t).project;
batch = S.tapEnd(batch, 0, 1800).project;
for (const t of [1500, 1700]) batch = S.tapWord(batch, 1, t).project;
batch = S.tapEnd(batch, 1, 2000).project;
batch = S.markLineStart(batch, 3, 10000);
batch = S.markLineStart(batch, 6, 30000);
batch = S.tapWord(batch, 4, 11000).project;
const batched = S.applyTimingFromLines(batch, [0, 1]);
assert.deepEqual(words(batched.project.lines[3]), [['A', 10000, 10200], ['b', 10200, 10400], ['c', 10400, 10800]], 'main line from the main source');
assert.deepEqual(words(batched.project.lines[4]), [['x', 11000, 11200], ['y', 11200, 11500]], 'ad-lib from the ad-lib source');
assert.equal(batched.project.lines[6], batch.lines[6], 'a main line with the ad-lib\'s words is not touched');
assert.equal(batched.applied, 2);
assert.equal(batched.skipped, 0);
const guarded = S.applyTimingFromLines(batched.project, [0, 3], { includeSynced: true });
assert.deepEqual(words(guarded.project.lines[3]), words(batched.project.lines[3]), 'a picked line is never overwritten by another picked line');

// Duet: main lines can be the other singer; ad-libs and instrumentals stay with their line; exported as agent v2.
let duet = S.projectFromPlainText('One line\n(echo)\nTwo line\n#INSTRUMENTAL\nThree line', meta);
duet = S.setDuet(duet, [0, 1, 3, 4], true);
assert.deepEqual(duet.lines.map((row) => Boolean(row.oppositeAligned)), [true, false, false, false, true], 'ad-lib and instrumental rows are not marked');
assert.equal(S.setDuet(duet, [0], true), duet, 'already a duet: nothing changes');
duet = S.setDuet(duet, [4], false);
assert.equal(duet.lines[4].oppositeAligned, undefined, 'back to the main singer');
assert.equal(S.insertLineAfter(duet, 0, 'New one').lines[1].oppositeAligned, true, 'a line added below a duet line keeps the singer');
assert.equal(S.insertLineAfter(duet, 0, 'echo', true).lines[1].oppositeAligned, undefined);
for (const [i, t] of [[0, 1000], [0, 1400], [0, 1800]]) duet = S.tapWord(duet, i, t).project;
duet = S.markLineStart(duet, 2, 3000);
const duetOut = S.lyricsFromProject(duet);
assert.equal(duetOut[0].oppositeAligned, true);
assert.equal(duetOut[1].oppositeAligned, undefined);
assert.match(lyricsToTtml({ lyrics: duetOut, title: 't', artist: 'a', preserveOriginal: false }), /ttm:agent="v2"/);

// Spelling fixes can reach every line with exactly the same text, keeping timing.
let spell = S.projectFromPlainText('I love yuo\n(I love yuo)\nSomething else\nI love yuo', meta);
spell = S.toggleSplit(spell, 3, { from: 1, to: 1 }, 2);   // line 3 split differently: I lo·ve yuo
for (const t of [1000, 1300, 1700]) spell = S.tapWord(spell, 0, t).project;
assert.deepEqual(S.sameTextLines(spell, 0), [1, 3]);
const fixedOne = S.setWordTextEverywhere(spell, 0, 2, 'you');
assert.deepEqual(fixedOne.lines.map((row) => S.lineText(row)), ['I love you', 'I love yuo', 'Something else', 'I love yuo'], 'only this line');
const fixedAll = S.setWordTextEverywhere(spell, 0, 2, 'you', S.sameTextLines(spell, 0));
assert.deepEqual(fixedAll.lines.map((row) => S.lineText(row)), ['I love you', 'I love you', 'Something else', 'I love you']);
assert.deepEqual(words(fixedAll.lines[0]).at(-1), ['you', 1700, null], 'timing kept');

// Unlinked edges: only starts or only ends move, never past each other.
let edges = S.projectFromPlainText('one two three', meta);
for (const t of [1000, 2000, 3000]) edges = S.tapWord(edges, 0, t).project;
edges = S.tapWord(edges, 0, 4000).project;
const startsLater = S.shiftWordEdges(edges, 0, [0, 1], 250, 'start');
assert.deepEqual(words(startsLater.lines[0]), [['one', 1250, 2000], ['two', 2250, 3000], ['three', 3000, 4000]]);
assert.equal(startsLater.lines[0].start, 1250, 'the line start follows the first word');
const endsEarlier = S.shiftWordEdges(edges, 0, [2], -5000, 'end');
assert.deepEqual(words(endsEarlier.lines[0]).at(-1), ['three', 3000, 3000 + S.MIN_WORD_MS], 'an end never passes its start');
assert.deepEqual(words(S.shiftWords(edges, 0, [1], 100).lines[0])[1], ['two', 2100, 3100], 'linked: both move');

// Split similar lines: same text, however split; lines split differently kept unless included.
let sim = S.projectFromPlainText('say something\nsay something\nsay something\n(say something)\nsay something', meta);
sim = S.toggleSplit(sim, 0, { from: 1, to: 1 }, 4);            // line 0: say some·thing
sim = S.toggleSplit(sim, 2, { from: 1, to: 1 }, 2);            // line 2: say so·mething (different)
for (const t of [5000, 5600, 6000]) sim = S.tapWord(sim, 1, t).project; // line 1 unsplit, word-synced (third tap ends it)
assert.deepEqual(S.matchingLines(sim, 0), [1, 2, 4], 'split differently still matches; the ad-lib does not');
const units = (row) => row.words.map((w) => w.text.trim()).join('|');
const splitCopy = S.copySplitsToMatchingLines(sim, 0);
assert.deepEqual([splitCopy.applied, splitCopy.same, splitCopy.keptDifferent], [2, 0, 1]);
assert.equal(units(splitCopy.project.lines[1]), 'say|some|thing');
assert.equal(units(splitCopy.project.lines[2]), 'say|so|mething', 'split differently: kept');
assert.equal(units(splitCopy.project.lines[4]), 'say|some|thing');
assert.deepEqual(words(splitCopy.project.lines[1]).slice(1), [['some', 5600, 5778], ['thing', 5778, 6000]], 'synced timing shared by letters (4 of 9)');
assert.equal(S.isLineWordSynced(splitCopy.project.lines[1]), true);
const splitAll = S.copySplitsToMatchingLines(sim, 0, { includeDifferent: true });
assert.equal(splitAll.applied, 3);
assert.equal(units(splitAll.project.lines[2]), 'say|some|thing', 'ticked: different splits replaced');
assert.equal(S.copySplitsToMatchingLines(splitAll.project, 0).same, 3, 'already split this way');
// Copying timing from a split line also copies its splits.
let timedSplit = S.markLineStart(sim, 4, 20000);
for (const t of [1000, 1300, 1700]) timedSplit = S.tapWord(timedSplit, 0, t).project;
timedSplit = S.tapEnd(timedSplit, 0, 2100).project;
const copiedSplit = S.applyTimingToMatchingLines(timedSplit, 0);
assert.deepEqual(words(copiedSplit.project.lines[4]), [['say', 20000, 20300], ['some', 20300, 20700], ['thing', 20700, 21100]]);
assert.equal(copiedSplit.project.lines[4].words[1].joinNext, true);

// Guessed syllables: English (hyphenation patterns + spelling rules) and Hindi (aksharas, schwa deletion).
const dotted = (text) => { const letters = SW.characters(text); let out = ''; let from = 0;
  for (const at of SY.guessBreaks(text, /[\u0900-\u097F]/u.test(text) ? 'hi' : 'en')) { out += `${letters.slice(from, at).join('')}·`; from = at; } return out + letters.slice(from).join(''); };
for (const [word, expected] of [['something', 'some·thing'], ['beautiful,', 'beau·ti·ful,'], ['singing', 'sing·ing'], ['thing', 'thing'],
  ['tonight', 'to·night'], ['somebody', 'some·bo·dy'], ['little', 'lit·tle'], ["baby's", "ba·by's"], ['love', 'love'], ['(yeah', '(yeah'],
  ['दिल', 'दिल'], ['प्यार', 'प्यार'], ['समझना', 'स·मझ·ना'], ['जानता', 'जान·ता'], ['कहानी', 'क·हा·नी'], ['इश्क़', 'इश्क़'], ['हुए।', 'हु·ए।']]) {
  assert.equal(dotted(word), expected, `guess for ${word}`);
}
// "Remove all splits": a word becomes one unit again, first start to last end.
let joinAll = S.projectFromPlainText('say beautiful', meta);
joinAll = S.toggleSplit(joinAll, 0, { from: 1, to: 1 }, 4);
joinAll = S.toggleSplit(joinAll, 0, { from: 1, to: 2 }, 6);
assert.deepEqual(joinAll.lines[0].words.map((w) => w.text.trim()), ['say', 'beau', 'ti', 'ful']);
for (const t of [100, 400, 700, 900]) joinAll = S.tapWord(joinAll, 0, t).project;
joinAll = S.tapEnd(joinAll, 0, 1300).project;
const joined = S.joinWordGroup(joinAll, 0, { from: 1, to: 3 });
assert.deepEqual(words(joined.lines[0]), [['say', 100, 400], ['beautiful', 400, 1300]]);
assert.equal(joined.lines[0].words[1].joinNext, undefined);
assert.equal(S.lineText(joined.lines[0]), 'say beautiful');
assert.equal(S.joinWordGroup(joined, 0, { from: 0, to: 0 }), joined, 'an unsplit word is left as it is');

// Other languages: each guesses only its own script, so a mixed song is done language by language.
const dottedIn = (language, text) => { const letters = SW.characters(text); let out = ''; let from = 0;
  for (const at of SY.guessBreaks(text, language)) { out += `${letters.slice(from, at).join('')}·`; from = at; } return out + letters.slice(from).join(''); };
for (const [language, word, expected] of [
  ['es', 'corazón,', 'co·ra·zón,'], ['es', 'amor', 'a·mor'], ['es', 'despacito', 'des·pa·ci·to'],
  ['pt', 'saudade', 'sau·da·de'], ['it', 'amore', 'a·mo·re'], ['fr', 'toujours', 'tou·jours'], ['fr', "aujourd'hui", "au·jour·d'hui"],
  ['de', 'zusammen', 'zu·sam·men'], ['id', 'selamanya', 'se·la·ma·nya'], ['tr', 'seviyorum', 'se·vi·yo·rum'],
  ['pl', 'dziewczyna', 'dziew·czy·na'], ['ru', 'навсегда', 'на·все·гда'],
  ['pa', 'ਦਿਲ', 'ਦਿਲ'], ['pa', 'ਪਿਆਰ', 'ਪਿ·ਆਰ'], ['pa', 'ਮਿਲਣਾ', 'ਮਿਲ·ਣਾ'], ['pa', 'ਪੱਕਾ', 'ਪੱ·ਕਾ'],
  ['ko', '사랑해', '사·랑·해'], ['ko', '(너를', '(너·를'],
  ['es', 'समझना', 'समझना'], ['hi', 'corazón', 'corazón'], ['en', 'corazón', 'corazón'], ['ru', 'love', 'love'], ['ko', 'ਦਿਲ', 'ਦਿਲ'],
]) assert.equal(dottedIn(language, word), expected, `${language} guess for ${word}`);
assert.ok(SY.SYLLABLE_LANGUAGES.length >= 13);
let mixedLanguages = S.projectFromPlainText('Tum mera dil समझना corazón', meta);
mixedLanguages = SY.guessSongSyllables(mixedLanguages, 'hi').project;
assert.deepEqual(mixedLanguages.lines[0].words.map((w) => w.text.trim()), ['Tum', 'mera', 'dil', 'स', 'मझ', 'ना', 'corazón'], 'Hindi touches only Devanagari words');
mixedLanguages = SY.guessSongSyllables(mixedLanguages, 'es').project;
assert.equal(mixedLanguages.lines[0].words.map((w) => w.text.trim()).slice(-3).join('|'), 'co|ra|zón');
let guessed = S.projectFromPlainText('Something beautiful\n(singing)\nसमझना दिल', meta);
guessed = S.toggleSplit(guessed, 0, { from: 1, to: 1 }, 5);   // a hand-made split: beaut·iful
const englishGuess = SY.guessSongSyllables(guessed, 'en');
const hindiGuess = SY.guessSongSyllables(englishGuess.project, 'hi');
const songGuess = { project: hindiGuess.project, words: englishGuess.words + hindiGuess.words };
assert.equal(songGuess.words, 3, 'something, singing, समझना (दिल has one syllable)');
assert.deepEqual(songGuess.project.lines.map((row) => row.words.map((w) => w.text.trim()).join('|')),
  ['Some|thing|beaut|iful', 'sing|ing', 'स|मझ|ना|दिल'], 'words already split are left alone');
assert.equal(S.lineText(songGuess.project.lines[0]), 'Something beautiful', 'the text never changes');
assert.equal(SY.guessLineSyllables(songGuess.project, 0).words, 0, 'guessing again changes nothing');

// A finished line moves on at once; a delayed move let a quick Commit restart the finished line later in time.
const screenSource = (await import('node:fs')).readFileSync(path.join(root, 'components/sync-studio/sync-studio-screen.tsx'), 'utf8');
assert.ok(!/setTimeout\(advanceWords/.test(screenSource), 'no delayed move to the next line');
assert.match(screenSource, /const cursor = cursorRef\.current;/);
// "Last G: End": Commit on the last word ends the line like End instead of carrying on.
assert.match(screenSource, /if \(key === 'commit' && settings\.lastCommitEnds\) \{\n\s+apply\(\(p\) => tapEnd\(p, cursor, time\)\.project\);/);
// Leaving on purpose asks before keeping changes (back arrow and Android back); saving to the vault resets that.
assert.equal((screenSource.match(/else leaveProject\(\)/g) || []).length, 2);
assert.match(screenSource, /saveMobileVaultLyrics\([^)]*\);\n\s+\/\/ What is in the vault[^\n]*\n\s+studio\.markSaved\(\);/);
const hookSource = (await import('node:fs')).readFileSync(path.join(root, 'components/sync-studio/use-sync-studio.ts'), 'utf8');
assert.match(hookSource, /else if \(current && original\?\.wasDraft\) remember\(original\.project\);/, 'discard puts the opened version back');
// Commit onto the next line is two undo steps, so Undo restores that line's old sync and keeps this one finished.
assert.match(screenSource, /apply\(\(p\) => tapWord\(p, cursor, time\)\.project\);\n\s+const resyncing/);
// The tapped-row marker resets the moment the cursor moves, never in an effect after the render:
// a quick Start then Commit on a new line would otherwise restart it (the blue word lagged by one).
assert.ok(!/useEffect\(\(\) => \{ tappingRow\.current = -1; \}, \[cursor\]\)/.test(screenSource));
assert.match(screenSource, /if \(index !== cursorRef\.current\) \{ tappingRow\.current = -1;/);
assert.ok(!/[^.]setCursor\((?!index\))/.test(screenSource.replace('const [cursor, setCursor] = useState(0);', '')), 'every move goes through moveCursor');

console.log('Sync Studio checks passed: line marks, tap and swipe timing, ad-libs, editing, slide bar (free zone, sliding back), word spacing, instrumental breaks, ad-libs from words, word timing by hand, copying timing to matching lines, vault lyrics and Spicy-ready TTML.');
