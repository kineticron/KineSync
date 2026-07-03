const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn, execSync } = require("node:child_process");
const { createBridgeSettingsStore } = require("./bridgeSettingsStore");
const { createBridgeServer } = require("./bridgeServer");
const { createBridgeRelayClient } = require("./bridgeRelayClient");
const { createLyricsService } = require("./lyrics");
const { createPlaybackController } = require("./playbackController");
const { createSpotifyDetector } = require("./spotifyDetector");
const { createSpotifyAuth } = require("./spotifyAuth");
const {
  buildDefaultTtmlFilename,
  lyricsToTtml,
} = require("./lyricsTtmlExport");
const { initLyricsVaultStore, getLyricsVaultStore, defaultExportPath } = require("./lyricsVault");



// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
  app.quit();
}

const MAX_FRAME_RATE = 240;
const APP_ICON_PATH = path.join(__dirname, "assets", "R.png");

// Load Widevine CDM from the user's Chrome installation so BrowserWindows
// can handle DRM-protected content (required by the Spotify web player).
(function loadWidevine() {
  const searchDirs = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ]
    .filter(Boolean)
    .map((d) => path.join(d, "Google", "Chrome", "Application"));

  for (const chromeApp of searchDirs) {
    if (!fs.existsSync(chromeApp)) continue;
    let versions;
    try {
      versions = fs
        .readdirSync(chromeApp)
        .filter((d) => /^\d+\./.test(d))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const ver of versions) {
      const wvRoot = path.join(chromeApp, ver, "WidevineCdm");
      const manifestPath = path.join(wvRoot, "manifest.json");
      const cdmDir = path.join(wvRoot, "_platform_specific", "win_x64");
      if (!fs.existsSync(manifestPath) || !fs.existsSync(cdmDir)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        app.commandLine.appendSwitch("widevine-cdm-path", cdmDir);
        app.commandLine.appendSwitch(
          "widevine-cdm-version",
          manifest.version || ver,
        );
        return;
      } catch {
        continue;
      }
    }
  }
})();

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 980,
    height: 900,
    minWidth: 820,
    minHeight: 640,
    backgroundColor: "#0A0B11",
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  return mainWindow;
};

