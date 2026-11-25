/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

function interpolate(value, input, output) {
  if (value <= input[0]) return output[0];
  for (let index = 1; index < input.length; index++) {
    if (value <= input[index]) {
      const ratio = (value - input[index - 1]) / (input[index] - input[index - 1]);
      return output[index - 1] + ratio * (output[index] - output[index - 1]);
    }
  }
  return output.at(-1);
}

function load(file, mocks, globals, source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')) {
  const scope = { exports: {}, require: name => { assert.ok(name in mocks, name); return mocks[name]; }, ...globals };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, scope);
  return scope.exports;
}

function hookHarness() {
  const slots = [];
  let cursor, pending, mounted = true, dirty = true;
  const effect = (callback, deps) => {
    const slot = slots[cursor++] ??= {};
    if (slot.deps?.every((value, index) => Object.is(value, deps[index]))) return;
    pending.push(() => {
      slot.cleanup?.();
      slot.deps = deps;
      slot.callback = callback;
      slot.cleanup = callback();
    });
  };
  return {
    react: {
      ...React,
      useState(initial) {
        const slot = slots[cursor++] ??= { value: initial };
        return [slot.value, update => {
          assert.ok(mounted, 'no state updates after unmount');
          const next = typeof update === 'function' ? update(slot.value) : update;
          if (!Object.is(slot.value, next)) {
            slot.value = next;
            dirty = true;
          }
        }];
      },
      useRef: initial => slots[cursor++] ??= { current: initial },
      useEffect: effect,
      useLayoutEffect: effect,
      useCallback: callback => callback,
    },
    render(component, props, beforeEffects) {
      let tree;
      do {
        dirty = false;
        cursor = 0;
        pending = [];
        tree = component(props);
        beforeEffects?.(tree);
        beforeEffects = undefined;
        pending.forEach(run => run());
      } while (dirty);
      return tree;
    },
    replayEffects(between) {
      const effects = slots.filter(slot => slot.callback);
      effects.forEach(slot => slot.cleanup?.());
      between();
      effects.forEach(slot => { slot.cleanup = slot.callback(); });
    },
    unmount() {
      mounted = false;
      slots.forEach(slot => slot.cleanup?.());
    },
  };
}

