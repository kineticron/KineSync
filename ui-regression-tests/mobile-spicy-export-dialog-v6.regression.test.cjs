// Interactive mobile UI regression checks for the restricted Spicy export flow.
// Transpiles and renders the real ExpoLyrics vault screen and the real shared
// LyricsGlassDialog with mocked native modules, then drives actual presses.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { test, afterEach } = require("node:test");

function loadDependency(name) {
  try {
    return require(name);
  } catch {
    return require(path.join(__dirname, "..", "ui-regression-deps", "node_modules", name));
  }
}

const React = loadDependency("react");
const TestRenderer = loadDependency("react-test-renderer");
const ts = loadDependency("typescript");
const repoRoot = process.env.KINESYNC_IMPL_ROOT
  ? path.resolve(process.env.KINESYNC_IMPL_ROOT)
  : path.join(__dirname, "..");
const vaultPath = path.join(repoRoot, "ExpoLyrics", "app", "(tabs)", "vault.tsx");
const glassPath = path.join(repoRoot, "ExpoLyrics", "components", "lyrics", "lyrics-glass-dialog.tsx");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle(rounds = 6) {
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

function compileTsModule(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: filePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      allowJs: true,
      isolatedModules: true,
    },
  }).outputText;
  const mod = new Module(filePath, module);
  mod.filename = filePath;
  mod.paths = Module._nodeModulePaths(path.dirname(filePath));
  mod._compile(output, filePath);
  return mod.exports;
}

const host = name => function Host(props) {
  return React.createElement(name, props, props.children);
};
const View = host("View");
const Text = host("Text");
const TextInput = host("TextInput");
const ScrollView = host("ScrollView");
const ActivityIndicator = host("ActivityIndicator");
const BlurView = host("BlurView");
const SafeAreaView = host("SafeAreaView");
const AnimatedView = host("AnimatedView");
const Ionicons = function Ionicons() { return null; };
const MotionPressable = function MotionPressable(props) {
  return React.createElement("MotionPressable", props, props.children);
};
const FlashList = function FlashList(props) {
  const data = Array.isArray(props.data) ? props.data : [];
  const items = data.map((item, index) => React.createElement(
    React.Fragment,
    { key: props.keyExtractor ? props.keyExtractor(item) : index },
    props.renderItem ? props.renderItem({ item, index }) : null,
  ));
  return React.createElement(
    View,
    { style: props.contentContainerStyle },
    props.ListHeaderComponent || null,
    items,
    data.length === 0 ? props.ListEmptyComponent || null : null,
  );
};
const Modal = function Modal(props) {
  if (!props.visible) return null;
  return React.createElement("Modal", props, props.children);
};
const Pressable = function Pressable(props) {
  return React.createElement("Pressable", props, props.children);
};
const Animated = { View: AnimatedView };

const mocks = {
  shareCalls: [],
  fileWrites: [],
  fileCreates: [],
  fetchCalls: [],
  catalog: [],
  vaultEntries: new Map(),
  restrictedResponses: new Set(),
  fetchImplementation: null,
  alertCalls: [],
};

function resetMocks() {
  mocks.shareCalls.length = 0;
  mocks.fileWrites.length = 0;
  mocks.fileCreates.length = 0;
  mocks.fetchCalls.length = 0;
  mocks.catalog = [];
  mocks.vaultEntries = new Map();
  mocks.restrictedResponses = new Set();
  mocks.fetchImplementation = null;
  mocks.alertCalls.length = 0;
}

function makeEntry(overrides = {}) {
  return {
    vaultId: "vault-spicy-1",
    track: {
      id: "track-1",
      title: "Restricted Song",
      artist: "Restricted Artist",
      album: "Restricted Album",
      durationMs: 240000,
      spotifyTrackId: "spotify-1",
    },
    lyrics: [{ text: "spicy line", startTimeMs: 0, endTimeMs: 1000 }],
    originalSource: "spicy-lyrics",
    metadata: { fetchOrigin: { source: "spicylyrics", isrc: "US1234567890" } },
    sourceLabel: "Spicy Lyrics",
    lineCount: 1,
    hasTranslations: false,
    exportRestricted: true,
    ...overrides,
  };
}

