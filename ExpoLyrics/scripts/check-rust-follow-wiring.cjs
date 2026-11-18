/* Execute the production Rust view and gesture against native follow guards.
 * This covers the delayed-false and late-JS-grant handoff on both renderer
 * styles. Native command application runs the Swift/Kotlin guard expressions
 * from source rather than a source-only assertion. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync, transformSync } = require('esbuild');
const app = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const swift = read('../modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift');
const android = read('../modules/kinesync-rust-lyrics/android/src/main/java/dev/kineticron/rustlyrics/KineSyncRustLyricsView.kt');

function swiftGuards(name, endMarker) {
  const start = swift.indexOf(`private func ${name}(`);
  const end = swift.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${name} must exist`);
  const conditions = [...swift.slice(start, end).matchAll(/guard (.+?) else \{ return false \}/g)]
    .flatMap(match => match[1].split(',').map(condition => condition.trim().replace(/self\./g, 'state.')));
  return new Function('state', 'value', 'gesture', 'nextEpoch', 'identity',
    `return !!(${conditions.map(condition => `(${condition})`).join(' && ')});`);
}
const physicalAllowed = swiftGuards('followCommandAllowed', '  private func takeOwnership');
const lateAllowed = swiftGuards('lateGestureOwnershipAllowed', '  private func followCommandAllowed');

function kotlinGuards(name, endMarker) {
  const start = android.indexOf(`private fun ${name}`);
  const end = android.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Kotlin ${name} must exist`);
  const conditions = [...android.slice(start, end).matchAll(/if \((.+?)\) return false/g)]
    .map(match => `!(${match[1].replace(/\bownershipEpoch\b|\breleasePending\b|\btouchActive\b|\bownershipFloor\b/g, field => `state.${field}`)})`);
  return new Function('state', 'value', 'gesture', 'nextEpoch',
    `return !!(${conditions.map(condition => `(${condition})`).join(' && ')});`);
}
const kotlinLate = kotlinGuards('lateGestureOwnershipAllowed', '  private fun emitRecapturedFollow');
const kotlinPhysical = kotlinGuards('followCommandAllowed', '  private fun takeOwnership');

function nativeHarness(generation) {
  return {
    generation,
    ownershipEpoch: 0,
    ownershipFloor: 0,
    touchActive: false,
    releasePending: false,
    releaseRecaptured: false,
    following: true,
  };
}
function beginTouch(native) {
  native.releasePending = false;
  native.releaseRecaptured = false;
  native.touchActive = true;
  native.ownershipFloor = Math.max(native.ownershipFloor, native.ownershipEpoch + 1);
}
function endTouch(native) { native.touchActive = false; }
function startRelease(native) {
  native.releasePending = true;
  native.releaseRecaptured = false;
  native.following = false;
}
function eventFor(native) {
  return { generation: native.generation, ownershipEpoch: native.ownershipEpoch };
}
function apply(native, command) {
  const late = lateAllowed(native, command.value, command.gesture, command.epoch, command.generation)
    && kotlinLate(native, command.value, command.gesture, command.epoch);
  if (late) {
    native.ownershipEpoch = command.epoch;
    return native.releaseRecaptured ? eventFor(native) : null;
  }
  if (!physicalAllowed(native, command.value, command.gesture, command.epoch, command.generation)
    || !kotlinPhysical(native, command.value, command.gesture, command.epoch)) return false;
  native.ownershipEpoch = command.epoch;
  if (command.value) native.ownershipFloor = Math.max(native.ownershipFloor, command.epoch);
  native.releasePending = false;
  native.releaseRecaptured = false;
  native.following = command.value;
  return true;
}
function finishRelease(native, resumed) {
  if (resumed) {
    native.following = true;
    native.releaseRecaptured = true;
    return eventFor(native);
  }
  native.releasePending = false;
  native.releaseRecaptured = false;
  return null;
}

// Production view with real gesture and follow ownership modules.
const preparation = buildSync({ entryPoints: [path.join(app, 'lib/rust-lyrics-preparation.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
  tsconfig: path.join(app, 'tsconfig.json') }).outputFiles[0].text;
const prepared = { exports: {} };
vm.runInNewContext(preparation, { module: prepared, exports: prepared.exports, require, Intl });
const timingSource = buildSync({ entryPoints: [path.join(app, 'lib/lyrics-timing.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
  tsconfig: path.join(app, 'tsconfig.json') }).outputFiles[0].text;
const timing = { exports: {} };
vm.runInNewContext(timingSource, { module: timing, exports: timing.exports, require, Intl });
const compiled = transformSync(fs.readFileSync(path.join(app, 'components/lyrics/rust/rust-lyrics-view.tsx'), 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
const jsx = (type, props) => ({ type, props: props || {} });
const gestureModule = require('../lib/rust-lyrics-gesture.js');
const followModule = require('../lib/rust-lyrics-follow.js');
const line = { lineStartTime: 0, lineEndTime: 1000, syllables: [{ text: 'Word', startTime: 0, endTime: 1000 }] };
let store;
let parentFollow = true;
const imports = {
  react: { memo: f => f, useMemo: f => f(), useCallback: f => f, useRef: current => ({ current }), useState: current => [current, () => {}], useEffect: () => {} },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', Platform: { OS: 'ios' }, AppState: {},
    StyleSheet: { create: x => x }, useWindowDimensions: () => ({ width: 390, height: 640 }),
    Linking: { openURL: () => Promise.resolve() }, PanResponder: { create: handlers => ({ panHandlers: handlers }) } },
  'expo-modules-core': { requireOptionalNativeModule: () => ({ abiVersion: () => 11, monotonicMs: () => 1000 }), requireNativeViewManager: () => 'NativeView' },
  '@/store/playback-store': { usePlaybackStore: Object.assign(select => select(store), { getState: () => store, subscribe: () => () => {} }) },
  '@/lib/rust-lyrics-protocol': require('../lib/rust-lyrics-protocol.js'),
  '@/lib/rust-lyrics-preparation': prepared.exports,
  '@/lib/rust-lyrics-follow': followModule,
  '@/lib/rust-lyrics-gesture': gestureModule,
  '@/constants/player-layout': { LANDSCAPE_FONT_SCALE: 0.8 },
  '@/lib/lyrics-timing': timing.exports,
  '@/lib/lyrics-arrival-trace': { arrivalHandle: () => undefined },
  './static-lyrics-view': { StaticLyricsView: 'StaticLyricsView' },
};
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: id => { assert.ok(imports[id], id); return imports[id]; }, __DEV__: true, performance, console });
const RustLyricsView = mod.exports.RustLyricsView;
function nodes(node) {
  if (node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
function flush() { return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve()); }

function createWiring(style = 'spicy') {
  store = {
    currentTrack: { id: 'track-a', durationMs: 240000 }, lyrics: [line], lyricsMetadata: {}, lyricsSource: '', lyricsStatusMessage: '',
    lyricsStyle: style, showTranslatedText: true, showRustDebugOverlay: false, anchorPositionMs: 0, anchorMonotonicMs: 0, isPlaying: false,
  };
  parentFollow = true;
  const rendered = nodes(RustLyricsView({ active: true, tapToSeekEnabled: true, autoFollowEnabled: true,
    onAutoFollowChange: enabled => { parentFollow = enabled; }, onUserInteraction: () => {}, resumeAutoFollowSignal: 0 }));
  const nativeView = rendered.find(node => node.type === 'NativeView');
  const pan = rendered.find(node => node.props?.onPanResponderGrant);
  assert.ok(nativeView && pan);
  const generation = JSON.parse(nativeView.props.trackJson).generation;
  const native = nativeHarness(generation);
  const commands = [];
  nativeView.props.ref.current = {
    setFollowing: (value, epoch, commandGeneration, gesture) => {
      commands.push({ value, epoch, generation: commandGeneration, gesture });
      return Promise.resolve();
    },
    hitTest: () => Promise.resolve(2), setAnchor: () => Promise.resolve(), scrollBy: () => Promise.resolve(), fling: () => Promise.resolve(),
  };
  const status = event => nativeView.props.onStatus({ nativeEvent: event });
  return {
    generation, native, commands, status,
    grant: () => pan.props.onPanResponderGrant({ nativeEvent: { locationX: 20, locationY: 80 } }),
    release: () => pan.props.onPanResponderRelease(),
    ready: () => status({ state: 'ready', generation, message: 'ready', ownershipEpoch: 0 }),
    follow: epoch => status({ state: 'follow', generation, ownershipEpoch: epoch, message: 'follow' }),
  };
}
function baseline(wiring) {
  wiring.ready();
  const command = wiring.commands.pop();
  assert.ok(command && command.value === true);
  assert.equal(apply(wiring.native, command), true);
}

for (const style of ['spicy', 'amll']) {
  // Delayed false arrives before the async near release completes.
  {
    const wiring = createWiring(style);
    baseline(wiring);
    beginTouch(wiring.native); wiring.grant();
    const delayedFalse = wiring.commands.pop();
    assert.equal(delayedFalse.value, false);
    assert.equal(delayedFalse.gesture, true);
    endTouch(wiring.native); startRelease(wiring.native);
    assert.equal(apply(wiring.native, delayedFalse), null, 'late false records without undoing pending recapture');
    const event = finishRelease(wiring.native, true);
    assert.equal(event.ownershipEpoch, delayedFalse.epoch, 'near release announces the current gesture epoch');
    wiring.follow(event.ownershipEpoch);
    assert.equal(parentFollow, true);
    assert.equal(wiring.native.following, true);
  }

  // The near event is emitted before the delayed false reaches native. The false
  // later re-announces the same recapture at the current gesture epoch.
  {
    const wiring = createWiring(style);
    baseline(wiring);
    beginTouch(wiring.native); wiring.grant();
    const delayedFalse = wiring.commands.pop();
    endTouch(wiring.native); startRelease(wiring.native);
    const oldEvent = finishRelease(wiring.native, true);
    wiring.follow(oldEvent.ownershipEpoch);
    assert.equal(parentFollow, false, 'pre-grant event is stale against the current JS epoch');
    const current = apply(wiring.native, delayedFalse);
    assert.equal(current.ownershipEpoch, delayedFalse.epoch);
    wiring.follow(current.ownershipEpoch);
    assert.equal(parentFollow, true, 're-announced current gesture epoch is accepted');
    assert.equal(wiring.native.releasePending, true, 'recapture remains reopenable for later late grants');
  }

  // The same near event is emitted before JS runs its grant at all. The grant's
  // delayed false must produce an eventual current-epoch acknowledgement.
  {
    const wiring = createWiring(style);
    baseline(wiring);
    beginTouch(wiring.native);
    endTouch(wiring.native); startRelease(wiring.native);
    const oldEvent = finishRelease(wiring.native, true);
    wiring.follow(oldEvent.ownershipEpoch);
    assert.equal(parentFollow, true);
    wiring.grant();
    const delayedFalse = wiring.commands.pop();
    const current = apply(wiring.native, delayedFalse);
    assert.equal(current.ownershipEpoch, delayedFalse.epoch);
    wiring.follow(current.ownershipEpoch);
    assert.equal(parentFollow, true, 'late JS grant catches up to the recaptured gesture');
    assert.equal(wiring.native.releasePending, true, 'recapture remains reopenable for later late grants');
  }

  // Two-touch handoff: A near completes while JS is blocked, B starts, then a
  // delayed A grant false arrives during B. A tagged boolean cannot carry this.
  // B near must later re-announce at the delayed B grant epoch, not disable.
  {
    const wiring = createWiring(style);
    baseline(wiring);
    beginTouch(wiring.native); endTouch(wiring.native);
    startRelease(wiring.native); finishRelease(wiring.native, true);

    beginTouch(wiring.native);
    wiring.grant();
    const delayedA = wiring.commands.pop();
    assert.equal(delayedA.value, false);
    assert.equal(apply(wiring.native, delayedA), true, 'delayed A grant takes manual ownership during B');
    assert.equal(wiring.native.ownershipEpoch, delayedA.epoch);

    endTouch(wiring.native); startRelease(wiring.native);
    const bNear = finishRelease(wiring.native, true);
    wiring.follow(bNear.ownershipEpoch);
    assert.equal(parentFollow, true);

    wiring.grant();
    const delayedB = wiring.commands.pop();
    assert.ok(delayedB.epoch > delayedA.epoch);
    const bAck = apply(wiring.native, delayedB);
    assert.equal(bAck.ownershipEpoch, delayedB.epoch, 'late B grant re-announces at the B epoch');
    wiring.follow(bAck.ownershipEpoch);
    assert.equal(parentFollow, true);
    assert.equal(wiring.native.following, true);
    assert.equal(wiring.native.ownershipEpoch, delayedB.epoch);
  }

  // Far release is not a recapture. The delayed false stays authoritative.
  {
    const wiring = createWiring(style);
    baseline(wiring);
    beginTouch(wiring.native); wiring.grant();
    const delayedFalse = wiring.commands.pop();
    endTouch(wiring.native); startRelease(wiring.native);
    assert.equal(apply(wiring.native, delayedFalse), null);
    assert.equal(finishRelease(wiring.native, false), null);
    assert.equal(parentFollow, false);
    assert.equal(wiring.native.following, false);
    assert.equal(wiring.native.releasePending, false);
  }

  // A delayed A recapture cannot reclaim follow after touch B owns the viewport.
  {
    const wiring = createWiring(style);
    baseline(wiring);
    beginTouch(wiring.native); wiring.grant();
    const aFalse = wiring.commands.pop();
    apply(wiring.native, aFalse);
    endTouch(wiring.native); startRelease(wiring.native);
    const aEvent = finishRelease(wiring.native, true);
    wiring.follow(aEvent.ownershipEpoch);
    assert.equal(parentFollow, true);

    beginTouch(wiring.native); wiring.grant();
    const bFalse = wiring.commands.pop();
    apply(wiring.native, bFalse);
    assert.equal(parentFollow, false);
    wiring.follow(aEvent.ownershipEpoch);
    assert.equal(parentFollow, false, 'stale A event is rejected after touch B');
    assert.equal(apply(wiring.native, aFalse), false, 'stale A command is rejected after touch B');
  }
}

// Track/generation recreation rejects old commands and stale events.
{
  const old = createWiring('spicy');
  baseline(old);
  beginTouch(old.native); old.grant();
  const oldFalse = old.commands.pop();
  const next = createWiring('amll');
  baseline(next);
  assert.equal(apply(next.native, oldFalse), false, 'old generation command cannot apply after recreation');
  parentFollow = false;
  next.follow(oldFalse.epoch);
  assert.equal(parentFollow, false, 'old generation event is ignored by the current view');
}

assert.match(swift, /lateGestureOwnershipAllowed\(value, gesture: gesture, nextEpoch: nextEpoch, identity: UInt64\(commandGeneration\)\)/);
assert.match(swift, /emitRecapturedFollow\(\)/);
assert.match(android, /lateGestureOwnershipAllowed\(value, gesture, nextEpoch\)/);
assert.match(android, /emitRecapturedFollow\(\)/);
assert.match(read('../components/lyrics/rust/rust-lyrics-view.tsx'), /issue\(enabled, followGeneration\.current, true\)/);
console.log('Rust follow wiring PASS: delayed false, late JS grant, far release, stale A/B and generation recreation across Spicy/AMLL.');
