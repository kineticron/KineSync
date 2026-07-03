const fs = require("fs");
const path = require("path");
const {
  withDangerousMod,
  withPodfile,
  withXcodeProject,
} = require("expo/config-plugins");

const PATCH_SCRIPT = "scripts/apply-live-activity-native-patches.js";
const POST_INSTALL_MARKER = "ExpoLyricsLiveActivityPatch";
const LIVE_ACTIVITY_TARGET_NAME = "LiveActivity";

function getPbxId(reference) {
  return String(reference || "").split(" ")[0];
}

function normalizePbxString(value) {
  return String(value || "").replace(/^"|"$/g, "");
}

function findLiveActivityTarget(xcodeProject) {
  const nativeTargets = xcodeProject.hash.project.objects.PBXNativeTarget || {};
  return Object.entries(nativeTargets).find(([, target]) => {
    if (!target || typeof target !== "object" || target.isa !== "PBXNativeTarget") {
      return false;
    }
    return normalizePbxString(target.name) === LIVE_ACTIVITY_TARGET_NAME;
  });
}

function hardenLiveActivityTarget(xcodeProject) {
  const targetEntry = findLiveActivityTarget(xcodeProject);
  if (!targetEntry) {
    console.warn("[live-activity] LiveActivity Xcode target was not found.");
    return;
  }

  const [, target] = targetEntry;
  const configListId = getPbxId(target.buildConfigurationList);
  const configLists = xcodeProject.hash.project.objects.XCConfigurationList || {};
  const buildConfigs = xcodeProject.hash.project.objects.XCBuildConfiguration || {};
  const configList = configLists[configListId];

  for (const buildConfiguration of configList?.buildConfigurations || []) {
    const configId = getPbxId(buildConfiguration.value ?? buildConfiguration);
    const config = buildConfigs[configId];
    if (!config?.buildSettings) {
      continue;
    }

    config.buildSettings.GENERATE_INFOPLIST_FILE = "NO";
    config.buildSettings.INFOPLIST_FILE = `${LIVE_ACTIVITY_TARGET_NAME}/Info.plist`;
  }
}

function withLyricsLiveActivity(config) {
  config = withXcodeProject(config, (config) => {
    hardenLiveActivityTarget(config.modResults);
    return config;
  });

  config = withDangerousMod(config, [
    "ios",
    (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const { applyLiveActivityNativePatches, assertCustomWidget, assertSharedAttributes } =
        require(path.join(projectRoot, PATCH_SCRIPT));

      applyLiveActivityNativePatches();

      assertCustomWidget(
        path.join(
          projectRoot,
          "node_modules",
          "expo-live-activity",
          "ios-files",
          "LiveActivityWidget.swift",
        ),
      );
      assertSharedAttributes(
        path.join(
          projectRoot,
          "node_modules",
          "expo-live-activity",
          "ios",
          "LiveActivityAttributes.swift",
        ),
      );

      const generatedWidget = path.join(
        projectRoot,
        "ios",
        "LiveActivity",
        "LiveActivityWidget.swift",
      );
      if (fs.existsSync(generatedWidget)) {
        assertCustomWidget(generatedWidget);
        assertSharedAttributes(
          path.join(projectRoot, "ios", "LiveActivity", "LiveActivityAttributes.swift"),
        );
        console.log("[live-activity] Verified custom widget + shared attributes in ios/LiveActivity.");
      }

      return config;
    },
  ]);

  config = withPodfile(config, (config) => {
    const projectRoot = config.modRequest.projectRoot;
    const patchScript = path.join(projectRoot, PATCH_SCRIPT).replace(/\\/g, "/");
    const snippet = `
    # ${POST_INSTALL_MARKER}
    system("node", "${patchScript}")
`;

    if (!config.modResults.contents.includes(POST_INSTALL_MARKER)) {
      config.modResults.contents = config.modResults.contents.replace(
        /post_install do \|installer\|/,
        `post_install do |installer|${snippet}`,
      );
    }

    return config;
  });

  return config;
}

module.exports = withLyricsLiveActivity;