function createStubs() {
  const File = class File {
    constructor(...args) {
      this.uri = typeof args[1] === "string" ? args[1] : String(args[0] || "mock-file.ttml");
      this.name = path.basename(this.uri);
      this.size = 128;
    }
    create(options) { mocks.fileCreates.push({ uri: this.uri, options }); }
    write(content) { mocks.fileWrites.push({ uri: this.uri, content }); }
    async text() { return ""; }
    static async pickFileAsync() { return { canceled: true }; }
  };
  const Paths = { cache: "/cache" };
  const useFocusEffect = callback => {
    React.useEffect(() => { callback(); }, [callback]);
  };
  const router = { canGoBack: () => true, back() {}, replace() {} };
  const usePlaybackStore = selector => selector({
    currentTrack: null,
    lyrics: [],
    lyricsSource: "",
    lyricsMetadata: {},
  });
  usePlaybackStore.getState = () => ({
    currentTrack: null,
    lyrics: [],
    lyricsSource: "",
    lyricsMetadata: {},
  });

  const localStubs = {
    "expo-router": { router, useFocusEffect },
    "expo-file-system": { File, Paths },
    "expo-sharing": { shareAsync: async (uri, options) => { mocks.shareCalls.push({ uri, options }); } },
    "expo-blur": { BlurView },
    "react-native": {
      ActivityIndicator,
      Alert: { alert: (...args) => { mocks.alertCalls.push(args); } },
      KeyboardAvoidingView: View,
      Modal,
      Platform: { OS: "ios" },
      Pressable,
      ScrollView,
      StyleSheet: { create: value => value, absoluteFill: {}, hairlineWidth: 1 },
      Text,
      TextInput,
      View,
    },
    "react-native-reanimated": {
      __esModule: true,
      Animated,
      default: Animated,
      FadeIn: { duration: () => ({ reduceMotion: () => ({}) }) },
      ReduceMotion: { System: "system" },
    },
    "react-native-safe-area-context": {
      SafeAreaView,
      useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    },
    "@shopify/flash-list": { FlashList },
    "@react-native-vector-icons/ionicons": {
      __esModule: true,
      default: Ionicons,
    },
    "@/components/ui/motion-pressable": { MotionPressable },
    "@/components/ui/promotional-backdrop": { PromotionalBackdrop: () => null },
    "@/components/lyrics/bridged-artwork-image": { BridgedArtworkImage: () => null },
    "@/components/lyrics/desktop-vault-catalog": { DesktopVaultCatalog: () => null },
    "@/constants/design": {
      Design: {
        background: "#000",
        text: "#fff",
        muted: "#999",
        accent: "#6fe8b3",
        accentInk: "#001",
        border: "#222",
      },
    },
    "@/hooks/use-vault-incoming-share": {
      useVaultIncomingShare: () => ({
        resolvedSharedPayloads: [],
        clearSharedPayloads() {},
        error: null,
      }),
    },
    "@/lib/mobile-lyrics-vault": {
      readVaultCatalog: async () => mocks.catalog,
      getMobileVaultEntry: async vaultId => mocks.vaultEntries.get(vaultId) || null,
      deleteMobileVaultEntry: async () => {},
      renameMobileVaultEntry: async () => {},
      saveMobileVaultLyrics: async () => {},
    },
    "@/lib/mobile-lyrics-client": {
      fetchLrcRedExportLyricsForTrack: async (track, isrc) => {
        mocks.fetchCalls.push({ track, isrc });
        if (!mocks.fetchImplementation) throw new Error("fetch implementation was not configured");
        return mocks.fetchImplementation(track, isrc);
      },
    },
    "@/lib/lyrics-ttml-import": {
      extractTtmlMetadata: () => ({}),
      parseTtmlToLyrics: () => ({ lyrics: [] }),
    },
    "@/lib/lyrics-ttml-export": {
      buildDefaultTtmlFilename: track => `${track.title || "lyrics"}.ttml`,
      lyricsToTtml: payload => `TTML:${payload.source}:${payload.lyrics.length}:${payload.title}`,
    },
    "@/lib/lyrics-policy": {
      assertLyricsExportAllowed: entry => {
        if (mocks.restrictedResponses.has(entry.vaultId)) throw new Error("Spicy lyrics cannot be exported.");
      },
      isSpicyLyricsResponse: entry => mocks.restrictedResponses.has(entry.vaultId),
    },
    "@/store/playback-store": { usePlaybackStore },
  };
  return localStubs;
}

function loadVaultModule() {
  const stubs = createStubs();
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "@/components/lyrics/lyrics-glass-dialog") return compileTsModule(glassPath);
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    if (request === "react") return React;
    if (request === "react/jsx-runtime") return require(path.join(__dirname, "..", "ui-regression-deps", "node_modules", "react", "jsx-runtime"));
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return compileTsModule(vaultPath).default;
  } finally {
    Module._load = originalLoad;
  }
}

