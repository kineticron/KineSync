const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [ipaArgument, version, commit, outputArgument] = process.argv.slice(2);
if (!ipaArgument || !version || !commit || !outputArgument) {
  throw new Error('Usage: create-ios-release-metadata.js <ipa> <version> <commit> <output-directory>');
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Invalid three-component iOS version: ${version}`);
}
if (!/^[0-9a-f]{40}$/i.test(commit)) {
  throw new Error(`Invalid Git commit: ${commit}`);
}

const ipaPath = path.resolve(ipaArgument);
const outputDirectory = path.resolve(outputArgument);
const ipa = fs.readFileSync(ipaPath);
const sha256 = crypto.createHash('sha256').update(ipa).digest('hex');
const repositoryUrl = 'https://github.com/Kineticron/KineSync';
const releaseAssetRoot = `${repositoryUrl}/releases/download/ios-latest`;
const ipaUrl = `${releaseAssetRoot}/KineSync-iOS-unsigned.ipa`;
const sourceUrl = `${releaseAssetRoot}/sidestore-source.json`;

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(
  path.join(outputDirectory, 'KineSync-iOS-unsigned.sha256'),
  `${sha256}  KineSync-iOS-unsigned.ipa\n`,
);

const source = {
  name: 'KineSync iOS',
  identifier: 'dev.kineticron.KineSync.sidestore',
  sourceURL: sourceUrl,
  apps: [
    {
      name: 'KineSync',
      bundleIdentifier: 'dev.kineticron.KineSync',
      developerName: 'Kineticron',
      subtitle: 'Real-time synchronized lyrics',
      localizedDescription:
        'Displays word-synchronized lyrics from your KineSync Desktop Bridge, with landscape presentation and iOS Live Activities.',
      iconURL: `${repositoryUrl}/raw/main/ExpoLyrics/assets/images/R.png`,
      tintColor: '6B21A8',
      permissions: [
        {
          type: 'network',
          usageDescription: 'Connects to your KineSync Desktop Bridge over your local network or secure relay.',
        },
        {
          type: 'background-audio',
          usageDescription: 'Keeps synchronized playback information available while the app is backgrounded.',
        },
      ],
      versions: [
        {
          version,
          date: new Date().toISOString(),
          localizedDescription: `Automated unsigned build of main commit ${commit.slice(0, 7)}.`,
          downloadURL: ipaUrl,
          size: ipa.length,
          minOSVersion: '16.4',
        },
      ],
    },
  ],
};

fs.writeFileSync(
  path.join(outputDirectory, 'sidestore-source.json'),
  `${JSON.stringify(source, null, 2)}\n`,
);
console.log(`Generated SideStore source ${version} and SHA-256 ${sha256}.`);
