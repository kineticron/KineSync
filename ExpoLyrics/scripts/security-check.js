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
const loginModal = read('components/spotify-login-modal.tsx');
const login = read('components/spotify-login-webview.tsx');
const rustLyrics = read('components/lyrics/rust/rust-lyrics-view.tsx');
const signingPlugin = read('plugins/with-release-signing.js');

assert.equal(pkg.dependencies['expo-secure-store'], require('expo/bundledNativeModules.json')['expo-secure-store']);
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
for (const webView of [fallback]) {
  assert(
    webView.includes('isAllowedSpotifyWebViewNavigation(url, isTopFrame)'),
    'Spotify WebViews must distinguish CAPTCHA frames from top-level redirects',
  );
}
assert(login.includes('isAllowedSpotifyLoginNavigation(url, isTopFrame)'), 'Login must retain its exact challenge host filter');
assert(login.includes('if (url && isTrustedSpotifyWebViewMessageUrl(url)) onMessage?.(event);'),
  'Login must validate the message URL before forwarding auth events');
assert.match(loginModal, /import \{ SpotifyLoginWebView \} from ['"]\.\/spotify-login-webview['"]/,
  'The shared modal must import the guarded login WebView');
assert.match(loginModal, /<SpotifyLoginWebView\s+onMessage=\{onMessage\}\s*\/>/,
  'The shared modal must forward auth messages through the guarded login WebView');
for (const [name, screen] of [['Settings', explore], ['Onboarding', onboarding]]) {
  assert.match(screen, /import \{ SpotifyLoginModal \} from ['"]@\/components\/spotify-login-modal['"]/,
    name + ' must import the shared login modal');
  assert.doesNotMatch(screen, /\bSpotifyLoginWebView\b/, name + ' must use the shared modal for login');
  const modalProps = screen.match(/<SpotifyLoginModal\b([\s\S]*?)^\s*\/>/m)?.[1];
  assert(modalProps, name + ' login must use the shared modal');
  assert.match(modalProps,
    /onMessage=\{\(\{ nativeEvent \}\) => \{\s*if \(!isTrustedSpotifyWebViewMessageUrl\(nativeEvent\.url \|\| ['"]{2}\)\)\s*return;\s*const event = parseBrowserEvent\(nativeEvent\.data\);/,
    name + ' login must reject untrusted messages before parsing auth data');
  assert.match(modalProps,
    /if \(event\?\.type === ['"]spotifyToken['"] && event\.token\) \{\s*void saveMobileLyricsSettings\(\{\s*spotifyWebToken: event\.token,\s*spotifyWebTokenExpiresAt: Number\(event\.expiresAt \|\| 0\),/,
    name + ' login must only save tokens from parsed Spotify token events');
  assert.match(modalProps, /if \(event\?\.type === ['"]signedIn['"] && event\.signedIn\) \{\s*completeSpotifySignIn\(\);/,
    name + ' login must only complete sign-in on a confirmed event');
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
assert(!rustLyrics.includes('react-native-webview'), 'lyrics packets stay on the native bridge');
assert.match(rustLyrics, /nativeEvent\.generation !== revision\.generation/, 'stale native readiness cannot reset the current track');
assert(app.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'));
assert(app.plugins.includes('./plugins/with-release-signing.js'));
assert(signingPlugin.includes('signingConfigs\\.debug'));
assert(!explore.includes('password123'));

console.log('Mobile security regression checks passed.');