function timerHarness() {
  let now = 0, nextId = 0;
  const events = new Map();
  return {
    setTimeout(callback, delay) {
      const id = ++nextId;
      events.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: id => events.delete(id),
    advance(ms) {
      const end = now + ms;
      while (events.size) {
        const [id, event] = [...events].sort((a, b) => a[1].at - b[1].at)[0];
        if (event.at > end) break;
        events.delete(id);
        now = event.at;
        event.callback();
      }
      now = end;
    },
    get pending() { return events.size; },
  };
}

function launchHarness({ os = 'android', reduceMotion = false, width = 390, height = 844, splashFailures = 0, beforeEffects, source } = {}) {
  const hooks = hookHarness();
  const timers = timerHarness();
  const values = [], styles = [], completions = [], warnings = [];
  const calls = { hide: 0, cancel: 0, reload: 0 };
  let valueIndex, styleIndex;
  const { LaunchTransition, launchTiming } = load('components/ui/launch-transition.tsx', {
    react: hooks.react,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': {
      Platform: { OS: os }, Text: 'Text', View: 'View', Pressable: 'Pressable',
      StyleSheet: { create: value => value, absoluteFill: {} }, useWindowDimensions: () => ({ width, height }),
    },
    expo: { reloadAppAsync: async () => { calls.reload++; } },
    'expo-splash-screen': {
      preventAutoHideAsync: () => Promise.resolve(),
      hideAsync: async () => { calls.hide++; },
      hide: () => {
        if (++calls.hide <= splashFailures) throw Error('native hide failed');
      },
    },
    'react-native-reanimated': {
      __esModule: true, default: { View: 'AnimatedView' }, useReducedMotion: () => reduceMotion,
      useSharedValue: value => values[valueIndex++] ??= { value },
      useAnimatedStyle: callback => { styles[styleIndex++] = callback; return { animatedStyle: callback }; },
      interpolate, Extrapolation: { CLAMP: 'clamp' },
      Easing: { linear: 'linear', back: () => 'back', cubic: 'cubic', in: value => value, out: value => value },
      withTiming: (value, _, complete) => { if (complete) completions.push(complete); return value; },
      withDelay: (_, animation) => animation,
      withSequence: (...animations) => animations.at(-1),
      withSpring: value => value,
      cancelAnimation: () => { calls.cancel++; },
      runOnJS: callback => callback,
    },
    '@/constants/design': { Design: { background: '#090C13' }, Motion: {} },
    './launch-visibility': { LaunchVisibilityContext: { Provider: 'VisibilityProvider' } },
  }, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    console: { warn: message => warnings.push(message) },
  }, source);
  let tree, ready = false;
  const render = (nextReady = ready, beforeCommitEffects) => {
    ready = nextReady;
    tree = hooks.render(props => {
      valueIndex = styleIndex = 0;
      return LaunchTransition(props);
    }, { ready, children: 'App' }, beforeCommitEffects);
  };
  const nativeLayout = (width, height) => ({ nativeEvent: { layout: { width, height } } });
  const find = (element, predicate) => {
    if (!element?.props) return;
    if (predicate(element.props)) return element;
    for (const child of React.Children.toArray(element.props.children)) {
      const match = find(child, predicate);
      if (match) return match;
    }
  };
  const wordmark = () => {
    const element = find(tree, props => props.onMetrics);
    return element.type(element.props);
  };
  const launch = {
    render, timers, values, styles, timing: launchTiming, calls, completions, warnings,
    unmount: hooks.unmount,
    replayEffects: hooks.replayEffects,
    layout: (w = width, h = height) => tree.props.onLayout(nativeLayout(w, h)),
    widths(full = 150, prefix = 53, throughE = 71) {
      const [name, hidden] = wordmark().props.children;
      name.props.onLayout(nativeLayout(full, 42));
      hidden.props.children[0].props.onLayout(nativeLayout(prefix, 42));
      hidden.props.children[1].props.onLayout(nativeLayout(throughE, 42));
    },
    line: line => wordmark().props.children[0].props.onTextLayout({ nativeEvent: { lines: line ? [line] : [] } }),
    get overlay() { return find(tree, props => props.accessibilityLabel === 'KineSync is opening'); },
    get waiting() {
      return find(tree, props => props.children === 'Restoring setup…' || props.children === 'Setup is taking longer than expected.');
    },
    get retry() { return find(tree, props => props.accessibilityRole === 'button'); },
    get interactive() { return tree.props.children[0].props.pointerEvents === 'auto'; },
    get visible() { return tree.props.children[0].props.children.props.value; },
    get contentStyle() { return tree.props.children[0].props.style[1].animatedStyle(); },
  };
  render(false, beforeEffects && (initialTree => {
    tree = initialTree;
    beforeEffects(launch);
  }));
  return launch;
}

