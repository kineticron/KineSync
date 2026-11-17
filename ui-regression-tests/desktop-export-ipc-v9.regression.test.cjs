// Interactive main-process regression checks for the desktop lrc.red export IPC
// handler. Loads the real DesktopBridge src/index.js inside a stubbed Electron
// host, registers the real ipcMain handlers, and exercises the actual async
// lookup/save-dialog/write boundary.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { test, afterEach } = require("node:test");

const repoRoot = process.env.KINESYNC_IMPL_ROOT
  ? path.resolve(process.env.KINESYNC_IMPL_ROOT)
  : path.join(__dirname, "..");
const mainPath = path.join(repoRoot, "DesktopBridge", "src", "index.js");
const realFs = require("node:fs");

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) await tick();
}
async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const originalLoad = Module._load;
const originalWriteFile = realFs.promises.writeFile;
const originalSeekFile = realFs.writeFileSync;
const originalRemoveFile = realFs.rmSync;
const originalConsoleLog = console.log;
const originalSetInterval = global.setInterval;

function createEmitter() {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return this;
    },
    once(event, handler) {
      const wrapped = (...args) => {
        this.off(event, wrapped);
        handler(...args);
      };
      return this.on(event, wrapped);
    },
    off(event, handler) {
      const list = listeners.get(event) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
      return this;
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) || [])]) handler(...args);
      return true;
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
  };
}

const handlers = [];
const harnesses = [];

