"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { syncText, preservationFingerprint } = require("./sync-musixmatch-core.cjs");

const root = path.resolve(__dirname, "../..");
const mobilePath = path.join(root, "ExpoLyrics/lib/mobile-lyrics-service.js");

test("Musixmatch sync updates only declared source functions and constants", () => {
  const mobile = fs.readFileSync(mobilePath, "utf8");
  const adapterStart = mobile.indexOf("function makeMobileSafeHeaders");
  const adapterEnd = mobile.indexOf("function wordArrayToBase64", adapterStart);
  const adapter = mobile.slice(adapterStart, adapterEnd);
  const drifted = mobile.replace('profileId: "mac-ios-v2.0@apic-appmobile"', 'profileId: "drifted-profile"');
  assert.notEqual(drifted, mobile, "test fixture contains a deliberate Musixmatch profile drift");
  const output = syncText(drifted, (file) => fs.readFileSync(path.join(root, "DesktopBridge/src/lyrics/parts", file), "utf8"));
  assert.equal(output, mobile, "scoped sync restores the generated declarations");
  assert.equal(syncText(output, (file) => fs.readFileSync(path.join(root, "DesktopBridge/src/lyrics/parts", file), "utf8")), output, "generation is deterministic and idempotent");
  assert.ok(output.includes("baseUrls: [MUSIXMATCH_APP_MOBILE_PROFILE.baseUrl]"));
  assert.ok(output.includes("namespace: \"lyrics_richsynched\""));
  assert.ok(output.includes("function makeMobileSafeHeaders"));
  assert.ok(output.includes("function fetchMusixmatchText"));
  assert.ok(output.includes("headers: makeMobileSafeHeaders({"));
  assert.equal(output.slice(adapterStart, adapterStart + adapter.length), adapter, "mobile request adapter stays byte-for-byte unchanged");
});

test("non-Musixmatch code and mobile adapters preserve the development 680da25 baseline", () => {
  const mobile = fs.readFileSync(mobilePath, "utf8");
  // Computed from git show 680da25:ExpoLyrics/lib/mobile-lyrics-service.js after masking
  // only the scoped declarations and refreshMusixmatchUserToken(...) call expression.
  assert.equal(preservationFingerprint(mobile), "abda96e64140e6fa4eb71446c1b5d6488d2fce8046f1aed28eb686e762be8459");
  const changedUnrelatedBranch = mobile.replace('source !== "musixmatch"', 'source !== "unrelated-source"');
  assert.notEqual(preservationFingerprint(changedUnrelatedBranch), preservationFingerprint(mobile));
});
