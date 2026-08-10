/* global __dirname */
const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const marker = "KineSyncDirectLiveActivityRenderer";
const sourcePath = path.join(
  projectRoot,
  "native",
  "expo-widgets",
  "WidgetLiveActivity.swift",
);
const packageRoot = path.join(projectRoot, "node_modules", "expo-widgets");
const targetPath = path.join(
  packageRoot,
  "ios",
  "Widgets",
  "WidgetLiveActivity.swift",
);

function assertDirectRenderer(filePath) {
  const contents = fs.readFileSync(filePath, "utf8");
  if (!contents.includes(marker)) {
    throw new Error(`KineSync direct Live Activity renderer is missing from ${filePath}.`);
  }
}

function applyKineSyncLiveActivityPatch() {
  if (!fs.existsSync(packageRoot)) {
    console.warn(
      "[live-activity] expo-widgets is not installed; skipping native renderer patch.",
    );
    return false;
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (!String(packageJson.version).startsWith("57.")) {
    throw new Error(
      `The KineSync Live Activity renderer expects expo-widgets 57.x, found ${packageJson.version}.`,
    );
  }

  fs.copyFileSync(sourcePath, targetPath);
  assertDirectRenderer(targetPath);
  console.log(
    "[live-activity] Applied the Sideloadly-safe native renderer to expo-widgets.",
  );
  return true;
}

if (require.main === module) {
  applyKineSyncLiveActivityPatch();
}

module.exports = {
  applyKineSyncLiveActivityPatch,
  assertDirectRenderer,
  marker,
};