function loadMainHarness() {
  const state = {
    dialogCalls: [],
    writes: [],
    ipcHandlers: new Map(),
    detector: null,
    lyricsLookup: null,
    lookupCount: 0,
    hasRequestRegistry: false,
    registryCalls: [],
    storeEntry: null,
    showSaveDialog: async () => ({ canceled: false, filePath: "C:/tmp/out.ttml" }),
  };

  const settingsStore = new Proxy(
    {
      getBridgeKey: () => "bridge-key",
      getRelayUrl: () => "",
      getRelayBridgeId: () => "",
      getNgrokDomain: () => "",
      getNgrokAuthToken: () => "",
      getSpotifySpDcCookie: () => "",
      getSpotifyWebToken: () => "",
      getGeminiApiKey: () => "",
      getSpicyLyricsPublishableKey: () => "",
      getSpicyLyricsUseCorsProxy: () => false,
    },
    {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key === "string" && key.startsWith("set")) return () => {};
        return () => {};
      },
    },
  );

  const eventBus = createEmitter();
  const bridge = Object.assign(createEmitter(), {
    start() {},
    stop() {},
    getStatus: () => ({}),
    broadcastPlayback() {},
    broadcastLyrics() {},
  });
  const relayBridge = Object.assign(createEmitter(), {
    start() {},
    stop() {},
    restart() {},
    getStatus: () => ({}),
    broadcastPlayback() {},
    broadcastLyrics() {},
  });

  const detector = Object.assign(createEmitter(), {
    start() {},
    stop() {},
    getStatus: () => ({}),
    getTimingDiagnostics: () => ({}),
    refetchArtwork() {},
    setSpotifyAccessTokenGetter() {},
  });
  state.detector = detector;

  const store = {
    getEntry: vaultId => (state.storeEntry && state.storeEntry.vaultId === vaultId ? state.storeEntry : null),
    startRefresh: () => () => {},
    listEntries: () => [],
    listEntryCount: () => 0,
    getVaultRoot: () => "C:/vault",
    close() {},
  };

  const lyricsService = {
    fetchSyncedLyrics: async () => null,
    fetchFromSpicyLyrics: async () => null,
    getCachedLyrics: () => null,
    getPublishedLyrics: () => null,
    getCachedSourceLyricsPacket: () => null,
    rememberPublishedLyrics() {},
    setActiveTrack() {},
    clearCache() {},
    getMusixmatchRuntimeStatus: () => ({}),
    stop() {},
  };

  const lyricsModule = {
    createLyricsService: () => lyricsService,
    fetchLrcRedExportLyrics: async () => {
      state.lookupCount += 1;
      if (!state.lyricsLookup) throw new Error("lyrics lookup was not configured");
      return state.lyricsLookup();
    },
    fetchFromSpicyLyrics: async () => null,
  };

  const ipcMain = {
    handle(channel, handler) {
      state.ipcHandlers.set(channel, handler);
    },
    removeHandler(channel) {
      state.ipcHandlers.delete(channel);
    },
  };

  const mainWindow = {
    isDestroyed: () => false,
    loadFile() {},
    webContents: {
      send() {},
      on() {},
      setWindowOpenHandler() {},
      setBackgroundThrottling() {},
      setFrameRate() {},
    },
    once() {},
  };

  const app = {
    whenReady: () => Promise.resolve(),
    quit() {},
    on() {},
    getPath: () => path.join(repoRoot, "ui-regression-tests", ".tmp-user-data"),
    configureHostResolver() {},
    commandLine: { appendSwitch() {} },
  };

  const dialog = {
    showSaveDialog: async (...args) => {
      state.dialogCalls.push(args);
      return state.showSaveDialog(...args);
    },
  };

  const electron = {
    app,
    BrowserWindow: class {
      constructor() { return mainWindow; }
      static getAllWindows() { return []; }
    },
    dialog,
    ipcMain,
    shell: { openExternal() {} },
  };

  const registryPath = path.join(repoRoot, "DesktopBridge", "src", "exportRequestRegistry.js");
  const realRegistry = realFs.existsSync(registryPath)
    ? originalLoad.call(Module, registryPath, module, false)
    : null;
  state.hasRequestRegistry = Boolean(realRegistry);
  const exportRequestRegistry = realRegistry
    ? {
        createExportRequestRegistry: () => {
          const registry = realRegistry.createExportRequestRegistry();
          for (const key of Object.keys(registry)) {
            if (typeof registry[key] !== "function") continue;
            const original = registry[key].bind(registry);
            registry[key] = (...args) => {
              state.registryCalls.push({ key, args });
              return original(...args);
            };
          }
          return registry;
        },
      }
    : {
        createExportRequestRegistry: () => {
          const canceled = new Set();
          return {
            cancel(requestId) { state.registryCalls.push({ key: "cancel", args: [requestId] }); canceled.add(requestId); },
            isCurrent(requestId) { state.registryCalls.push({ key: "isCurrent", args: [requestId] }); return !canceled.has(requestId); },
          };
        },
      };

  const localStubs = {
    "./exportRequestRegistry": exportRequestRegistry,
    "./bridgeSettingsStore": { createBridgeSettingsStore: () => settingsStore },
    "./musixmatchTokenManager": {
      createMusixmatchTokenManager: () => ({
        getToken: () => "",
        refreshToken: async () => "",
        invalidateToken: async () => {},
        getStatus: () => ({}),
      }),
    },
    "./bridgeServer": { createBridgeServer: () => bridge },
    "./bridgeRelayClient": { createBridgeRelayClient: () => relayBridge },
    "./relayServer": { createHostedRelayServer: () => createEmitter() },
    "./ngrokRelayManager": {
      createNgrokRelayManager: () => ({
        start: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        getStatus: () => ({}),
      }),
    },
    "./lyrics": lyricsModule,
    "./playbackController": {
      createPlaybackController: () => ({
        setSpotifyAccessTokenGetter() {},
        setSeekHandler() {},
        seek() {},
      }),
    },
    "./spotifyDetector": { createSpotifyDetector: () => detector },
    "./spotifyAuth": {
      createSpotifyAuth: () => ({
        getAccessToken: async () => "",
        getStatus: () => ({}),
        adoptAccessToken: () => false,
        logout: async () => ({ ok: true }),
        login: async () => ({ ok: true }),
        showDesktopApp: async () => ({ ok: true }),
      }),
    },
    "./containerSpotifyTokenWatcher": {
      createContainerSpotifyTokenWatcher: () => ({ start() {}, stop() {} }),
    },
    "./lyricsTtmlExport": {
      buildDefaultTtmlFilename: () => "out.ttml",
      lyricsToTtml: () => "<tt/>",
    },
    "./lyricsVault": {
      initLyricsVaultStore: () => {},
      getLyricsVaultStore: () => store,
      defaultExportPath: () => "C:/tmp/out.ttml",
    },
    "./bridgeVault": { attachBridgeVault: () => {} },
    "./lyricsPolicy": {
      isSpicyCommunityLyrics: () => true,
      isSpicyLyricsResponse: () => true,
      assertLyricsExportAllowed: () => {
        throw new Error("Spicy lyrics cannot be exported. Export from lrc.red instead.");
      },
    },
    "./spicyLyricsConfig.json": { publishableKey: "" },
  };

  global.setInterval = () => 0;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "electron-squirrel-startup") return false;
    if (request === "@ngrok/ngrok") return {};
    if (request === "qrcode") return { toDataURL: async () => "" };
    if (Object.prototype.hasOwnProperty.call(localStubs, request)) return localStubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  realFs.promises.writeFile = async (filePath, body) => {
    state.writes.push({ filePath, body });
  };
  realFs.writeFileSync = () => {};
  realFs.rmSync = () => {};
  console.log = () => {};
  console.warn = () => {};

  delete require.cache[mainPath];
  try {
    require(mainPath);
  } finally {
    console.log = originalConsoleLog;
  }

  const harness = {
    state,
    eventBus,
    detector,
    store,
    async ready() {
      await waitFor(
        () => state.ipcHandlers.has("bridge:lyrics:export-lrc-red"),
        "desktop export-lrc-red IPC handler",
      );
      await settle();
      return this;
    },
    exportLrcRed(options) {
      const handler = state.ipcHandlers.get("bridge:lyrics:export-lrc-red");
      assert.equal(typeof handler, "function", "export-lrc-red handler was not registered");
      return handler({}, options);
    },
    cancelLrcRed(requestId) {
      const handler = state.ipcHandlers.get("bridge:lyrics:export-lrc-red:cancel");
      assert.equal(typeof handler, "function", "export-lrc-red cancel handler was not registered");
      return handler({}, { requestId });
    },
    emitTrack(track) {
      detector.emit("snapshot", {
        trackId: track.trackId,
        spotifyTrackId: track.spotifyTrackId || "",
        title: track.title,
        artist: track.artist,
        album: track.album || "",
        durationMs: track.durationMs,
        positionMs: 0,
        isPlaying: true,
        timestamp: Date.now(),
      });
    },
    close() {
      for (const channel of [...state.ipcHandlers.keys()]) {
        state.ipcHandlers.delete(channel);
      }
      delete require.cache[mainPath];
      Module._load = originalLoad;
      global.setInterval = originalSetInterval;
      realFs.promises.writeFile = originalWriteFile;
      realFs.writeFileSync = originalSeekFile;
      realFs.rmSync = originalRemoveFile;
    },
  };
  harnesses.push(harness);
  return harness;
}
afterEach(() => {
  while (harnesses.length) {
    try { harnesses.pop().close(); } catch {}
  }
});

