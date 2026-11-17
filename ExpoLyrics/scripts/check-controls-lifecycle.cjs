const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app/(tabs)/index.tsx'), 'utf8');
const ast = ts.createSourceFile('player.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = {};
let screen, dock;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations[node.name.text] = node.initializer;
  if (ts.isJsxOpeningElement(node)) {
    if (node.attributes.getText(ast).includes('style={styles.screen}')) screen = node;
    if (node.attributes.getText(ast).includes('style={styles.controlsWrap}')) dock = node;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const js = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const evaluate = (code, context) => vm.runInNewContext(js(`(${code})`), context);
const moduleContext = { exports: {} };
vm.runInNewContext(js(fs.readFileSync(path.join(root, 'lib/controls-motion.ts'), 'utf8')), moduleContext);
const { controlsAppIsForeground, controlsShowEdge } = moduleContext.exports;
const hookSource = source.slice(source.indexOf('  const clearControlsIdleTimer ='), source.indexOf('  const sendSeekToPlaybackSource ='));
const screenHandler = name => screen.attributes.properties.find(p => p.name?.text === name).initializer.expression.getText(ast);
const sameDeps = (a, b) => a && a.length === b.length && b.every((value, index) => Object.is(value, a[index]));

// Run the production hook block through dependency-aware effect setup/cleanup
// and a deterministic JS timer queue. This does not emulate UIKit or Reanimated.
function mount(initialAppState = 'active', overrides = {}) {
  const state = {
    controlsVisible: true, controlsInteractive: true, liveReducedMotion: false, isLandscape: false,
    fullscreenAlbumMode: false, autoHidePlaybackControls: true,
    landscapeArtControlsVisible: false, tourAutoHideDemo: false,
    tour: { active: false }, scrubPreviewPositionMs: null, ...overrides,
  };
  let dirty = false, cursor = 0, pending = [], now = 0, timerId = 0, api;
  let subscriptions = 0, hidden = 0;
  const hooks = [], timers = new Map(), listeners = new Set();
  const ref = current => ({ current });
  const foregroundInitializer = declarations.controlsForeground?.arguments[0].getText(ast);
  const initialForeground = foregroundInitializer
    ? evaluate(foregroundInitializer, { controlsAppIsForeground, AppState: { currentState: initialAppState } })
    : true; // The prior candidate had no foreground guard.
  const progress = { current: 1, get() { return this.current; }, get value() { return this.current; }, set value(value) { this.current = value; } };
  const context = {
    Math, controlsAppIsForeground, controlsShowEdge,
    controlsForeground: ref(initialForeground),
    controlsTouchActive: ref(false), controlsScrubActive: ref(false),
    controlsOpacity: progress,
    controlsStageProgress: { current: 1, get() { return this.current; }, set value(value) { this.current = value; } },
    controlsTarget: { current: 1, get() { return this.current; }, set(value) { this.current = value; if (!value) hidden++; } },
    controlsIdleTimerRef: ref(null), scheduleControlsHideRef: ref(() => {}), showControlsRef: ref(() => {}),
    isLandscapeRef: ref(state.isLandscape), fullscreenAlbumModeRef: ref(false),
    autoHidePlaybackControlsRef: ref(true), landscapeArtControlsVisibleRef: ref(false),
    CONTROLS_IDLE_TIMEOUT_MS: 2500, CONTROLS_EASE: 'configured cubic', ReanimatedEasing: { linear: 'linear' },
    nativePlaybackUnavailable: () => false,
    setScrubPreviewPositionMs: value => set('scrubPreviewPositionMs', value),
    setControlsVisible: value => set('controlsVisible', value),
    setControlsInteractive: value => set('controlsInteractive', value),
    setLandscapeArtControlsVisible: value => set('landscapeArtControlsVisible', value),
    cancelAnimation: () => {}, withTiming: target => target, withDelay: (_delay, animation) => animation,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, time: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    AppState: { addEventListener: (name, listener) => {
      assert.equal(name, 'change'); subscriptions++; listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    } },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { callback, deps };
      return hooks[index].callback;
    },
    useEffect(create, deps) {
      const index = cursor++;
      if (!sameDeps(hooks[index]?.deps, deps)) {
        pending.push({ index, create, cleanup: hooks[index]?.cleanup });
        hooks[index] = { deps };
      }
    },
  };
  function set(key, value) {
    if (!Object.is(state[key], value)) { state[key] = value; dirty = true; }
  }
  const render = evaluate(`props => {
    const { controlsVisible, liveReducedMotion, isLandscape, fullscreenAlbumMode,
      autoHidePlaybackControls, landscapeArtControlsVisible, tourAutoHideDemo,
      tour, scrubPreviewPositionMs } = props;
    ${hookSource}
    return { scheduleControlsHide, handleControlsInteraction, showControls, hideControls, clearControlsIdleTimer };
  }`, context);
  function flush() {
    let iterations = 0;
    do {
      assert.ok(iterations++ < 20, 'effects must settle');
      dirty = false; cursor = 0; pending = [];
      context.isLandscapeRef.current = state.isLandscape;
      context.fullscreenAlbumModeRef.current = state.fullscreenAlbumMode;
      context.autoHidePlaybackControlsRef.current = state.autoHidePlaybackControls;
      context.landscapeArtControlsVisibleRef.current = state.landscapeArtControlsVisible;
      api = render({ ...state });
      Object.assign(context, api);
      pending.forEach(effect => effect.cleanup?.());
      pending.forEach(effect => { hooks[effect.index].cleanup = effect.create(); });
    } while (dirty);
  }
  flush();
  return {
    state, context, timers,
    get hidden() { return hidden; }, get subscriptions() { return subscriptions; },
    get interactionCallback() { return api.handleControlsInteraction; },
    change(patch) { Object.assign(state, patch); flush(); },
    touch(name, touches = []) {
      evaluate(screenHandler(name), context)({ nativeEvent: { touches } }); flush();
    },
    scrub(value) {
      evaluate(declarations.handleScrubPreview.arguments[0].getText(ast), context)(value); flush();
    },
    interact() { api.handleControlsInteraction(); flush(); },
    app(value) { [...listeners].forEach(listener => listener(value)); flush(); },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].time - b[1].time)[0];
        if (!next || next[1].time > end) break;
        now = next[1].time; timers.delete(next[0]); next[1].callback(); flush();
      }
      now = end;
    },
    unmount() { hooks.forEach(hook => hook.cleanup?.()); assert.equal(listeners.size, 0); },
  };
}

