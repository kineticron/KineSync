"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { extractSpicyPayloadMetadata } = require("../src/lyrics");

test("Spicy attribution identifies Apple Music lyrics", () => {
  const metadata = extractSpicyPayloadMetadata({ source: "aml" });

  assert.equal(metadata.attribution.source, "aml");
  assert.equal(metadata.attribution.provider, "Apple Music");
  assert.equal(metadata.attribution.community, undefined);
});

test("Spicy attribution preserves community maker and uploader credit", () => {
  const metadata = extractSpicyPayloadMetadata({
    source: "spl",
    TTMLUploadMetadata: {
      Maker: {
        id: "maker-id",
        username: "lyric-maker",
        avatar: "https://example.com/maker.png",
      },
      Uploader: {
        id: "uploader-id",
        username: "lyric-uploader",
        avatar: "https://example.com/uploader.png",
      },
    },
  });

  assert.equal(metadata.attribution.provider, "Spicy Lyrics");
  assert.equal(metadata.attribution.community, true);
  assert.equal(metadata.attribution.maker.username, "lyric-maker");
  assert.equal(metadata.attribution.uploader.username, "lyric-uploader");
});