function lyricsResult(overrides = {}) {
  return {
    lyrics: [{ text: "independent line", startTimeMs: 0, endTimeMs: 1000 }],
    source: "lrc-red",
    metadata: {},
    ...overrides,
  };
}

test("desktop IPC: track change during independent lookup must not open a save dialog or write", { timeout: 10000 }, async () => {
  const harness = await loadMainHarness().ready();
  const pending = deferred();
  harness.state.lyricsLookup = () => pending.promise;
  harness.emitTrack({ trackId: "track-a", title: "Track A", artist: "Artist A", durationMs: 1000 });
  await settle();

  const resultPromise = harness.exportLrcRed({
    vaultId: "",
    format: "ttml",
    requestId: 101,
    expected: { trackId: "track-a", title: "Track A", artist: "Artist A", durationMs: 1000 },
  });

  await waitFor(() => harness.state.lookupCount === 1, "independent lookup entry");
  assert.equal(harness.state.dialogCalls.length, 0, "lookup must be pending before the track changes");
  assert.equal(harness.state.writes.length, 0, "lookup must be pending before the track changes");
  assert.ok(
    harness.state.registryCalls.some(call => /begin|activate|start|open/i.test(call.key)),
    "candidate did not activate the export request before the lookup completes",
  );
  harness.emitTrack({ trackId: "track-b", title: "Track B", artist: "Artist B", durationMs: 2000 });
  await settle();
  pending.resolve(lyricsResult());
  const result = await resultPromise;

  assert.equal(harness.state.lookupCount, 1, "the independent lookup must have been entered exactly once");
  assert.equal(harness.state.dialogCalls.length, 0, "changing track during lookup must not prompt to save");
  assert.equal(harness.state.writes.length, 0, "changing track during lookup must not write a file");
  assert.notEqual(result?.ok, true, "stale lookup must not report a successful export");
  assert.ok(
    harness.state.hasRequestRegistry,
    "candidate did not provide an export request lifecycle",
  );
});

test("desktop IPC: vault entry edit or delete during lookup must not open a save dialog or write", { timeout: 10000 }, async () => {
  const harness = await loadMainHarness().ready();
  const pending = deferred();
  harness.state.lyricsLookup = () => pending.promise;
  harness.state.storeEntry = {
    vaultId: "vault-1",
    manifest: { trackId: "vault-track", title: "Vault Track", artist: "Vault Artist", durationMs: 1000 },
    metadata: {},
    lyrics: [{ text: "spicy", startTimeMs: 0, endTimeMs: 1000 }],
  };

  const resultPromise = harness.exportLrcRed({ vaultId: "vault-1", format: "ttml", requestId: 102, expected: {} });
  await waitFor(() => harness.state.lookupCount === 1, "vault independent lookup entry");
  assert.equal(harness.state.dialogCalls.length, 0, "vault lookup must be pending before the entry is removed");
  assert.ok(
    harness.state.registryCalls.some(call => /begin|activate|start|open/i.test(call.key)),
    "candidate did not activate the export request before the lookup completes",
  );
  harness.state.storeEntry = null;
  await settle();
  pending.resolve(lyricsResult());
  const result = await resultPromise;

  assert.equal(harness.state.lookupCount, 1, "the vault independent lookup must have been entered exactly once");
  assert.equal(harness.state.dialogCalls.length, 0, "deleted vault entry must not prompt to save");
  assert.equal(harness.state.writes.length, 0, "deleted vault entry must not write a file");
  assert.notEqual(result?.ok, true);
  assert.ok(
    harness.state.hasRequestRegistry,
    "candidate did not provide an export request lifecycle",
  );
});

