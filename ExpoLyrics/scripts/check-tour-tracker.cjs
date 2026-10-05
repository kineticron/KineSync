/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

// Exercise the real fallback's message, recovery and asynchronous callbacks.
(async () => {
  let tour = { active: false, pending: false }, ingested = 0, catalogCalls = 0, resolveCatalog;
  const effects = [], cleanups = [], commands = [], timers = new Map();
  const playback = { playbackMode: 'mobile', connectionStatus: 'disconnected', currentTrack: null,
    ingestPacket(packet) { ingested++; this.currentTrack = { id: packet.trackId }; return { trackChanged: true }; },
    clearLyrics() {}, setLyricsStatusMessage() {} };
  const mocks = {
    react: { ...React, forwardRef: component => component, useRef: value => ({ current: value }), useCallback: value => value,
      useState: value => [value, () => {}], useEffect: effect => effects.push(effect), useImperativeHandle() {} },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', ActivityIndicator: 'Spinner', Platform: { OS: 'ios', select: options => options.ios ?? options.default },
      StyleSheet: { create: value => value, absoluteFill: {} }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    'react-native-webview': { WebView: 'WebView' }, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@react-native-vector-icons/ionicons': { __esModule: true, default: 'Icon' }, 'expo-router': { router: { push() {} } },
    '@/store/player-tour-store': { usePlayerTourStore: Object.assign(selector => selector ? selector(tour) : tour, { getState: () => tour }) },
    '@/store/spotify-session-store': { useSpotifySessionStore: { getState: () => ({ signedIn: true, loggedOut: false }) } },
    '@/store/playback-store': { usePlaybackStore: { getState: () => playback, subscribe: () => () => {} }, startPlaybackClock() {} },
    '@/lib/lyrics-sync': { refreshLyricsForCurrentTrack() {} }, '@/lib/mobile-lyrics-settings': { saveMobileLyricsSettings() {} },
    '@/lib/mobile-lyrics-client': { resolveSpotifyCatalogMatch: () => { catalogCalls++; return new Promise(resolve => { resolveCatalog = resolve; }); } },
    '@/lib/spotify-browser': { parseBrowserEvent: JSON.parse, isTrustedSpotifyWebViewMessageUrl: () => true, makeBrowserCommandScript: JSON.stringify,
      installBrowserControlPreludeScript: '', installBrowserControlScript: '', spotifyAuthProbeScript: '' },
  };
  let timerId = 0;
  const context = { exports: {}, require: name => { assert.ok(name in mocks, name); return mocks[name]; }, Date,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval: () => ++timerId, clearInterval() {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../components/lyrics/spotify-browser-fallback.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, context);
  const tree = context.exports.SpotifyBrowserFallback({}, null);
  const find = node => !node || typeof node !== 'object' ? null : node.type === 'WebView' ? node :
    React.Children.toArray(node.props?.children).map(find).find(Boolean);
  const webview = find(tree); assert.ok(webview);
  webview.props.ref({ injectJavaScript: command => commands.push(JSON.parse(command)) });
  effects.forEach(effect => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
  const send = data => webview.props.onMessage({ nativeEvent: { data: JSON.stringify(data), url: 'https://open.spotify.com' } });
  send({ type: 'ready' }); assert.equal(commands.at(-1).enabled, true);
  send({ type: 'metadata', title: 'Background song', artist: 'Artist', album: '', spotifyTrackId: '' });
  assert.equal(catalogCalls, 1);
  send({ type: 'playback', positionMs: 500, durationMs: 30000, isPlaying: true });
  assert.equal(ingested, 1);
  tour.pending = true;
  send({ type: 'playback', positionMs: 600, durationMs: 30000, isPlaying: true });
  assert.equal(ingested, 1, 'pending tour stops queued Spotify messages before unmount');
  tour = { active: true, pending: false };
  send({ type: 'playback', positionMs: 700, durationMs: 30000, isPlaying: true });
  for (const callback of [...timers.values()]) callback();
  cleanups.forEach(cleanup => cleanup());
  assert.equal(commands.at(-1).enabled, false, 'unmount stops browser monitoring');
  tour = { active: false, pending: false };
  resolveCatalog({ spotifyTrackId: 'late-match', artist: 'Artist', album: 'Album', durationMs: 30000 });
  await Promise.resolve(); await Promise.resolve();
  send({ type: 'playback', positionMs: 800, durationMs: 30000, isPlaying: true });
  assert.equal(ingested, 1, 'disposed tracker and late catalog completions cannot write live playback after the tour');
  const Stack = () => null; Stack.Screen = 'StackScreen';
  Object.assign(mocks['expo-router'], { Stack });
  mocks['expo-router/react-navigation'] = { DarkTheme: { colors: {} }, ThemeProvider: 'ThemeProvider' };
  mocks['expo-status-bar'] = { StatusBar: 'StatusBar' };
  mocks['react-native-gesture-handler'] = { GestureHandlerRootView: 'GestureRoot' };
  mocks['react-native-reanimated'] = { useReducedMotion: () => false };
  mocks['react-native-safe-area-context'].SafeAreaProvider = 'SafeAreaProvider';
  mocks['@/providers/bridge-provider'] = { BridgeProvider: 'BridgeProvider' };
  mocks['@/constants/design'] = { Design: { background: '#090C13' } };
  function load(relative) {
    const scope = { exports: {}, require: context.require };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText, scope);
    return scope.exports.default;
  }
  const RootLayout = load('app/_layout.tsx'), PlayerLayout = load('app/(tabs)/_layout.tsx');
  const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)];
  for (const session of [
    { active: false, pending: false, onboardingVisible: true },
    { active: true, pending: false, onboardingVisible: false },
    { active: false, pending: true, onboardingVisible: false },
    { active: false, pending: false, onboardingVisible: false },
  ]) {
    tour = session;
    const rootNodes = nodes(RootLayout()), playerNodes = nodes(PlayerLayout());
    for (const stack of [...rootNodes, ...playerNodes].filter(node => node.type === Stack)) {
      assert.equal(stack.props.screenOptions.statusBarHidden, false, 'native status bar stays visible independently of tour or orientation');
      assert.equal(stack.props.screenOptions.orientation,
        session.active || session.pending ? 'portrait' : 'default',
        'onboarding allows rotation; pending/active tours temporarily lock portrait at both navigation levels');
    }
    for (const node of [...rootNodes, ...playerNodes].filter(node => node.type === 'StackScreen' && ['index', '(tabs)'].includes(node.props.name))) {
      assert.equal(node.props.options.gestureEnabled, !(session.active || session.pending), 'tour disables swipe dismissal at both navigation levels and restores it on exit');
    }
  }
  const plist = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8')).expo.ios.infoPlist;
  assert.equal(plist.UIViewControllerBasedStatusBarAppearance, true);
  assert.equal(plist.UIStatusBarHidden, false);
  console.log('Tour lifecycle checks passed: tracker shutdown, pending/active suppression, late callbacks, swipe guards, restored navigation and native status bar configuration.');
})();
