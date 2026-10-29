/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const platform = process.argv.includes('--android') ? 'android' : 'ios';
const alerts = [], openedUrls = [];
const development = process.argv.includes('--development');
const developmentLogs = [], publishedSamples = [];
const diagnosticModules = new Map();
function diagnosticModule(name) {
  if (diagnosticModules.has(name)) return diagnosticModules.get(name);
  const exports = {}; diagnosticModules.set(name, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../lib/spotify-detector', `${name}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, __DEV__: development, Date, performance,
    require: name => diagnosticModule(name.replace('./', '')),
    console: { log: line => developmentLogs.push(JSON.parse(line.slice('[Spotify timing bootstrap] '.length))) } });
  return exports;
}
const developmentTiming = diagnosticModule('development-timing-log');
const timingCalls = [], timingShares = [];
let controlError, rejectLaunch = false;
class SpotifyPlaybackUnavailableError extends Error {}
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
  async metadata() { return { title: 'Resolved Title', artist: 'Resolved Artist', album: 'Album', artworkUrl: 'https://i.scdn.co/image/resolved' }; }
  async control(command) { commands.push(command); if (controlError) throw controlError; }
  clear() { this.enabled = false; this.clears++; }
}
const callableStore = state => Object.assign(fn => fn(state), { getState: () => state });
const AppState = { currentState: 'active', addEventListener(_, fn) { listeners.add(fn); return { remove: () => listeners.delete(fn) }; } };
const mocks = {
  react: ReactMock, 'react/jsx-runtime': require('react/jsx-runtime'),
  'react-native': { View: 'View', Text: 'Text', Button: 'Button', ActivityIndicator: 'Spinner', AppState, Platform: { OS: platform },
    Share: { share: async value => timingShares.push(value) }, Alert: { alert: (...args) => alerts.push(args) },
    Linking: { openURL: async url => { openedUrls.push(url); if (rejectLaunch) throw new Error('No app'); } },
    StyleSheet: { create: x => x, absoluteFill: {} } },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' }, 'react-native-webview': { WebView: 'WebView' },
  'expo-router': { router: { push() {} } },
  '@/lib/spotify-detector/client': { SpotifyDetector: Detector, SpotifyPlaybackUnavailableError }, '@/lib/spotify-detector/bootstrap': { bootstrap: 'capture', bootstrapAndroidObserver: 'android-observer' },
  '@/lib/spotify-detector/development-timing-log': developmentTiming,
  '@/lib/spotify-detector/packet': { detectorPacket: s => { publishedSamples.push(s); return ({ trackId: s.uri, positionMs: s.positionMs, title: s.title || '', artworkUrl: s.artworkUrl || '', artist: s.artist || '', album: s.album || '' }); } },
  '@/lib/spotify-detector/timing-diagnostics': { startTimingCapture: () => timingCalls.push('start'), clearTimingCapture: () => timingCalls.push('clear'), timingSnapshot: () => ({ active: false, records: [] }) },
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
  __DEV__: development, console: { debug() {} },
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
const receipt = Object.freeze({ wallMs: Date.now(), monotonicMs: performance.now() });
const evidence = developmentTiming.developmentTimingAnchor({ playerPath: '$.player_state', serverPath: '$',
  positionField: 'position_as_of_timestamp', position: 1000, player: receipt.wallMs - 100, server: receipt.wallMs,
  receipt, origin: 'registration', device: 'private-device', session: 'private-session', connection: 'private-connection' });
const firstSample = { uri: 'spotify:track:test', title: 'Test', artist: 'Artist', positionMs: 1000,
  playing: true, receivedAt: receipt.wallMs, positionTimestampMs: receipt.wallMs - 100,
  sourceServerTimestampMs: receipt.wallMs, positionObservedAt: receipt, developmentTiming: evidence };
instance.callbacks.sample(firstSample);
for (let n = 0; n < 10; n++) await Promise.resolve();
instance.callbacks.ready();
render(); assert.equal(tree, null, 'usable native state unmounts the closed browser');
assert.equal(packets.length, 2, 'sample and asynchronous metadata publication');
for (let n = 0; n < 10; n++) await Promise.resolve();
assert.equal(publishedSamples.at(-1).developmentTiming, evidence, 'actual metadata publication preserves anchor');
assert.equal(publishedSamples.at(-1).positionObservedAt, receipt);
if (development) {
  assert(Object.isFrozen(evidence.receipt));
  assert(developmentLogs.some(l => l.stage === 'metadata-publish' && l.raw.anchor === evidence.anchor));
  assert(developmentLogs.some(l => l.stage === 'store-track-change' && l.track.startsWith('track-')));
} else assert.equal(developmentLogs.length, 0);
assert.equal(timingCalls.length, 0, 'timing capture is off until explicit opt-in');
ref.current.runDiagnostics();
assert.equal(alerts.at(-1)[0], 'Spotify timing diagnostics');
assert.equal(timingCalls.length, 0, 'opening the dialog does not start capture');
alerts.at(-1)[2][0].onPress();
assert.deepEqual(timingCalls, ['start']);
alerts.at(-1)[2][1].onPress();
assert.deepEqual(JSON.parse(timingShares.at(-1).message), { active: false, records: [] }, 'share only the safe timing snapshot');
alerts.at(-1)[2][2].onPress();
assert.deepEqual(timingCalls, ['start', 'clear']);
ref.current.togglePlayPause();
assert.equal(commands.at(-1).type, 'toggle', 'controls target native device while browser is unmounted');
assert.equal(find(tree), null);
controlError = new SpotifyPlaybackUnavailableError('No device');
ref.current.togglePlayPause();
await Promise.resolve();
assert.equal(alerts.at(-1)[0], "Can't Start Playback Just Yet");
assert.equal(alerts.at(-1)[1], "KineSync can't start the playback without you starting the Spotify app on one of your other devices.");
assert.equal(alerts.at(-1)[2][0].text, 'Close');
assert.equal(alerts.at(-1)[2][1].text, 'Open Spotify');
alerts.at(-1)[2][1].onPress();
await Promise.resolve();
assert.equal(openedUrls.at(-1), platform === 'ios' ? 'spotify://eevee/open.spotify.com/' : 'spotify://');
rejectLaunch = true;
alerts.at(-1)[2][1].onPress();
for (let n = 0; n < 10; n++) await Promise.resolve();
assert.equal(openedUrls.at(-1), 'spotify://', 'standard launch is the final fallback');
assert.equal(alerts.at(-1)[0], 'Couldn’t Open Spotify');
controlError = new Error('Spotify control HTTP 429.');
ref.current.togglePlayPause();
await Promise.resolve();
assert.equal(alerts.at(-1)[0], 'Spotify control', 'other errors retain their diagnostic message');
controlError = undefined;
ref.current.openBrowser(); render(); web = find(tree); assert(web, 'browser remains available on demand');
web.props.ref.current = { injectJavaScript: script => injected.push(script) };
web.props.onMessage({ nativeEvent: { data: '{"type":"ready"}', url: 'https://open.spotify.com/' } });
assert.equal(JSON.parse(injected.at(-1)).enabled, false, 'browser playback polling is disabled');
ref.current.togglePlayPause(); assert.equal(commands.at(-1).type, 'toggle', 'mounted browser does not receive transport commands');
for (let n = 0; n < 10; n++) await Promise.resolve();
scheduled.splice(0).forEach(fn => fn());
instance.callbacks.sample({ uri: 'spotify:track:missing-artist', title: 'Unknown track', artist: '', artworkUrl: 'https://i.scdn.co/image/stale', positionMs: 1000 });
assert.equal(playback.currentTrack.artist, '', 'raw observer may omit artist');
const searchesBefore = searches.length;
assert.equal(scheduled.length, 0, 'missing artist cannot launch a lyrics search');
for (let n = 0; n < 10; n++) await Promise.resolve();
assert.equal(playback.currentTrack.artist, 'Resolved Artist', 'native metadata fills artist before searching');
assert.equal(packets.at(-1).title, 'Resolved Title', 'ID-only snapshots receive the exact catalog title');
assert.equal(packets.at(-1).artworkUrl, 'https://i.scdn.co/image/resolved', 'catalog artwork replaces stale observer artwork');
instance.callbacks.sample({ uri: 'spotify:track:missing-artist', title: 'Unknown track', artist: '', positionMs: 2000 });
assert.equal(packets.at(-1).title, 'Resolved Title', 'subsequent sparse anchors retain the enriched title');
assert.equal(packets.at(-1).artworkUrl, 'https://i.scdn.co/image/resolved', 'subsequent sparse anchors retain the enriched cover');
assert.equal(packets.at(-1).positionMs, 2000, 'enrichment preserves native position anchors');
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
// Cached transport mocked; real Detector.setEnabled replay is tested by check-spotify-timing.
const replay = { ...firstSample, receivedAt: Date.now() + 1000 };
instance.callbacks.sample(replay);
assert.equal(publishedSamples.at(-1).developmentTiming, evidence);
assert.equal(publishedSamples.at(-1).positionObservedAt, receipt);
assert.equal(publishedSamples.at(-1).receivedAt, replay.receivedAt);
if (development) {
  assert(developmentLogs.some(l => l.stage === 'js-startup' && l.version === 2 && l.buildBase === '959f855'));
  assert(developmentLogs.some(l => l.stage === 'cold-mount'));
  assert(developmentLogs.some(l => l.stage === 'app-state' && l.previous === 'active' && l.next === 'background'));
  assert(developmentLogs.some(l => l.stage === 'app-state' && l.previous === 'background' && l.next === 'active'));
  assert(developmentLogs.some(l => l.stage === 'observation-policy' && l.enabled));
  assert(!/private-|spotify:track:|Resolved Title/.test(JSON.stringify(developmentLogs)));
} else assert.equal(developmentLogs.length, 0);
const packetsAfterReplay = packets.length;
session.loggedOut = true; actions.logout(); render(); web = find(tree);
assert.equal(web.props.source.uri, 'https://accounts.spotify.com/logout', 'logout clears browser cookies even after unmount');
instance.callbacks.authenticated('late-token', 123);
instance.callbacks.sample({ uri: 'spotify:track:test', positionMs: 3000 });
assert.equal(packets.length, packetsAfterReplay, 'logout suppresses late auth/state callbacks');
web.props.onLoadEnd(); render(); assert.equal(tree, null, 'logout browser is temporary');
for (const hook of hooks) hook?.cleanup?.();
assert.equal(listeners.size, 0); assert.equal(actions, null);
instance.callbacks.sample({ uri: 'spotify:track:test', positionMs: 4000 });
assert.equal(packets.length, packetsAfterReplay, 'unmounted detector cannot write playback');
console.log(`Native detector lifecycle checks passed (${platform}): shared login, browser unmount, single state source, native controls, tour/background cleanup and logout.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
