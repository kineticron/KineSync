const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { lyricsToTtml } = require('../lib/lyrics-ttml-export');
const { parseTtmlToLyrics } = require('../lib/lyrics-ttml-import');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.resolve(root, file), 'utf8');
const profiles = {
  Maker: { username: 'maker', url: 'https://spicylyrics.org/uid/123', avatar: 'https://example.com/maker.png' },
  Uploader: { username: 'uploader', url: 'https://spicylyrics.org/uid/456', avatar: 'https://example.com/uploader.png' },
};
const payload = { source: 'spicy_lyrics', UploadAttribution: profiles };
let attribution;
for (const file of ['../DesktopBridge/src/lyrics/parts/01c-fingerprinting.js', 'lib/mobile-lyrics-service.js']) {
  const source = read(file);
  const helper = source.slice(source.indexOf('function extractSpicyPayloadMetadata('), source.indexOf('function extractSpicyLeadVocalPlainText('));
  const context = vm.createContext({ payload });
  vm.runInContext(helper, context);
  attribution = vm.runInContext('extractSpicyPayloadMetadata(payload).attribution', context);
  assert.equal(attribution.maker.url, profiles.Maker.url);
  assert.equal(attribution.uploader.url, profiles.Uploader.url);
  context.payload = { source: 'spl', TTMLUploadMetadata: {
    Maker: { ...profiles.Maker, url: `  ${profiles.Maker.url}  ` },
    Uploader: { ...profiles.Uploader, url: 'javascript:alert(1)' },
  } };
  const legacy = vm.runInContext('extractSpicyPayloadMetadata(payload).attribution', context);
  assert.equal(legacy.maker.url, profiles.Maker.url, 'trim URLs before validation');
  assert.equal(legacy.uploader.url, undefined, 'unsafe URLs stay unlinked');
  context.payload = { ...payload, source: 'apple_music' };
  const official = vm.runInContext('extractSpicyPayloadMetadata(payload).attribution', context);
  assert.equal(official.maker, undefined);
  assert.equal(official.uploader, undefined);
}
const xml = lyricsToTtml({ lyrics: [{ lineStartTime: 0, lineEndTime: 1000,
  syllables: [{ text: 'Hello', startTime: 0, endTime: 1000 }] }], metadata: { attribution } });
assert.deepEqual(parseTtmlToLyrics(xml).metadata.attribution, JSON.parse(JSON.stringify(attribution)), 'TTML preserves contributor URLs');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.events = {}; }
  appendChild(child) { this.children.push(child); }
  addEventListener(type, handler) { this.events[type] = handler; }
}
class Anchor extends Element {}
const descendants = node => Array.isArray(node) ? node.flatMap(descendants)
  : node ? [node, ...(node.children || []).flatMap(descendants)] : [];