// Visibility requests update touch and accessibility eligibility in the same
// render, without waiting for either motion clock or an animation completion.
const immediate = mount();
immediate.tick(2500);
assert.equal(immediate.state.controlsVisible, false);
assert.equal(immediate.state.controlsInteractive, false);
immediate.interact();
assert.equal(immediate.state.controlsVisible, true);
assert.equal(immediate.state.controlsInteractive, true);
immediate.unmount();

// Hidden lyric interactions retain the renderer's action and reveal callback.
// The screen's raw touch bookkeeping must not consume or pre-empt that action.
const hiddenLyrics = mount();
hiddenLyrics.tick(2500);
assert.equal(hiddenLyrics.state.controlsVisible, false);
hiddenLyrics.touch('onTouchStart');
assert.equal(hiddenLyrics.state.controlsVisible, false, 'raw touch does not steal a hidden lyric interaction');
hiddenLyrics.interact();
assert.equal(hiddenLyrics.state.controlsVisible, true, 'the lyric renderer callback reveals controls');
assert.equal(hiddenLyrics.state.controlsInteractive, true);
hiddenLyrics.touch('onTouchEnd'); hiddenLyrics.tick(2500);
assert.equal(hiddenLyrics.state.controlsVisible, false);
hiddenLyrics.change({ liveReducedMotion: true }); hiddenLyrics.interact();
assert.equal(hiddenLyrics.state.controlsVisible, true, 'hidden lyric interaction also reveals with reduced motion');
hiddenLyrics.unmount();