// Exercise the actual launch styles throughout the camera move.
for (const [width, height] of [[320, 568], [390, 844], [430, 932], [768, 1024], [1024, 1366]]) {
  const launch = launchHarness({ width, height, os: 'ios' });
  launch.layout();
  launch.widths();
  launch.line({ y: 0, ascender: 32, xHeight: 16 });
  launch.render(true);
  const { values, styles, timing } = launch;
  const [progress, scale, focus] = values;
  const [brandStyle, stemStyle, , overlayStyle, contentStyle] = styles;
  progress.value = timing.zoomStart / timing.duration;
  scale.value = 1;
  const initial = stemStyle();
  assert.equal(initial.opacity, 0, 'white continuation never changes the glyph during reveal');
  assert.ok(Math.abs(initial.left + initial.width / 2 - width / 2) < 150 * 0.15,
    'zoom destination is a white stroke in the middle of the word');
  const targetScale = Math.max(width / initial.width, height / initial.height) * 1.2;
  for (let frame = 0; frame <= 100; frame++) {
    const zoomProgress = frame / 100;
    const travel = zoomProgress ** 3;
    progress.value = (timing.zoomStart + timing.zoomDuration * zoomProgress) / timing.duration;
    scale.value = 0.88 + (targetScale - 0.88) * travel;
    focus.value = travel;
    const stem = stemStyle();
    const centerX = stem.left + stem.width / 2, centerY = stem.top + stem.height / 2;
    assert.ok(centerX >= 0 && centerX <= width, 'white text stroke stays horizontally onscreen throughout zoom');
    assert.ok(centerY >= 0 && centerY <= height, 'white text stroke stays vertically onscreen throughout zoom');
    assert.equal(brandStyle().opacity, 1, 'letters fade together with the overlay');
    const splashOpacity = overlayStyle().opacity;
    if (zoomProgress <= 0.08) assert.equal(splashOpacity, 1, 'wordmark stays visible as zoom starts');
    if (zoomProgress > 0.08 && zoomProgress < 0.82) {
      assert.ok(splashOpacity > 0 && splashOpacity < 1, 'text fades while zoom is still running');
      assert.ok(contentStyle().opacity > 0, 'content appears during the zoom');
    }
    if (zoomProgress >= 0.82) assert.equal(splashOpacity, 0, 'fade completes before zoom finishes');
    if (stem.left <= 0 && stem.top <= 0 && stem.left + stem.width >= width && stem.top + stem.height >= height) {
      assert.equal(splashOpacity, 0, 'viewport-sized white surface is already invisible');
    }
    if (zoomProgress >= 0.5) assert.ok(splashOpacity <= 0.18 + Number.EPSILON, 'content dominates before extreme magnification');
  }
  const end = stemStyle();
  assert.ok(end.left <= 0 && end.top <= 0 && end.left + end.width >= width && end.top + end.height >= height,
    'zoom still travels into the central white point');
  assert.equal(contentStyle().opacity, 1, 'content is fully visible by the end of the zoom');
  progress.value = 1;
  assert.equal(overlayStyle().opacity, 0);
  launch.unmount();
}

// A normal Android line starts promptly. Zero and invalid glyph metrics still
// compose a finite camera target, with the same wordmark and reveal.
for (const [line, targetY] of [
  [{ y: 0, ascender: 32, xHeight: 20 }, 1],
  [{ y: 0, ascender: 32, xHeight: 0 }, 3],
  [{ y: 0, ascender: 0, xHeight: 0 }, 3],
  [{ y: NaN, ascender: Infinity, xHeight: -2 }, 3],
  [undefined, 3],
]) {
  const launch = launchHarness();
  launch.layout();
  launch.widths();
  launch.line(line);
  launch.render(true);
  assert.equal(launch.calls.hide, 1, 'native splash releases at root layout');
  assert.equal(launch.completions.length, 1);
  const [, scale, focus] = launch.values;
  scale.value = 1;
  focus.value = 0;
  const stem = launch.styles[1]();
  assert.equal(stem.top + stem.height / 2 - 844 / 2, targetY);
  launch.completions[0](true);
  launch.render();
  assert.ok(!launch.overlay && launch.interactive && launch.visible);
  assert.equal(launch.contentStyle.opacity, 1);
  assert.equal(launch.contentStyle.transform[0].translateY, 0);
  assert.equal(launch.timers.pending, 0);
  launch.unmount();
}

{
  const launch = launchHarness();
  launch.layout();
  launch.widths();
  launch.render(true);
  assert.equal(launch.calls.hide, 1, 'the native splash does not wait for line metrics');
  assert.equal(launch.completions.length, 0, 'allow native line metrics a short measurement window');
  launch.timers.advance(400);
  launch.render();
  assert.equal(launch.calls.hide, 1, 'missing Android text event does not trap the native splash');
  assert.equal(launch.completions.length, 1);
  launch.unmount();
}

