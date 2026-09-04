const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

const versions = [
  readJson('DesktopBridge/package.json').version,
  readJson('DesktopBridge/package-lock.json').version,
  readJson('DesktopBridge/package-lock.json').packages?.['']?.version,
  readJson('ExpoLyrics/package.json').version,
  readJson('ExpoLyrics/package-lock.json').version,
  readJson('ExpoLyrics/package-lock.json').packages?.['']?.version,
  readJson('ExpoLyrics/app.json').expo?.version,
];

if (versions.some((version) => !/^\d+\.\d+\.\d+$/.test(version || ''))) {
  throw new Error('Every release version must contain three numeric components.');
}
if (new Set(versions).size !== 1) {
  throw new Error(`Release versions do not match: ${versions.join(', ')}`);
}

console.log(versions[0]);
