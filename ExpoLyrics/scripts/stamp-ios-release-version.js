const fs = require('fs');
const path = require('path');

const runNumber = process.argv[2];
if (!/^\d+$/.test(runNumber || '') || Number(runNumber) < 1) {
  throw new Error('Expected a positive GitHub Actions run number.');
}

const projectRoot = path.resolve(__dirname, '..');
const appJsonPath = path.join(projectRoot, 'app.json');
const appConfig = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
const baseVersion = String(appConfig.expo?.version || '1.0.0');
const versionParts = baseVersion.split('.');

if (!/^\d+$/.test(versionParts[0] || '') || !/^\d+$/.test(versionParts[1] || '')) {
  throw new Error(`Expo version must start with numeric major and minor values: ${baseVersion}`);
}

// CFBundleShortVersionString supports three numeric components. Preserve the
// source major/minor and use the workflow run number as a monotonic patch.
const releaseVersion = `${versionParts[0]}.${versionParts[1]}.${runNumber}`;
appConfig.expo.version = releaseVersion;
appConfig.expo.ios = appConfig.expo.ios || {};
appConfig.expo.ios.buildNumber = runNumber;

fs.writeFileSync(appJsonPath, `${JSON.stringify(appConfig, null, 2)}\n`);
fs.writeFileSync(path.join(projectRoot, 'ios-release-version.txt'), `${releaseVersion}\n`);
console.log(`Stamped iOS release version ${releaseVersion} (${runNumber}).`);
