/* Execute the production Rust view and gesture against native follow guards.
 * Exercise UIKit's delayed handoff and Android's ordered JS movement on both
 * styles. Evaluate the Swift/Kotlin guard expressions directly from source. */
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

function kotlinPredicate(pattern, fields) {
  const expression = android.match(pattern)?.[1];
  assert.ok(expression, String(pattern));
  const evaluate = new Function(...fields, 'return (' + expression.replaceAll('.toDouble()', '')
    .replace('epoch.isFinite()', 'Number.isFinite(epoch)') + ');');
  return values => evaluate(...fields.map(field => values[field]));
}
const wrongCommandTrack = kotlinPredicate(
  /fun advanceOwnership[^\n]*\n\s*if \((.+)\) return false/,
  ['commandGeneration', 'generation', 'epoch']);
const oldCommand = kotlinPredicate(/if \((nextEpoch <= ownershipEpoch)\) return false/,
  ['nextEpoch', 'ownershipEpoch']);
const ownsMovement = kotlinPredicate(/private fun ownsGesture[^\n]+=\s*([\s\S]+?)\n\n/,
  ['attached', 'failed', 'gestureEpoch', 'epoch', 'commandGeneration', 'generation']);
const currentRelease = kotlinPredicate(/if \((session == releaseSession[\s\S]+?)\) \{/,
  ['session', 'releaseSession', 'generation', 'releaseGeneration', 'ownershipEpoch', 'releaseEpoch', 'releasePending', 'failed']);

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
  const late = lateAllowed(native, command.value, command.gesture, command.epoch, command.generation);
  if (late) {
    native.ownershipEpoch = command.epoch;
    return native.releaseRecaptured ? eventFor(native) : null;
  }
  if (!physicalAllowed(native, command.value, command.gesture, command.epoch, command.generation)) return false;
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
let hooks = [];
let hookIndex = 0;
let layoutEffects = [];
const react = {
  memo: fn => fn,
  useMemo(fn, deps) {
    const index = hookIndex++;
    const previous = hooks[index];
    if (!previous || !deps || previous.deps?.length !== deps.length ||
      deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      hooks[index] = { value: fn(), deps };
    }
    return hooks[index].value;
  },
  useCallback: fn => fn,
  useRef(current) { return hooks[hookIndex++] ??= { current }; },
  useState(initial) {
    const slot = hooks[hookIndex++] ??= { value: initial };
    return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
  },
  useEffect: () => {},
  useLayoutEffect(effect, deps) {
    const index = hookIndex++;
    const previous = hooks[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      layoutEffects.push(() => {
        previous?.cleanup?.();
        hooks[index] = { deps, cleanup: effect() };
      });
    }
  },
};
const imports = {
  react,
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
  '@/lib/rust-frame-trace': {},
  './static-lyrics-view': { StaticLyricsView: 'StaticLyricsView' },
  './rust-fps-overlay': { RustFpsOverlay: 'RustFpsOverlay' },
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

function createWiring(style = 'spicy', platform = 'ios') {
  imports['react-native'].Platform.OS = platform;
  store = {
    currentTrack: { id: 'track-a', durationMs: 240000 }, lyrics: [line], lyricsMetadata: {}, lyricsSource: '', lyricsStatusMessage: '',
    lyricsStyle: style, showTranslatedText: true, showRustDebugOverlay: false, anchorPositionMs: 0, anchorMonotonicMs: 0, isPlaying: false,
  };
  parentFollow = true;
  hooks = [];
  let reveal = false;
  const presses = [];
  const props = { active: true, tapToSeekEnabled: true, autoFollowEnabled: true,
    shouldRevealTap: () => reveal, onLinePress: line => presses.push(line),
    onAutoFollowChange: enabled => { parentFollow = enabled; }, onUserInteraction: () => {}, resumeAutoFollowSignal: 0 };
  const render = () => {
    hookIndex = 0;
    layoutEffects = [];
    const rendered = nodes(RustLyricsView(props));
    for (const applyEffect of layoutEffects) applyEffect();
    return rendered;
  };
  const findPan = rendered => rendered.find(node => node.props?.onPanResponderGrant);
  const rendered = render();
  const nativeView = rendered.find(node => node.type === 'NativeView');
  assert.ok(nativeView);
  assert.equal(findPan(rendered), undefined, 'gestures wait for native readiness');
  let pan;
  const generation = JSON.parse(nativeView.props.trackJson).generation;
  const native = nativeHarness(generation);
  const commands = [];
  const anchors = [];
  const bridge = [];
  nativeView.props.ref.current = {
    setFollowing: (value, epoch, commandGeneration, gesture) => {
      const command = { value, epoch, generation: commandGeneration, gesture };
      commands.push(command);
      bridge.push({ name: 'follow', ...command });
      return Promise.resolve();
    },
    reserveTouchEpoch: (value, epoch, generation) => {
      bridge.push({ name: 'reserve', value, epoch, generation });
      return Promise.resolve();
    },
    hitTest: () => Promise.resolve(0),
    setAnchor: json => { anchors.push(JSON.parse(json)); return Promise.resolve(); },
    scrollBy: (delta, epoch, generation) => {
      bridge.push({ name: 'scroll', delta, epoch, generation });
      return Promise.resolve();
    },
    fling: (velocity, epoch, generation) => {
      bridge.push({ name: 'fling', velocity, epoch, generation });
      return Promise.resolve();
    },
  };
  const status = event => nativeView.props.onStatus({ nativeEvent: event });
  return {
    generation, native, commands, status, anchors, bridge, presses,
    setReveal: value => { reveal = value; },
    deactivate: () => {
      props.active = false;
      assert.equal(findPan(render()), undefined, 'inactive surfaces lose the responder');
    },
    readyReplacement: () => {
      const next = render().find(node => node.type === 'NativeView');
      const nextGeneration = JSON.parse(next.props.trackJson).generation;
      next.props.onStatus({ nativeEvent: { state: 'ready', generation: nextGeneration, message: 'ready', ownershipEpoch: 0 } });
      assert.equal(anchors.at(-1).generation, nextGeneration);
      return anchors.at(-1);
    },
    grant: () => pan.props.onPanResponderGrant({ nativeEvent: { locationX: 20, locationY: 80, pageY: 80 } }),
    move: (dy, dx = 0) => pan.props.onPanResponderMove(null, { dy, dx }),
    release: () => pan.props.onPanResponderRelease(),
    terminate: () => pan.props.onPanResponderTerminate(),
    ready: () => {
      status({ state: 'ready', generation: generation - 1, message: 'stale ready', ownershipEpoch: 0 });
      assert.equal(findPan(render()), undefined, 'a stale ready event cannot enable gestures');
      status({ state: 'ready', generation, message: 'ready', ownershipEpoch: 0 });
      const ready = render();
      assert.equal(JSON.parse(ready.find(node => node.type === 'NativeView').props.trackJson).generation, generation);
      pan = findPan(ready);
      assert.ok(pan, 'the ready surface accepts gestures');
      assert.equal(pan.props.onShouldBlockNativeResponder(), true);
    },
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

// Packet generations and playback discontinuities are independent.
for (const style of ['amll', 'spicy']) {
  const wiring = createWiring(style);
  baseline(wiring);
  assert.equal(wiring.anchors.at(-1).snap, true);
  store.showTranslatedText = false;
  const refreshed = wiring.readyReplacement();
  assert.notEqual(refreshed.generation, wiring.generation);
  assert.equal(refreshed.snap, style === 'spicy');
  store.anchorPositionMs = 2000;
  store.lyricsMetadata = { credits: { songwriters: ['Writer'] } };
  assert.equal(wiring.readyReplacement().snap, true, 'a simultaneous seek must still snap');
  store.currentTrack = { ...store.currentTrack, id: 'track-b' };
  assert.equal(wiring.readyReplacement().snap, true, 'a different track must still snap');
}

// UIKit remains the only movement path on iOS, including termination.
{
  const wiring = createWiring();
  baseline(wiring);
  wiring.grant(); wiring.move(-30); wiring.release();
  wiring.grant(); wiring.move(40); wiring.terminate();
  assert.deepEqual(wiring.bridge.map(command => command.name), ['follow', 'follow', 'follow']);
}

// The harness models native state updates and injects Rust's release result.
// The source predicates above determine which commands/results may apply.
function androidWiring(style) {
  const wiring = createWiring(style, 'android');
  const state = {
    generation: wiring.generation, session: 1, attached: true, failed: false,
    following: true, ownershipEpoch: 0, gestureEpoch: -1, dragging: false, releasePending: false,
  };
  function apply(command) {
    const { epoch, generation: commandGeneration } = command;
    if (command.name === 'follow' || command.name === 'reserve') {
      if (wrongCommandTrack({ ...state, commandGeneration, epoch }) ||
          oldCommand({ ...state, nextEpoch: epoch })) return false;
      state.ownershipEpoch = epoch;
      state.gestureEpoch = command.gesture && !command.value ? epoch : -1;
      state.dragging = false;
      state.releasePending = false;
      state.following = command.value;
      return true;
    }
    if (!ownsMovement({ ...state, epoch, commandGeneration })) return false;
    if (command.name === 'scroll') {
      state.dragging = true;
      return true;
    }
    assert.equal(command.name, 'fling');
    if (!state.dragging) return false;
    state.dragging = false;
    state.gestureEpoch = -1;
    state.releasePending = true;
    const { session: releaseSession, generation: releaseGeneration, ownershipEpoch: releaseEpoch } = state;
    return resumed => {
      if (!currentRelease({ ...state, releaseSession, releaseGeneration, releaseEpoch })) return false;
      state.releasePending = false;
      if (resumed) {
        state.following = true;
        wiring.follow(releaseEpoch);
      }
      return true;
    };
  }
  wiring.ready();
  assert.equal(apply(wiring.bridge.shift()), true);
  return { ...wiring, state, apply };
}

for (const style of ['spicy', 'amll']) {
  for (const [dy, resumed] of [[-45, true], [45, false]]) {
    const wiring = androidWiring(style);
    wiring.grant(); wiring.move(dy / 20); wiring.move(dy / 3); wiring.move(dy); wiring.release(); wiring.release();
    const [grant, first, second, release] = wiring.bridge;
    assert.deepEqual(wiring.bridge.map(command => command.name), ['follow', 'scroll', 'scroll', 'fling']);
    assert.equal(grant.value, false, 'touch-down takes follow ownership before the first delta');
    assert.equal(grant.gesture, true);
    assert.equal(first.delta, -dy / 3, 'first delta includes the travel across slop');
    assert.equal(first.delta + second.delta, -dy, 'forward exactly one logical delta per move with the right sign');
    assert.equal(Math.sign(release.velocity), -Math.sign(dy));
    assert.ok(wiring.bridge.every(command => command.epoch === grant.epoch && command.generation === wiring.generation));
    assert.equal(parentFollow, false);
    assert.equal(wiring.apply(first), false, 'movement cannot precede its grant');
    assert.equal(wiring.apply(grant), true);
    assert.equal(wiring.apply({ ...first, generation: first.generation - 1 }), false, 'old generation delta cannot move this track');
    assert.equal(wiring.apply(release), false, 'a release requires a native delta');
    assert.equal(wiring.apply(first), true);
    assert.equal(wiring.apply(second), true);
    const finish = wiring.apply(release);
    assert.equal(wiring.apply(release), false, 'duplicate release cannot reopen the gesture');
    assert.equal(wiring.apply(first), false, 'last delta cannot reopen the released gesture');
    assert.equal(finish(resumed), true);
    assert.equal(finish(true), false, 'the result can be consumed only once');
    assert.equal(wiring.state.following, resumed);
    assert.equal(parentFollow, resumed, 'only a current native recapture resumes JS follow');
  }

  for (const end of ['terminate', 'deactivate', 'grant']) {
    const wiring = androidWiring(style);
    wiring.grant(); wiring.move(-25); wiring[end]();
    if (end !== 'grant') wiring.release();
    const [grant, delta, cancel, next] = wiring.bridge;
    assert.deepEqual(wiring.bridge.map(command => command.name),
      end === 'grant' ? ['follow', 'scroll', 'fling', 'follow'] : ['follow', 'scroll', 'fling']);
    assert.equal(cancel.velocity, 0, end + ' settles the previous drag without inertia');
    assert.equal(cancel.epoch, grant.epoch);
    assert.equal(wiring.apply(grant), true);
    assert.equal(wiring.apply(delta), true);
    const finish = wiring.apply(cancel);
    if (next) {
      assert.ok(next.epoch > cancel.epoch);
      assert.equal(wiring.apply(next), true);
      assert.equal(finish(true), false, 'a replacement grant supersedes cancellation recapture');
    } else {
      assert.equal(finish(true), true, 'a current zero-velocity release can recapture');
    }
    assert.deepEqual(wiring.presses, []);
  }

  for (const supersede of ['grant', 'reveal', 'resume', 'track', 'surface', 'error']) {
    const wiring = androidWiring(style);
    wiring.grant(); wiring.move(-30); wiring.release();
    const [grant, delta, release] = wiring.bridge.splice(0);
    wiring.apply(grant); wiring.apply(delta);
    const finish = wiring.apply(release);
    if (supersede === 'grant' || supersede === 'reveal') {
      wiring.setReveal(supersede === 'reveal');
      wiring.grant();
      // Drop the delivered event before letting the corresponding new native
      // command arrive. JS has advanced its ownership epoch independently.
      wiring.follow(release.epoch);
      assert.equal(parentFollow, false);
      const [next] = wiring.bridge;
      assert.equal(next.name, supersede === 'reveal' ? 'reserve' : 'follow');
      assert.equal(next.value, false, 'reveal preserves the existing manual intent');
      assert.equal(wiring.apply(next), true);
      wiring.terminate();
      assert.equal(wiring.bridge.length, 1, 'an unmoved cancellation has no native motion');
    } else if (supersede === 'resume') {
      assert.equal(wiring.apply({ ...grant, epoch: grant.epoch + 1, gesture: false, value: true }), true);
    } else if (supersede === 'track') {
      wiring.state.generation++;
    } else if (supersede === 'surface') {
      wiring.state.session++;
    } else {
      wiring.state.failed = true;
    }
    assert.equal(finish(true), false, supersede + ' invalidates a pending release');
    assert.equal(wiring.apply(delta), false);
    assert.equal(wiring.apply(grant), false);
    assert.equal(parentFollow, false);
  }

  // Replacing the packet cancels the old JS drag even on the same track.
  {
    const wiring = androidWiring(style);
    wiring.grant(); wiring.move(-35);
    store.showTranslatedText = false;
    assert.notEqual(wiring.readyReplacement().generation, wiring.generation);
    wiring.move(-45); wiring.release();
    assert.deepEqual(wiring.bridge.map(command => command.name), ['follow', 'scroll', 'follow']);
  }
}

assert.match(swift, /lateGestureOwnershipAllowed\(value, gesture: gesture, nextEpoch: nextEpoch, identity: UInt64\(commandGeneration\)\)/);
assert.match(swift, /emitRecapturedFollow\(\)/);
assert.match(android, /val releaseMayHaveChangedFollow = releasePending \|\| following != value\s*clearGesture\(\)[\s\S]*?if \(releaseMayHaveChangedFollow\) \{\s*following = value\s*owner\?\.setFollowing\(value\)/);
assert.match(read('../components/lyrics/rust/rust-lyrics-view.tsx'), /issue\(enabled, followGeneration\.current, true\)/);

(async () => {
  // A row tap restores follow and seeks without sending drag commands.
  const wiring = androidWiring('spicy');
  wiring.grant(); wiring.release();
  await flush();
  assert.deepEqual(wiring.bridge.map(command => command.name), ['follow', 'follow']);
  assert.deepEqual(wiring.bridge.map(command => command.value), [false, true]);
  assert.equal(wiring.presses.length, 1);

  const reveal = androidWiring('spicy');
  reveal.setReveal(true);
  reveal.grant(); reveal.release();
  assert.deepEqual(reveal.bridge.map(command => command.name), ['reserve']);
  assert.equal(reveal.bridge[0].value, true);
  assert.equal(parentFollow, true);
  assert.deepEqual(reveal.presses, []);
  reveal.bridge.length = 0;
  reveal.grant(); reveal.move(15); reveal.terminate();
  const [reservation, promotion, delta, cancel] = reveal.bridge;
  assert.deepEqual(reveal.bridge.map(command => command.name), ['reserve', 'follow', 'scroll', 'fling']);
  assert.ok(promotion.epoch > reservation.epoch, 'reveal drag takes ownership only after crossing slop');
  assert.equal(delta.delta, -15);
  assert.equal(delta.epoch, promotion.epoch);
  assert.equal(cancel.velocity, 0);

  const staleTap = androidWiring('amll');
  staleTap.grant(); staleTap.release();
  store.showTranslatedText = false;
  assert.notEqual(staleTap.readyReplacement().generation, staleTap.generation);
  await flush();
  assert.deepEqual(staleTap.presses, [], 'an old async hit cannot seek after a packet replacement');
  assert.deepEqual(staleTap.bridge.map(command => command.value), [false, false]);
  console.log('Rust follow wiring PASS: UIKit handoff, Android movement and cancellation, and stale ownership across Spicy/AMLL.');
})().catch(error => { console.error(error); process.exitCode = 1; });
