// Lyric sharing: line text with syllable ranges, picked lines, and the video's time-driven motion.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(root, file)], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
};
const T = await load('lib/share/share-timeline.ts');
const A = await load('lib/active-lyric-line.ts');

// Text and ranges: spaces from the syllables, Spicy's isPartOfWord, or between letters.
const spicy = A.lyricTextWithRanges([
  { text: 'some', startTime: 0, endTime: 1, isPartOfWord: true }, { text: 'thing', startTime: 1, endTime: 2, isPartOfWord: false },
  { text: 'good', startTime: 2, endTime: 3 },
]);
assert.equal(spicy.text, 'something good');
assert.deepEqual(spicy.ranges, [[0, 4], [4, 9], [10, 14]]);
const spaced = A.lyricTextWithRanges([{ text: ' Hold ' }, { text: 'on' }]);
assert.deepEqual([spaced.text, spaced.ranges], ['Hold on', [[0, 4], [5, 7]]], 'ranges follow the trimmed text');
assert.equal(A.getPrimaryLineText({ syllables: [{ text: 'a' }, { text: 'b' }] }), 'a b');

const word = (text, startTime, endTime) => ({ text, startTime, endTime });
const lyrics = [
  { lineStartTime: 1000, lineEndTime: 2000, syllables: [word('Hello ', 1000, 1500), word('there', 1500, 2000)], backgroundSyllables: [word('(hey)', 1600, 1900)], translatedText: 'Hola' },
  { lineStartTime: 2500, lineEndTime: 3000, syllables: [word('♪', 2500, 3000)] },
  { lineStartTime: 3000, lineEndTime: 5000, syllables: [word('Whole line', 3000, 5000)] },
];
const picked = T.shareLines(lyrics, 0, 2, { translation: true });
assert.equal(picked.length, 2, 'instrumental marks are left off the card');
assert.deepEqual(picked[0].words.map((w) => [w.from, w.to]), [[0, 5], [6, 11]]);
assert.equal(picked[0].adLib, '(hey)');
assert.equal(picked[0].translation, 'Hola');
assert.equal(T.shareLines(lyrics, 0, 0)[0].translation, undefined, 'translations only when shown');
assert.equal(picked[1].wordSynced, false, 'a line-synced line lights at once');
assert.equal(T.shareLines(lyrics, 2, 0).length, 2, 'the range can be picked either way round');

// Video timing: a lead-in, a tail, frames, and motion as a pure function of time.
const win = T.videoWindow(picked);
assert.deepEqual([win.start, win.end], [1000 - T.VIDEO_LEAD_IN_MS, 5000 + T.VIDEO_TAIL_MS]);
assert.equal(T.frameCount(1000), T.VIDEO_FPS);
assert.equal(T.activeLineAt(picked, 500), 0);
assert.equal(T.activeLineAt(picked, 3200), 1);
assert.equal(T.wordProgress(picked[0].words[0], 1250), 0.5);
assert.equal(T.lineGlow(picked[0], 1500), 1);
assert.equal(T.lineGlow(picked[0], 2000 + 400), 0, 'a line fades out after it ends');

// The share button sits with the bottom player buttons, in both layouts and the full-screen album view.
const controls = readFileSync(path.join(root, 'components/lyrics/playback-controls.tsx'), 'utf8');
assert.equal((controls.match(/accessibilityLabel="Share lyrics"/g) || []).length, 2);
const player = readFileSync(path.join(root, 'app/(tabs)/index.tsx'), 'utf8');
assert.match(player, /accessibilityLabel="Share lyrics"[^\n]*onPress=\{openShareLyrics\}/);
assert.equal((player.match(/onOpenShareMenu=\{openShareLyrics\}/g) || []).length, 2);

// The encoder module's native code must be committed (android/ folders are ignored by default).
const { execFileSync } = await import('node:child_process');
for (const file of ['modules/kinesync-video-encoder/android/build.gradle',
  'modules/kinesync-video-encoder/android/src/main/java/dev/kineticron/kinesync/videoencoder/KineSyncVideoEncoderModule.kt']) {
  let ignored = true;
  try { execFileSync('git', ['check-ignore', '-q', file], { cwd: root }); } catch { ignored = false; }
  assert.equal(ignored, false, `${file} must not be git-ignored`);
}

console.log('Share checks passed: line text and ranges, picked lines, video window, time-driven word fill, share buttons.');
