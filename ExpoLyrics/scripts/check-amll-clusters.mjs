import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { countGraphemes, graphemeSegments, splitGraphemes } from "unicode-segmenter/grapheme";
import { patchAmllClusters } from "./amll-cluster-patch.mjs";

const original = await readFile(new URL("../node_modules/@applemusic-like-lyrics/core/dist/amll-core.mjs", import.meta.url), "utf8");
const patched = patchAmllClusters(original);
const region = (name) => {
  const start = patched.indexOf(`//#region ${name}`);
  assert.ok(start >= 0, `AMLL region exists: ${name}`);
  return patched.slice(start, patched.indexOf("//#endregion", start));
};
const context = vm.createContext({ splitGraphemes, graphemeSegments, countGraphemes, Intl: {} });
vm.runInContext(region("src/utils/is-cjk.ts") + "\n" + region("src/utils/lyric-split-words.ts"), context);
const splitWords = context.chunkAndSplitLyricWords;
for (const text of ["क्षि", "किताब", "క్షి", "నీకు", "น้ำ", "กิ้", "光の"]) {
  const words = splitWords([{ word: text, startTime: 1000, endTime: 5000 }]).flat();
  assert.equal(words.map(word => word.word).join(""), text);
  assert.deepEqual(Array.from(words, word => word.word), Array.from(splitGraphemes(text)), text);
  assert.equal(words[0].startTime, 1000);
  assert.equal(words.at(-1).endTime, 5000, `cluster splitting preserves timing span: ${text}`);
  for (let i = 1; i < words.length; i++) assert.equal(words[i].startTime, words[i - 1].endTime);
}
for (const text of ["한글", "Hello"]) {
  const words = splitWords([{ word: text, startTime: 1000, endTime: 5000 }]).flat();
  assert.equal(words.length, 1, 'existing non-CJK grouping stays intact');
  assert.equal(words[0].word, text);
}
assert.throws(() => patchAmllClusters("upstream changed"), /no longer matches upstream/);
console.log("AMLL preprocessing checks passed: Thai/Indic/CJK clusters, contiguous timing, missing Intl and upstream patch guard.");
