const fs = require('fs');
const path = require('path');

const releaseVersion = process.argv[2];
const runNumber = process.argv[3];
if (!/^\d+\.\d+\.\d+$/.test(releaseVersion || '')) {
  throw new Error('Expected a three-component release version.');
}
if (!/^\d+$/.test(runNumber || '') || Number(runNumber) < 1) {
  throw new Error('Expected a positive GitHub Actions run number.');
}

const projectRoot = path.resolve(__dirname, '..');
const appJsonPath = path.join(projectRoot, 'app.json');
const appConfig = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
appConfig.expo.version = releaseVersion;
appConfig.expo.ios = appConfig.expo.ios || {};
appConfig.expo.ios.buildNumber = runNumber;

fs.writeFileSync(appJsonPath, `${JSON.stringify(appConfig, null, 2)}\n`);
fs.writeFileSync(path.join(projectRoot, 'ios-release-version.txt'), `${releaseVersion}\n`);
console.log(`Stamped iOS release version ${releaseVersion} (${runNumber}).`);
