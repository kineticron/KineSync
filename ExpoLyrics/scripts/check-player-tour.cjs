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
const { usePlayerTourStore: store, getTourPosition } = context.exports;
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
  usePlayerTourStore: store,
  usePlaybackStore: { getState: () => ({ connectionStatus: 'connected' }), setState: liveCommand },
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
console.log('Player tour checks passed: actual player handlers, ordered lessons, sample seek/pause/translation, replay, and live playback isolation.');
