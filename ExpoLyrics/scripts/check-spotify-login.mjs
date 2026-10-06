import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

const bundled = await build({ entryPoints: ['lib/spotify-browser.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { isAllowedSpotifyWebViewNavigation: allowed, isAllowedSpotifyLoginNavigation: loginAllowed, isTrustedSpotifyWebViewMessageUrl: trusted, spotifyAuthProbeScript } =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
assert(allowed('about:blank', false), 'An empty challenge child frame must initialize');
assert(!allowed('about:blank', true), 'Blank documents must not replace the login page');
assert(!trusted('about:blank'), 'An empty challenge frame must not send auth messages');
assert(allowed('https://www.google.com/recaptcha/api2/anchor', false));
assert(!allowed('https://www.google.com/recaptcha/api2/anchor', true));
assert(!allowed('javascript:alert(1)', false));
assert(!allowed('data:text/html,login', false));
assert(!allowed('https://accounts.spotify.com.evil.test/login', true));
assert(!allowed('spotify:login', false));
assert(allowed('https://accounts.spotify.com/en/login/password', true));
assert(allowed('https://open.spotify.com/', true), 'The player must load before confirming sign-in');
assert(loginAllowed('https://challenge.spotify.com/c/www/verify', true), 'A Spotify challenge redirect must continue after email entry');
assert(!trusted('https://challenge.spotify.com/c/www/verify'), 'Challenge pages cannot report auth tokens');
assert(!loginAllowed('https://challenge.spotify.com.evil.test/c/www/verify', true));
assert(!loginAllowed('http://challenge.spotify.com/c/www/verify', true));
assert(!loginAllowed('https://user:password@challenge.spotify.com/c/www/verify', true));

let requests = 0;
vm.runInNewContext(spotifyAuthProbeScript, {
  window: { location: { origin: 'https://accounts.spotify.com' } },
  fetch: () => { requests++; },
});
assert.equal(requests, 0, 'Login pages must not receive web-player token polling');
const posted = [];
vm.runInNewContext(spotifyAuthProbeScript, {
  window: {
    location: { origin: 'https://open.spotify.com' },
    ReactNativeWebView: { postMessage: value => posted.push(JSON.parse(value)) },
    setInterval() {},
  },
  document: { querySelector: () => null },
  fetch: async () => {
    requests++;
    return { ok: true, json: async () => ({ isAnonymous: false, accessToken: 'test-token', accessTokenExpirationTimestampMs: 123 }) };
  },
});
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(requests, 1);
assert(posted.some(event => event.type === 'signedIn' && event.signedIn));

const changes = [];
let index = 0;
const jsx = (type, props, key) => ({ type, props, key });
const source = fs.readFileSync('components/spotify-login-webview.tsx', 'utf8');
const modules = {
  react: { useRef: current => ({ current }), useState: initial => { const id = index++; return [initial, value => changes.push({ id, value })]; } },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: value => value } },
  'react-native-webview': { WebView: 'WebView' },
  '@/lib/spotify-browser': { isAllowedSpotifyLoginNavigation: loginAllowed, isTrustedSpotifyWebViewMessageUrl: trusted, spotifyAuthProbeScript, SPOTIFY_WEBVIEW_ORIGIN_WHITELIST: ['https://*'] },
};
const context = { exports: {}, require: name => { assert(name in modules, name); return modules[name]; } };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
let delivered = 0;
const handler = () => { delivered++; };
const tree = context.exports.SpotifyLoginWebView({ onMessage: handler });
const flatten = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat().flatMap(flatten)];
const nodes = flatten(tree);
const webview = nodes.find(node => node.type === 'WebView');
assert(webview);
assert.equal(webview.props.userAgent, undefined, 'Login must use its actual browser identity');
assert.equal(webview.props.sharedCookiesEnabled, true);
webview.props.onMessage({ nativeEvent: { url: 'https://open.spotify.com/' } });
assert.equal(delivered, 1);
assert(webview.props.onShouldStartLoadWithRequest({ url: 'https://challenge.spotify.com/c/www/verify', isTopFrame: true }));
webview.props.onMessage({ nativeEvent: { url: '' } });
assert.equal(delivered, 1, 'Challenge pages must not post tokens even when iOS omits the URL');
webview.props.onNavigationStateChange({ url: 'https://open.spotify.com/' });
webview.props.onMessage({ nativeEvent: { url: '' } });
assert.equal(delivered, 2, 'Trusted player messages with an omitted URL must still work');
webview.props.onContentProcessDidTerminate();
assert(changes.some(change => change.id === 1 && change.value === true));
const retry = nodes.find(node => node.type === 'Pressable');
assert(retry, 'Retry must also be available for an unreported stall');
retry.props.onPress();
assert(changes.some(change => change.id === 0 && typeof change.value === 'function' && change.value(0) === 1));
console.log('Spotify login checks passed: challenge frames, native browser identity, player-only probes, confirmed sign-in, and process recovery.');
