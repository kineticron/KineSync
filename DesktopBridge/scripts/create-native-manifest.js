#!/usr/bin/env node

// Create the versioned manifest attached to a native-binaries release.
// This is deliberately generated from the files produced by the build; hashes
// must never be copied from an unverified source or entered by hand.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const version = process.argv[2] || require("../package.json").version;
const inputDir = path.resolve(process.argv[3] || "dist-native");
const output = path.resolve(
  process.argv[4] || path.join(inputDir, `native-assets-v${version}.json`),
);
const assetNames = [
  "windows_media_session.node",
  "spotify-seek-helper.dll",
  "spotify-seek-helper.runtimeconfig.json",
  "Microsoft.Windows.SDK.NET.dll",
  "WinRT.Runtime.dll",
];

const assets = {};
for (const name of assetNames) {
  const file = path.join(inputDir, name);
  if (!fs.statSync(file).isFile()) {
    throw new Error(`Missing native artifact: ${file}`);
  }
  const bytes = fs.readFileSync(file);
  assets[name] = {
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

fs.writeFileSync(
  output,
  `${JSON.stringify({ schemaVersion: 1, manifestVersion: version, releaseTag: `v${version}`, assets }, null, 2)}\n`,
  { encoding: "utf8", flag: "wx" },
);
console.log(`Wrote ${output}`);