const applyMaxFpsRendering = (window) => {
  if (!window || window.isDestroyed()) {
    return false;
  }

  const { webContents } = window;
  let changed = false;
  if (typeof webContents.setBackgroundThrottling === "function") {
    webContents.setBackgroundThrottling(false);
    changed = true;
  }
  if (typeof webContents.setFrameRate === "function") {
    webContents.setFrameRate(MAX_FRAME_RATE);
    changed = true;
  }
  return changed;
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: "automatic",
    secureDnsServers: ["https://dns.google/dns-query"],
  });

  const mainWindow = createWindow();
  applyMaxFpsRendering(mainWindow);
  const bridgeSettingsStore = createBridgeSettingsStore({ app });
  initLyricsVaultStore({ userDataPath: app.getPath("userData") });
  const bridge = createBridgeServer({
    port: 3001,
    getHandshakeKey: () => bridgeSettingsStore.getBridgeKey(),
  });
  const relayBridge = createBridgeRelayClient({
      getRelayUrl: () => bridgeSettingsStore.getRelayUrl(),
      getBridgeId: () => bridgeSettingsStore.getRelayBridgeId(),
      getBridgeKey: () => bridgeSettingsStore.getBridgeKey(),
    });
    const bridgeTransports = [bridge, relayBridge];

    // ponytail: auto-start removed from main process — the renderer
    // calls bridgeAPI.startNgrokRelay() from saved settings on load,
    // avoiding duplicate relay servers and port conflicts.
  const detector = createSpotifyDetector();
  const spotifyAuth = createSpotifyAuth({
    getSpDcCookie: () => bridgeSettingsStore.getSpotifySpDcCookie(),
    setSpDcCookie: (value) => bridgeSettingsStore.setSpotifySpDcCookie(value),
  });
  const spotifyAccessTokenGetter = (options = {}) =>
    spotifyAuth.getAccessToken(options);
  detector.setSpotifyAccessTokenGetter(spotifyAccessTokenGetter);
  const lyricsService = createLyricsService({
    getMusixmatchUserToken: () => bridgeSettingsStore.getMusixmatchUserToken(),
    getSpotifyWebToken: () => bridgeSettingsStore.getSpotifyWebToken(),
    getGeminiApiKey: () => bridgeSettingsStore.getGeminiApiKey(),
    getSpotifyAccessToken: spotifyAccessTokenGetter,
    getSpicyLyricsUseCorsProxy: () =>
      bridgeSettingsStore.getSpicyLyricsUseCorsProxy(),
  });
  const playbackController = createPlaybackController();
  playbackController.setSpotifyAccessTokenGetter(spotifyAccessTokenGetter);
  const STATUS_PUSH_INTERVAL_MS = 250;
  let latestPlaybackStatus = {};
  let lastDetectorStatusPushAt = 0;
  let latestLyricsStatus = {
    lyricsStatus: "Waiting for track...",
    lyricsLines: 0,
  };
  let latestCommandStatus = "No playback commands yet.";
  let activeTrackId = "";
  let latestSnapshot = null;
  let lyricsRequestVersion = 0;
  let activeLyricsRequest = null;
  let latestLyricsPacket = null;

  const getMusixmatchTokenStatus = () => {
    const token = bridgeSettingsStore.getMusixmatchUserToken();
    const configured = Boolean(token);
    const preview = configured
      ? token.length <= 8
        ? `${token.slice(0, 1)}***${token.slice(-1)}`
        : `${token.slice(0, 4)}...${token.slice(-4)}`
      : "";
    return {
      musixmatchTokenConfigured: configured,
      musixmatchTokenPreview: preview,
    };
  };

  const getSpotifyWebTokenStatus = () => {
    const token = bridgeSettingsStore.getSpotifyWebToken();
    const configured = Boolean(token);
    const trimmed = String(token || "").trim();
    const isCookieLike =
      trimmed.startsWith("sp_dc=") ||
      trimmed.includes("sp_dc=") ||
      (!/^bearer\s+/i.test(trimmed) &&
        !/^BQ/i.test(trimmed) &&
        !trimmed.includes(".") &&
        trimmed.length > 32);
    const mode = configured
      ? isCookieLike
        ? "sp_dc"
        : "access-token"
      : "none";
    const preview = configured
      ? trimmed.length <= 8
        ? `${trimmed.slice(0, 1)}***${trimmed.slice(-1)}`
        : `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`
      : "";
    return {
      spotifyWebTokenConfigured: configured,
      spotifyWebTokenPreview: preview,
      spotifyWebTokenMode: mode,
      spotifyWebTokenRecommendedMode: "access-token",
    };
  };

  const getGeminiApiKeyStatus = () => {
    const token = bridgeSettingsStore.getGeminiApiKey();
    const configured = Boolean(token);
    const preview = configured
      ? token.length <= 8
        ? `${token.slice(0, 1)}***${token.slice(-1)}`
        : `${token.slice(0, 4)}...${token.slice(-4)}`
      : "";
    return {
      geminiApiKeyConfigured: configured,
      geminiApiKeyPreview: preview,
      translationProvider:
        "google/gemini-3.1-flash-lite -> google/gemini-3.5-flash -> google/gemma-4-31b-it (usage-limit fallback)",
    };
  };

  const getLyricsServiceStatus = () => {
    if (typeof lyricsService.getMusixmatchRuntimeStatus !== "function") {
      return {};
    }
    return lyricsService.getMusixmatchRuntimeStatus();
  };

  const getSpotifyAuthStatus = () => {
    return spotifyAuth.getStatus();
  };

  let lastUiArtworkUrl = null;
  const pushStatus = (extra = {}) => {
    const detectorStatus = detector.getStatus();
    const nextArtworkUrl = String(detectorStatus.artworkUrl || "");
    const artworkPatch = {};
    if (nextArtworkUrl !== lastUiArtworkUrl) {
      lastUiArtworkUrl = nextArtworkUrl;
      artworkPatch.artworkUrl = nextArtworkUrl;
    }
    const { artworkUrl: _detectorArtworkUrl, ...detectorStatusWithoutArtwork } =
      detectorStatus;
    const payload = {
      ...bridge.getStatus(),
      ...relayBridge.getStatus(),
      ...detectorStatusWithoutArtwork,
      ...getMusixmatchTokenStatus(),
      ...getSpotifyWebTokenStatus(),
      ...getGeminiApiKeyStatus(),
      ...getLyricsServiceStatus(),
      ...getSpotifyAuthStatus(),
      ...latestPlaybackStatus,
      ...latestLyricsStatus,
      commandStatus: latestCommandStatus,
      ...artworkPatch,
      ...extra,
    };
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("bridge:status", payload);
    }
  };

  const broadcastPlayback = (packet, options = {}) => {
    for (const transport of bridgeTransports) {
      transport.broadcastPlayback(packet, options);
    }
  };

  const broadcastLyrics = (packet) => {
    for (const transport of bridgeTransports) {
      transport.broadcastLyrics(packet);
    }
  };

  const publishLyricsPacket = (lyricsPacket) => {
    if (!lyricsPacket) {
      return;
    }
    latestLyricsPacket = lyricsPacket;
    if (
      lyricsPacket.trackId &&
      Array.isArray(lyricsPacket.lyrics) &&
      lyricsPacket.lyrics.length > 0 &&
      typeof lyricsService.rememberPublishedLyrics === "function"
    ) {
      lyricsService.rememberPublishedLyrics(
        lyricsPacket.trackId,
        lyricsPacket,
      );
    }
    broadcastLyrics(lyricsPacket);
    latestLyricsStatus = {
      lyricsStatus: lyricsPacket.statusMessage || "Synced lyrics loaded.",
      lyricsLines: Array.isArray(lyricsPacket.lyrics)
        ? lyricsPacket.lyrics.length
        : 0,
    };
    pushStatus({
      ...latestPlaybackStatus,
      ...latestLyricsStatus,
      commandStatus: latestCommandStatus,
    });
  };

  ipcMain.handle("bridge:settings:get", () => {
      return {
        musixmatchUserToken: bridgeSettingsStore.getMusixmatchUserToken(),
        spotifyWebToken: bridgeSettingsStore.getSpotifyWebToken(),
        geminiApiKey: bridgeSettingsStore.getGeminiApiKey(),
        bridgeKey: bridgeSettingsStore.getBridgeKey(),
        relayUrl: bridgeSettingsStore.getRelayUrl(),
        relayBridgeId: bridgeSettingsStore.getRelayBridgeId(),
        ngrokDomain: bridgeSettingsStore.getNgrokDomain(),
        ngrokAuthToken: bridgeSettingsStore.getNgrokAuthToken(),
        spicyLyricsUseCorsProxy: bridgeSettingsStore.getSpicyLyricsUseCorsProxy(),
        ...getMusixmatchTokenStatus(),
        ...getSpotifyWebTokenStatus(),
        ...getGeminiApiKeyStatus(),
        ...getSpotifyAuthStatus(),
        ...relayBridge.getStatus(),
      };
    });

  ipcMain.handle("bridge:settings:set", (_event, patch = {}) => {
    if (
      typeof patch !== "object" ||
      patch === null ||
      (!Object.prototype.hasOwnProperty.call(patch, "musixmatchUserToken") &&
        !Object.prototype.hasOwnProperty.call(patch, "spotifyWebToken") &&
        !Object.prototype.hasOwnProperty.call(patch, "geminiApiKey") &&
        !Object.prototype.hasOwnProperty.call(patch, "openRouterApiKey") &&
        !Object.prototype.hasOwnProperty.call(patch, "bridgeKey") &&
        !Object.prototype.hasOwnProperty.call(patch, "relayUrl") &&
        !Object.prototype.hasOwnProperty.call(patch, "relayBridgeId") &&
        !Object.prototype.hasOwnProperty.call(patch, "spicyLyricsUseCorsProxy"))
    ) {
      return {
        ok: false,
        error: "No settings were provided.",
        ...getMusixmatchTokenStatus(),
        ...getSpotifyWebTokenStatus(),
        ...getGeminiApiKeyStatus(),
      };
    }
    if (Object.prototype.hasOwnProperty.call(patch, "musixmatchUserToken")) {
      bridgeSettingsStore.setMusixmatchUserToken(patch.musixmatchUserToken);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "spotifyWebToken")) {
      bridgeSettingsStore.setSpotifyWebToken(patch.spotifyWebToken);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "geminiApiKey")) {
      bridgeSettingsStore.setGeminiApiKey(patch.geminiApiKey);
    } else if (
      Object.prototype.hasOwnProperty.call(patch, "openRouterApiKey")
    ) {
      bridgeSettingsStore.setGeminiApiKey(patch.openRouterApiKey);
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, "spicyLyricsUseCorsProxy")
    ) {
      bridgeSettingsStore.setSpicyLyricsUseCorsProxy(
        patch.spicyLyricsUseCorsProxy,
      );
    }
    if (Object.prototype.hasOwnProperty.call(patch, "bridgeKey")) {
      bridgeSettingsStore.setBridgeKey(patch.bridgeKey);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "relayUrl")) {
      bridgeSettingsStore.setRelayUrl(patch.relayUrl);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "relayBridgeId")) {
          bridgeSettingsStore.setRelayBridgeId(patch.relayBridgeId);
        }
        if (Object.prototype.hasOwnProperty.call(patch, "ngrokDomain")) {
          bridgeSettingsStore.setNgrokDomain(patch.ngrokDomain);
        }
        if (Object.prototype.hasOwnProperty.call(patch, "ngrokAuthToken")) {
          bridgeSettingsStore.setNgrokAuthToken(patch.ngrokAuthToken);
        }
        relayBridge.restart();
    lyricsService.clearCache();
    pushStatus({
      ...latestPlaybackStatus,
      ...latestLyricsStatus,
      commandStatus: latestCommandStatus,
    });
    return {
      ok: true,
      bridgeKey: bridgeSettingsStore.getBridgeKey(),
      relayUrl: bridgeSettingsStore.getRelayUrl(),
      relayBridgeId: bridgeSettingsStore.getRelayBridgeId(),
      spicyLyricsUseCorsProxy: bridgeSettingsStore.getSpicyLyricsUseCorsProxy(),
      ...getMusixmatchTokenStatus(),
      ...getSpotifyWebTokenStatus(),
      ...getGeminiApiKeyStatus(),
      ...relayBridge.getStatus(),
    };
  });

  ipcMain.handle("spotify:login", async () => {
    try {
      // Use the same recovery path used by automatic HTTP/token failures.
      await spotifyAuth.getAccessToken({
        forceRefresh: true,
        interactiveOnFailure: true,
      });
      lyricsService.clearCache();
      pushStatus({
        ...latestPlaybackStatus,
        ...latestLyricsStatus,
        commandStatus: latestCommandStatus,
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("spotify:logout", () => {
    spotifyAuth.logout();
    lyricsService.clearCache();
    pushStatus({
      ...latestPlaybackStatus,
      ...latestLyricsStatus,
      commandStatus: latestCommandStatus,
    });
    return { ok: true };
  });

  ipcMain.handle("spotify:status", () => {
      return getSpotifyAuthStatus();
    });

    // Ngrok Relay Control
    let ngrokProcess = null;
    let ngrokShuttingDown = false;
    let hostedRelayServer = null;

    function killProcessTree(proc) {
      if (!proc || proc.killed) return;
      if (process.platform === "win32") {
        try {
          execSync(`taskkill /T /F /PID ${proc.pid}`, { stdio: "ignore" });
        } catch {
          try { proc.kill(); } catch {}
        }
      } else {
        proc.kill();
      }
    }

    async function killStaleNgrok() {
      // If a previous ngrok is still running (e.g., orphaned from a crash), kill it
      try {
        const tunnels = await fetchNgrokApi("http://127.0.0.1:4040/api/tunnels");
        if (tunnels) {
          if (process.platform === "win32") {
            execSync("taskkill /F /IM ngrok.exe", { stdio: "ignore" });
          } else {
            execSync("pkill -f ngrok", { stdio: "ignore" });
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch {
        // No stale ngrok running — expected case
      }
    }

    function normalizeNgrokUrl(rawUrl) {
      const url = String(rawUrl || "").trim();
      if (!url) return "";
      if (/^https?:\/\//i.test(url)) return url;
      return `https://${url}`;
    }

    function toWebSocketUrl(publicUrl) {
      return String(publicUrl || "")
        .replace(/^https:\/\//i, "wss://")
        .replace(/^http:\/\//i, "ws://")
        .replace(/\/+$/, "");
    }

    async function fetchNgrokApi(url) {
      return new Promise((resolve, reject) => {
        const http = require("node:http");
        const req = http.get(url, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
        });
        req.on("error", reject);
        req.setTimeout(1000, () => req.destroy(new Error("ngrok API timeout")));
      });
    }

    async function waitForNgrokTunnel(apiUrl) {
      for (let i = 0; i < 40; i++) {
        try {
          const payload = await fetchNgrokApi(apiUrl);
          const tunnels = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
          const publicUrl = tunnels.find(t => String(t?.public_url || "").startsWith("https://"))?.public_url ||
                           tunnels.find(t => String(t?.public_url || "").startsWith("http://"))?.public_url || "";
          if (publicUrl) return publicUrl;
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      return "";
    }

    async function authenticateNgrok(token) {
      return new Promise((resolve) => {
        const proc = spawn("ngrok", ["config", "add-authtoken", token], { windowsHide: true });
        let output = "";
        proc.stdout.on("data", d => output += d);
        proc.stderr.on("data", d => output += d);
        proc.on("close", (code) => {
          if (code === 0) resolve({ ok: true });
          else resolve({ ok: false, error: output || `ngrok auth failed (code ${code})` });
        });
        proc.on("error", (e) => resolve({ ok: false, error: e.message }));
      });
    }

    ipcMain.handle("ngrok:authenticate", async (_event, token) => {
      if (!token || !token.trim()) return { ok: false, error: "Empty auth token" };
      return authenticateNgrok(token.trim());
    });

    ipcMain.handle("ngrok:relay:start", async (_event, options = {}) => {
      const { domain, authToken, bridgeKey, bridgeId } = options;
      if (!domain) return { ok: false, error: "ngrok domain required" };
      if (!authToken) return { ok: false, error: "ngrok auth token required" };
      if (!bridgeKey) return { ok: false, error: "bridge key required" };
      if (!bridgeId) return { ok: false, error: "bridge ID required" };

      // Stop any existing relay (in-process or orphaned from a prior session)
      if (ngrokProcess && !ngrokProcess.killed) {
        ngrokShuttingDown = true;
        killProcessTree(ngrokProcess);
        ngrokProcess = null;
      }
      if (hostedRelayServer) {
        hostedRelayServer.stop(() => {});
        hostedRelayServer = null;
      }
      ngrokShuttingDown = false;
      await killStaleNgrok();

      // Configure ngrok auth token
      const authResult = await authenticateNgrok(authToken);
      if (!authResult.ok) return { ok: false, error: `Auth failed: ${authResult.error}` };

      const relayPort = 8787;
      const ngrokApiUrl = "http://127.0.0.1:4040/api/tunnels";
      const ngrokBin = "ngrok";

      // Start local relay server
      const { createHostedRelayServer } = require("./relayServer");
      const relay = createHostedRelayServer({ port: relayPort });
      hostedRelayServer = relay;
      await new Promise((resolve) => relay.start(resolve));
      console.log(`[bridge-relay] listening on ws://127.0.0.1:${relayPort}`);

      // Start ngrok tunnel
      const ngrokUrl = normalizeNgrokUrl(domain);
      const ngrokArgs = ["http", `--url=${ngrokUrl}`, String(relayPort), "--log=stdout"];
      console.log(`[ngrok] starting tunnel at ${ngrokUrl}`);

      ngrokProcess = spawn(ngrokBin, ngrokArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

      ngrokProcess.on("error", (error) => {
        console.error(`[ngrok] failed to start: ${error.message}`);
        if (!ngrokShuttingDown) relay.stop(() => {});
      });

      ngrokProcess.stdout.on("data", (chunk) => {
        const text = String(chunk || "").trim();
        if (text) console.log(`[ngrok] ${text}`);
      });
      ngrokProcess.stderr.on("data", (chunk) => {
        const text = String(chunk || "").trim();
        if (text) console.error(`[ngrok] ${text}`);
      });
      ngrokProcess.on("exit", (code) => {
        if (!ngrokShuttingDown) {
          console.error(`[ngrok] exited with code ${code ?? "unknown"}`);
          relay.stop(() => {});
        }
      });

      const publicUrl = await waitForNgrokTunnel(ngrokApiUrl);
      if (!publicUrl) {
        if (ngrokProcess) ngrokProcess.kill();
        relay.stop(() => {});
        return { ok: false, error: "ngrok started but no public URL reported" };
      }

      const relayWsUrl = toWebSocketUrl(publicUrl);
      const mobileUrl = `${relayWsUrl}/bridge/${encodeURIComponent(bridgeId)}`;

      console.log("[bridge-relay] ngrok tunnel ready");
      console.log(`[bridge-relay] Public Relay WebSocket URL: ${relayWsUrl}`);
      console.log(`[bridge-relay] Expo WebSocket URL: ${mobileUrl}`);

      // Store relay URL and connect desktop bridge to relay
      bridgeSettingsStore.setRelayUrl(relayWsUrl);
      bridgeSettingsStore.setRelayBridgeId(bridgeId);
      bridgeSettingsStore.setBridgeKey(bridgeKey);
      if (relayBridge) {
        relayBridge.restart();
      }

      // Push status so UI shows relay as active
      pushStatus({
        ...latestPlaybackStatus,
        ...latestLyricsStatus,
        commandStatus: latestCommandStatus,
      });

      return {
        ok: true,
        publicUrl: relayWsUrl,
        mobileUrl,
        bridgeId,
        bridgeKey,
        connectedClients: true,
      };
    });

    ipcMain.handle("ngrok:relay:stop", async () => {
      ngrokShuttingDown = true;
      killProcessTree(ngrokProcess);
      ngrokProcess = null;
      if (hostedRelayServer) {
        hostedRelayServer.stop(() => {});
        hostedRelayServer = null;
      }
      if (relayBridge) {
        relayBridge.stop();
      }
      return { ok: true };
    });

  ipcMain.handle("bridge:lyrics:export-ttml", async () => {
    const lyrics = Array.isArray(latestLyricsPacket?.lyrics)
      ? latestLyricsPacket.lyrics
      : [];
    if (!lyrics.length) {
      return {
        ok: false,
        error: "No synced lyrics are loaded for the current track.",
      };
    }

    let ttmlBody = "";
    try {
      ttmlBody = lyricsToTtml({
        lyrics,
        title: latestSnapshot?.title || "",
        artist: latestSnapshot?.artist || "",
        source: latestLyricsPacket?.source || "",
        durationMs: latestSnapshot?.durationMs || 0,
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const defaultPath = buildDefaultTtmlFilename({
      title: latestSnapshot?.title || "",
      artist: latestSnapshot?.artist || "",
    });
    const saveResult = mainWindow.isDestroyed()
      ? { canceled: true }
      : await dialog.showSaveDialog(mainWindow, {
          title: "Export lyrics as TTML",
          defaultPath,
          filters: [
            { name: "TTML lyrics", extensions: ["ttml", "xml"] },
            { name: "All files", extensions: ["*"] },
          ],
        });
    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: false, canceled: true };
    }

    try {
      await fs.promises.writeFile(saveResult.filePath, ttmlBody, "utf8");
      return {
        ok: true,
        filePath: saveResult.filePath,
        lineCount: lyrics.length,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const saveCurrentTrackToVault = async ({
    includeTranslations = false,
    refreshAfterSave = true,
  } = {}) => {
    const lyrics = Array.isArray(latestLyricsPacket?.lyrics)
      ? latestLyricsPacket.lyrics
      : [];
    if (!lyrics.length) {
      return {
        ok: false,
        error: "No synced lyrics are loaded for the current track.",
      };
    }
    if (!latestSnapshot?.trackId) {
      return {
        ok: false,
        error: "No active Spotify track to associate with the vault entry.",
      };
    }
    if (
      typeof lyricsService.saveCurrentLyricsToVault !== "function"
    ) {
      return { ok: false, error: "Vault save is unavailable." };
    }

    try {
      const saved = await lyricsService.saveCurrentLyricsToVault(
        latestSnapshot,
        lyrics,
        {
          includeTranslations: Boolean(includeTranslations),
          source: latestLyricsPacket?.source || "",
          metadata: latestLyricsPacket?.metadata || null,
        },
      );
      if (refreshAfterSave) {
        runLyricsSync(latestSnapshot, {
          force: true,
          preferredSource: "local-vault",
        });
      }
      return {
        ok: true,
        vaultId: saved.vaultId,
        sourceLabel: saved.sourceLabel,
        lineCount: saved.lineCount,
        translatedLineCount: saved.translatedLineCount,
        vaultEntryCount: getLyricsVaultStore()?.listEntryCount?.() || 0,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  ipcMain.handle("bridge:lyrics:vault:save", async (_event, options = {}) => {
    return saveCurrentTrackToVault(options);
  });

  ipcMain.handle("bridge:lyrics:vault:import-ttml", async (_event, options = {}) => {
    return importLyricsFileToVaultDialog(options);
  });

  ipcMain.handle("bridge:lyrics:vault:import", async (_event, options = {}) => {
    return importLyricsFileToVaultDialog(options);
  });

  async function importLyricsFileToVaultDialog(options = {}) {
    const includeTranslations = Boolean(options?.includeTranslations);
    const openResult = mainWindow.isDestroyed()
      ? { canceled: true }
      : await dialog.showOpenDialog(mainWindow, {
          title: "Import lyrics into vault",
          properties: ["openFile"],
          filters: [
            {
              name: "Lyrics files",
              extensions: ["json", "ttml", "xml"],
            },
            { name: "JSON lyrics", extensions: ["json"] },
            { name: "TTML lyrics", extensions: ["ttml", "xml"] },
            { name: "All files", extensions: ["*"] },
          ],
        });
    if (openResult.canceled || !openResult.filePaths?.length) {
      return { ok: false, canceled: true };
    }

    const filePath = openResult.filePaths[0];
    try {
      const fileContent = await fs.promises.readFile(filePath, "utf8");
      if (typeof lyricsService.importLyricsFileToVault !== "function") {
        return { ok: false, error: "Vault import is unavailable." };
      }
      const saved = await lyricsService.importLyricsFileToVault(
        fileContent,
        filePath,
        latestSnapshot || {},
        { includeTranslations },
      );
      if (latestSnapshot?.trackId) {
        runLyricsSync(latestSnapshot, {
          force: true,
          preferredSource: "local-vault",
        });
      }
      return {
        ok: true,
        vaultId: saved.vaultId,
        sourceLabel: saved.sourceLabel,
        lineCount: saved.lineCount,
        translatedLineCount: saved.translatedLineCount,
        filePath,
        vaultEntryCount: getLyricsVaultStore()?.listEntryCount?.() || 0,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  ipcMain.handle("bridge:lyrics:vault:list", async () => {
    const store = getLyricsVaultStore();
    if (!store) {
      return { ok: false, error: "Lyrics vault is not initialized.", entries: [] };
    }
    return {
      ok: true,
      folderPath: store.getVaultRoot(),
      entries: store.listEntries(),
      entryCount: store.listEntryCount(),
    };
  });

  ipcMain.handle(
    "bridge:lyrics:vault:export",
    async (_event, { vaultId, format = "ttml" } = {}) => {
      const store = getLyricsVaultStore();
      if (!store) {
        return { ok: false, error: "Lyrics vault is not initialized." };
      }
      const entry = store.getEntry(vaultId);
      if (!entry?.lyrics?.length) {
        return { ok: false, error: "Vault entry not found or has no lyrics." };
      }

      const exportFormat = String(format || "ttml").toLowerCase() === "json"
        ? "json"
        : "ttml";
      const manifest = entry.manifest || {};
      let body = "";
      let defaultPath = defaultExportPath(entry, exportFormat);

      if (exportFormat === "json") {
        body = JSON.stringify(
          {
            title: manifest.title || "",
            artist: manifest.artist || "",
            album: manifest.album || "",
            durationMs: Number(manifest.durationMs || 0),
            spotifyTrackId: manifest.spotifyTrackId || "",
            sourceLabel: entry.sourceLabel || "",
            lyrics: entry.lyrics,
          },
          null,
          2,
        );
      } else {
        try {
          body = lyricsToTtml({
            lyrics: entry.lyrics,
            title: manifest.title || "",
            artist: manifest.artist || "",
            source: entry.sourceLabel || "",
            durationMs: Number(manifest.durationMs || 0),
          });
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        defaultPath =
          buildDefaultTtmlFilename({
            title: manifest.title || "",
            artist: manifest.artist || "",
          }) || defaultPath;
      }

      const saveResult = mainWindow.isDestroyed()
        ? { canceled: true }
        : await dialog.showSaveDialog(mainWindow, {
            title:
              exportFormat === "json"
                ? "Download vault lyrics as JSON"
                : "Download vault lyrics as TTML",
            defaultPath,
            filters:
              exportFormat === "json"
                ? [
                    { name: "JSON lyrics", extensions: ["json"] },
                    { name: "All files", extensions: ["*"] },
                  ]
                : [
                    { name: "TTML lyrics", extensions: ["ttml", "xml"] },
                    { name: "All files", extensions: ["*"] },
                  ],
          });
      if (saveResult.canceled || !saveResult.filePath) {
        return { ok: false, canceled: true };
      }

      try {
        await fs.promises.writeFile(saveResult.filePath, body, "utf8");
        return {
          ok: true,
          filePath: saveResult.filePath,
          format: exportFormat,
          lineCount: entry.lyrics.length,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle("bridge:lyrics:vault:open-folder", async () => {
    const store = getLyricsVaultStore();
    if (!store || typeof store.getVaultRoot !== "function") {
      return { ok: false, error: "Lyrics vault is not initialized." };
    }
    const vaultRoot = store.getVaultRoot();
    try {
      fs.mkdirSync(vaultRoot, { recursive: true });
      const openError = await shell.openPath(vaultRoot);
      if (openError) {
        return { ok: false, error: openError, folderPath: vaultRoot };
      }
      return {
        ok: true,
        folderPath: vaultRoot,
        vaultEntryCount: store.listEntryCount?.() || 0,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        folderPath: vaultRoot,
      };
    }
  });


  const statusTimer = setInterval(() => {
    pushStatus({
      ...latestPlaybackStatus,
      ...latestLyricsStatus,
      commandStatus: latestCommandStatus,
    });
  }, STATUS_PUSH_INTERVAL_MS);

  const runLyricsSync = (
    snapshot,
    {
      force = false,
      preferredSource = "auto",
      immediateTranslation = false,
    } = {},
  ) => {
    if (!snapshot?.trackId) {
      return;
    }
    const normalizedPreferredSource =
      typeof preferredSource === "string" ? preferredSource : "auto";
    console.log(
      `[bridge-lyrics] runLyricsSync start track=${String(snapshot.trackId || "")} title=${String(snapshot.title || "")} source=${normalizedPreferredSource} force=${Boolean(force)} immediateTranslation=${Boolean(immediateTranslation)}`,
    );
    if (
      !force &&
      !immediateTranslation &&
      normalizedPreferredSource !== "auto" &&
      typeof lyricsService.getCachedSourceLyricsPacket === "function"
    ) {
      const cachedSourcePacket = lyricsService.getCachedSourceLyricsPacket(
        snapshot.trackId,
        normalizedPreferredSource,
      );
      if (cachedSourcePacket?.lyrics?.length) {
        console.log(
          `[bridge-lyrics] instant source switch track=${String(snapshot.trackId || "")} source=${normalizedPreferredSource}`,
        );
        publishLyricsPacket(cachedSourcePacket);
        return Promise.resolve(cachedSourcePacket);
      }
    }
    if (
      activeLyricsRequest?.inFlight &&
      activeLyricsRequest.trackId === snapshot.trackId &&
      activeLyricsRequest.preferredSource === normalizedPreferredSource &&
      (!immediateTranslation || activeLyricsRequest.immediateTranslation)
    ) {
      console.log(
        `[bridge-lyrics] reusing in-flight request track=${String(snapshot.trackId || "")} source=${normalizedPreferredSource}`,
      );
      if (activeLyricsRequest.latestPacket) {
        publishLyricsPacket(activeLyricsRequest.latestPacket);
      } else {
        latestLyricsStatus = {
          ...latestLyricsStatus,
          lyricsStatus: "Fetching synced lyrics...",
        };
        pushStatus({
          ...latestPlaybackStatus,
          ...latestLyricsStatus,
          commandStatus: latestCommandStatus,
        });
      }
      return activeLyricsRequest.promise;
    }

    const requestVersion = ++lyricsRequestVersion;
    const requestState = {
      requestVersion,
      trackId: snapshot.trackId,
      preferredSource: normalizedPreferredSource,
      immediateTranslation: Boolean(immediateTranslation),
      inFlight: true,
      latestPacket: null,
      promise: Promise.resolve(null),
    };
    activeLyricsRequest = requestState;
    latestLyricsStatus = {
      ...latestLyricsStatus,
      lyricsStatus: "Fetching synced lyrics...",
    };
    pushStatus({
      ...latestPlaybackStatus,
      ...latestLyricsStatus,
      commandStatus: latestCommandStatus,
    });

    requestState.promise = lyricsService
      .fetchSyncedLyrics(snapshot, {
        force,
        preferredSource: normalizedPreferredSource,
        immediateTranslation: Boolean(immediateTranslation),
        onSyncedLyrics: (lyricsPacket) => {
          if (
            requestVersion !== lyricsRequestVersion ||
            lyricsPacket.trackId !== activeTrackId
          ) {
            return;
          }
          requestState.latestPacket = lyricsPacket;
          const translatedCount = Array.isArray(lyricsPacket?.lyrics)
            ? lyricsPacket.lyrics.reduce(
                (count, line) =>
                  count + (String(line?.translatedText || "").trim() ? 1 : 0),
                0,
              )
            : 0;
          console.log(
            `[bridge-lyrics] onSyncedLyrics track=${String(lyricsPacket?.trackId || "")} source=${String(lyricsPacket?.source || "")} lines=${Number(lyricsPacket?.lyrics?.length || 0)} translated=${translatedCount}`,
          );
          publishLyricsPacket(lyricsPacket);
        },
      })
      .then((result) => {
        requestState.inFlight = false;
        const translatedCount = Array.isArray(result?.lyrics)
          ? result.lyrics.reduce(
              (count, line) =>
                count + (String(line?.translatedText || "").trim() ? 1 : 0),
              0,
            )
          : 0;
        console.log(
          `[bridge-lyrics] runLyricsSync result track=${String(result?.trackId || snapshot.trackId || "")} source=${String(result?.source || "unknown")} lines=${Number(result?.lyrics?.length || 0)} translated=${translatedCount}`,
        );
        return result;
      })
      .catch((error) => {
        requestState.inFlight = false;
        if (requestVersion !== lyricsRequestVersion) {
          return;
        }
        const message = `Lyrics sync failed on desktop: ${
          error instanceof Error ? error.message : String(error)
        }`;
        publishLyricsPacket({
          trackId: snapshot.trackId,
          lyrics: [],
          source: "desktop-bridge",
          statusMessage: message,
        });
      });
    return requestState.promise;
  };

  const runLyricsTranslateOnly = (snapshot) => {
    if (!snapshot?.trackId) {
      return Promise.resolve(null);
    }
    console.log(
      `[bridge-lyrics] translate-only start track=${String(snapshot.trackId || "")} title=${String(snapshot.title || "")}`,
    );
    if (
      activeLyricsRequest?.inFlight &&
      activeLyricsRequest.translateOnly &&
      activeLyricsRequest.trackId === snapshot.trackId
    ) {
      console.log(
        `[bridge-lyrics] reusing in-flight translate-only track=${String(snapshot.trackId || "")}`,
      );
      if (activeLyricsRequest.latestPacket) {
        publishLyricsPacket(activeLyricsRequest.latestPacket);
      } else {
        latestLyricsStatus = {
          ...latestLyricsStatus,
          lyricsStatus: "Translating on-screen lyrics...",
        };
        pushStatus({
          ...latestPlaybackStatus,
          ...latestLyricsStatus,
          commandStatus: latestCommandStatus,
        });
      }
      return activeLyricsRequest.promise;
    }

    const requestVersion = ++lyricsRequestVersion;
    const requestState = {
      requestVersion,
      trackId: snapshot.trackId,
      translateOnly: true,
      inFlight: true,
      latestPacket: null,
      promise: Promise.resolve(null),
    };
    activeLyricsRequest = requestState;
    latestLyricsStatus = {
      ...latestLyricsStatus,
      lyricsStatus: "Translating on-screen lyrics...",
      lyricsLines: Array.isArray(latestLyricsPacket?.lyrics)
        ? latestLyricsPacket.lyrics.length
        : 0,
    };
    pushStatus({
      ...latestPlaybackStatus,
      ...latestLyricsStatus,
      commandStatus: latestCommandStatus,
    });

    requestState.promise = lyricsService
      .translatePublishedLyrics(snapshot, {
        onSyncedLyrics: (lyricsPacket) => {
          if (
            requestVersion !== lyricsRequestVersion ||
            lyricsPacket.trackId !== activeTrackId
          ) {
            return;
          }
          requestState.latestPacket = lyricsPacket;
          const translatedCount = Array.isArray(lyricsPacket?.lyrics)
            ? lyricsPacket.lyrics.reduce(
                (count, line) =>
                  count + (String(line?.translatedText || "").trim() ? 1 : 0),
                0,
              )
            : 0;
          console.log(
            `[bridge-lyrics] translate-only progress track=${String(lyricsPacket?.trackId || "")} source=${String(lyricsPacket?.source || "")} lines=${Number(lyricsPacket?.lyrics?.length || 0)} translated=${translatedCount}`,
          );
          publishLyricsPacket(lyricsPacket);
        },
      })
      .then((result) => {
        requestState.inFlight = false;
        const translatedCount = Array.isArray(result?.lyrics)
          ? result.lyrics.reduce(
              (count, line) =>
                count + (String(line?.translatedText || "").trim() ? 1 : 0),
              0,
            )
          : 0;
        console.log(
          `[bridge-lyrics] translate-only result track=${String(result?.trackId || snapshot.trackId || "")} source=${String(result?.source || "unknown")} lines=${Number(result?.lyrics?.length || 0)} translated=${translatedCount}`,
        );
        return result;
      })
      .catch((error) => {
        requestState.inFlight = false;
        if (requestVersion !== lyricsRequestVersion) {
          return;
        }
        const message = `Translation failed on desktop: ${
          error instanceof Error ? error.message : String(error)
        }`;
        publishLyricsPacket({
          trackId: snapshot.trackId,
          lyrics: Array.isArray(latestLyricsPacket?.lyrics)
            ? latestLyricsPacket.lyrics
            : [],
          source: latestLyricsPacket?.source || "desktop-bridge",
          metadata: latestLyricsPacket?.metadata,
          statusMessage: message,
        });
      });
    return requestState.promise;
  };

  detector.on("snapshot", (packet) => {
    const previousSnapshot = latestSnapshot;
    latestSnapshot = packet;
    broadcastPlayback(packet);
    const timing =
      packet.timing && typeof packet.timing === "object"
        ? packet.timing
        : typeof detector.getTimingDiagnostics === "function"
          ? detector.getTimingDiagnostics()
          : {};
    latestPlaybackStatus = {
      lastPacketAt: packet.timestamp,
      durationMs: packet.durationMs,
      currentTrack: packet.title
        ? `${packet.title} - ${packet.artist}`
        : "No track",
      positionMs: packet.positionMs,
      isPlaying: packet.isPlaying,
      ...timing,
    };

    const now = Date.now();
    if (now - lastDetectorStatusPushAt >= 250) {
      lastDetectorStatusPushAt = now;
      pushStatus();
    }

    const trackChanged = packet.trackId !== activeTrackId;
    if (!trackChanged) {
      const spotifyIdBecameAvailable =
        Boolean(packet.spotifyTrackId) &&
        !previousSnapshot?.spotifyTrackId &&
        packet.trackId === activeTrackId;
      if (spotifyIdBecameAvailable) {
        console.log(
          `[bridge-lyrics] exact Spotify track id became available for current track; refetching lyrics track=${String(packet.trackId || "")} spotifyTrackId=${String(packet.spotifyTrackId || "")}`,
        );
        activeLyricsRequest = null;
        runLyricsSync(packet, {
          force: true,
          preferredSource: "auto",
        });
      }
      return;
    }

    activeTrackId = packet.trackId;
    if (typeof lyricsService.setActiveTrack === "function") {
      lyricsService.setActiveTrack(activeTrackId);
    }
    if (!activeTrackId) {
      activeLyricsRequest = null;
      publishLyricsPacket({
        trackId: "",
        lyrics: [],
        source: "desktop-bridge",
        statusMessage: "Waiting for Spotify track...",
      });
      return;
    }
    activeLyricsRequest = null;
    runLyricsSync(packet);
  });

  const wireBridgeTransport = (transport) => {
    transport.on("clientCountChanged", () => pushStatus());
    transport.on("lyricsRefreshRequested", (request = {}) => {
      if (!latestSnapshot?.trackId) {
        return;
      }
      const immediateTranslation = Boolean(request.immediateTranslation);
      console.log(
        `[bridge-lyrics] lyricsRefreshRequested source=${String(request?.preferredSource || "auto")} immediateTranslation=${immediateTranslation} track=${String(latestSnapshot.trackId || "")}`,
      );
      if (immediateTranslation) {
        let published = lyricsService.getPublishedLyrics(latestSnapshot.trackId);
        const onScreenPacket =
          latestLyricsPacket?.trackId === latestSnapshot.trackId
            ? latestLyricsPacket
            : null;
        if (
          !published?.lyrics?.length &&
          Array.isArray(onScreenPacket?.lyrics) &&
          onScreenPacket.lyrics.length > 0
        ) {
          lyricsService.rememberPublishedLyrics(
            latestSnapshot.trackId,
            onScreenPacket,
          );
          published = lyricsService.getPublishedLyrics(latestSnapshot.trackId);
        }
        if (published?.lyrics?.length) {
          runLyricsTranslateOnly(latestSnapshot);
          return;
        }
        console.log(
          `[bridge-lyrics] translate-only unavailable for track=${String(latestSnapshot.trackId || "")}, falling back to full lyrics sync`,
        );
      }
      runLyricsSync(latestSnapshot, {
        force: false,
        preferredSource:
          typeof request.preferredSource === "string"
            ? request.preferredSource
            : "auto",
        immediateTranslation,
      });
    });
    transport.on("vaultSaveRequested", ({ includeTranslations, reply } = {}) => {
      void saveCurrentTrackToVault({
        includeTranslations,
        refreshAfterSave: false,
      })
        .then((result) => {
          if (typeof reply === "function") {
            reply({
              type: "vault:save:result",
              ...result,
            });
          }
          if (result?.ok && latestSnapshot?.trackId) {
            runLyricsSync(latestSnapshot, {
              force: true,
              preferredSource: "local-vault",
            });
          }
        })
        .catch((error) => {
          if (typeof reply === "function") {
            reply({
              type: "vault:save:result",
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
    });
    transport.on("lyricsRefetchRequested", () => {
      if (!activeTrackId) {
        return;
      }
      if (activeLyricsRequest?.trackId === activeTrackId) {
        if (activeLyricsRequest.latestPacket) {
          publishLyricsPacket(activeLyricsRequest.latestPacket);
          return;
        }
        if (activeLyricsRequest.inFlight) {
          latestLyricsStatus = {
            ...latestLyricsStatus,
            lyricsStatus: "Still fetching synced lyrics on desktop...",
          };
          pushStatus({
            ...latestPlaybackStatus,
            ...latestLyricsStatus,
            commandStatus: latestCommandStatus,
          });
          return;
        }
      }
      const cachedLyrics = lyricsService.getCachedLyrics(activeTrackId);
      if (cachedLyrics) {
        publishLyricsPacket(cachedLyrics);
        return;
      }
      if (latestSnapshot?.trackId === activeTrackId) {
        runLyricsSync(latestSnapshot, {
          force: false,
          preferredSource: "auto",
        });
      } else {
        const message = "No cached lyrics available. Try fetching new lyrics.";
        publishLyricsPacket({
          trackId: activeTrackId,
          lyrics: [],
          source: "desktop-bridge",
          statusMessage: message,
        });
      }
    });
    transport.on("artworkRefetchRequested", () => {
      if (typeof detector.refetchArtwork === "function") {
        detector.refetchArtwork();
      }
    });
    transport.on("playbackCommand", (packet) => {
      if (!packet || typeof packet.type !== "string") {
        return;
      }
      if (packet.type === "playback:playPause") {
        latestCommandStatus = "Sending play/pause...";
        void playbackController
          .togglePlayPause()
          .then(() => {
            latestCommandStatus = "Play/pause command sent.";
          })
          .catch((error) => {
            latestCommandStatus = `Play/pause failed: ${error.message}`;
          });
        return;
      }
      if (packet.type === "playback:resync") {
        latestCommandStatus = "Resyncing playback timer...";
        void playbackController
          .resyncPlayback()
          .then(() => {
            latestCommandStatus = "Playback timer resync sent.";
          })
          .catch((error) => {
            latestCommandStatus = `Playback resync failed: ${error.message}`;
          });
        return;
      }
      if (packet.type === "playback:next") {
        latestCommandStatus = "Sending next track...";
        void playbackController
          .next()
          .then(() => {
            latestCommandStatus = "Next track command sent.";
          })
          .catch((error) => {
            latestCommandStatus = `Next failed: ${error.message}`;
          });
        return;
      }
      if (packet.type === "playback:previous") {
        latestCommandStatus = "Sending previous track...";
        void playbackController
          .previous()
          .then(() => {
            latestCommandStatus = "Previous track command sent.";
          })
          .catch((error) => {
            latestCommandStatus = `Previous failed: ${error.message}`;
          });
        return;
      }
      if (packet.type === "playback:seek") {
        const seekPositionMs = Math.max(
          0,
          Math.floor(Number(packet.positionMs || 0)),
        );
        latestCommandStatus = `Seeking to ${seekPositionMs}ms...`;
        console.log(`[playback] seek requested -> ${seekPositionMs}ms`);
        void playbackController
          .seek(seekPositionMs)
          .then(() => {
            latestCommandStatus = `Seek command sent (${seekPositionMs}ms).`;
            console.log(`[playback] seek ok -> ${seekPositionMs}ms`);
            if (!latestSnapshot?.trackId) {
              return;
            }
            const forcedPacket = {
              ...latestSnapshot,
              positionMs: seekPositionMs,
              timestamp: Date.now(),
              capturedAtMs: Date.now(),
            };
            latestSnapshot = forcedPacket;
            latestPlaybackStatus = {
              ...latestPlaybackStatus,
              positionMs: seekPositionMs,
              lastPacketAt: forcedPacket.timestamp,
            };
            broadcastPlayback(forcedPacket, { force: true });
          })
          .catch((error) => {
            latestCommandStatus = `Seek failed: ${error.message}`;
            console.error(`[playback] seek failed -> ${error.message}`);
          });
      }
    });
  };
  for (const transport of bridgeTransports) {
    wireBridgeTransport(transport);
  }
  detector.on("error", (error) => pushStatus({ detectorError: error.message }));

  bridge.start();
  relayBridge.start();
  detector.start();
  pushStatus({ startedAt: Date.now() });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on("before-quit", () => {
      ipcMain.removeHandler("bridge:settings:get");
      ipcMain.removeHandler("bridge:settings:set");
      ipcMain.removeHandler("spotify:login");
      ipcMain.removeHandler("spotify:logout");
      ipcMain.removeHandler("spotify:status");
      ipcMain.removeHandler("bridge:lyrics:export-ttml");
      ipcMain.removeHandler("bridge:lyrics:vault:save");
      ipcMain.removeHandler("bridge:lyrics:vault:import-ttml");
      ipcMain.removeHandler("bridge:lyrics:vault:import");
      ipcMain.removeHandler("bridge:lyrics:vault:list");
      ipcMain.removeHandler("bridge:lyrics:vault:export");
      ipcMain.removeHandler("bridge:lyrics:vault:open-folder");
      ipcMain.removeHandler("ngrok:authenticate");
      ipcMain.removeHandler("ngrok:relay:start");
      ipcMain.removeHandler("ngrok:relay:stop");
      clearInterval(statusTimer);
      // Kill ngrok process tree + hosted relay server to free port 8787
      killProcessTree(ngrokProcess);
      ngrokProcess = null;
      if (hostedRelayServer) {
        hostedRelayServer.stop(() => {});
        hostedRelayServer = null;
      }
      detector.stop();
      relayBridge.stop();
      bridge.stop();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
