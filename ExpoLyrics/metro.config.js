const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Both apps ship the same public Spicy Lyrics key from this shared config.
const sharedConfigDirectory = path.resolve(__dirname, '../DesktopBridge/src');
config.watchFolders = [...new Set([...config.watchFolders, sharedConfigDirectory])];

module.exports = config;
