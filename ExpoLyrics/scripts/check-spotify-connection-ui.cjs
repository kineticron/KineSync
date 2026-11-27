const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const path = require('node:path');
const compile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const healthExports = {};
vm.runInNewContext(compile('lib/spotify-detector/health.ts'), { exports: healthExports });
let health = healthExports.initialSpotifyHealth;
let playback = { playbackMode: 'mobile', connectionStatus: 'disconnected', showSpotifyStatusBar: false }, tour = { active: false, pending: false };
const actions = [];
const mocks = {
  react: { memo: fn => fn }, 'react/jsx-runtime': require('react/jsx-runtime'),
  'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', Linking: { openURL: async url => actions.push(url) }, StyleSheet: { create: s => s } },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 10 }) },
  '@/components/ui/native-touchable': { NativeTouchable: 'Pressable' },
  '@/store/playback-store': { usePlaybackStore: selector => selector(playback) },
  '@/store/player-tour-store': { usePlayerTourStore: selector => selector(tour) },
  '@/store/spotify-connection-store': { useSpotifyConnectionStore: selector => selector({ health }) },
  '@/lib/spotify-detector/health': healthExports,
  '@/lib/spotify-player-actions': { requestOpenSpotifyBrowser: () => actions.push('open'), requestReloadSpotifyBrowser: () => actions.push('retry') },
};
const exportsObject = {};
vm.runInNewContext(compile('components/lyrics/spotify-connection-strip.tsx'), { exports: exportsObject, require: name => { assert(name in mocks, name); return mocks[name]; } });
const render = exportsObject.SpotifyConnectionStrip;
const text = tree => tree == null || typeof tree === 'boolean' ? '' : typeof tree !== 'object' ? String(tree) : React.Children.toArray(tree.props?.children).map(text).join('');

// 1. Default hidden (toggle defaults to false, renders null with no leftover spacer)
assert.equal(render(), null, 'default hidden when toggle is off');

// 2. Healthy connected hidden: even when enabled, healthy connected renders null
playback.showSpotifyStatusBar = true;
health = { ...healthExports.initialSpotifyHealth, phase: 'ready', target: 'available' };
assert.equal(render(), null, 'healthy connected hidden even when enabled');

// 3. Disabled hidden: when toggle is disabled/false, unhealthy states render null
playback.showSpotifyStatusBar = false;
for (const phase of ['connecting', 'registering', 'retryWait', 'offline', 'signInRequired']) {
  health = { ...healthExports.initialSpotifyHealth, phase };
  assert.equal(render(), null, 'disabled hidden for unhealthy phase ' + phase);
}
health = { ...healthExports.initialSpotifyHealth, phase: 'ready', target: 'restricted' };
assert.equal(render(), null, 'disabled hidden for restricted target');