for (const widths of [null, [150, 0, 71], [150, 53, NaN], [150, 71, 71]]) {
  const launch = launchHarness();
  launch.layout();
  if (widths) launch.widths(...widths);
  launch.render(true);
  launch.timers.advance(400);
  launch.render();
  assert.equal(launch.calls.hide, 1, 'missing or unreliable widths release native splash');
  assert.equal(launch.completions.length, 0, 'without a focal target, skip the zoom');
  assert.ok(!launch.overlay && launch.interactive);
  assert.equal(launch.contentStyle.opacity, 1);
  assert.equal(launch.contentStyle.transform[0].translateY, 0);
  launch.unmount();
}

for (const reduceMotion of [false, true]) {
  const launch = launchHarness({ reduceMotion });
  launch.layout();
  launch.widths();
  launch.line({ y: 0, ascender: 32, xHeight: 16 });
  launch.render(false);
  assert.equal(launch.calls.hide, 1, 'root layout releases native splash before setup completes');
  assert.ok(launch.waiting && !launch.interactive && !launch.retry);
  launch.timers.advance(5000);
  launch.render(false);
  assert.equal(launch.calls.hide, 1, 'readiness watchdog does not request a duplicate release');
  assert.ok(!launch.overlay && launch.waiting, 'replace launch overlay with visible setup status');
  assert.ok(!launch.interactive && !launch.visible, 'pending setup keeps app underneath hidden and inaccessible');
  assert.equal(launch.contentStyle.opacity, 0);
  assert.equal(launch.contentStyle.transform[0].translateY, 0);
  launch.retry.props.onPress();
  assert.equal(launch.calls.reload, 1, 'retry reloads the app without reopening onboarding prematurely');
  launch.render(true);
  assert.ok(!launch.waiting && launch.interactive && launch.visible);
  assert.equal(launch.contentStyle.opacity, 1);
  assert.equal(launch.contentStyle.transform[0].translateY, 0);
  assert.equal(launch.completions.length, 0, 'late readiness cannot replay launch');
  assert.equal(launch.timers.pending, 0);
  launch.unmount();
}

{
  const launch = launchHarness();
  launch.layout(0, 844);
  launch.widths();
  launch.line({ y: 0, ascender: 32, xHeight: 16 });
  launch.render(true);
  launch.timers.advance(400);
  launch.render();
  assert.equal(launch.calls.hide, 0, 'zero-size root does not begin the launch animation');
  launch.timers.advance(4600);
  launch.render();
  assert.equal(launch.calls.hide, 1, 'missing root layout still has a deadline');
  assert.ok(!launch.overlay && launch.interactive);
  launch.unmount();
}

{
  const launch = launchHarness();
  launch.layout();
  launch.widths();
  launch.render(false);
  launch.timers.advance(1000);
  launch.render(false);
  assert.equal(launch.calls.hide, 1);
  assert.ok(launch.waiting && !launch.visible, 'splash handoff shows setup status while app content stays hidden');
  launch.render(true);
  assert.equal(launch.calls.hide, 1);
  assert.equal(launch.completions.length, 1, 'readiness before watchdog starts the launch normally');
  launch.unmount();
}

{
  const launch = launchHarness({ os: 'ios', reduceMotion: true });
  launch.layout();
  launch.render(true);
  assert.equal(launch.calls.hide, 1, 'reduced motion does not wait for decorative measurements');
  assert.ok(!launch.overlay && launch.interactive);
  assert.equal(launch.contentStyle.opacity, 1);
  assert.equal(launch.contentStyle.transform[0].translateY, 0);
  assert.equal(launch.completions.length, 0);
  launch.unmount();
}

{
  const launch = launchHarness();
  launch.layout();
  launch.widths();
  launch.line({ y: 0, ascender: 32, xHeight: 16 });
  launch.render(true);
  launch.widths(155, 54, 75);
  launch.line({ y: 0, ascender: 33, xHeight: 17 });
  launch.render(false);
  launch.render(true);
  assert.equal(launch.completions.length, 1, 'new measurements and readiness changes cannot restart motion');
  assert.equal(launch.calls.cancel, 0, 'gate changes do not cancel motion');
  launch.completions[0](false);
  launch.values[0].value = 0.2;
  launch.values[3].value = 16;
  launch.timers.advance(launch.timing.duration);
  launch.render();
  assert.ok(launch.overlay && launch.visible && !launch.interactive);
  launch.timers.advance(400);
  launch.render();
  assert.ok(!launch.overlay && launch.interactive, 'watchdog completes motion when callback fails');
  assert.equal(launch.contentStyle.opacity, 1);
  assert.equal(launch.contentStyle.transform[0].translateY, 0);
  assert.equal(launch.calls.cancel, 4);
  launch.completions[0](true);
  launch.render();
  assert.equal(launch.calls.cancel, 4, 'late completion cannot finish twice');
  assert.equal(launch.timers.pending, 0);
  launch.unmount();
}

