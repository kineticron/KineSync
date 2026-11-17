// CI-only Expo config change. The committed app.json stays device-neutral.
const fs = require('node:fs');
const path = require('node:path');

const DEV_CLIENT = 'expo-dev-client';
const DEV_CLIENT_OPTIONS = { embeddedBundle: true, skipOnboarding: true, showMenuAtLaunch: false };

function withEmbeddedDevClient(config) {
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  const withoutDevClient = plugins.filter(plugin => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    return name !== DEV_CLIENT;
  });
  return { ...config, plugins: [...withoutDevClient, [DEV_CLIENT, { ...DEV_CLIENT_OPTIONS }]] };
}

function prepare(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config.expo || typeof config.expo !== 'object') throw new Error('app.json has no expo object');
  const next = { ...config, expo: withEmbeddedDevClient(config.expo) };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next.expo.plugins.at(-1);
}

if (require.main === module) {
  const file = path.resolve(process.argv[2] || path.join(process.env.GITHUB_WORKSPACE || path.resolve(__dirname, '../..'), 'ExpoLyrics/app.json'));
  const applied = prepare(file);
  console.log(`Simulator CI enabled ${applied[0]} embeddedBundle in ${file}`);
}

module.exports = { DEV_CLIENT, DEV_CLIENT_OPTIONS, withEmbeddedDevClient, prepare };
