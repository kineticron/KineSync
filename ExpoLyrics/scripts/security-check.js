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
const bridgeSettings = read('lib/bridge-settings.ts');
const explore = read('app/(tabs)/explore.tsx');
const onboarding = read('components/onboarding/onboarding-screen.tsx');
const webLyrics = read('components/lyrics/web-lyrics-view.tsx');
const signingPlugin = read('plugins/with-release-signing.js');

assert.equal(pkg.dependencies['expo-secure-store'], '~57.0.1');
assert(!/http:\/\/(?!localhost|127\.0\.0\.1)/i.test(lyricsService), 'public HTTP lyrics endpoint found');
assert(network.includes("parsed.protocol === 'ws:' && !privateHost"), 'public ws:// must be rejected');
assert(network.includes('key.length >= 16'), 'weak bridge keys must be rejected');
assert(!spotify.includes("origin === '*'"), 'wildcard Spotify message origin found');
assert(!fallback.includes("origin === '*'"), 'wildcard Spotify fallback origin found');

const spotifyAppRedirectHosts = [
  'spotify.link',
  'spotify.app.link',
  'spotify-alternate.app.link',
];

const whitelistSource = spotify.match(
  /SPOTIFY_WEBVIEW_ORIGIN_WHITELIST:[^=]*=\s*\[([\s\S]*?)\];/,
)?.[1];
assert(whitelistSource, 'Spotify WebView origin whitelist not found');
const spotifyOriginWhitelist = [...whitelistSource.matchAll(/["']([^"']+)["']/g)].map(
  (match) => match[1],
);
const extractWebViewOrigin = (url) =>
  /^[A-Za-z][A-Za-z0-9+\-.]+:(\/\/)?[^/]*/.exec(url)?.[0] || '';
const passesWebViewOriginWhitelist = (url) => {
  const origin = extractWebViewOrigin(url);
  return spotifyOriginWhitelist.some((entry) => {
    const pattern = entry
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '.*');
    return new RegExp(`^${pattern}`).test(origin);
  });
};

for (const host of ['accounts.spotify.com', 'open.spotify.com', ...spotifyAppRedirectHosts]) {
  assert(
    passesWebViewOriginWhitelist(`https://${host}/redirect/path`),
    `${host} must reach onShouldStartLoadWithRequest instead of Linking.openURL`,
  );
}
assert(
  spotify.includes("if (!isTopFrame) return true"),
  'HTTPS CAPTCHA frames must remain inside the Spotify WebView',
);
for (const webView of [fallback, explore, onboarding]) {
  assert(
    webView.includes('isAllowedSpotifyWebViewNavigation(url, isTopFrame)'),
    'Spotify WebViews must distinguish CAPTCHA frames from top-level redirects',
  );
}
assert(
  fallback.includes('resumedFromBackground &&') &&
    fallback.includes('!recentBlockedNativeHandoff'),
  'Spotify resume refreshes must require a real background transition and suppress native handoff loops',
);
assert(
  fallback.includes('lastBlockedNativeNavigationAtRef.current = Date.now()'),
  'blocked Spotify native redirects must arm resume-refresh suppression',
);
assert(
  fallback.includes('key={`spotify-browser-${browserGeneration}`}'),
  'Spotify resume recovery must remount the suspended WebView',
);
assert(
  fallback.includes('browserGeneration !== browserGenerationRef.current'),
  'Spotify WebView events must belong to the active generation',
);
assert(
  fallback.includes('previousPlaybackMode === "desktop"') &&
    fallback.includes('state.playbackMode === "mobile"') &&
    fallback.includes('refreshBrowser(true, true)'),
  'switching from Desktop Bridge to Mobile Only must remount the Spotify WebView',
);
assert(
  bridgeSettings.includes('bridgeSettingsWriteQueue.then'),
  'bridge settings writes must be serialized',
);
assert(
  !explore.includes("setServerUrl('');\n      bridgeClient.disconnect();"),
  'invalid form input must not clear a previously working bridge URL',
);
assert(
  webLyrics.includes('key={`web-lyrics-${webViewGeneration}`}'),
  'refocusing must remount the suspended lyrics WebView',
);
assert(
  webLyrics.includes('readyGeneration === webViewGeneration'),
  'lyrics WebView readiness must belong to the active generation',
);
assert(
  !webLyrics.includes('webViewRef.current?.reload()'),
  'refocusing must not rely on reloading a suspended lyrics WebView',
);
assert(app.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'));
assert(app.plugins.includes('./plugins/with-release-signing.js'));
assert(signingPlugin.includes('signingConfigs\\.debug'));
assert(!explore.includes('password123'));

console.log('Mobile security regression checks passed.');
