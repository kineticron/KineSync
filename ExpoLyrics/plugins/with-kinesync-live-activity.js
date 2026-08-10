const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

module.exports = function withKineSyncLiveActivity(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const { applyKineSyncLiveActivityPatch } = require(
        path.join(projectRoot, "scripts", "apply-kinesync-live-activity-patch.js")
      );
      applyKineSyncLiveActivityPatch();
      return config;
    },
  ]);
};