for (const landscape of [false, true]) for (const terminal of ['onTouchEnd', 'onTouchCancel']) {
  const player = mount('active', { isLandscape: landscape, landscapeArtControlsVisible: landscape });
  player.touch('onTouchStart');
  player.scrub(1234);
  const originalInteraction = player.interactionCallback;
  player.change({ liveReducedMotion: true });
  player.change({ landscapeArtControlsVisible: false });
  player.change({ landscapeArtControlsVisible: true, liveReducedMotion: false });
  player.change({ autoHidePlaybackControls: false });
  player.change({ autoHidePlaybackControls: true });
  assert.equal(player.context.controlsTouchActive.current, true);
  assert.equal(player.context.controlsScrubActive.current, true);
  assert.equal(player.state.scrubPreviewPositionMs, 1234, 'dependency changes cannot cancel a scrub');
  assert.equal(player.interactionCallback, originalInteraction, 'motion policy cannot recreate the scrub gesture through onUserInteraction');
  assert.equal(player.subscriptions, 1, 'callback churn cannot resubscribe lifecycle listener');
  player.tick(12000);
  assert.equal(player.timers.size, 0, 'touch and scrub pause idle through dependency changes');
  player.touch(terminal);
  player.tick(4000);
  assert.equal(player.timers.size, 0, 'touch finalization cannot end a still-active scrub');
  player.scrub(null);
  assert.equal(player.timers.size, 1, 'scrub end re-arms after root touch finalization');
  player.tick(2499);
  assert.equal(landscape ? player.state.landscapeArtControlsVisible : player.state.controlsVisible, true);
  player.tick(1);
  assert.equal(landscape ? player.state.landscapeArtControlsVisible : player.state.controlsVisible, false);
  player.unmount();
}
for (const terminal of ['onTouchEnd', 'onTouchCancel']) {
  const player = mount();
  player.touch('onTouchStart');
  player.scrub(500);
  player.scrub(null);
  assert.equal(player.timers.size, 0, 'scrub end retains remaining raw touch ownership');
  player.touch(terminal);
  assert.equal(player.timers.size, 1);
  player.unmount();
}
for (const label of ['previous long hold', 'next long hold']) for (const terminal of ['onTouchEnd', 'onTouchCancel']) {
  const player = mount();
  const queuedTimeout = [...player.timers.values()][0].callback;
  player.touch('onTouchStart');
  player.change({ liveReducedMotion: true });
  queuedTimeout();
  for (let i = 0; i < 12; i++) { player.tick(1000); player.interact(); }
  assert.equal(player.timers.size, 0, `${label} has no arbitrary hold timeout`);
  assert.equal(player.hidden, 0, 'even a queued obsolete timeout respects current ownership');
  player.touch(terminal, [{}]);
  assert.equal(player.timers.size, 0, 'second finger retains ownership after partial release or cancellation');
  player.touch(terminal);
  assert.equal(player.timers.size, 1);
  player.tick(2500);
  assert.equal(player.state.controlsVisible, false);
  player.unmount();
}
for (const initial of [null, 'unknown', 'active']) {
  const player = mount(initial);
  assert.equal(player.timers.size, 1, `initial ${initial} cannot strand timer without a change event`);
  player.tick(2500);
  assert.equal(player.state.controlsVisible, false);
  player.unmount();
}
for (const initial of ['background', 'inactive']) {
  const player = mount(initial);
  assert.equal(player.timers.size, 0);
  player.app('active');
  assert.equal(player.timers.size, 1);
  player.touch('onTouchStart'); player.scrub(500);
  player.app('background');
  assert.equal(player.context.controlsTouchActive.current, false);
  assert.equal(player.context.controlsScrubActive.current, false);
  assert.equal(player.state.scrubPreviewPositionMs, null);
  assert.equal(player.timers.size, 0, 'preview reset in background cannot arm idle');
  player.app('active');
  assert.equal(player.timers.size, 1);
  player.unmount();
}
// A foreground notification resolving initial unknown state is not a loss of ownership.
const discovering = mount(null);
discovering.touch('onTouchStart'); discovering.scrub(123);
discovering.app('active');
assert.equal(discovering.state.scrubPreviewPositionMs, 123);
assert.equal(discovering.context.controlsTouchActive.current, true);
assert.equal(discovering.timers.size, 0);
discovering.unmount();
// Superseded timers cannot hide early after policy reruns or release.
for (const landscape of [false, true]) {
  const renewed = mount('active', { isLandscape: landscape, landscapeArtControlsVisible: landscape });
  const stale = [...renewed.timers.values()][0].callback;
  renewed.touch('onTouchStart'); renewed.tick(1000); renewed.touch('onTouchEnd');
  stale();
  assert.equal(landscape ? renewed.state.landscapeArtControlsVisible : renewed.state.controlsVisible, true);
  assert.equal(renewed.timers.size, 1);
  renewed.tick(2499);
  assert.equal(landscape ? renewed.state.landscapeArtControlsVisible : renewed.state.controlsVisible, true);
  renewed.tick(1);
  assert.equal(landscape ? renewed.state.landscapeArtControlsVisible : renewed.state.controlsVisible, false);
  renewed.unmount();
}
// A mode change must re-arm even when preview was already null (no state update).
const touring = mount();
touring.tick(1000);
touring.change({ tour: { active: true } });
assert.equal(touring.timers.size, 1, 'tour transition cannot clear idle without re-arming');
touring.tick(2499);
assert.equal(touring.state.controlsVisible, true);
touring.tick(1);
assert.equal(touring.state.controlsVisible, false);
touring.unmount();
const player = mount();
player.touch('onTouchStart'); player.scrub(999);
player.change({ fullscreenAlbumMode: true });
assert.equal(player.context.controlsTouchActive.current, false);
assert.equal(player.context.controlsScrubActive.current, false);
assert.equal(player.state.scrubPreviewPositionMs, null);
assert.equal(player.timers.size, 0);
player.change({ fullscreenAlbumMode: false });
assert.equal(player.timers.size, 1);
player.touch('onTouchStart'); player.scrub(999);
player.change({ isLandscape: true });
assert.equal(player.state.scrubPreviewPositionMs, null);
assert.equal(player.context.controlsTouchActive.current, false);
player.change({ isLandscape: false });
player.touch('onTouchStart'); player.scrub(999);
player.change({ tour: { active: true } });
assert.equal(player.state.scrubPreviewPositionMs, null);
player.touch('onTouchStart'); player.scrub(500);
player.unmount();
assert.equal(player.timers.size, 0);
assert.equal(player.context.controlsTouchActive.current, false);
assert.equal(player.context.controlsScrubActive.current, false);
console.log('Controls lifecycle checks passed: production hook dependencies and effect cleanup, scrub/hold ownership, both release orders, cancellation, mode transitions, lifecycle and unknown initial AppState. JS policy only, not native event delivery.');