for (const activeAnimation of [false, true]) {
  const launch = launchHarness();
  launch.layout();
  if (activeAnimation) {
    launch.widths();
    launch.line({ y: 0, ascender: 32, xHeight: 16 });
    launch.render(true);
  }
  launch.unmount();
  assert.equal(launch.timers.pending, 0);
  assert.equal(launch.calls.cancel, activeAnimation ? 4 : 0);
  launch.timers.advance(10000);
  launch.completions[0]?.(true);
  assert.equal(launch.calls.hide, activeAnimation ? 1 : 0, 'unmounted callbacks cannot change native splash');
}

function sendLayoutFacts(launch) {
  launch.layout();
  launch.widths();
  launch.line({ y: 0, ascender: 32, xHeight: 16 });
}

for (const timing of ['before effects', 'during effect replay']) {
  const launch = launchHarness({
    beforeEffects: timing === 'before effects' ? sendLayoutFacts : undefined,
  });
  if (timing === 'during effect replay') launch.replayEffects(() => sendLayoutFacts(launch));
  launch.render(true);
  assert.equal(launch.calls.hide, 1);
  assert.equal(launch.completions.length, 1, 'early layout facts survive lifetime effect setup');
  launch.unmount();
}

{
  const launch = launchHarness();
  sendLayoutFacts(launch);
  launch.render(true);
  launch.replayEffects(() => {});
  launch.render();
  assert.equal(launch.completions.length, 1, 'effect replay never restarts canceled motion');
  assert.equal(launch.calls.hide, 1);
  assert.ok(launch.interactive);
  assert.equal(launch.contentStyle.opacity, 1);
  launch.unmount();
}

for (const failures of [1, 2]) {
  const launch = launchHarness({ splashFailures: failures });
  sendLayoutFacts(launch);
  launch.render();
  launch.render(true);
  launch.completions[0](true);
  launch.render();
  assert.equal(launch.calls.hide, 1, 'animation start and finish do not duplicate a queued release retry');
  launch.timers.advance(150);
  launch.render();
  assert.equal(launch.calls.hide, 2);
  assert.equal(launch.warnings.length, failures);
  launch.warnings.forEach((message, index) => assert.match(message, new RegExp(`attempt ${index + 1} of 2`)));
  launch.timers.advance(10000);
  assert.equal(launch.calls.hide, 2, 'native release retry is bounded');
  assert.equal(launch.timers.pending, 0);
  launch.unmount();
}

{
  const launch = launchHarness({ splashFailures: 1 });
  launch.layout();
  launch.render();
  launch.unmount();
  launch.timers.advance(150);
  assert.equal(launch.calls.hide, 1, 'unmount cancels pending native splash retry');
}

