/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const platform = process.argv.includes('--android') ? 'android' : 'ios';
const baselineHost = process.env.SPOTIFY_DETECTOR_BASELINE_HOST;
const alerts = [], openedUrls = [];
const development = process.argv.includes('--development');
const developmentLogs = [], publishedSamples = [];
const diagnosticModules = new Map();
const nativeRendererReadyRefresh = { registerNativeRendererReadyResync: () => () => {} };
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
class SpotifyControlRejectedError extends Error {}
const captures = [];
const hooks = [], effects = [], listeners = new Set(), packets = [], injected = [], commands = [], searches = [];
const scheduled = new Map(), metadataCalls = [];
let now = 0, nextTimerId = 0, nextMetadata;
function advance(ms) {
  const end = now + ms;
  while (true) {
    const next = [...scheduled].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > end) break;
    const [id, timer] = next;
    scheduled.delete(id);
    now = timer.at;
    timer.fn();
  }
  now = end;
}
async function flush() {
  for (let n = 0; n < 10; n++) await Promise.resolve();
}
function holdMetadata() {
  assert.equal(nextMetadata, undefined);
  let resolve, reject;
  nextMetadata = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject };
}
const resolvedMetadata = { title: 'Resolved Title', artist: 'Resolved Artist', album: 'Album', artworkUrl: 'https://i.scdn.co/image/resolved' };
const sampleFor = (track, fields = {}) => ({
  uri: `spotify:track:${track}`, title: 'Observer Title', artist: 'Observer Artist', positionMs: 1000, ...fields,
});
let cursor = 0, dirty = false, actions, instance;
let tour = { active: false, pending: false };
const session = { signedIn: true, loggedOut: false, setSignedIn(value) { this.signedIn = value; } };
const playback = { playbackMode: 'mobile', connectionStatus: 'disconnected', currentTrack: null,
  ingestPacket(packet, source) { assert.equal(source, 'mobile'); packets.push(packet); const changed = this.currentTrack?.id !== packet.trackId;
    this.currentTrack = { id: packet.trackId, title: packet.title, artist: packet.artist }; return { trackChanged: changed }; }, setLyricsStatusMessage() {} };
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
  enabled = false; clears = 0; health = { controlsEnabled: true, phase: 'ready' };
  observation = { revision: 1, trackId: 'A', playing: true, positionMs: 1000, durationMs: 60_000, observedAt: 0 };
  playbackAccountVersion = 0;
  get playbackCommandState() {
    return this.health.controlsEnabled ? { ready: true, targetId: 'iphone', observation: this.observation } : { ready: false };
  }
  observe(patch) {
    this.observation = { ...this.observation, revision: this.observation.revision + 1, observedAt: now, ...patch };
    this.callbacks.health?.(this.health);
  }
  setActivity() {}
  setReachability() {}
  constructor(callbacks) { this.callbacks = callbacks; instance = this; }
  setEnabled(value) { this.enabled = value; }
  capture(raw, origin, id) { captures.push({ raw, origin, id }); return true; }
  refresh() {}
  async metadata(uri) {
    metadataCalls.push(uri);
    const response = nextMetadata;
    nextMetadata = undefined;
    return response ?? resolvedMetadata;
  }
  async control(command) { commands.push(command); if (controlError) throw controlError; }
  clear() { this.enabled = false; this.clears++; }
}
const callableStore = state => Object.assign(fn => fn(state), { getState: () => state });
const AppState = { currentState: 'active', addEventListener(_, fn) { listeners.add(fn); return { remove: () => listeners.delete(fn) }; } };
const queueExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../lib/playback-command-queue.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: queueExports });
const commandQueue = new queueExports.PlaybackCommandQueue({
  now: () => now,
  setTimeout: () => ++nextTimerId,
  clearTimeout() {},
});
let transport;
const refreshCommands = () => {
  if (transport) commandQueue.update(transport.read());
};
const optimisticPlayback = {
  registerPlaybackCommandTransport(_source, adapter) {
    transport = adapter;
    commandQueue.setTransport(adapter, adapter.send);
    refreshCommands();
    return () => { transport = undefined; commandQueue.setTransport(undefined); };
  },
  schedulePlaybackCommandRefresh: refreshCommands,
  submitPlaybackCommand(command) {
    refreshCommands();
    return command === 'toggle' ? commandQueue.toggle() : commandQueue.enqueue(command);
  },
};
const mocks = {
  '@/store/spotify-connection-store': { useSpotifyConnectionStore: Object.assign(selector => selector({ health: { phase: 'ready' } }), { setState() {} }) },
  '@/lib/spotify-detector/reachability': { subscribeSpotifyReachability: () => () => {} },
  '@/lib/native-clock-diagnostics': { emitNativeClockDiagnostic() {}, nativeClockCaptureActive: () => false, NATIVE_CLOCK_HTTP_TRACE_SCRIPT: '' },
  react: ReactMock, 'react/jsx-runtime': require('react/jsx-runtime'),
  'react-native': { View: 'View', Text: 'Text', Button: 'Button', ActivityIndicator: 'Spinner', AppState, Platform: { OS: platform },
    Share: { share: async value => timingShares.push(value) }, Alert: { alert: (...args) => alerts.push(args) },
    Linking: { openURL: async url => { openedUrls.push(url); if (rejectLaunch) throw new Error('No app'); } },
    StyleSheet: { create: x => x, absoluteFill: {} } },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' }, 'react-native-webview': { WebView: 'WebView' },
  'expo-router': { router: { push() {} } },
  '@/lib/optimistic-playback': optimisticPlayback,
  '@/lib/spotify-detector/client': { SpotifyDetector: Detector, SpotifyControlRejectedError, SpotifyPlaybackUnavailableError }, '@/lib/spotify-detector/bootstrap': { bootstrap: 'capture', bootstrapAndroidObserver: 'android-observer' },
  '@/lib/spotify-detector/development-timing-log': developmentTiming,
  '@/lib/spotify-detector/health': { spotifyHealthMessage: () => 'Spotify connected' },
  '@/lib/spotify-detector/packet': { detectorPacket: s => { publishedSamples.push(s); return ({ trackId: s.uri, positionMs: s.positionMs, title: s.title || '', artworkUrl: s.artworkUrl || '', artist: s.artist || '', album: s.album || '' }); } },
  '@/lib/spotify-detector/timing-diagnostics': { startTimingCapture: () => timingCalls.push('start'), clearTimingCapture: () => timingCalls.push('clear'), timingSnapshot: () => ({ active: false, records: [] }) },
  '@/lib/spotify-browser': { installBrowserControlPreludeScript: 'prelude', installBrowserControlScript: 'control', spotifyAuthProbeScript: 'auth',
    makeBrowserCommandScript: JSON.stringify, parseBrowserEvent: JSON.parse,
    isAllowedSpotifyWebViewNavigation: url => /^https:\/\/(open|accounts)\.spotify\.com\//.test(url),
    isTrustedSpotifyWebViewMessageUrl: url => /^https:\/\/open\.spotify\.com\//.test(url) },
  '@/lib/spotify-player-actions': { registerSpotifyPlayerActions: a => { actions = a; return () => { actions = null; }; } },
  '@/lib/mobile-lyrics-settings': { saveMobileLyricsSettings: async () => {} },
  '@/lib/lyrics-sync': { refreshLyricsForCurrentTrack: () => {
    const track = playback.currentTrack;
    assert(track.artist.trim());
    assert(track.title.trim() && !/^unknown track$/i.test(track.title.trim()));
    searches.push({ ...track, at: now });
  } },
  './native/native-renderer-ready-refresh': nativeRendererReadyRefresh,
  '@/store/playback-store': { usePlaybackStore: callableStore(playback) },
  '@/store/spotify-session-store': { useSpotifySessionStore: callableStore(session) },
  '@/store/player-tour-store': { usePlayerTourStore: { getState: () => tour } },
};
const context = { exports: {}, require: name => { assert(name in mocks, name); return mocks[name]; },
  __DEV__: development, console: { debug() {} },
  Date, setTimeout: (fn, delay) => {
    const id = ++nextTimerId;
    scheduled.set(id, { fn, at: now + delay });
    return id;
  }, clearTimeout: id => scheduled.delete(id) };
const hostPath = baselineHost || path.join(__dirname, '../components/lyrics/spotify-native-detector.tsx');
vm.runInNewContext(ts.transpileModule(fs.readFileSync(hostPath, 'utf8'), {
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
const findNode = (node, matches) => !node || typeof node !== 'object' ? null : matches(node) ? node :
  React.Children.toArray(node.props?.children).map(child => findNode(child, matches)).find(Boolean);
const find = node => findNode(node, child => child.type === 'WebView');
(async () => {
render();
let web = find(tree); assert(web, 'cold launch bootstraps shared login cookies');
web.props.ref.current = { injectJavaScript: script => injected.push(script) };
assert.equal(web.props.sharedCookiesEnabled, true);
assert.equal(web.props.userAgent.includes('Chrome/'), platform === 'android');
assert.equal(web.props.injectedJavaScriptBeforeContentLoaded.includes('android-observer'), platform === 'android');
if (platform === 'android') assert.equal(tree.props.style[1].opacity, 0.01, 'Chromium bootstrap stays in the viewport');
assert.equal(instance.enabled, true);
// A document with no installed capture hook still takes the cold path.
const oldDocument = web;
instance.callbacks.sessionNeeded(1); render(); web = find(tree);
assert.notEqual(web.key, oldDocument.key, 'cold capture changes the actual WebView key');
const beforeOldDocument = captures.length;
oldDocument.props.onMessage({ nativeEvent: { data: '{"type":"notice"}', url: 'https://open.spotify.com/' } });
assert.equal(captures.length, beforeOldDocument, 'obsolete document callbacks cannot capture credentials');
const message = (view, value) => view.props.onMessage({
  nativeEvent: { data: JSON.stringify(value), url: 'https://open.spotify.com/' },
});
web.props.ref.current = { injectJavaScript: script => injected.push(script) };
message(web, { type: 'notice', message: 'Network capture installed.' });
assert.equal(captures.at(-1).id, 1, 'the newly mounted document delivers the cold capture');
instance.callbacks.sessionFinished(1);
const warmKey = web.key;
instance.callbacks.sessionNeeded(2); render(); web = find(tree);
assert.equal(web.key, warmKey, 'warm renewal keeps the loaded document');
assert.match(injected.at(-1), /__startDetectorCapture\(2\)/);
const beforeWarm = captures.length;
message(web, { type: 'credentials', captureId: 1, token: 'obsolete' });
message(web, { type: 'credentials', token: 'untagged' });
assert.equal(captures.length, beforeWarm, 'warm acquisition accepts only its own capture ID');
message(web, { type: 'credentials', captureId: 2, token: 'fresh' });
assert.equal(captures.at(-1).id, 2);
instance.callbacks.sessionFinished(2);
assert.match(injected.at(-1), /__cancelDetectorCapture\(2\)/);
instance.callbacks.sessionNeeded(3);
message(web, { type: 'session', state: 'unavailable', captureId: 3 });
render(); web = find(tree);
assert.notEqual(web.key, warmKey, 'failed warm probe falls back to a new document');
instance.callbacks.sessionFinished(3);
message(web, { type: 'playback', positionMs: 9999 });
assert.equal(packets.length, 0, 'browser playback is never mixed with native detector timing');
const receipt = Object.freeze({ wallMs: Date.now(), monotonicMs: performance.now() });
const evidence = developmentTiming.developmentTimingAnchor({ playerPath: '$.player_state', serverPath: '$',
  positionField: 'position_as_of_timestamp', position: 1000, player: receipt.wallMs - 100, server: receipt.wallMs,
  receipt, origin: 'registration', device: 'private-device', session: 'private-session', connection: 'private-connection' });
const firstSample = { uri: 'spotify:track:test', title: 'Test', artist: 'Artist', positionMs: 1000,
  playing: true, receivedAt: receipt.wallMs, positionTimestampMs: receipt.wallMs - 100,
  sourceServerTimestampMs: receipt.wallMs, positionObservedAt: receipt, developmentTiming: evidence };
const held = holdMetadata();
const benchmarkStart = now;
instance.callbacks.sample(firstSample);
assert.equal(packets.length, 1, 'playback publishes while metadata is held');
assert.deepEqual(metadataCalls, [firstSample.uri]);
advance(99);
assert.equal(searches.length, 0);
advance(1);
assert.equal(searches.length, baselineHost ? 0 : 1);
advance(3900);
assert.equal(packets.length, 1, 'metadata remains outstanding for 4000 mock ms');
held.resolve(resolvedMetadata);
await flush();
advance(99);
assert.equal(searches.length, baselineHost ? 0 : 1);
advance(1);
assert.equal(searches.length, 1, 'enrichment does not trigger a duplicate lyrics lookup');
const benchmarkMs = searches[0].at - benchmarkStart;
assert.equal(benchmarkMs, baselineHost ? 4100 : 100);
assert.deepEqual(metadataCalls, [firstSample.uri]);
console.log(`Mock sample-to-lyrics-dispatch (${baselineHost ? 'baseline host' : 'optimized host'}, metadata held 4000 ms): ${benchmarkMs} ms.`);
if (baselineHost) return;
instance.callbacks.ready();
render(); assert(find(tree), 'a verified foreground session keeps its capture page warm');
assert.equal(tree.props.pointerEvents, 'none');
assert.equal(packets.length, 2, 'sample and asynchronous metadata publication');
await flush();
assert.equal(publishedSamples.at(-1).developmentTiming, evidence, 'actual metadata publication preserves anchor');
assert.equal(publishedSamples.at(-1).positionObservedAt, receipt);
if (development) {
  assert(Object.isFrozen(evidence.receipt));
  assert(developmentLogs.some(l => l.stage === 'metadata-publish' && l.raw.anchor === evidence.anchor));
  assert(developmentLogs.some(l => l.stage === 'store-track-change' && l.track.startsWith('track-')));
} else assert.equal(developmentLogs.length, 0);
assert.equal(timingCalls.length, 0, 'timing capture is off until explicit opt-in');
const alertsBeforeDiagnostics = alerts.length;
if (development) {
  ref.current.runDiagnostics();
  assert.equal(alerts.at(-1)[0], 'Spotify timing diagnostics');
  assert.equal(timingCalls.length, 0, 'opening the dialog does not start capture');
  alerts.at(-1)[2][0].onPress();
  assert.deepEqual(timingCalls, ['start']);
  alerts.at(-1)[2][1].onPress();
  assert.deepEqual(JSON.parse(timingShares.at(-1).message), { active: false, records: [] }, 'share only the safe timing snapshot');
  alerts.at(-1)[2][2].onPress();
  assert.deepEqual(timingCalls, ['start', 'clear']);
} else {
  assert.equal(Object.hasOwn(ref.current, 'runDiagnostics'), false);
  assert.equal(alerts.length, alertsBeforeDiagnostics, 'Release cannot open timing capture through the imperative handle');
  assert.deepEqual(timingCalls, []);
  assert.deepEqual(timingShares, []);
}
assert.ok(transport, 'the actual component registers its playback transport');
ref.current.togglePlayPause();
assert.equal(commands.at(-1).type, 'play', 'the warm, hidden browser delegates controls to native');
assert.equal(commands.at(-1).playing, false, 'the native command carries the desired play state');
instance.observe({ playing: false });
await flush();
const alertsBeforeFailure = alerts.length;
controlError = new SpotifyPlaybackUnavailableError('No device');
ref.current.togglePlayPause();
await flush();
assert.equal(commandQueue.getSnapshot().playPending, false, 'definite rejection clears the pending icon');
assert.equal(alerts.length, alertsBeforeFailure, 'unavailable controls use persistent health, without modal flood');
instance.health.controlsEnabled = false;
const disabledCommands = commands.length;
for (const action of ['togglePlayPause', 'skipNext', 'skipPrevious']) ref.current[action]();
ref.current.seekTo(1234);
assert.equal(commands.length, disabledCommands, 'every imperative native transport path is gated');
assert.equal(commandQueue.getSnapshot().nextPending, true, 'unverified taps still reach the queue');
assert.equal(commandQueue.getSnapshot().seekPending, true);
controlError = undefined;
instance.health.controlsEnabled = true;
instance.observe({});
await flush();
assert.equal(commands.at(-1).type, 'play');
instance.observe({ playing: true });
await flush();
assert.equal(commands.at(-1).type, 'next');
instance.observe({ trackId: 'B' });
await flush();
assert.equal(commands.at(-1).type, 'previous');
assert.equal(commandQueue.getSnapshot().seekPending, false, 'track change invalidates the queued seek');
instance.observe({ trackId: 'A' });
await flush();
ref.current.openBrowser(); render(); web = find(tree); assert(web, 'browser remains available on demand');
assert.equal(Boolean(findNode(tree, child => child.type === 'Button' && child.props.title === 'Diagnostics')), development);
web.props.ref.current = { injectJavaScript: script => injected.push(script) };
web.props.onMessage({ nativeEvent: { data: '{"type":"ready"}', url: 'https://open.spotify.com/' } });
assert.equal(JSON.parse(injected.at(-1)).enabled, false, 'browser playback polling is disabled');
ref.current.togglePlayPause();
assert.equal(commands.at(-1).type, 'play', 'mounted browser does not receive transport commands');
instance.observe({ playing: false });
await flush();
instance.callbacks.sample({ uri: 'spotify:track:missing-artist', title: 'Unknown track', artist: '', artworkUrl: 'https://i.scdn.co/image/stale', positionMs: 1000 });
assert.equal(playback.currentTrack.artist, '', 'raw observer may omit artist');
const searchesBefore = searches.length;
assert.equal(scheduled.size, 0, 'missing artist cannot launch a lyrics search');
await flush();
assert.equal(playback.currentTrack.artist, 'Resolved Artist', 'native metadata fills artist before searching');
assert.equal(packets.at(-1).title, 'Resolved Title', 'ID-only snapshots receive the exact catalog title');
assert.equal(packets.at(-1).artworkUrl, 'https://i.scdn.co/image/resolved', 'catalog artwork replaces stale observer artwork');
instance.callbacks.sample({ uri: 'spotify:track:missing-artist', title: 'Unknown track', artist: '', positionMs: 2000 });
assert.equal(packets.at(-1).title, 'Resolved Title', 'subsequent sparse anchors retain the enriched title');
assert.equal(packets.at(-1).artworkUrl, 'https://i.scdn.co/image/resolved', 'subsequent sparse anchors retain the enriched cover');
assert.equal(packets.at(-1).positionMs, 2000, 'enrichment preserves native position anchors');
advance(100);
assert.equal(searches.length, searchesBefore + 1);

const placeholder = sampleFor('placeholder', { title: '  UnKnOwN TrAcK  ' });
const beforePlaceholder = searches.length;
const failedPlaceholder = holdMetadata();
instance.callbacks.sample(placeholder);
advance(100);
failedPlaceholder.reject(new Error('metadata unavailable'));
await flush();
advance(100);
assert.equal(searches.length, beforePlaceholder, 'a known artist cannot make a placeholder title searchable');
const pendingPlaceholder = holdMetadata();
instance.callbacks.sample(placeholder);
advance(100);
assert.equal(searches.length, beforePlaceholder);
pendingPlaceholder.resolve(resolvedMetadata);
await flush();
advance(99);
assert.equal(searches.length, beforePlaceholder);
advance(1);
assert.equal(searches.length, beforePlaceholder + 1, 'metadata supplies the first usable title');

const noArtist = sampleFor('missing-artist-failure', { artist: '  ' });
const beforeMissingArtist = searches.length;
const beforeRetries = metadataCalls.length;
for (let attempt = 0; attempt < 3; attempt++) {
  const failed = holdMetadata();
  instance.callbacks.sample(noArtist);
  failed.reject(new Error('metadata unavailable'));
  await flush();
  advance(100);
}
instance.callbacks.sample(noArtist);
await flush();
advance(100);
assert.equal(metadataCalls.length - beforeRetries, 3, 'metadata retries remain bounded');
assert.equal(searches.length, beforeMissingArtist, 'missing artist with failed metadata cannot dispatch');

const a = sampleFor('epoch-a');
const beforeEpochSearches = searches.length;
const oldA = holdMetadata();
instance.callbacks.sample(a);
const [oldTimerId, oldTimer] = scheduled.entries().next().value;
instance.callbacks.sample(sampleFor('epoch-b'));
const newA = holdMetadata();
instance.callbacks.sample(a);
assert.equal(scheduled.has(oldTimerId), false, 'changing tracks cancels the old timer');
oldTimer.fn(); // Simulate a callback already queued when cancellation occurred.
oldA.resolve({ ...resolvedMetadata, title: 'Obsolete A Title' });
await flush();
assert.equal(playback.currentTrack.title, a.title, 'the stale A metadata cannot publish into the new A epoch');
assert.equal(searches.length, beforeEpochSearches);
advance(100);
assert.equal(searches.length, beforeEpochSearches + 1);
assert.equal(searches.at(-1).id, a.uri);
newA.resolve(resolvedMetadata);
await flush();
advance(100);
assert.equal(playback.currentTrack.title, resolvedMetadata.title);
assert.equal(searches.length, beforeEpochSearches + 1, 'new A enrichment does not redispatch lyrics');

function queueLifecycleSample(track) {
  const pending = holdMetadata();
  const searchesBefore = searches.length;
  instance.callbacks.sample(sampleFor(track));
  assert.equal(scheduled.size, 1);
  const packetsBefore = packets.length;
  return async () => {
    advance(100);
    pending.resolve(resolvedMetadata);
    await flush();
    advance(100);
    assert.equal(packets.length, packetsBefore, `${track} suppresses late enrichment`);
    assert.equal(searches.length, searchesBefore, `${track} suppresses late lyrics dispatch`);
  };
}

const finishTour = queueLifecycleSample('tour');
const acceptedPackets = packets.length;
tour.pending = true;
instance.callbacks.sample({ uri: 'spotify:track:test', positionMs: 2000 });
assert.equal(packets.length, acceptedPackets, 'pending tour suppresses queued native events');
await finishTour();
tour.pending = false;
const finishBackground = queueLifecycleSample('background');
AppState.currentState = 'background'; listeners.forEach(fn => fn('background'));
assert.equal(instance.enabled, false);
await finishBackground();
// Consume the event value, even if the host's cached currentState lags it.
listeners.forEach(fn => fn('active'));
assert.equal(instance.enabled, true, 'foreground event resumes observation with a stale background snapshot');
AppState.currentState = 'active';
listeners.forEach(fn => fn('active'));
assert.equal(instance.enabled, true, 'duplicate active remains enabled');
// Cached transport mocked; real Detector.setEnabled replay is tested by check-spotify-timing.
const replay = { ...firstSample, title: 'Unknown track', artist: '', receivedAt: Date.now() + 1000 };
const cachedReplayMetadata = holdMetadata();
const beforeReplay = searches.length;
instance.callbacks.sample(replay);
assert.equal(publishedSamples.at(-1).developmentTiming, evidence);
assert.equal(publishedSamples.at(-1).positionObservedAt, receipt);
assert.equal(publishedSamples.at(-1).receivedAt, replay.receivedAt);
advance(100);
assert.equal(searches.length, beforeReplay + 1, 'cached enrichment allows an initial lookup in a returning track epoch');
assert.equal(searches.at(-1).title, resolvedMetadata.title);
cachedReplayMetadata.resolve(resolvedMetadata);
await flush();
advance(100);
assert.equal(searches.length, beforeReplay + 1);
if (development) {
  assert(developmentLogs.some(l => l.stage === 'js-startup' && l.version === 3 && l.buildBase === '0453f4e'));
  assert(developmentLogs.some(l => l.stage === 'cold-mount'));
  assert(developmentLogs.some(l => l.stage === 'app-state' && l.previous === 'active' && l.next === 'background'));
  assert(developmentLogs.some(l => l.stage === 'app-state' && l.previous === 'background' && l.next === 'active'));
  assert(developmentLogs.some(l => l.stage === 'observation-policy' && l.enabled));
  assert(!/private-|spotify:track:|Resolved Title/.test(JSON.stringify(developmentLogs)));
} else assert.equal(developmentLogs.length, 0);
const finishLogout = queueLifecycleSample('logout');
const packetsBeforeLogout = packets.length;
session.loggedOut = true; actions.logout(); render(); web = find(tree);
assert.equal(web.props.source.uri, 'https://accounts.spotify.com/logout', 'logout clears browser cookies even after unmount');
instance.callbacks.authenticated('late-token', 123);
instance.callbacks.sample({ uri: 'spotify:track:test', positionMs: 3000 });
assert.equal(packets.length, packetsBeforeLogout, 'logout suppresses late auth/state callbacks');
await finishLogout();
web.props.onLoadEnd(); render(); assert.equal(tree, null, 'logout browser is temporary');
session.loggedOut = false;
render();
const finishUnmount = queueLifecycleSample('unmount');
const packetsBeforeUnmount = packets.length;
const queuedOnUnmount = scheduled.values().next().value;
for (const hook of hooks) hook?.cleanup?.();
assert.equal(listeners.size, 0); assert.equal(actions, null);
assert.equal(scheduled.size, 0, 'unmount cancels the lyrics timer');
queuedOnUnmount.fn();
await finishUnmount();
instance.callbacks.sample({ uri: 'spotify:track:test', positionMs: 4000 });
assert.equal(packets.length, packetsBeforeUnmount, 'unmounted detector cannot write playback');
console.log(`Native detector lifecycle checks passed (${platform}): shared login, warm capture, single state source, native controls, tour/background cleanup and logout.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