// 4. Unhealthy enabled visible: connecting, reconnecting, error, restricted, no active device
playback.showSpotifyStatusBar = true;
for (const phase of ['idle','suspended','offline','renewingSession','connecting','registering','ready','retryWait','rateLimited','signInRequired','denied']) {
  health = { ...healthExports.initialSpotifyHealth, phase };
  const tree = render(); assert(tree, phase); assert(text(tree).trim(), phase);
  assert.equal(tree.props.style[1].top,14);
  // Visibility has no lyrics, renderer readiness, artwork, browser or track prerequisite.
  assert(!/WebView/.test(text(tree)));
}
health = { ...health, phase: 'retryWait' };
let tree = render();React.Children.toArray(tree.props.children).find(n => n.type === 'Pressable').props.onPress();assert.deepEqual(actions,['retry']);
health = { ...health, phase: 'signInRequired' };tree=render();React.Children.toArray(tree.props.children).find(n => n.type === 'Pressable').props.onPress();assert.deepEqual(actions,['retry','open']);
health = { ...health, phase: 'ready', target: 'restricted' };assert(render(), 'restricted target visible when enabled');
health = { ...health, phase: 'ready', target: 'absent' };tree=render();assert(text(tree).includes('Last known playback')); React.Children.toArray(tree.props.children).find(n => n.type === 'Pressable').props.onPress();assert.equal(actions.at(-1),'spotify://');
playback.connectionStatus='connected';assert.equal(render(),null,'native health is hidden when bridge owns routing');assert.equal(playback.connectionStatus,'connected');
playback.connectionStatus='disconnected';playback.playbackMode='desktop';assert.equal(render(),null);
playback.playbackMode='mobile';tour.pending=true;assert.equal(render(),null);
// Exercise the actual player callbacks and queue with signed-in but unverified Spotify.
const queueExports = {};
vm.runInNewContext(compile('lib/playback-command-queue.ts'), { exports: queueExports });
const commandExports = {};
const session = { signedIn: true, loggedOut: false };
const platform = { OS: 'ios' };
const appState = { currentState: 'active', addEventListener() {} };
const store = getState => ({ getState, subscribe() {} });
const commandMocks = {
  'react-native': { AppState: appState, Platform: platform },
  '@/store/playback-store': { usePlaybackStore: store(() => playback) },
  '@/store/player-tour-store': { usePlayerTourStore: store(() => tour) },
  '@/store/spotify-session-store': { useSpotifySessionStore: store(() => session) },
  './playback-command-queue': queueExports,
};
const screenSource = fs.readFileSync(path.join(__dirname, '../app/(tabs)/index.tsx'), 'utf8');
vm.runInNewContext(compile('lib/optimistic-playback.ts'), {
  exports: commandExports, require: name => commandMocks[name],
  performance: { now: () => 1000 }, setTimeout: () => 1, clearTimeout() {},
});
const { playbackCommands, submitPlaybackCommand, nativePlaybackBlocked, playbackControlPosition } = commandExports;
playback = { ...playback, playbackMode: 'mobile', playbackPosition: 1000, connectionStatus: 'disconnected', isPlaying: true };
tour.pending = false;
let commandState = {
  ready: false, targetId: 'phone',
  observation: { trackId: 'A', revision: 1, positionMs: 1000, durationMs: 60_000, playing: true, observedAt: 1000 },
};
const sent = [];
commandExports.registerPlaybackCommandTransport('mobile', {
  read: () => commandState,
  send: command => { sent.push(command.type); return 'sent'; },
});
const source = ts.createSourceFile('index.tsx', screenSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['handlePlaybackPlayPause', 'handlePlaybackPrevious', 'handlePlaybackNext', 'handleLyricLinePress',
  'handleSeek', 'sendSeekToPlaybackSource', 'handleScrubPreview', 'finishSeekInteraction'];
const handlers = {};
const playButtonState = [];
const callbacks = {
  ...commandExports, handlers, Platform: platform,
  usePlaybackStore: { getState: () => playback }, usePlayerTourStore: { getState: () => tour },
  controlsScrubActive: { current: false }, setScrubPreviewPositionMs() {}, setAutoFollowEnabled() {}, setResumeAutoFollowSignal() {},
  spotifyBrowserRef: { current: {
    togglePlayPause: () => submitPlaybackCommand('toggle'),
    skipPrevious: () => submitPlaybackCommand({ type: 'previous' }),
    skipNext: () => submitPlaybackCommand({ type: 'next' }),
  } },
};
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['controlsPlaying', 'playPauseDisabled'].includes(node.name.getText(source))) {
    playButtonState.push(`const ${node.getText(source)};`);
  }
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) {
    const name = node.name.getText(source);
    const fn = node.initializer.arguments[0].getText(source);
    const code = ts.transpileModule(`handlers.${name} = ${fn};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, callbacks);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(Object.keys(handlers).length, names.length);
Object.assign(callbacks, handlers);
const { outputText: compiledPlayButtonState } = ts.transpileModule(
  `${playButtonState.join('\n')} [controlsPlaying, playPauseDisabled];`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const readPlayButton = (pendingCommands, isPlaying) => vm.runInNewContext(
  compiledPlayButtonState,
  { pendingCommands, isPlaying, tour, blocked: pendingCommands.blocked, queuedControls: true, isMobileNative: true },
);
assert.equal(readPlayButton({}, true)[1], true, 'a cached Pause button waits for the current scope to observe');
assert.equal(readPlayButton({ observedPlaying: false }, true)[0], false, 'the label follows the state the queue will toggle');
handlers.handlePlaybackPlayPause();
handlers.handlePlaybackNext();
handlers.handlePlaybackPrevious();
handlers.handleLyricLinePress({ lineStartTime: 15_000 });
const pending = playbackCommands.getSnapshot();
assert.equal(pending.playing, false);
assert.equal(pending.anchor.anchorPositionMs, 15_000);
assert.equal(pending.seekPreviewPositionMs, 15_000, 'lyric taps publish an immediate renderer preview');
assert.equal(pending.nextPending, true);
assert.equal(pending.previousPending, true);
assert.deepEqual(sent, [], 'controls enqueue while the detector lacks verified dispatch authority');
assert.equal(playback.isPlaying, true, 'the UI preview never changes actual playback');
assert.equal(playback.playbackPosition, 1000);
handlers.handleSeek(19_000);
assert.equal(playbackCommands.getSnapshot().seekPreviewPositionMs, 19_000, 'the credits seek path publishes the same preview');
commandState = { ...commandState, blocked: { next: true, seek: true } };
commandExports.refreshPlaybackCommands();
assert.equal(playbackCommands.getSnapshot().nextPending, false);
assert.equal(playbackCommands.getSnapshot().seekPending, false);
handlers.handlePlaybackNext();
handlers.handleSeek(20_000);
handlers.handleScrubPreview(20_000);
assert.equal(callbacks.controlsScrubActive.current, false);
assert.equal(playbackCommands.getSnapshot().nextPending, false);
assert.equal(playbackCommands.getSnapshot().seekPending, false);
assert.equal(nativePlaybackBlocked('next'), true);
session.signedIn = false;
session.loggedOut = true;
assert.equal(nativePlaybackBlocked(), true);
for (const [os, mode, connection] of [['web', 'mobile', 'disconnected'], ['ios', 'desktop', 'disconnected'], ['ios', 'mobile', 'connected']]) {
  platform.OS = os;
  playback.playbackMode = mode;
  playback.connectionStatus = connection;
  assert.equal(nativePlaybackBlocked('next'), false, 'mobile restrictions cannot steal desktop or browser routing');
}
assert.equal(playbackControlPosition(1000, pending), 15_000);
// 5. Verify persisted Settings toggle on actual Settings PAGE
const exploreSource = fs.readFileSync(path.join(__dirname, '../app/(tabs)/explore.tsx'), 'utf8');
assert(exploreSource.includes('showSpotifyStatusBar'), 'explore.tsx must bind showSpotifyStatusBar');
assert(exploreSource.includes('setShowSpotifyStatusBar'), 'explore.tsx must bind setShowSpotifyStatusBar');
assert(exploreSource.includes('accessibilityLabel="Spotify connection status bar"'), 'explore.tsx must have accessible toggle switch');

// 6. Verify playback store persistence
const storeSource = fs.readFileSync(path.join(__dirname, '../store/playback-store.ts'), 'utf8');
assert(storeSource.includes('kinesync_spotify_status_bar'), 'playback-store.ts must persist to kinesync_spotify_status_bar');
assert(storeSource.includes('showSpotifyStatusBar: false'), 'playback-store.ts must default showSpotifyStatusBar to false');

console.log('Spotify connection UI passed: actual component across all phases, empty lyrics/closed browser independent, bridge/tour exclusion, default hidden, healthy connected hidden, unhealthy enabled visible, disabled hidden, and Settings page toggle.');
