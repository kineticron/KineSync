/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const platform = process.argv.includes('--android') ? 'android' : 'ios';
const hooks = [], effects = [], listeners = new Set(), packets = [], injected = [], commands = [], searches = [], scheduled = [];
let cursor = 0, dirty = false, actions, instance;
let tour = { active: false, pending: false };
const session = { signedIn: true, loggedOut: false, setSignedIn(value) { this.signedIn = value; } };
const playback = { playbackMode: 'mobile', connectionStatus: 'disconnected', currentTrack: null,
  ingestPacket(packet, source) { assert.equal(source, 'mobile'); packets.push(packet); const changed = this.currentTrack?.id !== packet.trackId;
    this.currentTrack = { id: packet.trackId, artist: packet.artist }; return { trackChanged: changed }; }, setLyricsStatusMessage() {} };
const ReactMock = { ...React, forwardRef: fn => fn,
  useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
  useState(value) { const i = cursor++; if (!hooks[i]) hooks[i] = { value };
    return [hooks[i].value, next => { const value = typeof next === 'function' ? next(hooks[i].value) : next;
      if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; dirty = true; } }]; },
  useCallback(fn) { cursor++; return fn; },
  useImperativeHandle(ref, factory) { cursor++; ref.current = factory(); },
  useEffect(fn, deps) { const i = cursor++; const old = hooks[i];
    if (!old || deps.some((d, n) => !Object.is(d, old.deps[n]))) { effects.push(() => { old?.cleanup?.(); hooks[i] = { deps, cleanup: fn() }; }); } },
};
class Detector {
  enabled = false; clears = 0;
  constructor(callbacks) { this.callbacks = callbacks; instance = this; }
  setEnabled(value) { this.enabled = value; }
  capture() { return true; }
  refresh() {}
  async metadata() { return { artist: 'Resolved Artist', album: 'Album' }; }
  async control(command) { commands.push(command); }
  clear() { this.enabled = false; this.clears++; }
}
const callableStore = state => Object.assign(fn => fn(state), { getState: () => state });
const AppState = { currentState: 'active', addEventListener(_, fn) { listeners.add(fn); return { remove: () => listeners.delete(fn) }; } };
const mocks = {
  react: ReactMock, 'react/jsx-runtime': require('react/jsx-runtime'),
  'react-native': { View: 'View', Text: 'Text', Button: 'Button', ActivityIndicator: 'Spinner', AppState, Platform: { OS: platform },
    Share: { share: async () => {} }, Alert: { alert() {} }, StyleSheet: { create: x => x, absoluteFill: {} } },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' }, 'react-native-webview': { WebView: 'WebView' },
  'expo-router': { router: { push() {} } },
  '@/lib/spotify-detector/client': { SpotifyDetector: Detector }, '@/lib/spotify-detector/bootstrap': { bootstrap: 'capture', bootstrapAndroidObserver: 'android-observer' },
  '@/lib/spotify-detector/packet': { detectorPacket: s => ({ trackId: s.uri, positionMs: s.positionMs, artist: s.artist || '', album: s.album || '' }) },
  '@/lib/spotify-browser': { installBrowserControlPreludeScript: 'prelude', installBrowserControlScript: 'control', spotifyAuthProbeScript: 'auth',
    makeBrowserCommandScript: JSON.stringify, parseBrowserEvent: JSON.parse,
    isAllowedSpotifyWebViewNavigation: url => /^https:\/\/(open|accounts)\.spotify\.com\//.test(url),
    isTrustedSpotifyWebViewMessageUrl: url => /^https:\/\/open\.spotify\.com\//.test(url) },
  '@/lib/spotify-player-actions': { registerSpotifyPlayerActions: a => { actions = a; return () => { actions = null; }; } },
  '@/lib/mobile-lyrics-settings': { saveMobileLyricsSettings: async () => {} },
  '@/lib/lyrics-sync': { refreshLyricsForCurrentTrack: async () => { assert(playback.currentTrack.artist); searches.push(playback.currentTrack); } },
  '@/store/playback-store': { usePlaybackStore: callableStore(playback) },
  '@/store/spotify-session-store': { useSpotifySessionStore: callableStore(session) },
  '@/store/player-tour-store': { usePlayerTourStore: { getState: () => tour } },
};
const context = { exports: {}, require: name => { assert(name in mocks, name); return mocks[name]; },
  __DEV__: false,
  Date, setTimeout: fn => { scheduled.push(fn); return scheduled.length; }, clearTimeout() {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../components/lyrics/spotify-native-detector.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, context);
const ref = { current: null };
let tree;
function render() {
  let cycles = 0;
  do { dirty = false; cursor = 0; tree = context.exports.SpotifyNativeDetector({}, ref);
    while (effects.length) effects.shift()(); assert(++cycles < 15, 'render must settle'); } while (dirty);
  return tree;
}
const find = node => !node || typeof node !== 'object' ? null : node.type === 'WebView' ? node :
  React.Children.toArray(node.props?.children).map(find).find(Boolean);
(async () => {
render();
let web = find(tree); assert(web, 'cold launch bootstraps shared login cookies');
web.props.ref.current = { injectJavaScript: script => injected.push(script) };
assert.equal(web.props.sharedCookiesEnabled, true);
assert.equal(web.props.userAgent.includes('Chrome/'), platform === 'android');
assert.equal(web.props.injectedJavaScriptBeforeContentLoaded.includes('android-observer'), platform === 'android');
if (platform === 'android') assert.equal(tree.props.style[1].opacity, 0.01, 'Chromium bootstrap stays in the viewport');
assert.equal(instance.enabled, true);
web.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'playback', positionMs: 9999 }), url: 'https://open.spotify.com/' } });
assert.equal(packets.length, 0, 'browser playback is never mixed with native detector timing');
instance.callbacks.sample({ uri: 'spotify:track:test', title: 'Test', artist: 'Artist', positionMs: 1000 });
instance.callbacks.ready();
render(); assert.equal(tree, null, 'usable native state unmounts the closed browser');
assert.equal(packets.length, 1);
ref.current.togglePlayPause();
assert.equal(commands.at(-1).type, 'toggle', 'controls target native device while browser is unmounted');
assert.equal(find(tree), null);
ref.current.openBrowser(); render(); web = find(tree); assert(web, 'browser remains available on demand');
web.props.ref.current = { injectJavaScript: script => injected.push(script) };
web.props.onMessage({ nativeEvent: { data: '{"type":"ready"}', url: 'https://open.spotify.com/' } });
assert.equal(JSON.parse(injected.at(-1)).enabled, false, 'browser playback polling is disabled');
ref.current.togglePlayPause(); assert.equal(commands.at(-1).type, 'toggle', 'mounted browser does not receive transport commands');
for (let n = 0; n < 10; n++) await Promise.resolve();
scheduled.splice(0).forEach(fn => fn());
instance.callbacks.sample({ uri: 'spotify:track:missing-artist', title: 'Test', artist: '', positionMs: 1000 });
assert.equal(playback.currentTrack.artist, '', 'raw observer may omit artist');
const searchesBefore = searches.length;
assert.equal(scheduled.length, 0, 'missing artist cannot launch a lyrics search');
for (let n = 0; n < 10; n++) await Promise.resolve();
assert.equal(playback.currentTrack.artist, 'Resolved Artist', 'native metadata fills artist before searching');
scheduled.splice(0).forEach(fn => fn());
assert.equal(searches.length, searchesBefore + 1);
const acceptedPackets = packets.length;
tour.pending = true;
instance.callbacks.sample({ uri: 'spotify:track:test', positionMs: 2000 });
assert.equal(packets.length, acceptedPackets, 'pending tour suppresses queued native events');
tour.pending = false;
AppState.currentState = 'background'; listeners.forEach(fn => fn('background'));
assert.equal(instance.enabled, false);
AppState.currentState = 'active'; listeners.forEach(fn => fn('active'));
assert.equal(instance.enabled, true, 'foreground resumes native observation');
session.loggedOut = true; actions.logout(); render(); web = find(tree);
assert.equal(web.props.source.uri, 'https://accounts.spotify.com/logout', 'logout clears browser cookies even after unmount');
instance.callbacks.authenticated('late-token', 123);
instance.callbacks.sample({ uri: 'spotify:track:test', positionMs: 3000 });
assert.equal(packets.length, acceptedPackets, 'logout suppresses late auth/state callbacks');
web.props.onLoadEnd(); render(); assert.equal(tree, null, 'logout browser is temporary');
for (const hook of hooks) hook?.cleanup?.();
assert.equal(listeners.size, 0); assert.equal(actions, null);
instance.callbacks.sample({ uri: 'spotify:track:test', positionMs: 4000 });
assert.equal(packets.length, acceptedPackets, 'unmounted detector cannot write playback');
console.log(`Native detector lifecycle checks passed (${platform}): shared login, browser unmount, single state source, native controls, tour/background cleanup and logout.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
