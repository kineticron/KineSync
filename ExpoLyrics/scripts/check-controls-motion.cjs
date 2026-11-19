const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app/(tabs)/index.tsx'), 'utf8');
const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = {};
let dock;
let screen;
let fixedChildStyle;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations[node.name.text] = node.initializer;
  if (ts.isJsxOpeningElement(node) && node.attributes.getText(ast).includes('style={styles.controlsWrap}')) dock = node;
  if (ts.isJsxOpeningElement(node) && node.attributes.getText(ast).includes('style={styles.screen}')) screen = node;
  if (ts.isJsxOpeningElement(node)) {
    const style = node.attributes.properties.find(p => p.name?.text === 'style');
    if (style?.initializer?.expression?.getText(ast).includes("position: 'absolute', left: 0, right: 0, top: 0, height: Math.max(0, screenHeight - lyricTop)")) fixedChildStyle = style.initializer.expression.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const callback = name => declarations[name].arguments[0].getText(ast);
const evaluate = (code, context) => vm.runInNewContext(ts.transpileModule(`(${code})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
const common = { Math };
const helper = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'lib/controls-motion.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, helper);
const { controlsStage } = helper.exports;
const layout = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'constants/player-layout.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, layout);
const { LYRICS_EDGE_FADE_HEIGHT } = layout.exports;
const windows = [[0, .6], [.2, .8], [.4, 1]];
for (const progress of [-1, 0, .125, .2, .375, .4, .6, .625, .8, .9975, 1, 2]) {
  const stages = windows.map(([a, b]) => controlsStage(progress, a, b));
  for (const [index, stage] of stages.entries()) {
    const [start, end] = windows[index];
    const local = Math.max(0, Math.min(1, (progress - start) / (end - start)));
    const expected = local === 1 ? 1 : 1 - 2 ** (-10 * local);
    assert.equal(stage.opacity, expected, 'each window applies its own expo-out easing');
    assert.equal(stage.transform[0].translateY, 36 * (1 - expected));
    assert.ok(stage.opacity >= 0 && stage.opacity <= 1);
    assert.ok(stage.transform[0].translateY >= 0 && stage.transform[0].translateY <= 36);
  }
  assert.ok(stages[0].opacity >= stages[1].opacity && stages[1].opacity >= stages[2].opacity);
}
for (const [start, end] of windows) {
  assert.equal(controlsStage(start, start, end).opacity, 0);
  assert.equal(controlsStage(end, start, end).opacity, 1);
  assert.ok(Math.abs(controlsStage((start + end) / 2, start, end).opacity - (1 - 2 ** -5)) < 1e-12);
}
assert.ok(controlsStage(.2, ...windows[0]).opacity > .8);
assert.equal(controlsStage(.2, ...windows[1]).opacity, 0);
assert.equal(controlsStage(.4, ...windows[2]).opacity, 0);
assert.match(source, /bezier\(0\.16, 1, 0\.3, 1\)/);
assert.match(source, /const controlsStageProgress = useSharedValue\(1\)/);
assert.match(source, /clearControlsIdleTimer\(\);\s+cancelAnimation\(controlsOpacity\);\s+cancelAnimation\(controlsStageProgress\);/, 'unmount cancels both clocks');
assert.match(source, /controlsProgress=\{controlsStageProgress\}\s+controlsBackdropOffset=\{controlsBackdropOffset\}/);
assert.match(source, /controlsProgress=\{controlsProgress\}\s+controlsBackdropOffset=\{controlsBackdropOffset\}/, 'dock forwards the UI-thread coverage guard');
assert.match(source, /controlsProgress=\{controlsOpacity\} controlsTarget=/, 'attribution retains geometry progress');
// Execute both production animation clocks with a deterministic clock. Geometry
// easing is linearized here. Coverage is tested for arbitrary progress pairs
// below, so its proof does not depend on the native easing curve or frame rate.
function motionHarness(initial) {
  let now = 0, interactive = initial === 1;
  const completions = [];
  const makeProgress = () => ({
    current: initial, animation: null,
    get() {
      const animation = this.animation;
      if (!animation) return this.current;
      const elapsed = Math.max(0, Math.min(1, (now - animation.start) / animation.duration));
      return animation.from + (animation.target - animation.from) * elapsed;
    },
    get value() { return this.get(); },
    set value(next) {
      if (typeof next === 'number') { this.current = next; this.animation = null; }
      else this.animation = { ...next, from: this.current, start: now };
    },
  });
  const geometry = makeProgress(), stage = makeProgress();
  const context = {
    ...common, controlsOpacity: geometry, controlsStageProgress: stage,
    liveReducedMotion: false, fullscreenAlbumModeRef: { current: false },
    setControlsInteractive: next => { interactive = next; }, setControlsVisible: () => {},
    cancelAnimation: progress => { progress.current = progress.get(); progress.animation = null; },
    CONTROLS_EASE: 'configured cubic', ReanimatedEasing: { linear: 'linear' },
    withTiming: (target, options, completion) => {
      assert.equal(options.duration, options.easing === 'linear' ? 700 : 400);
      if (completion) completions.push(completion);
      return { target, duration: options.duration, completion };
    },
  };
  const animate = evaluate(callback('animateControls'), context);
  const backdrop = evaluate(callback('controlsBackdropOffset'), {
    Math, screenHeight: 844, dockTop: { value: 624 }, controlsOpacity: geometry,
  });
  const rows = () => windows.map(([a, b]) => controlsStage(stage.get(), a, b, backdrop()));
  const assertCoverage = () => {
    const edge = 844 - 220 * geometry.get();
    rows().forEach((row, index) => {
      if (row.opacity > 0) assert.ok(624 + [16, 70, 140][index] + row.transform[0].translateY >= edge - 1e-9,
        'every visible row stays below the opaque dynamic backdrop edge');
    });
  };
  return {
    context, geometry, stage, completions, animate, rows,
    get interactive() { return interactive; },
    tick(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed++) {
        now++;
        for (const progress of [geometry, stage]) {
          const animation = progress.animation;
          if (animation && now >= animation.start + animation.duration) {
            progress.current = animation.target;
            progress.animation = null;
            animation.completion?.(true);
          }
        }
        assertCoverage();
      }
    },
  };
}
for (const initial of [0, 1]) for (const interruption of [1, 16, 50, 150, 399, 400, 450, 699, 700]) {
  const h = motionHarness(initial);
  const shown = initial === 0;
  h.animate(shown);
  assert.equal(h.interactive, shown, 'show enables touch/accessibility immediately, hide disables immediately');
  h.tick(interruption);
  const before = [h.geometry.get(), h.stage.get()];
  const rowsBefore = h.rows();
  h.animate(!shown);
  assert.equal(h.interactive, !shown, 'reversal immediately applies the latest interaction target');
  assert.equal(h.geometry.get(), before[0], 'geometry reversal never snaps');
  assert.equal(h.stage.get(), before[1], 'row reversal never snaps');
  h.rows().forEach((row, index) => {
    assert.equal(row.opacity, rowsBefore[index].opacity);
    assert.equal(row.transform[0].translateY, rowsBefore[index].transform[0].translateY);
  });
  assert.equal(h.completions.length, 0, 'no stale animation completion can change interaction or accessibility');
  h.tick(700);
  assert.equal(h.geometry.get(), initial);
  assert.equal(h.stage.get(), initial);
  assert.equal(h.interactive, initial === 1);
  h.animate(shown); h.tick(150); h.animate(!shown); h.tick(75); h.animate(shown); h.tick(700);
  assert.equal(h.geometry.get(), shown ? 1 : 0);
  assert.equal(h.stage.get(), shown ? 1 : 0);
  assert.equal(h.interactive, shown);
  for (const policy of ['reduced motion', 'fullscreen']) {
    h.animate(!shown); h.tick(100);
    if (policy === 'reduced motion') h.context.liveReducedMotion = true;
    else h.context.fullscreenAlbumModeRef.current = true;
    h.animate(false);
    assert.equal(h.geometry.get(), 0); assert.equal(h.stage.get(), 0); assert.equal(h.interactive, false);
    h.animate(true);
    assert.equal(h.geometry.get(), 1); assert.equal(h.stage.get(), 1); assert.equal(h.interactive, true);
    h.tick(700);
    assert.equal(h.geometry.get(), 1); assert.equal(h.stage.get(), 1);
    h.context.liveReducedMotion = false;
    h.context.fullscreenAlbumModeRef.current = false;
  }
}
// Both clocks start on the first frame, with no blank 400ms prelude or 1100ms
// input lock. The row windows still start at 0ms, 140ms and 280ms respectively.
const reveal = motionHarness(0);
reveal.animate(true);
assert.equal(reveal.interactive, true);
reveal.tick(16);
assert.ok(reveal.geometry.get() > 0); assert.ok(reveal.stage.get() > 0);
assert.ok(reveal.rows()[0].opacity > 0);
assert.equal(reveal.rows()[1].opacity, 0); assert.equal(reveal.rows()[2].opacity, 0);
reveal.tick(34);
assert.ok(624 + 16 + reveal.rows()[0].transform[0].translateY < 844, 'timeline is on screen well before 400ms even with linearized geometry');
reveal.tick(91); assert.ok(reveal.rows()[1].opacity > 0); assert.equal(reveal.rows()[2].opacity, 0);
assert.equal(reveal.interactive, true, 'visible transport accepts input before finishing its reveal');
reveal.tick(140); assert.ok(reveal.rows()[2].opacity > 0);
reveal.tick(419); assert.equal(reveal.stage.get(), 1); assert.equal(reveal.geometry.get(), 1);
reveal.animate(false); assert.equal(reveal.interactive, false);
reveal.tick(400); assert.equal(reveal.geometry.get(), 0);
reveal.tick(300); assert.equal(reveal.stage.get(), 0);
// Mathematical coverage holds for arbitrary clock pairs, responsive dock heights
// and row layout offsets, including hide frames after geometry has reached zero.
for (const height of [390, 667, 844]) for (const dockHeight of [160, 220, 280]) {
  const dockTop = height - dockHeight;
  for (const geometry of [0, .01, .125, .5, .9, 1]) for (const progress of [0, .01, .2, .4, .6, .8, 1]) {
    const context = { Math, screenHeight: height, dockTop: { value: dockTop }, controlsOpacity: { value: geometry } };
    const offset = evaluate(callback('controlsBackdropOffset'), context)();
    const edge = evaluate(callback('fillTouchStyle'), context)().top;
    windows.forEach(([start, end]) => {
      const row = controlsStage(progress, start, end, offset);
      for (const layoutTop of [0, 16, 70, 140]) {
        assert.ok(dockTop + layoutTop + row.transform[0].translateY >= edge - 1e-9);
      }
      assert.equal(row.opacity, controlsStage(progress, start, end).opacity, 'coverage never changes the row opacity schedule');
      assert.equal(row.transform[0].translateY, Math.max(36 * (1 - row.opacity), offset));
    });
  }
}
// Execute actual touch handlers and idle callback, with a fake timer.
for (const gesture of ['scrub', 'previous long hold', 'next long hold']) {
  for (const terminal of ['onTouchEnd', 'onTouchCancel']) {
    let pending = null, hidden = 0;
    const context = {
      controlsForeground: { current: true }, controlsTouchActive: { current: false }, controlsScrubActive: { current: false }, controlsIdleTimerRef: { current: null },
      isLandscapeRef: { current: false }, tourAutoHideDemo: false,
      fullscreenAlbumModeRef: { current: false }, autoHidePlaybackControlsRef: { current: true },
      CONTROLS_IDLE_TIMEOUT_MS: 2500,
      clearControlsIdleTimer: () => { pending = null; },
      setTimeout: (fn, ms) => { assert.equal(ms, 2500); pending = fn; return 1; },
      showControls: () => {}, hideControls: () => { hidden++; },
    };
    context.scheduleControlsHide = evaluate(callback('scheduleControlsHide'), context);
    const handler = name => evaluate(screen.attributes.properties.find(p => p.name?.text === name).initializer.expression.getText(ast), context);
    handler('onTouchStart')();
    if (gesture === 'scrub') {
      context.controlsScrubActive.current = true;
      handler('onTouchCancel')({ nativeEvent: { touches: [] } });
      assert.equal(pending, null, 'native recognizer cancellation must not end active scrubbing');
      handler('onTouchStart')();
    }
    for (let elapsed = 0; elapsed < 10000; elapsed += 1000) context.scheduleControlsHide();
    assert.equal(pending, null, `${gesture} suppresses idle while held`);
    if (terminal === 'onTouchEnd') {
      handler(terminal)({ nativeEvent: { touches: [{}] } });
      assert.equal(pending, null, 'remaining finger retains ownership');
    }
    context.controlsScrubActive.current = false;
    handler(terminal)({ nativeEvent: { touches: [] } });
    assert.equal(typeof pending, 'function');
    pending();
    assert.equal(hidden, 1, `${gesture} re-arms after ${terminal}`);
  }
}
// The renderer viewport stays full size. Only the soft alpha mask moves.
assert.match(source, /collapsable=\{false\}\s+style=\{\[styles.lyricsWrap, lyricsViewportStyle\]\}/);
assert.match(source, /position: 'absolute', left: 0, right: 0, top: 0, height: Math.max\(0, screenHeight - lyricTop\)/);
assert.match(source, /<MaskedView[\s\S]*?androidRenderingMode="software"[\s\S]*?maskElement=/);
assert.ok(!source.includes('foregroundClipStyle'));
assert.doesNotMatch(callback('lyricsEdgeMaskSolidStyle'), /translate|scale/);
for (const height of [667, 844, 390]) for (const top of [60, 110]) for (const dockTop of [height - 180, height - 260]) {
  for (const p of [0, .125, .375, .625, .9975, 1]) {
    const context = { screenHeight: height, lyricTop: top, dockTop: { value: dockTop }, controlsOpacity: { value: p }, LYRICS_EDGE_FADE_HEIGHT, Math };
    const solid = evaluate(callback('lyricsEdgeMaskSolidStyle'), context)();
    const fade = evaluate(callback('lyricsEdgeMaskFadeStyle'), context)();
    const fill = evaluate(callback('fillTouchStyle'), context)();
    const edge = fill.top - top;
    const expectedFade = Math.min(edge, LYRICS_EDGE_FADE_HEIGHT * p);
    assert.ok(edge >= 0 && edge <= height - top, 'the mask edge stays inside the lyric area');
    assert.equal(solid.height, Math.max(0, edge - expectedFade));
    assert.equal(fade.height, expectedFade);
    assert.equal(solid.height + fade.height, edge, 'opaque mask and soft fade meet exactly at the moving edge');
    assert.equal(fade.transform[0].translateY, solid.height, 'the soft fade starts where the opaque mask ends');
    if (p === 0) {
      assert.equal(fade.height, 0, 'hidden controls leave no fade at the bottom of the lyric area');
      assert.equal(solid.height, edge, 'hidden controls keep the full lyric area opaque');
    }
    const child = evaluate(fixedChildStyle, context);
    assert.equal(child.height, height - top);
    assert.equal(child.top, 0);
    assert.equal(child.transform, undefined, 'local PanResponder coordinates remain untranslated');
  }
}
assert.match(source, /dockTop.value = dockLayout.current.y \+ dockLayout.current.childY/);
for (const settled of [false, true]) for (const fullscreen of [false, true]) {
  const context = { controlsInteractive: settled, fullscreenAlbumMode: fullscreen };
  const attribute = name => evaluate(dock.attributes.properties.find(p => p.name?.text === name).initializer.expression.getText(ast), context);
  assert.equal(attribute('pointerEvents'), settled || fullscreen ? 'auto' : 'none');
  assert.equal(attribute('accessibilityElementsHidden'), !settled && !fullscreen);
  assert.equal(attribute('importantForAccessibility'), !settled && !fullscreen ? 'no-hide-descendants' : 'auto');
}
assert.match(source, /controlsInteractive \|\| fullscreenAlbumMode \? "auto" : "none"/);
assert.match(source, /accessibilityElementsHidden=\{!controlsInteractive && !fullscreenAlbumMode\}/);
assert.match(source, /importantForAccessibility=\{!controlsInteractive && !fullscreenAlbumMode \? 'no-hide-descendants'/);
assert.match(source, /controlsTouchActive.current = false;/);
assert.match(source, /controlsScrubActive.current = false;/);
assert.equal((source.match(/<ArtworkBackground\s/g) || []).length, 1);
assert.doesNotMatch(source, /lyricsBottomBlur|_stableColors7|rgba\(0,0,0,0\.85\)/);
assert.match(source, /followControlsProgress=\{!isLandscape\}/);
// A portrait/landscape switch cancels the attribution's prior choreography.
const attributionSource = fs.readFileSync(path.join(root, 'components/lyrics/lyrics-attribution.tsx'), 'utf8');
const attributionAst = ts.createSourceFile('attribution.tsx', attributionSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let attributionReaction;
let attributionStyle;
function inspectAttribution(node) {
  if (ts.isCallExpression(node) && node.expression.getText(attributionAst) === 'useAnimatedReaction') attributionReaction = node.arguments[1].getText(attributionAst);
  if (ts.isVariableDeclaration(node) && node.name.getText(attributionAst) === 'positionStyle') attributionStyle = node.initializer.arguments[0].getText(attributionAst);
  ts.forEachChild(node, inspectAttribution);
}
inspectAttribution(attributionAst);
const mutable = initial => ({ current: initial, get() { return this.current; }, set(value) { this.current = value; } });
let cancelled = 0;
const attributionContext = {
  Math, translateX: mutable(70), translateY: mutable(-80), opacity: mutable(.3), chromeReady: mutable(0),
  cancelAnimation: () => cancelled++, followControlsProgress: true, controlsOffset: 208,
  controlsProgress: mutable(.5), viewportWidth: 390,
};
const reactAttribution = evaluate(attributionReaction, attributionContext);
reactAttribution({ followControlsProgress: true, shown: true, offset: 208 }, { followControlsProgress: false });
assert.equal(cancelled, 3);
const position = evaluate(attributionStyle, attributionContext)();
assert.equal(position.opacity, 1);
assert.equal(position.transform[0].translateX, 0);
assert.equal(position.transform[1].translateY, -104, 'attribution follows the exact shared clip progress');
reactAttribution({ followControlsProgress: false, shown: false, offset: 0 }, { followControlsProgress: true });
assert.equal(cancelled, 6);
assert.equal(attributionContext.translateY.get(), 0, 'landscape clears stale portrait positioning');
console.log('Controls motion checks passed: expo-out stages, immediate interaction, two-clock coverage, reversals, reduced motion, hold/release/cancel, clip geometry and structural layer guards. Native touch/Metal/VoiceOver are unverified.');

// Inspect the declared React hierarchy and execute the real web SafeAreaView
// padding policy. Layout events below are synthetic, not Yoga/device captures.
const ancestors = [];
for (let node = dock.parent.parent; node; node = node.parent) {
  if (ts.isJsxElement(node)) ancestors.push(node.openingElement);
}
assert.deepEqual(ancestors.map(node => node.tagName.getText(ast)), ['SafeAreaView', 'View']);
assert.ok(ancestors[1].attributes.getText(ast).includes('style={styles.screen}'));
const safeArea = ancestors[0];
const styleObject = declarations.styles.arguments[0];
const style = name => evaluate(styleObject.properties.find(p => p.name.getText(ast) === name).initializer.getText(ast), { StyleSheet: { absoluteFill: {} } });
const bottomStyle = style('bottomArea');
assert.equal(bottomStyle.position, 'absolute');
assert.equal(bottomStyle.overflow, 'visible');
assert.equal(style('controlsWrap').overflow, 'visible');
assert.equal(style('screen').padding, undefined);
const edges = evaluate(declarations._stableEdges8.getText(ast), {});
assert.equal(edges.includes('bottom'), true);
assert.equal(edges.includes('top'), false);
const flatten = value => Array.isArray(value) ? Object.assign({}, ...value.map(flatten)) : value;
let safeInsets;
const safeModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'node_modules/react-native-safe-area-context/src/SafeAreaView.web.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports: safeModule.exports, require(name) {
  if (name === 'react') return { forwardRef: callback => callback, useMemo: callback => callback() };
  if (name === 'react/jsx-runtime') return { jsx: (tag, props) => ({ tag, props }) };
  if (name === 'react-native') return { StyleSheet: { flatten }, View: 'View' };
  if (name === './SafeAreaContext') return { useSafeAreaInsets: () => safeInsets };
  throw Error(`Unexpected SafeAreaView import ${name}`);
} });
const onLayout = opening => evaluate(opening.attributes.properties.find(p => p.name?.text === 'onLayout').initializer.expression.getText(ast), geometryContext);
const geometryContext = { dockLayout: { current: { y: 0, childY: 0 } }, dockTop: { value: 0 }, handleControlsDockLayout: () => {} };
for (const height of [667, 844]) for (const bottomInset of [0, 21, 34]) for (const contentHeight of [180, 240]) {
  safeInsets = { top: 59, bottom: bottomInset, left: 0, right: 0 };
  const resolved = flatten(safeModule.exports.SafeAreaView({ style: bottomStyle, edges }, null).props.style);
  assert.equal(resolved.paddingBottom, 10 + bottomInset);
  const areaHeight = contentHeight + resolved.paddingTop + resolved.paddingBottom;
  const areaTop = height - resolved.bottom - areaHeight;
  onLayout(safeArea)({ nativeEvent: { layout: { y: areaTop } } });
  onLayout(dock)({ nativeEvent: { layout: { y: resolved.paddingTop, height: contentHeight } } });
  assert.equal(geometryContext.dockTop.value, height - contentHeight + 15 - bottomInset, 'measured top already includes bottom safe area and bottom:-25');
  const computed = { screenHeight: height, lyricTop: 153, dockTop: geometryContext.dockTop, controlsOpacity: { value: 1 }, LYRICS_EDGE_FADE_HEIGHT, Math };
  assert.equal(evaluate(callback('fillTouchStyle'), computed)().top, areaTop);
  assert.equal(evaluate(callback('lyricsEdgeMaskSolidStyle'), computed)().height +
    evaluate(callback('lyricsEdgeMaskFadeStyle'), computed)().height + 153, areaTop);
}
const dockComponent = dock.parent.children.find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'PlaybackControlsDock');
assert.ok(ts.isJsxFragment(dockComponent.attributes.properties.find(p => p.name?.text === 'fullscreenActions').initializer.expression), 'portrait always supplies fullscreen actions');
const controlsSource = fs.readFileSync(path.join(root, 'components/lyrics/playback-controls.tsx'), 'utf8');
const controlsAst = ts.createSourceFile('controls.tsx', controlsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let bottomSlotStyle;
const revealWindows = [];
function inspectControls(node) {
  if (ts.isCallExpression(node) && node.expression.getText(controlsAst) === 'controlsStage') {
    revealWindows.push(node.arguments.slice(1, 3).map(argument => Number(argument.getText(controlsAst))));
    assert.equal(node.arguments[3].getText(controlsAst), 'controlsBackdropOffset?.value ?? 0', 'every animated row uses the coverage guard');
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(controlsAst) === 'bottomSlotStyle') bottomSlotStyle = node.initializer.arguments[0].getText(controlsAst);
  ts.forEachChild(node, inspectControls);
}
inspectControls(controlsAst);
assert.deepEqual(revealWindows, windows, 'production rows use the tested timeline, transport and utility windows');
assert.match(controlsSource, /card: \{[\s\S]*?overflow: 'visible'/);
// The utility slot may clip its fullscreen collapse, but the reveal transform
// belongs to the slot itself. Its contents travel together outside that clip.
assert.match(controlsSource, /styles.bottomSlot, bottomSlotStyle, utilityRevealStyle/);
assert.doesNotMatch(callback('fillTouchStyle'), /controlsStageProgress/);
assert.doesNotMatch(callback('lyricsEdgeMaskSolidStyle'), /controlsStageProgress/);
assert.doesNotMatch(callback('lyricsEdgeMaskFadeStyle'), /controlsStageProgress/);
for (const progress of [0, .25, .5, .75, 1]) {
  assert.equal(evaluate(bottomSlotStyle, { hasFullscreenActions: true, UTILITY_ROW_HEIGHT: 44, fullscreenAlbumProgress: { value: progress } })().height, 44, 'album morph never changes portrait dock slot height');
}
console.log('Controls geometry checks passed: declared native ancestor hierarchy, actual web safe-area padding, measured dock top and fixed fullscreen slot. Native layout/compositing costs remain unmeasured.');
require('./check-controls-lifecycle.cjs');
