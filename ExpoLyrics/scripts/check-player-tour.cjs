/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
let time = 1000;
const context = { exports: {}, require, performance: { now: () => time } };
const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'store/player-tour-store.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(compiled, context);
const { usePlayerTourStore: store, getTourPosition, TOUR_STEPS } = context.exports;
store.getState().requestStart();
assert.equal(store.getState().active, false, 'sample waits for the main player to receive focus');
assert.equal(store.getState().pending, true);
store.getState().start();
assert.equal(store.getState().pending, false);
store.getState().advance('translate');
assert.equal(store.getState().step, 'welcome', 'out-of-order actions cannot skip lessons');
store.getState().advance('welcome');
assert.equal(store.getState().step, 'artwork');

// Execute the actual HomeScreen handlers with transport methods that fail if called in the tour.
const source = fs.readFileSync(path.join(root, 'app/(tabs)/index.tsx'), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['handlePlaybackPlayPause', 'handlePlaybackResync', 'handlePlaybackPrevious', 'handlePlaybackNext', 'handleLyricLinePress', 'handleSeek', 'handleShowFullscreenAlbum', 'handleShowLyrics', 'handleTranslate', 'handleResumeAutoFollow', 'handleToggleAutoHidePlaybackControls'];
const callbacks = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) {
    callbacks[node.name.getText(ast)] = node.initializer.arguments[0].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
let liveCommands = 0;
const liveCommand = () => { liveCommands++; };
const setter = () => {};
const handlers = {
  nativePlaybackBlocked: () => false,
  playbackCommands: { getSnapshot: () => ({}) },
  finishSeekInteraction: setter,
  usePlayerTourStore: store,
  usePlaybackStore: { getState: () => ({ playbackMode: 'desktop', connectionStatus: 'connected' }), setState: liveCommand },
  bridgeClient: { togglePlayPause: liveCommand, resyncPlayback: liveCommand, skipPrevious: liveCommand, skipNext: liveCommand },
  spotifyBrowserRef: { current: { togglePlayPause: liveCommand, resyncPlayback: liveCommand, skipPrevious: liveCommand, skipNext: liveCommand } },
  sendSeekToPlaybackSource: liveCommand, requestImmediateTranslationForCurrentSource: liveCommand,
  setAutoHidePlaybackControls: liveCommand, autoHidePlaybackControlsRef: { current: false },
  setScrubPreviewPositionMs: setter, setAutoFollowEnabled: setter, setResumeAutoFollowSignal: setter,
  setAlbumArtworkMorphing: setter, setFullscreenAlbumMode: setter, setTopBarMounted: setter,
  showControls: setter, albumArtworkMorphingRef: { current: false }, fullscreenAlbumModeRef: { current: false },
  currentTrack: { durationMs: 25000 }, autoFollowEnabled: true, isPlaying: true,
  Date, performance: { now: () => time }, result: {},
};
for (const [name, callback] of Object.entries(callbacks)) {
  const code = ts.transpileModule(`result.${name} = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, handlers);
}
assert.equal(Object.keys(handlers.result).length, names.length);
const actions = handlers.result;
handlers.handleSeek = actions.handleSeek;
actions.handleShowFullscreenAlbum(); assert.equal(store.getState().step, 'lyrics');
actions.handleShowLyrics(); assert.equal(store.getState().step, 'seek');
actions.handleLyricLinePress({ lineStartTime: 5000 });
assert.equal(store.getState().step, 'playback');
assert.equal(store.getState().anchorPositionMs, 5000);
time += 1000;
actions.handlePlaybackPlayPause();
assert.equal(store.getState().step, 'translate');
assert.equal(store.getState().isPlaying, false);
assert.equal(getTourPosition(store.getState()), 6000);
time += 1000;
assert.equal(getTourPosition(store.getState()), 6000, 'pause holds sample position');
actions.handleTranslate();
assert.equal(store.getState().translated, true);
assert.equal(store.getState().step, 'autoScroll');
actions.handleToggleAutoHidePlaybackControls();
assert.equal(store.getState().autoHideControls, false, 'earlier lessons cannot hide the controls');
actions.handleResumeAutoFollow();
assert.equal(store.getState().step, 'autoHide');
store.getState().advance('autoHide');
assert.equal(store.getState().step, 'autoHide', 'try the setting before continuing');
actions.handleToggleAutoHidePlaybackControls();
assert.equal(store.getState().autoHideControls, true, 'tour toggles its own auto-hide preview');
store.getState().advance('autoHide');
assert.equal(store.getState().step, 'done');
assert.equal(store.getState().autoHideControls, false, 'controls return after the demo lesson');
actions.handleSeek(99999); assert.equal(store.getState().anchorPositionMs, 25000);
actions.handlePlaybackPrevious(); actions.handlePlaybackNext(); actions.handlePlaybackResync();
assert.equal(liveCommands, 0, 'tour actions never write live anchors or send transport/translation commands');
store.getState().finish();
actions.handlePlaybackPlayPause(); actions.handleTranslate();
assert.equal(liveCommands, 2, 'live controls work again after finishing');
store.getState().start();
assert.equal(store.getState().step, 'welcome');
assert.equal(store.getState().translated, false);
assert.equal(store.getState().autoHideControls, false, 'replay resets the demo setting');
store.getState().finish();

const overlayFile = path.join(root, 'components/onboarding/player-tour-overlay.tsx');
const overlayCode = ts.transpileModule(fs.readFileSync(overlayFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
// Execute the production wrapper and retain its rendered host for assertions.
const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
const entrance = {};
function loadOverlay(platform) {
  const mocks = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Platform: { OS: platform }, StyleSheet: { create: styles => styles }, Text: 'Text', View: 'View' },
    'react-native-reanimated': {
      __esModule: true,
      default: { View: 'Animated.View' },
      FadeIn: { duration: () => ({ reduceMotion: () => entrance }) },
      ReduceMotion: { System: 'system' },
    },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    'expo-blur': { BlurView: 'BlurView' },
    'expo-linear-gradient': { LinearGradient: 'LinearGradient' },
    '@/components/ui/motion-pressable': { MotionPressable: 'Button' },
    '@/constants/design': { Design: {} },
    '@/store/player-tour-store': { usePlayerTourStore: store.getState, TOUR_STEPS },
  };
  const overlayContext = { exports: {}, require: name => {
    assert.ok(Object.hasOwn(mocks, name), `Missing overlay mock for ${name}`);
    return mocks[name];
  } };
  vm.runInNewContext(overlayCode, overlayContext, { filename: overlayFile });
  return overlayContext.exports.PlayerTourOverlay;
}

const renderAndroidOverlay = loadOverlay('android');
const renderIosOverlay = loadOverlay('ios');
const overlayProps = { controlsHeight: 180, transitioning: false, landscape: false, fullscreen: false };
store.getState().start();
for (const step of TOUR_STEPS) {
  store.setState({ step });
  const android = renderAndroidOverlay(overlayProps);
  assert.equal(android.type, 'View', `Android ${step} must use a plain View`);
  assert.equal(Object.hasOwn(android.props, 'entering'), false);
  if (step === 'welcome' || step === 'done') {
    assert.equal(android.props.accessibilityViewIsModal, true);
  } else {
    assert.equal(android.props.pointerEvents, 'box-none');
    assert.equal(android.props.children.props.accessibilityLiveRegion, 'polite');
  }
  const ios = renderIosOverlay(overlayProps);
  assert.equal(ios.type, 'Animated.View');
  assert.equal(ios.props.entering, entrance);
}
store.getState().finish();
console.log('Player tour checks passed: player handlers, ordered lessons, playback isolation, and Android overlays without entering animations.');
