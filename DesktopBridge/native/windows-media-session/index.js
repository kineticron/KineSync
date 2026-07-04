const fs = require("node:fs");
const path = require("node:path");

function loadNativeBinding() {
  const candidates = [
    path.join(__dirname, "build", "Release", "windows_media_session.node"),
    path.join(__dirname, "build", "Debug", "windows_media_session.node"),
    // Downloaded by postinstall from GitHub release.
    path.join(__dirname, "windows_media_session.node"),
    path.join(__dirname, "windows_media_session.original.node"),
  ];

  for (const candidatePath of candidates) {
    if (fs.existsSync(candidatePath)) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return require(candidatePath);
    }
  }

  return null;
}

const nativeBinding = loadNativeBinding();

class UnavailableWatcher {
  constructor(_onSnapshot, onError) {
    this.onError = onError;
    this.didNotify = false;
  }

  start() {
    if (this.didNotify || typeof this.onError !== "function") {
      return;
    }
    this.didNotify = true;
    this.onError(
      "Windows media native addon is not built. Rebuild it in DesktopBridge/native/windows-media-session so Spotify detection can start.",
    );
  }

  stop() {}
}

module.exports = nativeBinding || {
  WindowsMediaSessionWatcher: UnavailableWatcher,
};
