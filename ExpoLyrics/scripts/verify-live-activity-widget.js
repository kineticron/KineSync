/* global __dirname */
const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const { assertDirectRenderer, marker: directRendererMarker } = require(
  "./apply-kinesync-live-activity-patch",
);
const activitySourcePath = path.join(
  projectRoot,
  "widgets",
  "lyrics-live-activity.tsx",
);

function assertIncludes(contents, marker, label) {
  if (!contents.includes(marker)) {
    throw new Error(`${label} is missing ${JSON.stringify(marker)}.`);
  }
}

function verifyDirectNativeRenderer() {
  const sourcePath = path.join(
    projectRoot,
    "native",
    "expo-widgets",
    "WidgetLiveActivity.swift",
  );
  const packagePath = path.join(
    projectRoot,
    "node_modules",
    "expo-widgets",
    "ios",
    "Widgets",
    "WidgetLiveActivity.swift",
  );
  assertDirectRenderer(sourcePath);
  assertDirectRenderer(packagePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  for (const marker of [
    directRendererMarker,
    "decodeKineSyncState",
    "compactLeading:",
    "compactTrailing:",
    "minimal:",
    "DynamicIslandExpandedRegion(.bottom)",
    "KineSyncLiveActivityBanner",
  ]) {
    assertIncludes(source, marker, "Direct native Live Activity renderer");
  }
  console.log(
    "[live-activity] Verified direct native renderer (no App Group/runtime dependency).",
  );
}

function verifyActivitySource() {
  const source = fs.readFileSync(activitySourcePath, "utf8");
  for (const marker of [
    '"widget"',
    'createLiveActivity<LyricsLiveActivityProps>',
    '"KineSyncLyrics"',
    "banner:",
    "compactLeading:",
    "compactTrailing:",
    "minimal:",
    "expandedLeading:",
    "expandedTrailing:",
    "expandedBottom:",
  ]) {
    assertIncludes(source, marker, "Live Activity layout");
  }
  console.log("[live-activity] Verified all Lock Screen and Dynamic Island regions.");
}

function verifySdk57Configuration() {
  const packageJson = require(path.join(projectRoot, "package.json"));
  const appJson = require(path.join(projectRoot, "app.json"));
  const widgetDependency = packageJson.dependencies?.["expo-widgets"];
  if (!widgetDependency?.startsWith("~57.")) {
    throw new Error("expo-widgets must use the Expo SDK 57 release line.");
  }
  if (packageJson.dependencies?.["expo-live-activity"]) {
    throw new Error("The legacy expo-live-activity package must not be installed.");
  }

  const widgetPlugin = appJson.expo?.plugins?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "expo-widgets",
  );
  if (!widgetPlugin) {
    throw new Error("The expo-widgets config plugin is not configured.");
  }
  if (widgetPlugin[1]?.frequentUpdates !== true) {
    throw new Error("Live Activity frequent updates must be enabled.");
  }
  console.log(`[live-activity] Verified SDK 57 expo-widgets ${widgetDependency}.`);
}

function verifyGeneratedTargetIfPresent() {
  const targetDirectory = path.join(projectRoot, "ios", "ExpoWidgetsTarget");
  if (!fs.existsSync(targetDirectory)) {
    console.log(
      "[live-activity] Generated iOS target not present; source/config checks completed.",
    );
    return;
  }

  const indexPath = path.join(targetDirectory, "index.swift");
  const infoPlistPath = path.join(targetDirectory, "Info.plist");
  const indexSource = fs.readFileSync(indexPath, "utf8");
  const infoPlist = fs.readFileSync(infoPlistPath, "utf8");
  assertIncludes(indexSource, "WidgetLiveActivity()", "Generated widget target");
  assertIncludes(
    infoPlist,
    "com.apple.widgetkit-extension",
    "Generated widget Info.plist",
  );
  assertIncludes(
    infoPlist,
    "group.dev.kineticron.KineSync",
    "Generated widget Info.plist",
  );
  console.log("[live-activity] Verified generated ExpoWidgetsTarget extension.");
}

verifyDirectNativeRenderer();
verifyActivitySource();
verifySdk57Configuration();
verifyGeneratedTargetIfPresent();
