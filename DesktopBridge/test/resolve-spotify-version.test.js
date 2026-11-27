const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveSpotifyVersion } = require('../scripts/resolve-spotify-version');

const cli = '2.46.7';
const release = {
  tag_name: `v${cli}`,
  body: '- Spotify for **macOS**: `1.2.14` -> `1.3.9`\r\n- Spotify for **Linux**: `1.2.14` -> `1.3.8`\r\n',
};
const signed = 'https://repository.spotify.com stable/non-free amd64 Packages';
const line = (version, origin = signed, name = 'spotify-client') => `${name} | ${version} | ${origin}`;

test('selects the newest indexed Linux build using Debian revision and epoch ordering', () => {
  const packages = [
    line('1:1.3.8.10-2'),
    line('0:1.3.8.1000'),
    line('1:1.3.8.10-10'),
    line('1:1.3.8.9'),
    line('2:1.3.9.1'),
    line('2:1.2.13.1'),
  ].join('\n');
  assert.equal(resolveSpotifyVersion(release, cli, packages), '1:1.3.8.10-10');
});

test('retains the Debian epoch from the published version and ignores other indexes', () => {
  const packages = [
    line('1:1.3.4.258.gc60b10b0946a', signed, 'spotify-client:amd64'),
    line('2:1.3.8.10', 'https://other.invalid stable/non-free amd64 Packages'),
    line('2:1.3.8.10', signed.replace('amd64', 'arm64')),
    line('2:1.3.8.10', signed, 'spotify-client-qt'),
  ].join('\n');
  assert.equal(resolveSpotifyVersion(release, cli, packages), '1:1.3.4.258.gc60b10b0946a');
});

test('fails clearly for missing versions, missing Linux range and mismatched CLI tags', () => {
  assert.throws(() => resolveSpotifyVersion(release, cli, line('1:1.3.9.1')), /no spotify-client:amd64/);
  assert.throws(() => resolveSpotifyVersion(release, cli, ''), /no spotify-client:amd64/);
  assert.throws(() => resolveSpotifyVersion({ ...release, body: '' }, cli, ''), /Linux compatibility range/);
  assert.throws(() => resolveSpotifyVersion(release, '2.44.0', ''), /does not match installed version/);
});
