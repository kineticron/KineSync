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
for (const connected of [false, true]) for (const position of [0, 2999, 3000, 3001, 120000]) {
  const calls = [];
  const context = { useCallback: fn => fn, usePlayerTourStore: { getState: () => ({ active: false }) },
    usePlaybackStore: { getState: () => ({ playbackPosition: position, connectionStatus: connected ? 'connected' : 'disconnected' }) },
    handleSeek: ms => calls.push(['seek', ms]), bridgeClient: { skipPrevious: () => calls.push(['desktop']) },
    spotifyBrowserRef: { current: { skipPrevious: () => calls.push(['browser']) } } };
  vm.runInNewContext(`(${callback})()`, context);
  assert.deepEqual(calls, position > 3000 ? [['seek', 0]] : [[connected ? 'desktop' : 'browser']],
    'Previous restarts an ongoing song and only changes tracks near its beginning');
}
console.log('Playback previous checks passed: restart after three seconds for desktop and browser sources.');
