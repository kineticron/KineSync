const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const requestedUrl = process.argv.find((argument) => /^https?:\/\//i.test(argument));
const startUrl = requestedUrl || "https://accounts.spotify.com/";

app.setName("KineSync Login Browser");
app.setPath(
  "userData",
  process.env.KINESYNC_LOGIN_BROWSER_DATA ||
    path.join(process.env.HOME || "/config", ".config", "kinesync-login-browser"),
);

function openSpotifyUri(uri) {
  if (!/^spotify:/i.test(uri)) return false;
  spawn("spotify", [`--uri=${uri}`], {
    detached: true,
    stdio: "ignore",
  }).unref();
  return true;
}

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 720,
    minHeight: 540,
    title: "Spotify login",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (openSpotifyUri(url)) return { action: "deny" };
    if (/^https?:\/\//i.test(url)) {
      void window.loadURL(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (openSpotifyUri(url)) event.preventDefault();
  });
  void window.loadURL(startUrl);
});

app.on("window-all-closed", () => app.quit());