const renderers = [];
function renderVault() {
  const VaultScreen = loadVaultModule();
  let renderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(React.createElement(VaultScreen));
  });
  renderers.push(renderer);
  return renderer;
}
afterEach(() => {
  while (renderers.length) {
    try { TestRenderer.act(() => renderers.pop().unmount()); } catch {}
  }
  resetMocks();
});

function textsOf(renderer) {
  return renderer.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    if (Array.isArray(children)) return children.filter(child => typeof child === "string").join("");
    return typeof children === "string" ? children : "";
  });
}
function hasText(renderer, value) {
  return textsOf(renderer).some(text => text.includes(value));
}
function nodeText(node) {
  const children = node.props?.children;
  if (Array.isArray(children)) {
    return children.map(child => (typeof child === "string" ? child : "")).join("");
  }
  return typeof children === "string" ? children : "";
}

function findAction(renderer, label) {
  const pressables = renderer.root.findAll(node => node.type === "Pressable" && typeof node.props?.onPress === "function");
  for (let index = pressables.length - 1; index >= 0; index -= 1) {
    const texts = pressables[index].findAll(node => node.type === "Text").map(nodeText);
    if (texts.some(text => text.includes(label))) return pressables[index];
  }
  return null;
}
function findExportButton(renderer, label) {
  return renderer.root.find(node =>
    node.type === "MotionPressable" && node.props?.accessibilityLabel === label,
  );
}
function press(renderer, node) {
  assert.ok(node, "expected a pressable control");
  TestRenderer.act(() => { node.props.onPress(); });
}

async function openRestrictedDialog(renderer) {
  const fetchCountBefore = mocks.fetchCalls.length;
  const exportButton = findExportButton(renderer, "Export Restricted Song from lrc.red");
  assert.equal(exportButton.props.disabled, false, "restricted vault export button should be enabled");
  press(renderer, exportButton);
  await settle();
  await waitFor(() => hasText(renderer, "Spicy lyrics"), "initial Spicy dialog");
  assert.equal(mocks.fetchCalls.length, fetchCountBefore, "opening the notice must not fetch");
}

async function openLrcredDialog(renderer) {
  const fetchCountBefore = mocks.fetchCalls.length;
  await openRestrictedDialog(renderer);
  press(renderer, findAction(renderer, "Export from lrc.red instead"));
  await settle();
  await waitFor(() => hasText(renderer, "Export from lrc.red"), "lrc.red confirmation dialog");
  assert.equal(mocks.fetchCalls.length, fetchCountBefore, "opening the confirmation must not fetch");
}

function seedVault() {
  const entry = makeEntry();
  mocks.catalog = [entry];
  mocks.vaultEntries.set(entry.vaultId, entry);
  mocks.restrictedResponses.add(entry.vaultId);
  return entry;
}

async function prepareVault(renderer, entry) {
  await TestRenderer.act(async () => { await settle(); });
  return entry;
}

test("mobile restricted vault export button is enabled and opens the Spicy dialog", async () => {
  const entry = seedVault();
  const renderer = renderVault();
  await prepareVault(renderer, entry);
  const exportButton = findExportButton(renderer, "Export Restricted Song from lrc.red");
  assert.equal(exportButton.props.disabled, false, "restricted vault export button should stay enabled");
  press(renderer, exportButton);
  await settle();
  assert.equal(hasText(renderer, "Spicy lyrics"), true);
  assert.equal(hasText(renderer, "Spicy lyrics cannot be exported."), true);
});

test("mobile cancelling the initial dialog and the separate lrc.red confirmation performs zero fetches", async () => {
  const entry = seedVault();
  const renderer = renderVault();
  await prepareVault(renderer, entry);
  await openRestrictedDialog(renderer);
  press(renderer, findAction(renderer, "Cancel"));
  await settle();
  assert.equal(hasText(renderer, "Spicy lyrics"), false);
  assert.equal(mocks.fetchCalls.length, 0);

  await openLrcredDialog(renderer);
  press(renderer, findAction(renderer, "Cancel"));
  await settle();
  assert.equal(hasText(renderer, "This export comes from lrc.red, NOT Spicy Lyrics."), false);
  assert.equal(mocks.fetchCalls.length, 0, "cancelling lrc.red confirmation must not fetch");
});