for (const file of ['amll-webview-entry.ts', 'spicy-webview-entry.ts']) {
  const source = read(`components/lyrics/${file}`);
  const start = source.indexOf('function appendCreditsContent(');
  const end = source.indexOf('\nfunction ', start + 1);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const messages = [];
  const context = vm.createContext({
    HTMLAnchorElement: Anchor,
    document: { createElement: tag => tag === 'a' ? new Anchor(tag) : new Element(tag), createTextNode: textContent => ({ textContent }) },
    post: message => messages.push(message),
  });
  vm.runInContext(js, context);
  const container = new Element('div');
  context.appendCreditsContent(container, [], attribution);
  const anchors = descendants(container).filter(node => node instanceof Anchor);
  assert.deepEqual(anchors.map(node => [node.textContent, node.href]), [
    ['@maker', profiles.Maker.url], ['@uploader', profiles.Uploader.url],
  ]);
  for (const anchor of anchors) {
    let prevented = false;
    let stopped = false;
    anchor.events.click({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert.ok(prevented && stopped, 'profile clicks must not trigger lyric seeking');
    assert.equal(messages.at(-1).url, anchor.href);
    assert.equal(messages.at(-1).type, 'attributionLink');
  }
  const uploaderOnly = new Element('div');
  context.appendCreditsContent(uploaderOnly, [], { uploader: attribution.uploader });
  assert.ok(descendants(uploaderOnly).some(node => node.textContent === 'Uploaded By: '));
}

// Render the native footer with lightweight host elements and exercise its actual handlers.
const nativeSource = read('components/lyrics/native/native-lyrics-view.tsx');
const footer = nativeSource.slice(nativeSource.indexOf('const footer = useMemo('), nativeSource.indexOf('const retryFlatScroll ='));
const nativeJs = ts.transpileModule(`${footer}\nresult = footer;`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
const opened = [];
const context = vm.createContext({
  result: null,
  React: { createElement: (tag, props, ...children) => ({ tag, props, children }) },
  Pressable: 'Pressable', Text: 'Text', Image: 'Image', useMemo: callback => callback(),
  metadata: { attribution }, styles: { profileLink: { textDecorationLine: 'underline' } },
  landscapeMode: false, lyrics: [], onCreditsTimestampPress: undefined, onUserInteraction: undefined,
  Linking: { openURL(url) { opened.push(url); return Promise.resolve(); } },
});
vm.runInContext(nativeJs, context);
const nativeLinks = descendants(context.result).filter(node => node?.props?.accessibilityRole === 'link');
assert.equal(nativeLinks.length, 2);
for (const link of nativeLinks) {
  let stopped = false;
  link.props.onPress({ stopPropagation() { stopped = true; } });
  assert.ok(stopped);
}
assert.deepEqual(opened, [profiles.Maker.url, profiles.Uploader.url]);

// Exercise the persistent overlay with real component handlers and shared progress.
let expanded = false;
let interactions = 0;
let previousOverlayDeps;
let reducedMotion = false;
let reaction;
let sharedCursor = 0;
let stateUpdates = 0;
const sharedValues = [];
const sharedValue = initial => {
  let current = initial;
  return { animation: null, get: () => current, set(value) {
    if (value && typeof value === 'object') this.animation = value;
    else { current = value; this.animation = null; }
  } };
};
const runUIReaction = () => {
  const current = reaction.prepare();
  reaction.react(current, reaction.previous);
  reaction.previous = current;
};
const overlayLinks = [];
const jsx = (tag, props) => typeof tag === 'function' ? tag(props) : ({ tag, props, children: props?.children });
const overlayModule = { exports: {} };
const overlayCode = ts.transpileModule(read('components/lyrics/lyrics-attribution.tsx'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
}).outputText;
vm.runInNewContext(overlayCode, { exports: overlayModule.exports, require(name) {
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
  if (name === 'react') return { memo: component => component, useEffect(callback, deps) {
    if (!previousOverlayDeps || deps.some((value, index) => value !== previousOverlayDeps[index])) callback();
    previousOverlayDeps = deps;
  }, useState: () => [expanded, value => { expanded = value; stateUpdates++; }] };
  if (name === 'expo-blur') return { BlurView: 'BlurView' };
  if (name === 'expo-image') return { Image: 'Image' };
  if (name === 'react-native') return { useWindowDimensions: () => ({ width: 390, height: 844 }), Linking: { openURL: url => { overlayLinks.push(url); return Promise.resolve(); } }, Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: styles => styles, absoluteFill: {} } };
  if (name === 'react-native-reanimated') {
    const fade = { duration: () => ({ reduceMotion: () => 'fade' }) };
    return { __esModule: true, default: { View: 'AnimatedView', Text: 'AnimatedText' }, FadeIn: fade, ReduceMotion: { System: 'system' },
      Easing: { bezier: () => 'ease-in-out', linear: 'linear' },
      useAnimatedRef: () => ({}), measure: () => ({ width: 100 }),
      useAnimatedStyle: callback => new Proxy({}, { get: (_, property) => callback()[property] }),
      useReducedMotion: () => reducedMotion,
      useSharedValue: initial => sharedValues[sharedCursor++] ||= sharedValue(initial),
      useAnimatedReaction(prepare, react) { reaction = { prepare, react, previous: reaction?.previous || null }; runUIReaction(); },
      withTiming: (to, config, callback) => ({ type: 'timing', to, ...config, callback }),
    };
  }
  throw Error(`Unexpected overlay import ${name}`);
} });
const overlay = overlayModule.exports.LyricsAttribution;
const renderOverlay = props => { sharedCursor = 0; return overlay(props); };
const tree = node => Array.isArray(node) ? node.flatMap(tree) : node && typeof node === 'object' ? [node, ...tree(node.children)] : [];
const controlsTarget = sharedValue(0);
const controlsProgress = sharedValue(0);
const overlayProps = { metadata: { attribution }, trackId: 'song', controlsProgress, controlsTarget, controlsVisible: false, controlsHeight: 220, bottomInset: 24, onInteraction: () => { interactions++; } };
let nodes = tree(renderOverlay(overlayProps));
const badge = nodes.find(node => node.props?.accessibilityLabel === 'Lyrics attribution. Show details');
const badgeNodes = tree(badge);
assert.equal(badgeNodes.find(node => node.tag === 'AnimatedView').props.style[1].opacity, 0, 'Only the glass fades out, keeping handles visible');
assert.ok(badgeNodes.some(node => node.children?.[0] === 'U:'));
assert.ok(badgeNodes.some(node => node.children?.[0] === 'M:'));
badge.props.onPress();
assert.equal(expanded, true, 'Tapping the badge expands details, including taps on handles');
assert.equal(interactions, 1);
// The native target starts motion without a React render or an opacity update.
const updatesBeforeMotion = stateUpdates;
controlsTarget.set(1);
runUIReaction();
controlsProgress.set(1);
for (const decoration of badgeNodes.filter(node => node.tag === 'AnimatedView' || node.tag === 'AnimatedText')) {
  assert.equal(decoration.props.style.at(-1).opacity, 0, 'Glass, provider and avatars stay hidden throughout the exit, even after controls appear');
}
assert.equal(sharedValues[0].animation.to, 124, 'Exit distance clears the measured badge width and screen inset');
assert.equal(sharedValues[0].animation.duration, 220);
assert.equal(sharedValues[2].animation.to, 0, 'The badge fades out while sliding offscreen');
assert.equal(sharedValues[2].animation.duration, 220);
assert.equal(sharedValues[1].get(), 0, 'Exit keeps the badge at its original height');
const exitFinished = sharedValues[0].animation.callback;
sharedValues[0].set(124);
sharedValues[2].set(0);
exitFinished(true);
assert.equal(badgeNodes.find(node => node.tag === 'AnimatedView').props.style[1].opacity, 1, 'Glass becomes available only after the invisible badge moves offscreen');
assert.equal(sharedValues[1].get(), -208, 'Only the invisible badge relocates above the controls');
assert.equal(sharedValues[0].get(), 124);
assert.equal(sharedValues[0].animation.to, 0, 'Entrance slides left from offscreen');
assert.equal(sharedValues[0].animation.duration, 300);
assert.equal(sharedValues[2].get(), 0);
assert.equal(sharedValues[2].animation.to, 1, 'Entrance fades in alongside the slide');
assert.equal(sharedValues[2].animation.duration, 300);
// Reverse mid-entrance without a React render or jumping to an endpoint.
sharedValues[0].set(60);
sharedValues[2].set(0.5);
controlsTarget.set(0);
runUIReaction();
assert.equal(sharedValues[0].get(), 60);
assert.equal(sharedValues[1].get(), -208);
assert.equal(sharedValues[1].animation.to, 0);
assert.equal(sharedValues[1].animation.duration, 300, 'Closing controls lets attribution fall smoothly');
sharedValues[1].set(-80);
controlsTarget.set(1);
runUIReaction();
assert.equal(sharedValues[1].get(), -80, 'Reopening during the fall keeps the current position');
const cancelledExit = sharedValues[0].animation.callback;
controlsTarget.set(0);
runUIReaction();
cancelledExit(false);
cancelledExit(true);
assert.equal(sharedValues[1].get(), -80, 'A cancelled or stale exit cannot relocate the badge');
assert.equal(sharedValues[3].get(), 0, 'A cancelled exit cannot reveal the glass');
controlsTarget.set(1);
runUIReaction();
assert.equal(stateUpdates, updatesBeforeMotion, 'Motion never schedules React state updates');
sharedValues[0].set(0);
sharedValues[1].set(-208);
sharedValues[2].set(1);
nodes = tree(renderOverlay({ ...overlayProps, metadata: { attribution: { ...attribution } }, controlsVisible: true, controlsProgress: { get: () => 0.5 } }));
assert.equal(expanded, true, 'Equivalent metadata updates must not close the attribution panel');
assert.equal(nodes.find(node => node.tag === 'AnimatedView').props.style[1].transform[1].translateY, -208);
sharedValues[0].set(-8);
sharedValues[1].set(60);
assert.equal(nodes.find(node => node.tag === 'AnimatedView').props.style[1].transform[0].translateX, 0);
assert.equal(nodes.find(node => node.tag === 'AnimatedView').props.style[1].transform[1].translateY, 0, 'A stale frame timestamp cannot push the badge below the screen');
sharedValues[0].set(0);
sharedValues[1].set(-208);
assert.equal(nodes.find(node => node.tag === 'Modal').props.visible, true);
const avatars = nodes.filter(node => node.tag === 'Image');
assert.equal(avatars.length, 4, 'Both compact and expanded attribution include both profile pictures');
for (const profile of Object.values(profiles)) assert.equal(avatars.filter(node => node.props.source.uri === profile.avatar).length, 2);
const links = nodes.filter(node => node.props?.accessibilityRole === 'link');
assert.equal(links.length, 2);
for (const link of links) link.props.onPress({ stopPropagation() {} });
assert.deepEqual(overlayLinks, [profiles.Uploader.url, profiles.Maker.url]);
for (const provider of ['Apple Music', 'Spotify']) {
  const commercial = tree(renderOverlay({ ...overlayProps, metadata: { attribution: { source: provider, provider } } }));
  const compact = tree(commercial.find(node => node.props?.accessibilityLabel === 'Lyrics attribution. Show details'));
  assert.ok(compact.some(node => node.children === provider));
  assert.ok(!compact.some(node => node.props?.accessibilityRole === 'link'));
  assert.ok(!compact.some(node => node.tag === 'Image'), 'Commercial provider labels do not gain contributor pictures');
}
reducedMotion = true;
renderOverlay(overlayProps);
assert.equal(sharedValues[0].get(), 0);
assert.equal(sharedValues[1].get(), -208);
controlsTarget.set(0);
runUIReaction();
assert.equal(sharedValues[1].get(), 0, 'Reduced motion changes position without a slide or fall');
assert.equal(sharedValues[1].animation, null);
assert.equal(sharedValues[2].get(), 1, 'Reduced motion keeps attribution visible');
assert.equal(sharedValues[3].get(), 0, 'Reduced motion hides closed-controls chrome immediately');

// Native hit testing compares sibling layers, not the badge's nested zIndex.
const playerSource = read('app/(tabs)/index.tsx');
const playerAst = ts.createSourceFile('index.tsx', playerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let playerStyles;
let attributionParent;
const controlCallbacks = {};
function inspectPlayer(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(playerAst) === 'styles') playerStyles = node.initializer.arguments[0];
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(playerAst) === 'LyricsAttribution') attributionParent = node.parent;
  if (ts.isVariableDeclaration(node) && ['showControls', 'hideControls'].includes(node.name.getText(playerAst))) controlCallbacks[node.name.getText(playerAst)] = node.initializer.arguments[0].getText(playerAst);
  ts.forEachChild(node, inspectPlayer);
}
inspectPlayer(playerAst);
for (const [name, target] of [['showControls', 1], ['hideControls', 0]]) {
  const events = [];
  vm.runInNewContext(`(${controlCallbacks[name]})()`, {
    controlsTarget: { set: value => events.push(['target', value]) },
    setControlsVisible: () => events.push(['react']), controlsOpacity: {}, controlsTranslateY: {},
    withTiming: () => {}, ReanimatedEasing: { out: value => value, cubic: 'cubic' },
  });
  assert.deepEqual(events[0], ['target', target], 'Shared target is sent before the controls React update');
}
assert.ok(attributionParent.openingElement.attributes.getText(playerAst).includes('styles.lyricsAttributionLayer'));
const layerIndex = name => {
  const property = playerStyles.properties.find(property => property.name.getText(playerAst) === name);
  return vm.runInNewContext(`(${property.initializer.getText(playerAst)})`, { StyleSheet: { absoluteFill: {} } }).zIndex;
};
for (const name of ['controlsRevealZone', 'bottomArea', 'lyricsBottomBlurWrap']) {
  assert.ok(layerIndex('lyricsAttributionLayer') > layerIndex(name), `Attribution must receive taps above ${name}`);
}
console.log('Spicy contributor links, native accessibility, and TTML attribution checks passed.');
