/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../app/(tabs)/index.tsx'), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handlePlaybackPrevious') callback = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback);
const { outputText: invokePrevious } = ts.transpileModule(`(${callback})();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
});
for (const playbackMode of ['desktop', 'mobile']) {
  for (const position of [0, 2999, 3000, 3001, 120000]) {
    for (const previousPending of [false, true]) {
      const calls = [];
      const context = {
        nativePlaybackBlocked: () => false,
        useCallback: fn => fn,
        usePlayerTourStore: { getState: () => ({ active: false }) },
        usePlaybackStore: { getState: () => ({ playbackPosition: position, playbackMode, connectionStatus: 'disconnected' }) },
        playbackCommands: { getSnapshot: () => ({ previousPending }) },
        playbackControlPosition: positionMs => positionMs,
        handleSeek: ms => calls.push(['seek', ms]),
        bridgeClient: { skipPrevious: () => calls.push(['desktop']) },
        spotifyBrowserRef: { current: { skipPrevious: () => calls.push(['mobile']) } },
      };
      vm.runInNewContext(invokePrevious, context);
      assert.deepEqual(calls, position > 3000 && !previousPending ? [['seek', 0]] : [[playbackMode]],
        'Previous restarts after three seconds, and repeated pending skips keep their order');
    }
  }
}
const unavailableCalls = [];
vm.runInNewContext(invokePrevious, {
  useCallback: fn => fn,
  nativePlaybackBlocked: () => true,
  usePlayerTourStore: { getState: () => ({ active: false }) },
  usePlaybackStore: { getState: () => ({ playbackPosition: 120000, playbackMode: 'mobile' }) },
  playbackCommands: { getSnapshot: () => ({ previousPending: false }) },
  playbackControlPosition: positionMs => positionMs,
  handleSeek: ms => unavailableCalls.push(ms),
  bridgeClient: { skipPrevious: () => unavailableCalls.push('bridge') },
  spotifyBrowserRef: { current: { skipPrevious: () => unavailableCalls.push('native') } },
});
assert.equal(unavailableCalls.length, 0, 'restricted Previous cannot restart or skip playback');
console.log('Playback previous checks passed for desktop and mobile routing, restart and repeated skips.');
