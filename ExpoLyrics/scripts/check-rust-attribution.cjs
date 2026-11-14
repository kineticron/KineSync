/* global __dirname */
/* Execute the production attribution component and its real touch callbacks.
 * React/native hooks are unit boundaries; this is not a screenshot/reference. */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const app = path.resolve(__dirname, '..');
const source = path.join(app, 'components/lyrics/lyrics-attribution.tsx');
const compiled = buildSync({ entryPoints: [source], absWorkingDir: app, bundle: true, platform: 'node', format: 'cjs', write: false,
  tsconfig: path.join(app, 'tsconfig.json'), packages: 'external' }).outputFiles[0].text;
let expanded = false;
const opened = [];
const jsx = (type, props) => ({ type, props: props || {} });
const native = { Text: 'Text', View: 'View', Pressable: 'Pressable', Modal: 'Modal', ScrollView: 'ScrollView',
  StyleSheet: { create: x => x, absoluteFill: {} }, useWindowDimensions: () => ({ width: 390 }),
  Linking: { openURL: url => { opened.push(url); return Promise.resolve(); } } };
const chain = { duration: () => chain, reduceMotion: () => chain };
const animated = { View: 'View', Text: 'Text', Easing: { bezier: () => null, linear: null }, FadeIn: chain, ReduceMotion: { System: 'system' },
  useAnimatedReaction: () => {}, useAnimatedRef: () => ({}), useAnimatedStyle: () => ({}), useReducedMotion: () => false,
  useSharedValue: x => ({ get: () => x, set: () => {} }) };
const react = { memo: f => f, useEffect: () => {}, useState: () => [expanded, x => { expanded = x; }] };
const imports = { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': native,
  'react-native-reanimated': { ...animated, default: animated }, 'expo-blur': { BlurView: 'Blur' }, 'expo-image': { Image: 'Image' },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) } };
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: id => { assert.ok(imports[id], id); return imports[id]; } });
function nodes(node) {
  if (node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (typeof node.type === 'function') return nodes(node.type(node.props));
  return [node, ...nodes(node.props?.children)];
}
const props = { metadata: { attribution: { source: 'fixture', provider: 'Exact provider', url: 'https://example.org/provider',
  maker: { username: 'maker', url: 'https://example.org/maker' }, uploader: { username: 'uploader', url: 'https://example.org/uploader' } },
  credits: { songwriters: ['Writer'] } }, allCredits: true, controlsProgress: { get: () => 1 }, controlsTarget: { get: () => 1 },
  controlsVisible: true, controlsHeight: 100, bottomInset: 0, onInteraction() {} };
const render = () => nodes(mod.exports.LyricsAttribution(props));
render().find(n => n.props.accessibilityLabel === 'Lyrics attribution. Show details').props.onPress();
assert.equal(expanded, true);
assert.ok(render().find(n => n.type === 'Modal').props.visible);
const links = render().filter(n => n.props.accessibilityRole === 'link');
assert.equal(links.length, 3, 'non-Spicy provider/uploader/maker must all have actual links');
let stops = 0;
for (const link of links) link.props.onPress({ stopPropagation() { stops++; } });
assert.equal(stops, 3);
assert.deepEqual(opened.sort(), ['https://example.org/maker', 'https://example.org/provider', 'https://example.org/uploader']);
props.metadata.attribution.url = 'http://example.org/provider';
props.metadata.attribution.maker.url = 'javascript:bad';
assert.equal(render().filter(n => n.props.accessibilityRole === 'link').length, 1);
props.metadata = { credits: { songwriters: ['Writer'] } };
assert.ok(render().some(n => n.props.children === 'Song credits'), 'credit-only metadata must stay reachable');
props.allCredits = false;
assert.equal(render().length, 0, 'the non-Rust attribution eligibility remains unchanged');
console.log('Production Rust attribution eligibility, modal, exact profile/provider callbacks, credit-only data and URL guards passed.');
