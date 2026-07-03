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
}

main();
