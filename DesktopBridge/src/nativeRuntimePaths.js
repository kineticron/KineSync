const fs = require('node:fs');
const path = require('node:path');

// Electron's asar virtual filesystem is available to JavaScript, but not to
// child processes such as dotnet.exe. Forge unpacks the native runtime files;
// resolve those files to the physical app.asar.unpacked path when packaged.
function resolvePackagedNativePath(candidate) {
  const marker = `${path.sep}app.asar${path.sep}`;
  const markerIndex = candidate.toLowerCase().indexOf(marker.toLowerCase());
  if (markerIndex < 0) return candidate;

  const unpacked = `${candidate.slice(0, markerIndex)}${path.sep}app.asar.unpacked${path.sep}${candidate.slice(markerIndex + marker.length)}`;
  try {
    if (fs.existsSync(unpacked)) return unpacked;
  } catch {
    // Fall back to Electron's virtual path; callers report missing runtime.
  }
  return candidate;
}

module.exports = { resolvePackagedNativePath };
