const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const app = JSON.parse(read('app.json')).expo;
const pkg = JSON.parse(read('package.json'));
const lyricsService = read('lib/mobile-lyrics-service.js');
const network = read('lib/network.ts');
const spotify = read('lib/spotify-browser.ts');
const fallback = read('components/lyrics/spotify-browser-fallback.tsx');
const signingPlugin = read('plugins/with-release-signing.js');

assert.equal(pkg.dependencies['expo-secure-store'], '~57.0.1');
assert(!/http:\/\/(?!localhost|127\.0\.0\.1)/i.test(lyricsService), 'public HTTP lyrics endpoint found');
assert(network.includes("parsed.protocol === 'ws:' && !privateHost"), 'public ws:// must be rejected');
assert(network.includes('key.length >= 16'), 'weak bridge keys must be rejected');
assert(!spotify.includes("origin === '*'"), 'wildcard Spotify message origin found');
assert(!fallback.includes("origin === '*'"), 'wildcard Spotify fallback origin found');
assert(app.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'));
assert(app.plugins.includes('./plugins/with-release-signing.js'));
assert(signingPlugin.includes('signingConfigs\\.debug'));
assert(!read('app/(tabs)/explore.tsx').includes('password123'));

console.log('Mobile security regression checks passed.');
