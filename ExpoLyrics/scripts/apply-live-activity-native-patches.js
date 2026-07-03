const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const CUSTOM_WIDGET_MARKER = "lyricsMicIcon";
const ATTRIBUTES_SOURCE = path.join(
  projectRoot,
  "native",
  "live-activity-module",
  "LiveActivityAttributes.swift",
);

const widgetSwiftFiles = [
  "LiveActivityAttributes.swift",
  "LiveActivityWidget.swift",
  "LiveActivityView.swift",
];
const moduleFiles = [
  "LiveActivityAttributes.swift",
  "ExpoLiveActivityModule.swift",
];

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing native override file: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function assertCustomWidget(filePath) {
  const contents = readText(filePath);
  if (!contents.includes(CUSTOM_WIDGET_MARKER)) {
    throw new Error(
      `Live Activity widget patch verification failed for ${filePath}. ` +
        `Expected custom marker "${CUSTOM_WIDGET_MARKER}". ` +
        "Run npm install, then npx expo prebuild --clean before building.",
    );
  }
}

function assertSharedAttributes(filePath) {
  const contents = readText(filePath);
  if (!contents.includes("lyricsMode")) {
    throw new Error(
      `Live Activity attributes at ${filePath} are missing lyrics fields.`,
    );
  }
}

function widgetSourceFor(fileName) {
  if (fileName === "LiveActivityAttributes.swift") {
    return ATTRIBUTES_SOURCE;
  }
  return path.join(projectRoot, "native", "live-activity", fileName);
}

function patchDirectory(targetDir) {
  if (!fs.existsSync(targetDir)) {
    return false;
  }

  for (const fileName of widgetSwiftFiles) {
    copyIfExists(widgetSourceFor(fileName), path.join(targetDir, fileName));
  }

  assertCustomWidget(path.join(targetDir, "LiveActivityWidget.swift"));
  assertSharedAttributes(path.join(targetDir, "LiveActivityAttributes.swift"));
  return true;
}

function patchPackageWidgetTemplates() {
  const packageWidgetDir = path.join(
    projectRoot,
    "node_modules",
    "expo-live-activity",
    "ios-files",
  );

  if (!fs.existsSync(packageWidgetDir)) {
    console.warn(
      "[live-activity] Skipping ios-files patch because expo-live-activity is not installed.",
    );
    return false;
  }

  return patchDirectory(packageWidgetDir);
}

function patchGeneratedWidgetTarget() {
  return patchDirectory(path.join(projectRoot, "ios", "LiveActivity"));
}

function patchModuleTarget() {
  const moduleDir = path.join(
    projectRoot,
    "node_modules",
    "expo-live-activity",
    "ios",
  );

  if (!fs.existsSync(moduleDir)) {
    console.warn(
      "[live-activity] Skipping module patch because expo-live-activity is not installed.",
    );
    return false;
  }

  for (const fileName of moduleFiles) {
    copyIfExists(
      path.join(projectRoot, "native", "live-activity-module", fileName),
      path.join(moduleDir, fileName),
    );
  }

  assertSharedAttributes(path.join(moduleDir, "LiveActivityAttributes.swift"));
  return true;
}

function applyLiveActivityNativePatches() {
  const packageWidgetPatched = patchPackageWidgetTemplates();
  const generatedWidgetPatched = patchGeneratedWidgetTarget();
  const modulePatched = patchModuleTarget();

  if (packageWidgetPatched) {
    console.log(
      "[live-activity] Patched expo-live-activity/ios-files (used by expo prebuild).",
    );
  }
  if (modulePatched) {
    console.log("[live-activity] Patched expo-live-activity/ios native module.");
  }
  if (generatedWidgetPatched) {
    console.log("[live-activity] Patched generated ios/LiveActivity target.");
  }

  return {
    packageWidgetPatched,
    generatedWidgetPatched,
    modulePatched,
  };
}

if (require.main === module) {
  applyLiveActivityNativePatches();
}

module.exports = {
  CUSTOM_WIDGET_MARKER,
  applyLiveActivityNativePatches,
  assertCustomWidget,
  assertSharedAttributes,
};