test("desktop IPC: identity change while the save dialog is pending must not write", { timeout: 10000 }, async () => {
  const harness = await loadMainHarness().ready();
  harness.state.lyricsLookup = async () => lyricsResult();
  const savePending = deferred();
  harness.state.showSaveDialog = () => savePending.promise;
  harness.emitTrack({ trackId: "track-a", title: "Track A", artist: "Artist A", durationMs: 1000 });
  await settle();

  const resultPromise = harness.exportLrcRed({
    vaultId: "",
    format: "ttml",
    requestId: 101,
    expected: { trackId: "track-a", title: "Track A", artist: "Artist A", durationMs: 1000 },
  });
  await waitFor(() => harness.state.dialogCalls.length === 1, "save dialog request");
  assert.ok(
    harness.state.registryCalls.some(call => /begin|activate|start|open/i.test(call.key)),
    "candidate did not activate the export request before the lookup completes",
  );
  harness.emitTrack({ trackId: "track-b", title: "Track B", artist: "Artist B", durationMs: 2000 });
  await settle();
  savePending.resolve({ canceled: false, filePath: "C:/tmp/should-not-write.ttml" });
  const result = await resultPromise;

  assert.equal(harness.state.writes.length, 0, "identity change while the save dialog is pending must not write");
  assert.notEqual(result?.ok, true);
  assert.ok(
    harness.state.hasRequestRegistry,
    "candidate did not provide an export request lifecycle",
  );
});

test("desktop IPC: cancelling the activated request during lookup prevents save and write", { timeout: 10000 }, async () => {
  const harness = await loadMainHarness().ready();
  const pending = deferred();
  harness.state.lyricsLookup = () => pending.promise;
  harness.emitTrack({ trackId: "track-a", title: "Track A", artist: "Artist A", durationMs: 1000 });
  await settle();

  const resultPromise = harness.exportLrcRed({
    vaultId: "",
    format: "ttml",
    requestId: 105,
    expected: { trackId: "track-a", title: "Track A", artist: "Artist A", durationMs: 1000 },
  });
  await waitFor(() => harness.state.lookupCount === 1, "independent lookup entry");
  assert.equal(harness.state.dialogCalls.length, 0, "lookup must be pending before cancellation");
  assert.ok(
    harness.state.registryCalls.some(call => call.key === "activate" && Number(call.args[0]) === 105),
    "candidate did not activate request 105 before the lookup completes",
  );
  await harness.cancelLrcRed(105);
  await settle();
  pending.resolve(lyricsResult());
  const result = await resultPromise;

  assert.equal(result?.canceled, true, "cancelled request must report cancellation");
  assert.equal(harness.state.dialogCalls.length, 0, "cancelled request must not prompt to save");
  assert.equal(harness.state.writes.length, 0, "cancelled request must not write a file");
  assert.equal(harness.state.lookupCount, 1, "cancelled request must still have entered the lookup");
});

test("desktop IPC positive control: unchanged track prompts save and writes the independent TTML", { timeout: 10000 }, async () => {
  const harness = await loadMainHarness().ready();
  harness.state.lyricsLookup = async () => lyricsResult();
  harness.emitTrack({ trackId: "track-a", title: "Track A", artist: "Artist A", durationMs: 1000 });
  await settle();

  const result = await harness.exportLrcRed({
    vaultId: "",
    format: "ttml",
    requestId: 104,
    expected: { trackId: "track-a", title: "Track A", artist: "Artist A", durationMs: 1000 },
  });

  assert.equal(harness.state.lookupCount, 1, "positive control must enter the independent lookup");
  assert.equal(harness.state.dialogCalls.length, 1, "unchanged track must prompt to save");
  assert.equal(harness.state.writes.length, 1, "unchanged track must write exactly one file");
  assert.equal(harness.state.writes[0].filePath, "C:/tmp/out.ttml");
  assert.equal(harness.state.writes[0].body, "<tt/>");
  assert.equal(result?.ok, true);
  assert.equal(result?.format, "ttml");
  assert.ok(
    harness.state.registryCalls.some(call => /begin|activate|start|open/i.test(call.key)),
    "candidate did not activate the export request before the lookup completes",
  );
});
