"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { dispatchClientPacket } = require("../src/bridgeProtocol");

test("translation language reaches the desktop and old clients default to English", () => {
  const emitter = new EventEmitter();
  const requests = [];
  emitter.on("lyricsRefreshRequested", request => requests.push(request));
  dispatchClientPacket(emitter, { type: "lyrics:refresh", immediateTranslation: true, translationLanguage: "Telugu" });
  dispatchClientPacket(emitter, { type: "lyrics:refresh", immediateTranslation: true });
  assert.equal(requests[0].translationLanguage, "Telugu");
  assert.equal(requests[1].translationLanguage, "English");
});

test("translations use the selected language and cache separately for each language", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  // The service captures fetch when loaded; isolate it from other test modules.
  const servicePath = require.resolve("../src/lyrics");
  const existingModule = require.cache[servicePath];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const payload = JSON.parse(body.contents[0].parts[0].text);
    requests.push({ payload, system: body.systemInstruction.parts[0].text });
    const translated = payload.targetLanguage === "Spanish" ? "Hola mundo" : "Hello world";
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ lineCount: 1, translations: [{ i: 0, t: translated }] }) }] } }] }) };
  };
  delete require.cache[servicePath];
  try {
    const { createLyricsService } = require("../src/lyrics");
    const service = createLyricsService({ getGeminiApiKey: () => "test-key" });
    const track = { trackId: "language-test", title: "Song", artist: "Artist", durationMs: 4000 };
    service.rememberPublishedLyrics(track.trackId, { trackId: track.trackId, source: "local-vault", lyrics: [{ startTime: 0, endTime: 4000, syllables: [{ text: "Bonjour le monde", startTime: 0, endTime: 4000 }] }] });
    const english = await service.translatePublishedLyrics(track);
    const spanish = await service.translatePublishedLyrics(track, { translationLanguage: "Spanish" });
    const cached = await service.translatePublishedLyrics(track, { translationLanguage: "Spanish" });
    assert.equal(english.lyrics[0].translatedText, "Hello world");
    assert.equal(spanish.lyrics[0].translatedText, "Hola mundo");
    assert.equal(cached.lyrics[0].translatedText, "Hola mundo");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].payload.targetLanguage, "Spanish");
    assert.match(requests[1].system, /natural Spanish/);
    assert.doesNotMatch(requests[1].system, /Already-English/);
  } finally {
    global.fetch = originalFetch;
    delete require.cache[servicePath];
    if (existingModule) require.cache[servicePath] = existingModule;
  }
});
