import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
const jsxRuntime = { jsx, jsxs: jsx };
const loadComponent = (file, modules) => {
  const source = fs.readFileSync(file, 'utf8');
  const context = {
    exports: {},
    require: name => { assert(name in modules, name); return modules[name]; },
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, context);
  return context.exports;
};
const modules = {
  react: { useRef: current => ({ current }), useState: initial => { const id = index++; return [initial, value => changes.push({ id, value })]; } },
  'react/jsx-runtime': jsxRuntime,
  'react-native': { Platform: { OS: 'ios' }, View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: value => value } },
  'react-native-webview': { WebView: 'WebView' },
  '@/components/ui/native-touchable': { NativeTouchable: 'Pressable' },
  '@/lib/spotify-browser': { isAllowedSpotifyLoginNavigation: loginAllowed, isTrustedSpotifyWebViewMessageUrl: trusted, spotifyAuthProbeScript, SPOTIFY_WEBVIEW_ORIGIN_WHITELIST: ['https://*'] },
};
const { SpotifyLoginWebView } = loadComponent('components/spotify-login-webview.tsx', modules);
let delivered = 0;
const handler = () => { delivered++; };
const tree = SpotifyLoginWebView({ onMessage: handler });
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
modules['react-native'].Platform.OS = 'android';
index = 0;
const androidWebView = flatten(SpotifyLoginWebView({ onMessage: handler })).find(node => node.type === 'WebView');
assert.equal(androidWebView.props.userAgent, undefined, 'Android Accounts keeps its native identity for challenges');
assert.equal(androidWebView.props.onShouldStartLoadWithRequest({ url: 'https://open.spotify.com/', isTopFrame: true }), false,
  'Android must remount the desktop player before the unsupported mobile player loads');
assert(changes.some(change => change.id === 2 && change.value === true), 'Player navigation starts the desktop capture phase');
assert(androidWebView.props.onShouldStartLoadWithRequest({ url: 'https://challenge.spotify.com/c/www/verify', isTopFrame: true }),
  'Accounts challenges remain native on Android');
index = 0;
modules.react.useState = initial => [index++ === 2 ? true : initial, () => {}];
const desktopPlayer = flatten(SpotifyLoginWebView({ onMessage: handler })).find(node => node.type === 'WebView');
assert.equal(desktopPlayer.props.source.uri, 'https://open.spotify.com/');
assert.match(desktopPlayer.props.userAgent, /Windows NT.*Chrome\/137/);
assert.equal(desktopPlayer.props.contentMode, 'desktop');
assert.equal(desktopPlayer.props.sharedCookiesEnabled, true);

const { SpotifyLoginModal } = loadComponent('components/spotify-login-modal.tsx', {
  'react/jsx-runtime': jsxRuntime,
  'react-native': { Modal: 'Modal', View: 'View', Text: 'Text', StyleSheet: { create: value => value } },
  'react-native-gesture-handler': { GestureHandlerRootView: 'GestureHandlerRootView' },
  'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' },
  '@react-native-vector-icons/ionicons': { default: 'Ionicons' },
  '@/components/ui/motion-pressable': { MotionPressable: 'MotionPressable' },
  './spotify-login-webview': { SpotifyLoginWebView },
});
let closeCount = 0;
const onClose = () => { closeCount++; };
const modal = SpotifyLoginModal({ visible: true, onClose, onMessage: handler });
assert.equal(modal.type, 'Modal');
assert.equal(modal.props.visible, true);
assert.equal(SpotifyLoginModal({ visible: false, onClose, onMessage: handler }).props.visible, false);
assert.deepEqual(Array.from(modal.props.supportedOrientations), ['portrait', 'landscape-left', 'landscape-right']);
assert.equal(modal.props.onRequestClose, onClose);
const gestureRoot = modal.props.children;
assert.equal(gestureRoot.type, 'GestureHandlerRootView');
assert.equal(gestureRoot.props.style.flex, 1);
const provider = gestureRoot.props.children;
assert.equal(provider.type, 'SafeAreaProvider');
assert.equal(provider.props.initialMetrics, undefined, 'The modal provider measures its own window');
const safeArea = provider.props.children;
assert.equal(safeArea.type, 'SafeAreaView');
assert.equal(safeArea.props.style.flex, 1);
assert.deepEqual(Array.from(safeArea.props.edges), ['top', 'right', 'bottom', 'left']);

const [header, modalWebView] = safeArea.props.children;
const closeButton = header.props.children.find(child => child.type === 'MotionPressable');
assert(closeButton, 'The close button must be inside the safe-area header');
assert.equal(closeButton.props.accessibilityRole, 'button');
assert.equal(closeButton.props.accessibilityLabel, 'Close Spotify sign in');
assert(closeButton.props.style.width >= 44 && closeButton.props.style.height >= 44);
assert.equal(closeButton.props.onPress, onClose);
modal.props.onRequestClose();
closeButton.props.onPress();
assert.equal(closeCount, 2);
assert.equal(modalWebView.type, SpotifyLoginWebView);
assert.equal(modalWebView.props.onMessage, handler);

console.log('Spotify login checks passed: modal safe-area wiring, challenge frames, native browser identity, player-only probes, confirmed sign-in, and process recovery.');
