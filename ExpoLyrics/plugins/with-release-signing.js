const { withAppBuildGradle } = require('@expo/config-plugins');

// Expo's generated Android template signs release builds with the public debug
// key. Remove that fallback: EAS/CI supplies the real release signing config,
// while an unconfigured local release build fails instead of shipping as debug.
module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') return mod;
    mod.modResults.contents = mod.modResults.contents.replace(
      /(release\s*\{[\s\S]*?)^\s*signingConfig\s+signingConfigs\.debug\s*$/m,
      '$1        // Release signing is provided by EAS or the local CI environment.',
    );
    return mod;
  });
};
