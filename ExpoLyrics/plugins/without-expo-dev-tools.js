const { withPodfile, withSettingsGradle } = require('expo/config-plugins');

const packages = ['expo-dev-client', 'expo-dev-launcher', 'expo-dev-menu', 'expo-dev-menu-interface'];

function replaceAutolinkingCall(contents, call, replacement) {
  if ([...contents.matchAll(new RegExp(call.source, 'gm'))].length !== 1) {
    throw new Error('Expected one Expo autolinking call while excluding release development tools');
  }
  return contents.replace(call, replacement);
}

function excludeAndroid(contents) {
  const assignment = `expoAutolinking.exclude = ${JSON.stringify(packages)}`;
  if (contents.includes(`${assignment}\nexpoAutolinking.useExpoModules()`)) return contents;
  return replaceAutolinkingCall(contents, /^expoAutolinking\.useExpoModules\(\)[ \t]*$/m,
    `${assignment}\nexpoAutolinking.useExpoModules()`);
}

function excludeIos(contents) {
  const invocation = `use_expo_modules!(exclude: %w[${packages.join(' ')}])`;
  if (contents.includes(invocation)) return contents;
  return replaceAutolinkingCall(contents, /^([ \t]*)use_expo_modules![ \t]*$/m,
    `$1${invocation}`);
}

module.exports = function withoutExpoDevTools(config) {
  config = withSettingsGradle(config, mod => {
    mod.modResults.contents = excludeAndroid(mod.modResults.contents);
    return mod;
  });
  return withPodfile(config, mod => {
    mod.modResults.contents = excludeIos(mod.modResults.contents);
    return mod;
  });
};
module.exports.excludeAndroid = excludeAndroid;
module.exports.excludeIos = excludeIos;
