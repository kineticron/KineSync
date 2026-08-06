/* global __dirname */
const fs = require("fs");
const path = require("path");

const {
  assertCustomWidget,
  assertSharedAttributes,
} = require("./apply-live-activity-native-patches");

const projectRoot = path.join(__dirname, "..");

function verifyFile(label, filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} missing at ${filePath}`);
  }
  assertCustomWidget(filePath);
  console.log(`[live-activity] Verified ${label}.`);
}

function verifyPayloadGuards() {
  const javascriptSource = fs.readFileSync(
    path.join(projectRoot, "lib", "lyrics-live-activity.ts"),
    "utf8",
  );
  const swiftSource = fs.readFileSync(
    path.join(
      projectRoot,
      "native",
      "live-activity-module",
      "ExpoLiveActivityModule.swift",
    ),
    "utf8",
  );

  if (!javascriptSource.includes("ACTIVITYKIT_PAYLOAD_LIMIT_BYTES = 4096")) {
    throw new Error("JavaScript Live Activity payload guard is missing.");
  }
  if (!swiftSource.includes("activityKitPayloadLimitBytes = 4096")) {
    throw new Error("Native Live Activity payload guard is missing.");
  }
  console.log("[live-activity] Verified 4 KB payload guards in JS and Swift.");
}

function inspectLiveActivityImages() {
  const assetsDir = path.join(projectRoot, "assets", "liveActivity");
  if (!fs.existsSync(assetsDir)) {
    console.log(
      "[live-activity] No custom Live Activity images are bundled; presentation image limits do not apply.",
    );
    return;
  }

  const imageFiles = fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(png|jpe?g)$/i.test(entry.name));
  if (imageFiles.length === 0) {
    console.log(
      "[live-activity] No custom Live Activity images are bundled; presentation image limits do not apply.",
    );
    return;
  }

  for (const entry of imageFiles) {
    const filePath = path.join(assetsDir, entry.name);
    const size = fs.statSync(filePath).size;
    console.warn(
      `[live-activity] Review ${entry.name} (${size} bytes): Apple requires its pixel resolution to fit every presentation where it is used.`,
    );
  }
}

function main() {
  const packageWidgetDir = path.join(
    projectRoot,
    "node_modules",
    "expo-live-activity",
    "ios-files",
  );

  verifyFile(
    "package widget template",
    path.join(packageWidgetDir, "LiveActivityWidget.swift"),
  );
  assertSharedAttributes(
    path.join(packageWidgetDir, "LiveActivityAttributes.swift"),
  );
  console.log("[live-activity] Verified shared attributes in ios-files.");

  const generatedDir = path.join(projectRoot, "ios", "LiveActivity");
  const generatedWidget = path.join(generatedDir, "LiveActivityWidget.swift");

  if (fs.existsSync(generatedWidget)) {
    verifyFile("generated widget target", generatedWidget);
    assertSharedAttributes(path.join(generatedDir, "LiveActivityAttributes.swift"));
    console.log("[live-activity] Verified shared attributes in ios/LiveActivity.");
  }

  const moduleAttributes = path.join(
    projectRoot,
    "node_modules",
    "expo-live-activity",
    "ios",
    "LiveActivityAttributes.swift",
  );
  if (!fs.existsSync(moduleAttributes)) {
    throw new Error(`Patched module attributes missing at ${moduleAttributes}`);
  }
  assertSharedAttributes(moduleAttributes);
  console.log("[live-activity] Verified patched native module attributes.");

  verifyPayloadGuards();
  inspectLiveActivityImages();
}

main();
