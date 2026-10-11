// The isolated renderer lab omits playback/network providers, making matched
// renderer measurements possible even while unrelated native modules are under development.
module.exports = ({ config }) => {
  if (process.env.KINESYNC_ISOLATED_LYRICS_LAB !== '1') return config;
  return { ...config, experiments: { ...config.experiments, typedRoutes: false }, plugins: config.plugins.map(plugin => plugin === 'expo-router'
    ? ['expo-router', { root: './scripts/native-lyrics-lab-app' }] : plugin) };
};
