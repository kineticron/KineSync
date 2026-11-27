const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

function compare(left, operator, right) {
  const result = spawnSync('dpkg', ['--compare-versions', left, operator, right], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1 && !result.stderr) return false;
  throw new Error(`dpkg version comparison failed: ${result.stderr || result.signal}`);
}

function resolveSpotifyVersion(release, spicetifyVersion, aptOutput) {
  if (release.tag_name !== `v${spicetifyVersion}` || typeof release.body !== 'string') {
    throw new Error(`Spicetify release metadata does not match installed version ${spicetifyVersion}`);
  }
  const range = /^- Spotify for \*\*Linux\*\*: `(\d+\.\d+\.\d+)` -> `(\d+\.\d+\.\d+)`\s*$/m.exec(release.body);
  if (!range || !compare(range[1], 'le', range[2])) {
    throw new Error(`Missing or invalid Linux compatibility range for Spicetify ${spicetifyVersion}`);
  }
  const [, minimum, maximum] = range;
  let selected;
  for (const line of aptOutput.split('\n')) {
    const [name, version, origin] = line.split('|').map(column => column.trim());
    if (name !== 'spotify-client' && name !== 'spotify-client:amd64') continue;
    if (!/^https:\/\/repository\.spotify\.com\/?\s+stable\/non-free amd64 Packages$/.test(origin)) continue;
    // Spicetify publishes a three-component range. Compare the client release
    // family to it, then order eligible packages using full Debian versions.
    const family = /^(?:\d+:)?(\d+\.\d+\.\d+)(?:[.+~\-][0-9A-Za-z.+~\-]+)?$/.exec(version)?.[1];
    if (!family || !compare(family, 'ge', minimum) || !compare(family, 'le', maximum)) continue;
    if (!selected || compare(version, 'gt', selected)) selected = version;
  }
  if (!selected) {
    throw new Error(`Signed Spotify APT index has no spotify-client:amd64 in Spicetify ${spicetifyVersion}'s Linux range ${minimum} to ${maximum}`);
  }
  return selected;
}

if (require.main === module) {
  try {
    const [version, metadataPath] = process.argv.slice(2);
    const release = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    console.log(resolveSpotifyVersion(release, version, fs.readFileSync(0, 'utf8')));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { resolveSpotifyVersion };
