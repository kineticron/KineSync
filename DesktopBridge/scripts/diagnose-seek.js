const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { getDotnetExecutable } = require("../src/dotnetExecutable");
const { createPlaybackController } = require("../src/playbackController");

const SEEK_HELPER_DLL_PATH = path.join(
  __dirname,
  "..",
  "native",
  "spotify-seek-helper",
  "bin",
  "Release",
  "net9.0-windows10.0.19041.0",
  "spotify-seek-helper.dll",
);

function runDotnet(args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(getDotnetExecutable(), args, {
      cwd: path.dirname(SEEK_HELPER_DLL_PATH),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`dotnet command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          stderr.trim() || stdout.trim() || `dotnet exited with code ${code}`,
        ),
      );
    });
  });
}

async function main() {
  console.log("Spotify seek diagnostics");
  console.log("========================");
  console.log(`dotnet: ${getDotnetExecutable()}`);
  console.log(`helper dll: ${SEEK_HELPER_DLL_PATH}`);
  console.log(`dll exists: ${fs.existsSync(SEEK_HELPER_DLL_PATH)}`);

  if (!fs.existsSync(SEEK_HELPER_DLL_PATH)) {
    console.log("\nHelper DLL is missing. Run: npm run build:seek-helper");
    process.exitCode = 1;
    return;
  }

  console.log("\nGSMTC sessions (play Spotify on desktop first):");
  try {
    const diagnoseOutput = await runDotnet([SEEK_HELPER_DLL_PATH, "diagnose"]);
    console.log(diagnoseOutput || "(no sessions)");
  } catch (error) {
    console.error(
      `diagnose failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nTest seek to 45s:");
  try {
    const seekOutput = await runDotnet([SEEK_HELPER_DLL_PATH, "seek", "45000"]);
    console.log(seekOutput || "ok");
  } catch (error) {
    console.error(
      `native seek failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(
      "\nIf seekEnabled is false above, sign in to Spotify in the bridge and rely on API fallback.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nplaybackController.seek(45000):");
  try {
    await createPlaybackController().seek(45_000);
    console.log("ok");
  } catch (error) {
    console.error(
      `controller seek failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

void main();
