const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let cachedDotnetExecutable = "";

function getDotnetExecutable() {
  if (cachedDotnetExecutable) {
    return cachedDotnetExecutable;
  }

  const candidates = [];
  const dotnetRoot = String(process.env.DOTNET_ROOT || "").trim();
  if (dotnetRoot) {
    candidates.push(path.join(dotnetRoot, "dotnet.exe"));
  }
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    candidates.push(path.join(programFiles, "dotnet", "dotnet.exe"));
  }
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (programFilesX86) {
    candidates.push(path.join(programFilesX86, "dotnet", "dotnet.exe"));
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(
      path.join(localAppData, "Microsoft", "dotnet", "dotnet.exe"),
    );
  }

  try {
    const output = execFileSync("where.exe", ["dotnet"], {
      encoding: "utf8",
      windowsHide: true,
    });
    candidates.unshift(
      ...output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    // where.exe fails when dotnet is not on PATH (common under Electron).
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cachedDotnetExecutable = candidate;
        return cachedDotnetExecutable;
      }
    } catch {
      // Try the next candidate.
    }
  }

  cachedDotnetExecutable = "dotnet";
  return cachedDotnetExecutable;
}

module.exports = {
  getDotnetExecutable,
};
