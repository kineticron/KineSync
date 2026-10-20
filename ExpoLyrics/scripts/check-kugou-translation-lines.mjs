// Kugou KRC files for non-Chinese songs sometimes interleave a Chinese
// translation line after each lyric line. Those lines must be dropped; real
// Chinese songs and Japanese songs (kanji with kana) must be kept intact.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const servicePath = path.join(root, 'lib/mobile-lyrics-service.js');
const bundled = await build({
  entryPoints: [servicePath], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{
    name: 'expose',
    setup(b) {
      b.onLoad({ filter: /mobile-lyrics-service\.js$/ }, () => ({
        contents: `${fs.readFileSync(servicePath, 'utf8')}\nexport { parseKugouKrc as __parseKugouKrc, finalizeFetchedLyricsResult as __finalize };\n`,
        loader: 'js', resolveDir: path.dirname(servicePath),
      }));
    },
  }],
});
const { __parseKugouKrc: parse, __finalize: finalize } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const krc = (texts) => texts.map((text, index) => {
  const start = 1000 + index * 4000;
  const words = text.split(' ');
  return `[${start},3000]${words.map((word, w) => `<${w * 500},500,0>${word}${w < words.length - 1 ? ' ' : ''}`).join('')}`;
}).join('\n');
const textOf = (lines) => lines.map((line) => line.syllables.map((s) => s.text).join('').trim());

const english = ['I never felt so alive', 'Underneath the city lights', 'Hold me close tonight', 'We are dancing in the dark'];
const chinese = ['我从未感到如此鲜活', '在城市的灯光下', '今晚紧紧抱住我', '我们在黑暗中起舞'];
const interleaved = english.flatMap((line, index) => [line, chinese[index]]);
assert.deepEqual(textOf(parse(krc(interleaved))), english, 'interleaved Chinese translation lines are dropped');

assert.deepEqual(textOf(parse(krc(english))), english, 'plain English lyrics are unchanged');
assert.deepEqual(textOf(parse(krc(chinese))), chinese, 'a Chinese song keeps its lyrics');

const japanese = ['夜空に光る星', 'I love you forever', '君の名前を呼ぶ', 'Stay with me tonight', '心が叫んでる'];
assert.deepEqual(textOf(parse(krc(japanese))), japanese, 'Japanese lyrics (kanji with kana) are kept');

// A Chinese song with a few English hooks keeps everything.
const chineseWithHooks = ['我们一起走', 'baby', '在雨中', '一起唱', 'oh yeah', '不要离开'];
assert.deepEqual(textOf(parse(krc(chineseWithHooks))), chineseWithHooks, 'Chinese songs with English hooks are kept');

// Hindi (Devanagari) lyrics with Chinese translations are cleaned too.
const hindi = ['तुम ही हो', 'अब तुम ही हो', 'ज़िंदगी अब तुम ही हो', 'चैन भी मेरा दर्द भी'];
const hindiChinese = ['你就是', '现在你就是', '我的生命就是你', '我的安宁我的痛'];
assert.deepEqual(textOf(parse(krc(hindi.flatMap((line, i) => [line, hindiChinese[i]])))), hindi, 'Hindi songs drop interleaved Chinese lines');
assert.deepEqual(textOf(parse(krc(hindi))), hindi, 'plain Hindi lyrics are unchanged');

// Korean lines (Hangul, sometimes with Hanja) are never treated as translations.
const korean = ['너를 사랑해', '漢字 노래', '밤하늘의 별', '天下 사랑', '함께 걸어요'];
assert.deepEqual(textOf(parse(krc(korean))), korean, 'Korean lyrics are kept');

// Every online source is cleaned, not only Kugou; the user's own vault is not.
const asLines = (texts) => texts.map((text, i) => ({ lineStartTime: i * 2000, lineEndTime: i * 2000 + 1500,
  syllables: [{ text, startTime: i * 2000, endTime: i * 2000 + 1500 }] }));
for (const source of ['lrclib-synced', 'netease-yrc', 'qq-qrc', 'musixmatch-richsync']) {
  const result = await finalize({ source, lyrics: asLines(interleaved) });
  assert.deepEqual(textOf(result.lyrics), english, `${source} drops interleaved Chinese lines`);
}
const vault = await finalize({ source: 'local-vault', lyrics: asLines(interleaved) });
assert.equal(vault.lyrics.length, interleaved.length, 'vault lyrics are kept as saved');

console.log('Translation-line checks passed: interleaved Chinese dropped for every online source; English, Hindi, Chinese, Japanese and Korean songs intact.');