// Opt-in experiments load the exact baseline source from stdin, with the same
// hook, clock and native mocks as the production regression checks.
function compareBaselineLaunch(baseline) {
  for (const source of [baseline, undefined]) {
    const isBaseline = source === baseline;
    const control = launchHarness({ source, reduceMotion: true });
    sendLayoutFacts(control);
    control.render(true);
    assert.equal(control.calls.hide, 1);
    assert.ok(control.interactive, 'complete layout and setup allow both reduced-motion paths to finish');
    control.unmount();

    const missingLine = launchHarness({ source, reduceMotion: true });
    missingLine.layout();
    missingLine.widths();
    missingLine.render(true);
    missingLine.timers.advance(5000);
    missingLine.render();
    assert.equal(missingLine.calls.hide, isBaseline ? 0 : 1);
    assert.equal(missingLine.interactive, !isBaseline, 'only the baseline reduced-motion path requires the missing line');
    missingLine.unmount();

    const interrupted = launchHarness({ source });
    sendLayoutFacts(interrupted);
    interrupted.render(true);
    interrupted.widths(155); // A late layout changes only the full wordmark width.
    interrupted.render(true);
    assert.equal(interrupted.calls.cancel, isBaseline ? 4 : 0);
    assert.equal(interrupted.completions.length, isBaseline ? 2 : 1);
    interrupted.completions[0](false); // No successful worklet completion is delivered.
    interrupted.timers.advance(interrupted.timing.duration + 400);
    interrupted.render();
    assert.equal(Boolean(interrupted.overlay), isBaseline, 'the animation deadline removes a stalled overlay');
    assert.equal(interrupted.interactive, !isBaseline);
    interrupted.unmount();
  }
  console.log('Baseline comparison passed for the missing-line gate and gate-change cleanup.');
}

function checkSafeAreaOrdering() {
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  const insets = { top: 24, right: 0, bottom: 24, left: 0 };
  function mountProvider(parent, props) {
    const hooks = hookHarness();
    const { SafeAreaProvider, SafeAreaInsetsContext } = load('node_modules/react-native-safe-area-context/src/SafeAreaContext.tsx', {
      react: {
        ...hooks.react,
        useContext: context => context === SafeAreaInsetsContext ? parent?.insets : parent?.frame,
      },
      'react/jsx-runtime': require('react/jsx-runtime'),
      'react-native': { Dimensions: { get: () => frame }, StyleSheet: { create: value => value } },
      './NativeSafeAreaProvider': { NativeSafeAreaProvider: 'NativeSafeAreaProvider' },
    }, { process: { env: { NODE_ENV: 'production' } } });
    return () => hooks.render(SafeAreaProvider, props);
  }

  // Expo Router supplies no initial metrics on native production. Mount the
  // nested provider only after the installed outer provider exposes its child.
  const route = 'RootLayout';
  const outer = mountProvider(null, { children: route });
  const beforeInsets = outer();
  assert.equal(beforeInsets.props.children, null);
  beforeInsets.props.onInsetsChange({ nativeEvent: { frame, insets } });
  const inherited = outer().props.children.props.children;
  assert.equal(inherited.props.children, route);
  assert.deepEqual(inherited.props.value, insets);

  const nested = mountProvider({ insets: inherited.props.value, frame }, { children: 'BridgeProvider' });
  assert.equal(nested().props.children.props.children.props.children, 'BridgeProvider');
  console.log('Safe-area ordering passed with simulated outer insets and a delayed nested event.');
}

if (process.argv.includes('--compare-baseline-launch')) {
  compareBaselineLaunch(fs.readFileSync(0, 'utf8'));
  checkSafeAreaOrdering();
}

