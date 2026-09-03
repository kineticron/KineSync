const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolvePackagedNativePath } = require("../src/nativeRuntimePaths");

test("resolves an Electron asar path to its physical unpacked native file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kinesync-asar-"));
  try {
    const virtualPath = path.join(root, "resources", "app.asar", "native", "helper.dll");
    const unpackedPath = path.join(
      root,
      "resources",
      "app.asar.unpacked",
      "native",
      "helper.dll",
    );
    fs.mkdirSync(path.dirname(unpackedPath), { recursive: true });
    fs.writeFileSync(unpackedPath, "fixture");

    assert.equal(resolvePackagedNativePath(virtualPath), unpackedPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("leaves development paths and missing unpacked files unchanged", () => {
  const developmentPath = path.join("DesktopBridge", "native", "helper.dll");
  assert.equal(resolvePackagedNativePath(developmentPath), developmentPath);

  const missingVirtualPath = path.join("resources", "app.asar", "native", "missing.dll");
  assert.equal(resolvePackagedNativePath(missingVirtualPath), missingVirtualPath);
});
