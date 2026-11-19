const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.projectRoot = __dirname;
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  '/home/kit/repo/ExpoLyrics/node_modules',
];

// Both apps ship the same public Spicy Lyrics key from this shared config.
const sharedConfigDirectory = path.resolve(__dirname, '../DesktopBridge/src');
config.watchFolders = [...new Set([...config.watchFolders, sharedConfigDirectory, __dirname])];

module.exports = config;
