/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { buildSync } = require('esbuild');

const source = buildSync({
  entryPoints: [path.join(__dirname, '../components/lyrics/native/reference-scroll.tsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native', 'react-native-reanimated'],
}).outputFiles[0].text;
const cellSource = buildSync({ entryPoints: [path.join(__dirname, '../components/lyrics/native/amll-layout-cell.tsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native', 'react-native-reanimated', './reference-scroll'],
}).outputFiles[0].text;

for (const [spicy, reverseFrames, fps] of [[false, false, 60], [false, true, 60], [false, false, 120], [false, true, 120], [true, false, 60]]) {
  const shared = value => ({ value });
  const host = { command: shared({ serial: 0, offset: 0, delta: 0, index: 0, firstVisible: 0,
    interval: 800, instant: true, interlude: false, snap: false }), residual: shared(0), renderedResidual: shared(0), actualOffset: shared(0), spicy, motions: shared({}) };
  const reactions = [];
  const frames = [];
  const animations = new Map();
  const styles = [];
  let pendingTiming;
  const reanimated = {
    default: { ScrollView: 'ScrollView' },
    useSharedValue: value => {
      let current = value;
      const result = {};
      Object.defineProperty(result, 'value', { get: () => current, set: value => {
        if (pendingTiming) { animations.set(result, { from: current, elapsed: 0, ...pendingTiming }); pendingTiming = undefined; }
        else current = value;
      } });
      return result;
    },
    useAnimatedRef: () => () => {}, useScrollOffset() {},
    useAnimatedReaction: (prepare, react) => reactions.push({ prepare, react, previous: null }),
    useAnimatedStyle: callback => { styles.push(callback); return {}; },
    useFrameCallback: (callback, active = true) => {
      const frame = { callback, active }; frames.push(frame);
      return { setActive: active => { frame.active = active; } };
    },
    cancelAnimation: value => animations.delete(value),
    withTiming: (to, config) => { pendingTiming = { to, ...config }; return to; },
    defineAnimation: (_initial, factory) => factory(),
    scrollTo: (_ref, _x, y) => { host.actualOffset.value = y; },
  };
  // The host residual is the shared value being animated by the real scroll hook.
  host.residual = reanimated.useSharedValue(0);
  const react = { createContext: () => ({}), forwardRef: fn => fn, useCallback: fn => fn, useMemo: fn => fn(),
    useContext: () => host, useEffect: fn => fn(), createElement: () => ({}) };
  const moduleObject = { exports: {} };
  vm.runInNewContext(source, { module: moduleObject, exports: moduleObject.exports,
    require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx: () => ({}) } : name === 'react-native' ? {} : reanimated });
  const { ReferenceScrollView, useReferenceRowScroll } = moduleObject.exports;
  ReferenceScrollView({}, null);
  // This harness supplies deterministic hook implementations instead of React.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useReferenceRowScroll(host, 4, true);
  const flush = () => {
    for (const reaction of reactions) {
      const next = reaction.prepare();
      reaction.react(next, reaction.previous);
      reaction.previous = next;
    }
  };
  const tick = () => {
    for (const [value, animation] of animations) {
      animation.elapsed += 1000 / fps;
      const progress = Math.min(1, animation.elapsed / animation.duration);
      value.value = animation.from + (animation.to - animation.from) * animation.easing(progress);
      if (progress === 1) animations.delete(value);
    }
    for (const frame of reverseFrames ? [...frames].reverse() : frames)
      if (frame.active) frame.callback({ timeSincePreviousFrame: 1000 / fps });
    flush();
  };
  const issue = fields => {
    const previous = host.command.value;
    const correction = styles[0]().transform[0].translateY;
    host.command.value = { ...previous, serial: previous.serial + 1, ...fields };
    for (const reaction of reactions) {
      const next = reaction.prepare();
      reaction.react(next, reaction.previous);
      reaction.previous = next;
      // Native style mappers can run between independent command reactions.
      // Checking only after all reactions hides the one-frame cue flash.
      if (!fields.instant && fields.snap !== false)
        assert.equal(styles[0]().transform[0].translateY, correction, 'Cue reactions must never expose an uncompensated scroll delta');
    }
  };
  flush();
  issue({ offset: 300, delta: 300, instant: true, snap: true, index: 3 });
  assert.equal(host.actualOffset.value, 300);
  issue({ instant: true, snap: false });
  host.actualOffset.value = 2200; // Drag continues after touch-down took ownership.
  issue({ offset: 300, delta: 0, instant: false, snap: true });
  assert.equal(host.actualOffset.value, 2200, 'Resuming must not teleport the native list');
  assert.equal(styles[0]().transform[0].translateY, 0, 'Resume compensation must start at the actual drag endpoint');
  tick();
  assert.ok(host.actualOffset.value < 2200 && host.actualOffset.value > 300, 'Even a return over several viewports must animate');
  // Retarget while motion is in flight: preserve the current visual position.
  const before = host.actualOffset.value;
  issue({ offset: 500, delta: 200, index: 4 });
  assert.equal(host.actualOffset.value, before, 'A new lyric cue must not snap an in-flight scroll');
  for (let frame = 0; frame < 240; frame++) tick();
  assert.ok(Math.abs(host.actualOffset.value - 500) < 0.1, 'Following settles at the requested lyric');
  if (!spicy) {
    const cellModule = { exports: {} };
    vm.runInNewContext(cellSource, { module: cellModule, exports: cellModule.exports,
      require: name => name === 'react' ? react : name === 'react/jsx-runtime'
        ? { jsx: (type, props) => ({ type, props }) } : name === './reference-scroll' ? {} : reanimated });
    const layout = cellModule.exports.AmllLayoutCell({ index: 4 }, null).props.layout;
    const anchor = 80;
    let logicalY = 500 + anchor;
    let now = 0;
    // Expand every preceding background, then reverse before the transition ends.
    for (const delta of [200, -200]) {
      const config = layout({ currentOriginY: logicalY, targetOriginY: logicalY + delta });
      logicalY += delta;
      const animation = config.animations.transform[0].translateY;
      animation.onStart(animation, config.initialValues.transform[0].translateY, now, null);
      const before = host.actualOffset.value;
      issue({ offset: host.command.value.offset + delta, delta, geometry: true });
      assert.equal(host.actualOffset.value, before, 'Pause/resume cannot jump the viewport to the final layout');
      for (let frame = 0; frame < (delta > 0 ? 10 : 240); frame++) {
        now += 1000 / fps;
        tick();
        animation.onFrame(animation, now);
        const visualTop = logicalY + animation.current + styles[0]().transform[0].translateY - host.actualOffset.value;
        assert.ok(Math.abs(visualTop - anchor) < 0.02, 'Cell and viewport motion must preserve focus throughout pause and interrupted resume');
      }
    }
    issue({ offset: 650, delta: 150, index: 4, geometry: false });
    for (let frame = 0; frame < 80; frame++) {
      const before = host.actualOffset.value;
      const residual = host.residual.value;
      const correction = styles[0]().transform[0].translateY;
      issue({ offset: host.command.value.offset - 1, delta: -1, geometry: true });
      assert.equal(host.residual.value, residual - 1, 'Geometry retargets the existing viewport spring without changing velocity');
      assert.equal(host.actualOffset.value, before, 'The viewport must not jump ahead of the cell layout transform');
      assert.equal(styles[0]().transform[0].translateY, correction, 'Geometry must not restart row motion');
      tick();
    }
    assert.ok(Math.abs(styles[0]().transform[0].translateY) < 0.1,
      'Repeated background measurements cannot keep renewing the row stagger delay');
  }
  issue({ snap: false, instant: true });
  host.actualOffset.value = 900;
  for (let frame = 0; frame < 30; frame++) tick();
  assert.equal(host.actualOffset.value, 900, 'A user drag cancels all pending follow motion');
}
const viewSource = fs.readFileSync(path.join(__dirname, '../components/lyrics/native/native-lyrics-view.tsx'), 'utf8');
const ast = ts.createSourceFile('native-lyrics-view.tsx', viewSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let retry;
let scrollCallback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'onContentSizeChange') retry = node.initializer.getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'scrollTo') scrollCallback = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(retry);
assert.ok(scrollCallback);
for (const animated of [false, true]) {
  const calls = [];
  let ready = false;
  const context = { refreshBlurGeometry() {}, useCallback: fn => fn, transition: { onReady: () => { ready = true; } }, markRendererReady() {}, rendererReadyKey: 'test', pendingScroll: { current: { index: 4, animated } },
    following: { current: true }, lastScrollTarget: { current: 'old' },
    scrollTo: (index, animation) => calls.push([index, animation]), backgrounds: [], lyrics: [], timing: {} };
  vm.runInNewContext(`(${retry})()`, context);
  assert.deepEqual(calls, [[4, animated]], 'A cold row measurement must preserve the original scroll animation');
  assert.equal(context.pendingScroll.current, null);
  assert.equal(ready, true, 'A measured replacement must release the waiting lyrics crossfade');
}
for (const [index, animated, snap, geometry] of [[4, true, true, true], [5, true, true, false], [4, false, true, false], [4, true, false, false]]) {
  const command = { current: { serial: 8, index: 4, offset: 600, snap } };
  const context = { useCallback: fn => fn, nativeFollowIndex: (_rows, index) => index,
    currentPosition: { current: 14000 }, following: { current: true }, active: true, staticLyrics: false,
    rows: Array.from({ length: 10 }, (_, index) => ({ lead: { start: index * 1000, end: (index + 1) * 1000 } })),
    list: 'flash', flashRef: { current: { getLayout: () => ({ y: 500 }), getFirstItemOffset: () => 150, getFirstVisibleIndex: () => 3 } },
    flatRef: {}, lastScrollTarget: { current: '' }, landscapeMode: false, fontScale: 1, showTranslatedText: true,
    viewportHeight: 800, preview: false, style: 'amll', pendingScroll: { current: null }, scrollState: command, scrollCommand: {} };
  context.latestRows = { current: context.rows };
  context.translationOnlyLayout = { current: false };
  vm.runInNewContext(ts.transpileModule(`(${scrollCallback})(${index}, ${animated})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.equal(context.scrollCommand.value.geometry, geometry,
    'The host must distinguish background reflow from lyric advances, seeks and manual-follow resumes');
}

// -------------------------------------------------------------------------------------------------
// Regression test: Frame-by-frame visual offset continuity at scroll start (AMLL and Spicy).
//
// Root Cause Reproduction:
// Under commit 95c2c96, command reactions computed `rowDy = state.value.p - host.renderedResidual.value`.
// Since state.p was updated with the new cue delta (e.g. +180px) while host.renderedResidual was still
// 0 from the previous settled state, rowDy jumped to +180px for exactly 1 frame before frame callbacks ran.
// With useAnimatedStyle reading entry.row from host.motions, every row jumped far DOWN by +180px on Frame 0,
// and then on Frame 1, frame callbacks updated host.renderedResidual and stepped springs, collapsing rowDy back
// to ~0px (a -175px snap back).
//
// 1) Explicit reproduction of the unpatched Frame 0 jump:
const unpatchedDelta = 180;
const unpatchedP0 = 0;
const unpatchedRenderedResidual0 = 0; // Host renderedResidual before useFrameCallback ticks
const unpatchedRowP = unpatchedP0 + unpatchedDelta; // In command reaction, state.value.p += delta
const unpatchedRowDy = unpatchedRowP - unpatchedRenderedResidual0; // Buggy formula from commit 95c2c96
assert.equal(unpatchedRowDy, unpatchedDelta, 'Old unpatched logic exposes full unrendered delta (+180px) on Frame 0');
const unpatchedNextHostP = 175.2; // After 1 frame at 60Hz
const unpatchedNextRowP = 175.2;  // Row spring after 1 frame at 60Hz
const unpatchedFrame1RowDy = unpatchedNextRowP - unpatchedNextHostP; // Settles to 0 on Frame 1
const unpatchedGlitchSnap = unpatchedFrame1RowDy - unpatchedRowDy;
assert.ok(Math.abs(unpatchedGlitchSnap) > 170, 'Old unpatched logic produced a severe one-frame glitch snap (>170px)');

// 2) Frame-by-frame continuity test on actual compiled hook code across AMLL and Spicy:
function checkScrollStartContinuity(spicyMode, targetFps) {
  const sharedState = initial => {
    let current = initial;
    return {
      get value() { return current; },
      set value(v) {
        if (pendingTimingCfg) {
          activeAnimations.set(this, { from: current, elapsed: 0, ...pendingTimingCfg });
          pendingTimingCfg = undefined;
        } else {
          current = v;
        }
      }
    };
  };

  const testHost = {
    command: sharedState({ serial: 0, offset: 0, delta: 0, index: 0, firstVisible: 0, interval: 800, instant: true, interlude: false, snap: false }),
    residual: sharedState(0),
    renderedResidual: sharedState(0),
    actualOffset: sharedState(0),
    spicy: spicyMode,
    motions: sharedState({}),
  };

  const activeReactions = [];
  const activeFrames = [];
  const activeAnimations = new Map();
  const activeStyles = [];
  let pendingTimingCfg;

  const mockReanimated = {
    default: { ScrollView: 'ScrollView' },
    useSharedValue: val => {
      let current = val;
      const res = {};
      Object.defineProperty(res, 'value', {
        get: () => current,
        set: v => {
          if (pendingTimingCfg) {
            activeAnimations.set(res, { from: current, elapsed: 0, ...pendingTimingCfg });
            pendingTimingCfg = undefined;
          } else {
            current = v;
          }
        }
      });
      return res;
    },
    useAnimatedRef: () => () => {},
    useScrollOffset: () => {},
    useAnimatedReaction: (prepare, react) => activeReactions.push({ prepare, react, previous: null }),
    useAnimatedStyle: cb => { activeStyles.push(cb); return {}; },
    useFrameCallback: (cb, active = true) => {
      const f = { callback: cb, active };
      activeFrames.push(f);
      return { setActive: a => { f.active = a; } };
    },
    cancelAnimation: val => activeAnimations.delete(val),
    withTiming: (to, cfg) => { pendingTimingCfg = { to, ...cfg }; return to; },
    defineAnimation: (_init, factory) => factory(),
    scrollTo: (_ref, _x, y) => { testHost.actualOffset.value = y; },
  };

  testHost.residual = mockReanimated.useSharedValue(0);

  const mockReact = {
    createContext: () => ({}),
    forwardRef: fn => fn,
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useContext: () => testHost,
    useEffect: fn => { if (typeof fn === 'function') fn(); },
    createElement: () => ({}),
  };

  const compiledMod = { exports: {} };
  vm.runInNewContext(source, {
    module: compiledMod, exports: compiledMod.exports,
    require: name => name === 'react' ? mockReact : name === 'react/jsx-runtime' ? { jsx: () => ({}) } : name === 'react-native' ? {} : mockReanimated,
  });

  const { ReferenceScrollView: ScrollViewComponent, useReferenceRowScroll: useRowScroll } = compiledMod.exports;
  ScrollViewComponent({}, null);

  const testIndices = [2, 3, 4, 5];
  for (const idx of testIndices) {
    useRowScroll(testHost, idx, true);
  }

  const flushReactions = () => {
    for (const rx of activeReactions) {
      const next = rx.prepare();
      rx.react(next, rx.previous);
      rx.previous = next;
    }
  };

  const tickFrame = () => {
    for (const [val, anim] of activeAnimations) {
      anim.elapsed += 1000 / targetFps;
      const progress = Math.min(1, anim.elapsed / anim.duration);
      val.value = anim.from + (anim.to - anim.from) * anim.easing(progress);
      if (progress === 1) activeAnimations.delete(val);
    }
    for (const f of activeFrames) {
      if (f.active) f.callback({ timeSincePreviousFrame: 1000 / targetFps });
    }
    flushReactions();
  };

  flushReactions();
  // Settle at line 3, offset 300
  testHost.command.value = { serial: 1, offset: 300, delta: 300, index: 3, firstVisible: 2, interval: 800, instant: true, interlude: false, snap: true };
  flushReactions();
  assert.equal(testHost.actualOffset.value, 300);

  // Pre-scroll visual on-screen positions (layoutY - scrollOffset + translateY)
  const preVisualPositions = testIndices.map((idx, i) => idx * 80 - testHost.actualOffset.value + activeStyles[i]().transform[0].translateY);

  // Trigger auto-scroll to active line 4 at offset 480 (+180px delta)
  testHost.command.value = { serial: 2, offset: 480, delta: 180, index: 4, firstVisible: 2, interval: 800, instant: false, interlude: false, snap: true };
  flushReactions();

  // FRAME 0: At the exact instant command reactions fire, before display tick
  assert.equal(testHost.actualOffset.value, 300, 'ScrollView must remain at initial offset on Frame 0');
  for (let i = 0; i < testIndices.length; i++) {
    const idx = testIndices[i];
    const frame0Visual = idx * 80 - testHost.actualOffset.value + activeStyles[i]().transform[0].translateY;
    const frame0Jump = frame0Visual - preVisualPositions[i];
    assert.equal(frame0Jump, 0, `Row ${idx} must have 0.00px jump on Frame 0 at scroll start in ${spicyMode ? 'Spicy' : 'AMLL'} (was ${frame0Jump.toFixed(2)}px)`);
    if (!spicyMode && testHost.motions.value[idx]) {
      assert.equal(testHost.motions.value[idx].row, 0, `Row ${idx} motion registry must not expose unrendered cue delta on Frame 0 (was ${testHost.motions.value[idx].row})`);
    }
  }

  // FRAME 1: First display frame ticks
  tickFrame();
  assert.ok(testHost.actualOffset.value > 300 && testHost.actualOffset.value < 480, 'ScrollView displacement begins smoothly on Frame 1');
  const maxAllowedFirstStep = spicyMode ? 45 : 15;
  for (let i = 0; i < testIndices.length; i++) {
    const idx = testIndices[i];
    const frame1Visual = idx * 80 - testHost.actualOffset.value + activeStyles[i]().transform[0].translateY;
    const step1 = Math.abs(frame1Visual - preVisualPositions[i]);
    assert.ok(step1 <= maxAllowedFirstStep, `Row ${idx} Frame 1 step must be bounded and smooth in ${spicyMode ? 'Spicy' : 'AMLL'} (<= ${maxAllowedFirstStep}px, was ${step1.toFixed(2)}px)`);
  }

  // FRAMES 2..120: Continuous progression to settled target
  let previousPositions = testIndices.map((idx, i) => idx * 80 - testHost.actualOffset.value + activeStyles[i]().transform[0].translateY);
  for (let f = 2; f <= 120; f++) {
    tickFrame();
    for (let i = 0; i < testIndices.length; i++) {
      const idx = testIndices[i];
      const curVisual = idx * 80 - testHost.actualOffset.value + activeStyles[i]().transform[0].translateY;
      const step = Math.abs(curVisual - previousPositions[i]);
      assert.ok(step <= (spicyMode ? 45 : 25), `Row ${idx} frame ${f} step must be continuous in ${spicyMode ? 'Spicy' : 'AMLL'} (was ${step.toFixed(2)}px)`);
      previousPositions[i] = curVisual;
    }
  }
  assert.ok(Math.abs(testHost.actualOffset.value - 480) < 0.1, `Must settle smoothly at target offset 480 in ${spicyMode ? 'Spicy' : 'AMLL'}`);
}

checkScrollStartContinuity(false, 60);
checkScrollStartContinuity(false, 120);
checkScrollStartContinuity(true, 60);
checkScrollStartContinuity(true, 120);

// Active-Line Change Cost & Lag Regression: Workload Instrumentation
function checkActiveLineWorkload(fps) {
  const NUM_ROWS = 15;
  const activeLine = 5;
  let motionWrites = 0;
  let motionsVal = {};

  const hostMotions = {
    get value() { return motionsVal; },
    set value(v) {
      motionWrites++;
      motionsVal = v;
    },
  };

  const workHost = {
    command: { value: { serial: 1, offset: 200, delta: 0, index: 2, firstVisible: 0, interval: 800, instant: true, interlude: false, snap: true } },
    residual: { value: 0 },
    renderedResidual: { value: 0 },
    actualOffset: { value: 200 },
    spicy: false,
    motions: hostMotions,
  };

  const workReactions = [];
  const workFrames = [];
  const workStyles = [];

  const hookReanimated = {
    default: { ScrollView: 'ScrollView' },
    useAnimatedRef: () => () => {},
    useScrollOffset: () => {},
    useSharedValue: initial => {
      let v = initial;
      return {
        get value() { return v; },
        set value(next) { v = next; },
      };
    },
    useAnimatedReaction: (prepare, react) => workReactions.push({ prepare, react, previous: null }),
    useAnimatedStyle: cb => { workStyles.push(cb); return {}; },
    useFrameCallback: (cb, active = true) => {
      const f = { callback: cb, active };
      workFrames.push(f);
      return { setActive: a => { f.active = a; } };
    },
    cancelAnimation: () => {},
    withTiming: to => to,
    defineAnimation: (_init, factory) => factory(),
    scrollTo: (_ref, _x, y) => { workHost.actualOffset.value = y; },
  };

  const hookReact = {
    createContext: () => ({}),
    forwardRef: fn => fn,
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useContext: () => workHost,
    useEffect: fn => fn(),
    createElement: () => ({}),
  };

  const compiledMod = { exports: {} };
  vm.runInNewContext(source, {
    module: compiledMod,
    exports: compiledMod.exports,
    require: name => name === 'react' ? hookReact : name === 'react/jsx-runtime' ? { jsx: () => ({}) } : name === 'react-native' ? {} : hookReanimated,
  });

  const { ReferenceScrollView, useReferenceRowScroll } = compiledMod.exports;
  ReferenceScrollView({}, null);

  for (let i = 0; i < NUM_ROWS; i++) {
    useReferenceRowScroll(workHost, i, true);
  }

  // Initial settle
  for (const rx of workReactions) {
    const next = rx.prepare();
    rx.react(next, rx.previous);
    rx.previous = next;
  }
  motionWrites = 0; // Reset counter after initial mount

  // Issue cue transition to line 5 (+180px delta)
  workHost.command.value = { serial: 2, offset: 380, delta: 180, index: activeLine, firstVisible: 3, interval: 800, instant: false, interlude: false, snap: true };
  for (const rx of workReactions) {
    const next = rx.prepare();
    rx.react(next, rx.previous);
    rx.previous = next;
  }

  // Distant rows 3+ after active (e.g. lines 8, 9, 10) must be tracked for multi-active,
  // wrapped lines, translations, and landscape viewports where blur protection extends beyond active+1.
  assert.ok(workHost.motions.value[activeLine + 3] !== undefined, 'Row 3+ after active must be registered for blur parity');
  assert.ok(workHost.motions.value[0] !== undefined, 'Prior rows must be registered for reverse/interlude blur parity');

  // Step 60 frames (1 second of scroll)
  for (let f = 1; f <= fps; f++) {
    for (const frame of workFrames) {
      if (frame.active) frame.callback({ timeSincePreviousFrame: 1000 / fps });
    }
  }

  // Active line 5 and rows 3+ after active must be fully tracked in motion registry
  assert.ok(workHost.motions.value[activeLine] !== undefined, 'Active row 5 must be registered');
  assert.ok(workHost.motions.value[activeLine + 1] !== undefined, 'Next row 6 must be registered for blur protection');
  assert.ok(workHost.motions.value[activeLine + 3] !== undefined, 'Row 8 (3+ after active) must be tracked for blur parity');
}

checkActiveLineWorkload(60);
checkActiveLineWorkload(120);

// Worklet Closure Dependency Count & Reanimated Input Extraction Regression
function checkWorkletClosureDependencies() {
  const rootDir = path.resolve(__dirname, '..');
  const babel = require(require.resolve('@babel/core', { paths: [rootDir] }));
  const sourcePath = path.resolve(__dirname, '../components/lyrics/native/reference-scroll.tsx');
  const res = babel.transformFileSync(sourcePath, {
    configFile: false,
    babelrc: false,
    presets: [
      [require.resolve('@babel/preset-typescript', { paths: [rootDir] }), { isTSX: true, allExtensions: true }]
    ],
    plugins: [
      [require.resolve('react-native-worklets/plugin', { paths: [rootDir] })]
    ]
  });

  const matches = [...res.code.matchAll(/__closure\s*=\s*\[([^\]]+)\]/g)].map(m => m[1].split(',').map(s => s.trim()));
  const styleClosure = matches[matches.length - 1]; // useAnimatedStyle worklet in useReferenceRowScroll

  assert.ok(!styleClosure.includes('host'), 'useAnimatedStyle must NOT capture plain object host in worklet closure');
  assert.ok(styleClosure.includes('command'), 'useAnimatedStyle must capture destructured command');
  assert.ok(styleClosure.includes('renderedResidual'), 'useAnimatedStyle must capture destructured renderedResidual');
  assert.ok(styleClosure.includes('state'), 'useAnimatedStyle must capture state');

  function isSharedValue(v) { return Boolean(v && v._isReanimatedSharedValue); }
  function extractInputs(inputs, resultArray) {
    if (Array.isArray(inputs)) {
      for (const input of inputs) if (input) extractInputs(input, resultArray);
    } else if (isSharedValue(inputs)) {
      resultArray.push(inputs);
    } else if (Object.getPrototypeOf(inputs) === Object.prototype) {
      for (const element of Object.values(inputs)) if (element) extractInputs(element, resultArray);
    }
    return resultArray;
  }

  const mockHost = {
    command: { _isReanimatedSharedValue: true, name: 'command' },
    residual: { _isReanimatedSharedValue: true, name: 'residual' },
    renderedResidual: { _isReanimatedSharedValue: true, name: 'renderedResidual' },
    actualOffset: { _isReanimatedSharedValue: true, name: 'actualOffset' },
    spicy: false,
    motions: { _isReanimatedSharedValue: true, name: 'motions' },
  };
  const mockState = { _isReanimatedSharedValue: true, name: 'state' };

  // Old closure captured [host, state]:
  const oldExtracted = extractInputs([mockHost, mockState], []);
  assert.equal(oldExtracted.length, 6, 'Old closure leaked all 6 SharedValues including host.motions');
  assert.ok(oldExtracted.some(x => x.name === 'motions'), 'Old closure leaked host.motions');

  // New closure captures [spicy, command, state, renderedResidual]:
  const newExtracted = extractInputs([mockHost.spicy, mockHost.command, mockState, mockHost.renderedResidual], []);
  assert.equal(newExtracted.length, 3, 'New closure extracts strictly 3 SharedValues');
  assert.ok(!newExtracted.some(x => x.name === 'motions'), 'New closure strictly excludes host.motions');
}

checkWorkletClosureDependencies();

console.log('Native scrolling checks passed: coordinated focus at 60/120 Hz in either callback order, interrupted geometry, cold retries, manual follow, scroll-start frame continuity, active-line workload optimization, and worklet closure dependency verification.');
