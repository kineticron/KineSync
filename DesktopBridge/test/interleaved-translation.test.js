"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");

function load(mobile) {
  const src = path.resolve(__dirname, "../src");
  const context = vm.createContext({
    AbortController, Buffer, clearTimeout, setTimeout, clearInterval, setInterval,
    TextDecoder, URL, URLSearchParams, console, fetch, global: {}, module: { exports: {} },
    process: { env: {} }, require: createRequire(path.join(src, "lyricsService.js")),
  });
  if (mobile) {
    let source = fs.readFileSync(path.resolve(src, "../../ExpoLyrics/lib/mobile-lyrics-service.js"), "utf8");
    source = source.replace(/^import .*;\r?\n/gm, "");
    vm.runInContext(source.slice(0, source.indexOf("export {")), context);
  } else {
    const index = fs.readFileSync(path.join(src, "lyrics/index.js"), "utf8");
    for (const match of index.match(/const partFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)) {
      vm.runInContext(fs.readFileSync(path.join(src, "lyrics/parts", match[1]), "utf8"), context);
    }
  }
  return context;
}

const krc = (texts) => texts.map((text, index) => {
  const words = text.split(" ");
  return `[${1000 + index * 4000},3000]${words.map((word, w) => `<${w * 500},500,0>${word}${w < words.length - 1 ? " " : ""}`).join("")}`;
}).join("\n");
const asLines = (texts) => texts.map((text, i) => ({
  lineStartTime: i * 2000, lineEndTime: i * 2000 + 1500,
  syllables: [{ text, startTime: i * 2000, endTime: i * 2000 + 1500 }],
}));
const textOf = (lines) => Array.from(lines, (line) => line.syllables.map((s) => s.text).join("").trim());

const english = ["I never felt so alive", "Underneath the city lights", "Hold me close tonight", "We are dancing in the dark"];
const chinese = ["我从未感到如此鲜活", "在城市的灯光下", "今晚紧紧抱住我", "我们在黑暗中起舞"];
const interleaved = english.flatMap((line, i) => [line, chinese[i]]);
const hindi = ["तुम ही हो", "अब तुम ही हो", "ज़िंदगी अब तुम ही हो", "चैन भी मेरा दर्द भी"];
const japanese = ["夜空に光る星", "I love you forever", "君の名前を呼ぶ", "Stay with me tonight", "心が叫んでる"];
const chineseWithHooks = ["我们一起走", "baby", "在雨中", "一起唱", "oh yeah", "不要离开"];

for (const mobile of [false, true]) {
  const platform = mobile ? "mobile" : "desktop";

  test(`${platform}: Kugou drops interleaved Chinese translation lines only`, () => {
    const { parseKugouKrc } = load(mobile);
    assert.deepEqual(textOf(parseKugouKrc(krc(interleaved))), english);
    assert.deepEqual(textOf(parseKugouKrc(krc(hindi.flatMap((line, i) => [line, chinese[i]])))), hindi);
    for (const song of [english, chinese, hindi, japanese, chineseWithHooks]) {
      assert.deepEqual(textOf(parseKugouKrc(krc(song))), song);
    }
  });

  test(`${platform}: other online sources drop interleaved translations, vault lyrics are kept`, async () => {
    const { finalizeFetchedLyricsResult } = load(mobile);
    for (const source of ["lrclib-synced", "netease-yrc", "qq-qrc"]) {
      const result = await finalizeFetchedLyricsResult({ source, lyrics: asLines(interleaved) });
      assert.deepEqual(textOf(result.lyrics), english, source);
    }
    const vault = await finalizeFetchedLyricsResult({ source: "local-vault", lyrics: asLines(interleaved) });
    assert.equal(vault.lyrics.length, interleaved.length);
  });
}
