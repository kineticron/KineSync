// Interactive desktop UI regression checks for the restricted Spicy export flow.
// Loads the real DesktopBridge renderer (index.html) in jsdom and drives real
// DOM events with a mocked preload bridge. No source-text assertions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, afterEach } = require("node:test");

function loadDependency(name) {
  try {
    return require(name);
  } catch {
    return require(path.join(__dirname, "..", "ui-regression-deps", "node_modules", name));
  }
}

const { JSDOM, VirtualConsole } = loadDependency("jsdom");
const repoRoot = process.env.KINESYNC_IMPL_ROOT
  ? path.resolve(process.env.KINESYNC_IMPL_ROOT)
  : path.join(__dirname, "..");
const htmlPath = path.join(repoRoot, "DesktopBridge", "src", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async (rounds = 4) => {
  for (let index = 0; index < rounds; index += 1) await tick();
};

async function waitFor(predicate, label, timeoutMs = 1000) {
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

function createHarness({ vaultEntries = [], exportLrcRed, exportTtml } = {}) {
  const calls = {
    exportLrcRed: [],
    exportTtml: 0,
    exportVaultEntry: [],
    cancelLrcRedExport: [],
  };
  let statusHandler = null;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  const dom = new JSDOM(html, {
    url: `file:///${path.join(repoRoot, "DesktopBridge", "src", "index.html").replace(/\\/g, "/")}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() { return []; }
      };
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      window.bridgeStatus = {
        onStatus(handler) {
          statusHandler = handler;
          return () => {};
        },
      };
      window.bridgeSettings = {
        get: async () => ({}),
        set: async () => ({ ok: true }),
      };
      window.spotifyAuth = {
        login: async () => ({ ok: true }),
        logout: async () => ({ ok: true }),
        getStatus: async () => ({ ok: true }),
        showDesktopApp: async () => ({ ok: true }),
      };
      window.bridgeAPI = {
        getSettings: async () => ({}),
        saveSettings: async () => ({ ok: true }),
        startNgrokRelay: async () => ({ ok: true }),
        stopNgrokRelay: async () => ({ ok: true }),
        authenticateNgrok: async () => ({ ok: true }),
        renderQrCode: async () => "",
      };
      window.bridgeLyrics = {
        exportIdentity: async () => ({
          ok: true,
          trackId: "track-a",
          spotifyTrackId: "spotify-a",
          title: "Track A",
          artist: "Artist A",
          durationMs: 240000,
          isrc: "US1234567890",
        }),
        cancelLrcRedExport: async requestId => {
          calls.cancelLrcRedExport.push(requestId);
          return { ok: true };
        },
        exportTtml: async () => {
          calls.exportTtml += 1;
          return exportTtml ? exportTtml() : { ok: true, filePath: "C:/tmp/current.ttml", lineCount: 4 };
        },
        exportLrcRed: async options => {
          calls.exportLrcRed.push(options);
          return exportLrcRed ? exportLrcRed(options) : { ok: true, filePath: "C:/tmp/lrcred.ttml", lineCount: 4 };
        },
        listVaultEntries: async () => ({
          ok: true,
          entries: vaultEntries,
          entryCount: vaultEntries.length,
          folderPath: "C:/vault",
        }),
        exportVaultEntry: async (vaultId, format) => {
          calls.exportVaultEntry.push({ vaultId, format });
          return { ok: true, filePath: "C:/tmp/vault.ttml", lineCount: 4 };
        },
        openVaultFolder: async () => ({ ok: true }),
      };
    },
  });

  const { window } = dom;
  return {
    dom,
    window,
    document: window.document,
    calls,
    postStatus(status) {
      assert.equal(typeof statusHandler, "function", "renderer did not register a status handler");
      statusHandler({
        lyricsLines: 4,
        lyricsStatus: "Spicy Lyrics",
        isPlaying: false,
        durationMs: 240000,
        positionMs: 0,
        ...status,
        lyricsExportRestricted: status.lyricsExportRestricted ?? true,
      });
    },
    close() {
      window.close();
    },
  };
}

function restrictedEntry(overrides = {}) {
  return {
    vaultId: "vault-spicy-1",
    title: "Restricted Song",
    artist: "Restricted Artist",
    album: "Restricted Album",
    lineCount: 4,
    translatedLineCount: 0,
    durationMs: 240000,
    sourceLabel: "Spicy Lyrics",
    exportRestricted: true,
    savedAt: Date.now(),
    ...overrides,
  };
}

const harnesses = [];
function makeHarness(options) {
  const harness = createHarness(options);
  harnesses.push(harness);
  return harness;
}
afterEach(() => {
  while (harnesses.length) {
    try { harnesses.pop().close(); } catch {}
  }
});

function currentExportButton(harness) {
  return harness.document.getElementById("export-lyrics-ttml");
}
function protectedOverlay(harness) {
  return harness.document.getElementById("protected-export-overlay");
}
function lrcredOverlay(harness) {
  return harness.document.getElementById("lrcred-export-overlay");
}
function click(harness, node) {
  assert.ok(node, "expected a clickable element");
  node.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function openCurrentDialog(harness) {
  const button = currentExportButton(harness);
  assert.equal(button.disabled, false, "restricted current-track export button should be enabled so it can open the dialog");
  click(harness, button);
  await settle();
  assert.equal(protectedOverlay(harness).hidden, false, "clicking the restricted current-track export button should open the Spicy dialog");
}

async function openLrcredDialog(harness) {
  await openCurrentDialog(harness);
  click(harness, harness.document.getElementById("protected-export-lrcred"));
  await settle();
  assert.equal(lrcredOverlay(harness).hidden, false, "Export from lrc.red should open the independent confirmation dialog");
}

test("desktop current-track restricted export button is enabled and opens the Spicy dialog", async () => {
  const harness = makeHarness();
  await settle();
  harness.postStatus({ lyricsExportRestricted: true });
  await settle();
  const button = currentExportButton(harness);
  assert.equal(button.disabled, false, "restricted current-track export button should stay enabled");
  click(harness, button);
  await settle();
  assert.equal(protectedOverlay(harness).hidden, false);
  assert.match(harness.document.getElementById("protected-export-title").textContent, /Spicy lyrics/);
  assert.match(harness.document.getElementById("protected-export-message").textContent, /cannot be exported/i);
});

test("desktop vault restricted export buttons are enabled and open the Spicy dialog", async () => {
  const harness = makeHarness({ vaultEntries: [restrictedEntry()] });
  await settle();
  click(harness, harness.document.getElementById("open-lyrics-vault"));
  await waitFor(
    () => harness.document.querySelector(".vault-entry button[data-export-format='ttml']"),
    "vault entry export button",
  );
  const ttmlButton = harness.document.querySelector(".vault-entry button[data-export-format='ttml']");
  const jsonButton = harness.document.querySelector(".vault-entry button[data-export-format='json']");
  assert.equal(ttmlButton.disabled, false, "restricted vault TTML export button should stay enabled");
  assert.equal(jsonButton.disabled, false, "restricted vault JSON export button should stay enabled");
  click(harness, ttmlButton);
  await settle();
  assert.equal(protectedOverlay(harness).hidden, false);
  assert.equal(harness.calls.exportLrcRed.length, 0, "opening the dialog must not fetch anything");
  assert.equal(harness.calls.exportVaultEntry.length, 0, "opening the dialog must not export the restricted vault entry");
});

test("desktop cancelling the initial dialog and the separate lrc.red confirmation performs zero fetches", async () => {
  const harness = makeHarness();
  await settle();
  harness.postStatus({ lyricsExportRestricted: true });
  await settle();
  await openCurrentDialog(harness);
  click(harness, harness.document.getElementById("protected-export-cancel"));
  await settle();
  assert.equal(protectedOverlay(harness).hidden, true);
  assert.equal(lrcredOverlay(harness).hidden, true);
  assert.equal(harness.calls.exportLrcRed.length, 0);

  await openLrcredDialog(harness);
  click(harness, harness.document.getElementById("lrcred-export-cancel"));
  await settle();
  assert.equal(lrcredOverlay(harness).hidden, true);
  assert.equal(harness.calls.exportLrcRed.length, 0, "cancelling lrc.red confirmation must not fetch");
});

test("desktop confirm success exports one independent lrc.red TTML and closes the dialog", async () => {
  const harness = makeHarness({
    exportLrcRed: async () => ({ ok: true, filePath: "C:/tmp/independent.ttml", lineCount: 4, format: "ttml" }),
  });
  await settle();
  harness.postStatus({ lyricsExportRestricted: true });
  await settle();
  await openLrcredDialog(harness);
  click(harness, harness.document.getElementById("lrcred-export-confirm"));
  await settle(8);
  assert.equal(harness.calls.exportLrcRed.length, 1, "confirm should issue exactly one independent export request");
  assert.equal(harness.calls.exportLrcRed[0].vaultId, "");
  assert.equal(lrcredOverlay(harness).hidden, true, "successful export should close the lrc.red dialog");
  assert.equal(protectedOverlay(harness).hidden, true);
  assert.match(
    harness.document.getElementById("export-lyrics-ttml-status").textContent,
    /Saved lrc\.red lyrics to C:\/tmp\/independent\.ttml/,
  );
});

test("desktop no-match keeps the dialog open, shows the message, and performs no export", async () => {
  const harness = makeHarness({
    exportLrcRed: async () => ({ ok: false, noMatch: true, error: "lrc.red doesn't have this song" }),
  });
  await settle();
  harness.postStatus({ lyricsExportRestricted: true });
  await settle();
  await openLrcredDialog(harness);
  click(harness, harness.document.getElementById("lrcred-export-confirm"));
  await settle(8);
  assert.equal(harness.calls.exportLrcRed.length, 1);
  assert.equal(lrcredOverlay(harness).hidden, false, "no-match dialog should stay open");
  assert.match(harness.document.getElementById("lrcred-export-status").textContent, /doesn't have this song/i);
  assert.equal(harness.document.getElementById("export-lyrics-ttml-status").hidden, true);
});

test("desktop in-flight confirm stays cancellable, reopens cleanly, and a late old result cannot clobber or re-enable a newer request", async () => {
  const first = deferred();
  const second = deferred();
  let requestCount = 0;
  const harness = makeHarness({
    exportLrcRed: () => {
      requestCount += 1;
      return requestCount === 1 ? first.promise : second.promise;
    },
  });
  await settle();
  harness.postStatus({ lyricsExportRestricted: true });
  await settle();
  await openLrcredDialog(harness);

  let confirm = harness.document.getElementById("lrcred-export-confirm");
  const cancel = harness.document.getElementById("lrcred-export-cancel");
  click(harness, confirm);
  await settle();
  assert.equal(harness.calls.exportLrcRed.length, 1);
  assert.equal(confirm.disabled, true, "confirm should be busy while the fetch is in flight");
  assert.equal(cancel.disabled, false, "cancel must remain available while the fetch is in flight");

  click(harness, cancel);
  await settle();
  assert.equal(lrcredOverlay(harness).hidden, true, "cancel should close the in-flight dialog");
  assert.equal(harness.calls.cancelLrcRedExport.length, 1, "cancel should cancel the active request");

  await openCurrentDialog(harness);
  await openLrcredDialog(harness);
  confirm = harness.document.getElementById("lrcred-export-confirm");
  assert.equal(confirm.disabled, false, "reopened dialog controls should be enabled");
  assert.equal(harness.document.getElementById("lrcred-export-cancel").disabled, false);

  click(harness, confirm);
  await settle();
  assert.equal(harness.calls.exportLrcRed.length, 2, "the reopened dialog should start a second request");
  assert.equal(confirm.disabled, true, "the second request should own the busy state");

  first.resolve({ ok: true, filePath: "C:/tmp/stale.ttml", lineCount: 4 });
  await settle(8);
  assert.equal(confirm.disabled, true, "late old finally must not re-enable the active newer request");
  assert.equal(lrcredOverlay(harness).hidden, false, "late old result must not close the active newer dialog");
  assert.match(harness.document.getElementById("lrcred-export-status").textContent, /Fetching independent lrc\.red lyrics/);
  assert.doesNotMatch(harness.document.getElementById("lrcred-export-status").textContent, /Saved|stale/i);

  second.resolve({ ok: true, filePath: "C:/tmp/newer.ttml", lineCount: 4 });
  await settle(8);
  assert.equal(lrcredOverlay(harness).hidden, true, "the newer request should still complete and close");
  assert.match(harness.document.getElementById("export-lyrics-ttml-status").textContent, /newer\.ttml/);
});

test("desktop successful export closes and a fresh dialog reopens with enabled controls", async () => {
  const harness = makeHarness();
  await settle();
  harness.postStatus({ lyricsExportRestricted: true });
  await settle();
  await openLrcredDialog(harness);
  click(harness, harness.document.getElementById("lrcred-export-confirm"));
  await settle(8);
  assert.equal(lrcredOverlay(harness).hidden, true);

  await openLrcredDialog(harness);
  assert.equal(
    harness.document.getElementById("lrcred-export-confirm").disabled,
    false,
    "reopened confirm should be enabled after a successful export",
  );
  assert.equal(harness.document.getElementById("lrcred-export-cancel").disabled, false);
});
