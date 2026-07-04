#!/usr/bin/env node
// Downloads prebuilt native binaries from GitHub releases so contributors
// without C++ / .NET toolchains can skip local builds entirely.
// Falls back silently — local build commands still work if download fails.

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const PKG = require("../package.json");
const REPO = "Kineticron/KineSync";
const TAG = `v${PKG.version}`;

const NATIVE_MEDIA_DIR = path.join(
  __dirname,
  "..",
  "native",
  "windows-media-session",
);
const SEEK_HELPER_OUT = path.join(
  __dirname,
  "..",
  "native",
  "spotify-seek-helper",
  "bin",
  "Release",
  "net9.0-windows10.0.19041.0",
);

// { destPath: assetName }
const ASSETS = {
  [path.join(NATIVE_MEDIA_DIR, "windows_media_session.node")]:
    "windows_media_session.node",
  [path.join(SEEK_HELPER_OUT, "spotify-seek-helper.dll")]:
    "spotify-seek-helper.dll",
  [path.join(SEEK_HELPER_OUT, "spotify-seek-helper.runtimeconfig.json")]:
    "spotify-seek-helper.runtimeconfig.json",
  [path.join(SEEK_HELPER_OUT, "Microsoft.Windows.SDK.NET.dll")]:
    "Microsoft.Windows.SDK.NET.dll",
  [path.join(SEEK_HELPER_OUT, "WinRT.Runtime.dll")]:
    "WinRT.Runtime.dll",
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "KineSync-postinstall" } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(httpsGet(res.headers.location));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });
}

async function fetchReleaseAssets() {
  const apiUrl = `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`;
  const buf = await httpsGet(apiUrl);
  return JSON.parse(buf.toString("utf8")).assets || [];
}

async function downloadAsset(downloadUrl, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const buf = await httpsGet(downloadUrl);
  fs.writeFileSync(destPath, buf);
}

async function main() {
  // Only run on Windows — these binaries are Windows-only.
  if (process.platform !== "win32") return;
  if (process.env.SKIP_POSTINSTALL) return;

  // Skip if all targets already exist (local build or previous download).
  const allPresent = Object.keys(ASSETS).every((p) => fs.existsSync(p));
  if (allPresent) return;

  let assets;
  try {
    assets = await fetchReleaseAssets();
  } catch (err) {
    // No release yet, private repo without token, or offline — silently skip.
    console.warn(
      `[postinstall] Could not fetch release assets for ${TAG}: ${err.message}`,
    );
    console.warn(
      "[postinstall] Run 'npm run build:native' to build from source.",
    );
    return;
  }

  const byName = Object.fromEntries(assets.map((a) => [a.name, a.browser_download_url]));

  let downloaded = 0;
  for (const [destPath, assetName] of Object.entries(ASSETS)) {
    if (fs.existsSync(destPath)) continue;
    const url = byName[assetName];
    if (!url) {
      console.warn(`[postinstall] Asset not found in release: ${assetName}`);
      continue;
    }
    try {
      process.stdout.write(`[postinstall] Downloading ${assetName}...`);
      await downloadAsset(url, destPath);
      console.log(" done.");
      downloaded++;
    } catch (err) {
      console.warn(` failed: ${err.message}`);
    }
  }

  if (downloaded > 0) {
    console.log(`[postinstall] Downloaded ${downloaded} native artifact(s).`);
  }
}

main().catch((err) => {
  // Never fail the install; surface as a warning.
  console.warn(`[postinstall] Unexpected error: ${err.message}`);
});
