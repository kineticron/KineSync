"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const partFiles = [
  "01a-text-normalization.js",
  "01b-candidate-matching.js",
  "01c-fingerprinting.js",
  "01d-lyrics-parsing.js",
  "01e-utilities.js",
  "02-network-and-spotify.js",
  "03-qq-sources.js",
  "04-netease-spicy-lrclib-sources.js",
  "04-kugou-source.js",
  "05a-musixmatch-client.js",
  "05b-musixmatch-parsing.js",
  "06-translation.js",
  "08-local-vault-source.js",
  "07a-source-scoring.js",
  "07b-service-orchestration.js",
  "07c-module-exports.js",
];

function loadLyricsService() {
  const srcRequire = createRequire(path.join(__dirname, "..", "lyricsService.js"));
  const moduleShim = { exports: {} };
  const context = vm.createContext({
    AbortController,
    Buffer,
    clearInterval,
    clearTimeout,
    console,
    fetch,
    global,
    module: moduleShim,
    exports: moduleShim.exports,
    process,
    require: srcRequire,
    setInterval,
    setTimeout,
    TextDecoder,
    URL,
    URLSearchParams,
    __dirname: path.join(__dirname, ".."),
    __filename: path.join(__dirname, "..", "lyricsService.js"),
  });

  for (const fileName of partFiles) {
    const filePath = path.join(__dirname, "parts", fileName);
    const source = fs.readFileSync(filePath, "utf8");
    vm.runInContext(source, context, { filename: filePath });
  }

  return moduleShim.exports;
}

module.exports = loadLyricsService();