test("mobile confirm success writes and shares one independent TTML and closes the dialog", async () => {
  mocks.fetchImplementation = async () => ({
    lyrics: [{ text: "independent line", startTimeMs: 0, endTimeMs: 1000 }],
    source: "lrc-red",
    metadata: {},
  });
  const entry = seedVault();
  const renderer = renderVault();
  await prepareVault(renderer, entry);
  await openLrcredDialog(renderer);
  press(renderer, findAction(renderer, "Export lrc.red lyrics"));
  await TestRenderer.act(async () => { await settle(10); });

  assert.equal(mocks.fetchCalls.length, 1);
  assert.equal(mocks.fileWrites.length, 1);
  assert.match(mocks.fileWrites[0].content, /^TTML:lrc-red:1:Restricted Song$/);
  assert.equal(mocks.shareCalls.length, 1);
  assert.equal(mocks.shareCalls[0].options.mimeType, "application/ttml+xml");
  assert.equal(hasText(renderer, "This export comes from lrc.red, NOT Spicy Lyrics."), false, "successful share should close the dialog");
});

test("mobile no-match shows the message, keeps the dialog open, and does not share", async () => {
  mocks.fetchImplementation = async () => ({ lyrics: [], source: "lrc-red", metadata: {} });
  const entry = seedVault();
  const renderer = renderVault();
  await prepareVault(renderer, entry);
  await openLrcredDialog(renderer);
  press(renderer, findAction(renderer, "Export lrc.red lyrics"));
  await TestRenderer.act(async () => { await settle(10); });

  assert.equal(mocks.fetchCalls.length, 1);
  assert.equal(hasText(renderer, "lrc.red doesn't have this song"), true);
  assert.equal(mocks.fileWrites.length, 0);
  assert.equal(mocks.shareCalls.length, 0);
  assert.equal(hasText(renderer, "This export comes from lrc.red, NOT Spicy Lyrics."), true);
});

test("mobile in-flight cancel reopens with enabled controls and a late result cannot clobber the new dialog", async () => {
  const pending = deferred();
  mocks.fetchImplementation = () => pending.promise;
  const entry = seedVault();
  const renderer = renderVault();
  await prepareVault(renderer, entry);
  await openLrcredDialog(renderer);

  press(renderer, findAction(renderer, "Export lrc.red lyrics"));
  await settle();
  assert.equal(mocks.fetchCalls.length, 1);
  assert.equal(hasText(renderer, "Fetching lrc.red..."), true, "confirm control should show busy state");
  assert.equal(hasText(renderer, "Cancel"), true, "cancel must remain available while fetching");

  press(renderer, findAction(renderer, "Cancel"));
  await TestRenderer.act(async () => { await settle(); });
  assert.equal(hasText(renderer, "This export comes from lrc.red, NOT Spicy Lyrics."), false, "cancel should close the in-flight dialog");

  await openLrcredDialog(renderer);
  const confirm = findAction(renderer, "Export lrc.red lyrics");
  assert.ok(confirm, "reopened dialog should offer an enabled export action, not a stuck busy label");
  assert.equal(confirm.props.disabled, false, "reopened controls should be enabled");
  assert.equal(hasText(renderer, "Fetching lrc.red..."), false, "reopened dialog should not inherit busy state");

  pending.resolve({ lyrics: [{ text: "stale line", startTimeMs: 0, endTimeMs: 1000 }], source: "lrc-red", metadata: {} });
  await TestRenderer.act(async () => { await settle(10); });
  assert.equal(hasText(renderer, "This export comes from lrc.red, NOT Spicy Lyrics."), true, "late result must not close the new dialog");
  assert.equal(mocks.fileWrites.length, 0, "late result from a cancelled request must not write or export");
  assert.equal(mocks.shareCalls.length, 0);
});

test("mobile successful share closes and a fresh dialog reopens with enabled controls", async () => {
  mocks.fetchImplementation = async () => ({
    lyrics: [{ text: "independent line", startTimeMs: 0, endTimeMs: 1000 }],
    source: "lrc-red",
    metadata: {},
  });
  const entry = seedVault();
  const renderer = renderVault();
  await prepareVault(renderer, entry);
  await openLrcredDialog(renderer);
  press(renderer, findAction(renderer, "Export lrc.red lyrics"));
  await TestRenderer.act(async () => { await settle(10); });
  assert.equal(mocks.shareCalls.length, 1);

  await openLrcredDialog(renderer);
  const confirm = findAction(renderer, "Export lrc.red lyrics");
  assert.ok(confirm, "reopened dialog should offer an enabled export action");
  assert.equal(confirm.props.disabled, false, "reopened confirm should be enabled after a successful share");
  assert.equal(hasText(renderer, "Fetching lrc.red..."), false, "success must not leave busy state stuck");
});