async function checkSetupReadiness() {
  for (const outcome of ['fresh', 'completed', 'defaults rejected', 'restore rejected', 'unmounted', 'tour-amll', 'tour-spicy']) {
    const benchmark = outcome === 'tour-amll' || outcome === 'tour-spicy';
    const hooks = hookHarness();
    let resolveDefaults, rejectDefaults, connects = 0, legacyReads = 0, settingsReads = 0, tourStarts = 0, style;
    let marker = outcome === 'completed' || outcome === 'defaults rejected' ? 'true' : null;
    const defaults = new Promise((resolve, reject) => { resolveDefaults = resolve; rejectDefaults = reject; });
    const state = {
      serverUrl: outcome === 'defaults rejected' || outcome === 'unmounted' ? 'ws://bridge' : '',
      setLyricsStyle: value => { style = value; },
    };
    const { BridgeProvider, requestShowOnboarding } = load('providers/bridge-provider.tsx', {
      react: hooks.react,
      'react/jsx-runtime': require('react/jsx-runtime'),
      'react-native': {
        Platform: { OS: 'android' }, View: 'View', StyleSheet: { absoluteFill: {} },
        AppState: { addEventListener: () => ({ remove() {} }) },
        BackHandler: { addEventListener: () => ({ remove() {} }) },
      },
      '@react-native-async-storage/async-storage': {
        getItem: async key => {
          assert.equal(key, 'kinesync_onboarding_completed');
          legacyReads++;
          return marker;
        },
        setItem: async (key, value) => {
          assert.equal(key, 'kinesync_onboarding_completed');
          marker = value;
        },
      },
      '@/lib/bridge-client': { bridgeClient: { connect: () => connects++, disconnect() {} } },
      '@/lib/bridge-settings': {
        getBridgeSettings: async () => {
          settingsReads++;
          if (outcome === 'restore rejected') throw Error('setup restore failed');
          return {
            onboardingCompleted: false,
            playbackMode: outcome === 'defaults rejected' ? 'desktop' : 'mobile',
            serverUrl: state.serverUrl,
          };
        },
      },
      '@/lib/network': { extractHost: () => undefined, isPrivateIpv4: () => false },
      '@/store/playback-store': {
        initPlaybackStoreDefaults: () => defaults, stopPlaybackClock() {},
        usePlaybackStore: { getState: () => state },
      },
      '@/components/onboarding/onboarding-screen': { Onboarding: 'Onboarding' },
      '@/lib/live-activity': { startLiveActivitySync() {} },
      '@/components/ui/launch-transition': { LaunchTransition: 'LaunchTransition' },
      '@/store/player-tour-store': { usePlayerTourStore: { setState() {}, getState: () => ({ requestStart: () => tourStarts++ }) } },
      'expo-router': { usePathname: () => '/' },
      'expo-constants': { default: {} },
    }, {
      process: { env: benchmark ? { EXPO_PUBLIC_PERFORMANCE_SCENARIO: outcome } : {} },
      console: { warn() {} },
    });
    const render = () => hooks.render(BridgeProvider, { children: 'App' });
    const initial = render();
    assert.equal(initial.props.ready, false);
    assert.equal(initial.props.children[1], false);
    if (outcome === 'unmounted') hooks.unmount();
    if (outcome === 'defaults rejected' || outcome === 'tour-spicy') rejectDefaults(Error('defaults failed'));
    else resolveDefaults();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    if (outcome === 'unmounted') {
      assert.equal(connects, 0, 'stale restore cannot reconnect after unmount');
      assert.equal(legacyReads, 0);
      continue;
    }
    const settled = render();
    assert.equal(settled.props.ready, true);
    assert.equal(Boolean(settled.props.children[1]), outcome === 'fresh' || outcome === 'restore rejected');
    assert.equal(legacyReads, benchmark ? 0 : 1, 'benchmark skips onboarding persistence reads');
    assert.equal(settingsReads, benchmark ? 0 : 1, 'benchmark skips bridge restore');
    assert.equal(style, benchmark ? outcome.slice('tour-'.length) : undefined);
    assert.equal(tourStarts, benchmark ? 1 : 0);
    assert.equal(connects, outcome === 'defaults rejected' ? 1 : 0, 'configured desktop setup restores after defaults rejection');
    if (outcome === 'completed') {
      marker = null; // Settings clears the stored completion before opening setup again.
      requestShowOnboarding();
      const onboarding = render().props.children[1].props.children;
      await onboarding.props.onDismiss();
      assert.equal(render().props.children[1], false, 'explicit replay dismiss restores the player');
      assert.equal(marker, 'true');
      assert.equal(tourStarts, 1);
    }
    hooks.unmount();
  }
}

const splash = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8')).expo.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen')[1];
assert.equal(splash.backgroundColor, '#000000');
assert.equal(splash.dark.backgroundColor, '#000000');
assert.equal(splash.image, undefined, 'native splash has no logo');
assert.ok(fs.readFileSync(path.join(__dirname, '..', splash.android.drawable.icon), 'utf8').includes('#00000000'),
  'Android splash uses an empty transparent drawable');
checkSetupReadiness().then(() => {
  console.log('Launch checks passed: zoom geometry, Android measurement fallback, startup and animation deadlines, and setup readiness.');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
