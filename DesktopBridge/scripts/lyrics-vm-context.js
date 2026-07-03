"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const PART_FILES = [
  "01-matching-and-parsing.js",
  "02-network-and-spotify.js",
  "03-qq-sources.js",
  "04-netease-spicy-lrclib-sources.js",
  "04-kugou-source.js",
  "05-musixmatch-source.js",
  "06-translation.js",
  "08-local-vault-source.js",
  "07-selection-and-service.js",
];

function loadLyricsVmContext() {
  const srcRequire = createRequire(
    path.join(__dirname, "..", "src", "lyricsService.js"),
  );
  const moduleShim = { exports: {} };
  const context = vm.createContext({
    AbortController,
    Buffer,
    clearInterval,
    clearTimeout,
    console,
    fetch,
    global: {},
    module: moduleShim,
    exports: moduleShim.exports,
    process,
    require: srcRequire,
    setInterval,
    setTimeout,
    TextDecoder,
    URL,
    URLSearchParams,
    __dirname: path.join(__dirname, "..", "src"),
    __filename: path.join(__dirname, "..", "src", "lyricsService.js"),
  });
  for (const fileName of PART_FILES) {
    const filePath = path.join(__dirname, "..", "src", "lyrics", "parts", fileName);
    vm.runInContext(fs.readFileSync(filePath, "utf8"), context, {
      filename: filePath,
    });
  }
  return context;
}

module.exports = {
  loadLyricsVmContext,
};
