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
let playback = { playbackMode: 'mobile', connectionStatus: 'disconnected' }, tour = { active: false, pending: false };
const actions = [];
const mocks = {
  react: { memo: fn => fn }, 'react/jsx-runtime': require('react/jsx-runtime'),
  'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', Linking: { openURL: async url => actions.push(url) }, StyleSheet: { create: s => s } },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 10 }) },
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
for (const phase of ['idle','suspended','offline','renewingSession','connecting','registering','ready','retryWait','rateLimited','signInRequired','denied']) {
  health = { ...healthExports.initialSpotifyHealth, phase };
  const tree = render(); assert(tree, phase); assert(text(tree).trim(), phase);
  assert.equal(tree.props.style[1].top,14);
  // Visibility has no lyrics, renderer readiness, artwork, browser or track prerequisite.
  assert(!/WebView/.test(text(tree)));
}
health = { ...health, phase: 'retryWait' };
let tree = render();React.Children.toArray(tree.props.children).find(n => n.type === 'Pressable').props.onPress();assert.deepEqual(actions,['retry']);
health = { ...health, phase: 'signInRequired' };tree=render();React.Children.toArray(tree.props.children).find(n => n.type === 'Pressable').props.onPress();assert.deepEqual(actions,['retry','retry','open']);
playback.connectionStatus='connected';assert.equal(render(),null,'native health is hidden when bridge owns routing');assert.equal(playback.connectionStatus,'connected');
playback.connectionStatus='disconnected';playback.playbackMode='desktop';assert.equal(render(),null);
playback.playbackMode='mobile';tour.pending=true;assert.equal(render(),null);
console.log('Spotify connection UI passed: actual component across all phases, empty lyrics/closed browser independent, bridge/tour exclusion and actions.');
