require('./check-controls-reveal-routing.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = process.env.CONTROLS_LAYOUT_BASELINE
  ? execFileSync('git', ['show', `${process.env.CONTROLS_LAYOUT_BASELINE}:ExpoLyrics/app/(tabs)/index.tsx`], { encoding: 'utf8' })
  : fs.readFileSync(path.join(root, 'app/(tabs)/index.tsx'), 'utf8');
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
const { controlsShowEdge, controlsStage, controlsRowIsExposed, controlsTouchIsCovered } = helper.exports;
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
assert.match(source, /controlsProgress=\{controlsStageProgress\}/);
assert.doesNotMatch(source, /controlsBackdropOffset/);
assert.match(source, /controlsProgress=\{controlsOpacity\} controlsTarget=/, 'attribution retains geometry progress');
// Sample the configured native cubic easing, not a linear substitute, so early
// viewport assertions exercise the actual geometry trajectory.
const controlsEase = progress => {
  if (progress <= 0 || progress >= 1) return progress;
  const cubic = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let low = 0, high = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (low + high) / 2;
    if (cubic(mid, .16, .3) < progress) low = mid;
    else high = mid;
  }
  return cubic((low + high) / 2, 1, 1);
};
// Execute production scheduling. Complementary lyric/control masks guarantee
// coverage without making the rows inherit the moving backdrop's translation.
function motionHarness(initial) {
  let now = 0, interactive = initial === 1, visible = initial === 1;
  const completions = [];
  const makeProgress = () => ({
    current: initial, animation: null,
    get() {
      const animation = this.animation;
      if (!animation) return this.current;
      const elapsed = Math.max(0, Math.min(1, (now - animation.start - animation.delay) / animation.duration));
      return animation.from + (animation.target - animation.from) * animation.easing(elapsed);
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
    setControlsInteractive: next => { interactive = next; }, setControlsVisible: next => { visible = next; },
    cancelAnimation: progress => { progress.current = progress.get(); progress.animation = null; },
    controlsShowEdge, CONTROLS_EASE: controlsEase, ReanimatedEasing: { linear: 'linear' },
    withDelay: (delay, animation) => ({ ...animation, delay }),
    withTiming: (target, options, completion) => {
      assert.equal(options.duration, options.easing === 'linear' ? 700 : target === 1 ? 700 : 400);
      if (completion) completions.push(completion);
      return { target, duration: options.duration, completion, delay: 0, easing: options.easing === 'linear' ? value => value : options.easing };
    },
  };
  const animate = evaluate(callback('animateControls'), context);
  const rows = () => windows.map(([a, b]) => controlsStage(stage.get(), a, b));
  const surfaceContext = { Math, screenHeight: 844, lyricTop: 153, dockTop: { value: 624 }, controlsOpacity: geometry, controlsDockHeight: 220, LYRICS_EDGE_FADE_HEIGHT };
  const coverage = evaluate(callback('controlsCoverage'), surfaceContext);
  surfaceContext.controlsCoverage = { get value() { return coverage(); } };
  const surfaceStyles = ['lyricsEdgeMaskSolidStyle', 'lyricsEdgeMaskFadeStyle', 'fillTouchStyle', 'controlsCoverageClipStyle', 'controlsCoverageContentStyle']
    .map(name => evaluate(callback(name), surfaceContext));
  const surfaces = () => surfaceStyles.map(style => style());
  const assertCoverage = () => {
    const [solid, fade, fill, clip, content] = surfaces();
    assert.ok(Math.abs(624 + clip.top - fill.top) < 1e-9, 'control pixels start exactly where lyrics become fully transparent');
    assert.ok(Math.abs(153 + solid.height + fade.height - fill.top) < 1e-9);
    const contentOffset = content.marginTop ?? content.transform?.[0].translateY;
    assert.ok(Math.abs(clip.top + contentOffset) < 1e-9, 'clip movement never translates the rows');
    const clipHeight = clip.height ?? Math.max(36, 220 + (content.marginTop ?? 0) + 36);
    assert.ok(Math.abs(clipHeight + clip.marginBottom - 220) < 1e-9, 'clip bounds never resize the measured dock');
    rows().forEach(row => assert.ok(row.transform[0].translateY >= 0 && row.transform[0].translateY <= 36));
  };
  return {
    context, geometry, stage, completions, animate, rows, surfaces,
    get interactive() { return interactive; },
    get visible() { return visible; },
    tick(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed++) {
        now++;
        for (const progress of [geometry, stage]) {
          const animation = progress.animation;
          if (animation && now >= animation.start + animation.delay + animation.duration) {
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
  const surfacesBefore = JSON.stringify(h.surfaces());
  h.animate(!shown);
  assert.equal(h.interactive, !shown, 'reversal immediately applies the latest interaction target');
  assert.equal(h.geometry.get(), before[0], 'backing geometry never snaps on reversal');
  assert.equal(JSON.stringify(h.surfaces()), surfacesBefore, 'both masks and fill are continuous at reversal');
  assert.equal(h.stage.get(), before[1], 'row reversal never snaps');
  h.rows().forEach((row, index) => {
    assert.equal(row.opacity, rowsBefore[index].opacity);
    assert.equal(row.transform[0].translateY, rowsBefore[index].transform[0].translateY);
  });
  assert.equal(h.completions.length, 0, 'no stale animation completion can change interaction or accessibility');
  h.tick(1100);
  assert.equal(h.geometry.get(), initial);
  assert.equal(h.stage.get(), initial);
  assert.equal(h.interactive, initial === 1);
  h.animate(shown); h.tick(150); h.animate(!shown); h.tick(75); h.animate(shown); h.tick(1100);
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
// Both geometry and rows respond without a queued lead-in. Show geometry uses
// the row clock with a slight lead, hide retains the full reverse stagger.
const reveal = motionHarness(0);
reveal.animate(true);
assert.equal(reveal.interactive, true); assert.equal(reveal.geometry.get(), 0);
reveal.tick(16); assert.ok(reveal.geometry.get() > 0 && reveal.geometry.get() < 1);
assert.ok(reveal.rows()[0].opacity > 0);
assert.equal(reveal.rows()[1].opacity, 0); assert.equal(reveal.rows()[2].opacity, 0);
reveal.tick(125); assert.ok(reveal.rows()[1].opacity > 0); assert.equal(reveal.rows()[2].opacity, 0);
assert.equal(reveal.interactive, true, 'visible transport accepts input before finishing its reveal');
reveal.tick(140); assert.ok(reveal.rows()[2].opacity > 0);
reveal.tick(419); assert.equal(reveal.stage.get(), 1); assert.equal(reveal.geometry.get(), 1);
for (const elapsed of [1, 140, 280, 420, 560, 699]) {
  const h = motionHarness(0);
  h.animate(true); h.tick(elapsed);
  const lead = h.geometry.get() - h.stage.get();
  assert.ok(lead > 0 && lead <= .021, 'edge leads row clock only slightly');
  h.tick(700 - elapsed);
  assert.equal(h.geometry.get(), 1);
  assert.equal(h.stage.get(), 1);
}
reveal.animate(false); assert.equal(reveal.interactive, false);
reveal.tick(100); assert.equal(reveal.geometry.get(), 1);
assert.equal(reveal.rows()[0].transform[0].translateY, 0, 'timeline has not been pushed offscreen at 100ms');
reveal.tick(300); assert.equal(reveal.geometry.get(), 1);
assert.ok(reveal.rows()[0].opacity > .9, 'timeline remains visible at 400ms');
reveal.tick(300); assert.equal(reveal.stage.get(), 0); assert.equal(reveal.geometry.get(), 1);
reveal.tick(200); assert.ok(reveal.geometry.get() > 0 && reveal.geometry.get() < 1);
reveal.tick(200); assert.equal(reveal.geometry.get(), 0);
// Reverse while the backing mask retracts. Both masks, the badge's geometry
// driver and every row retain their exact value, including before the next frame.
reveal.animate(true); reveal.tick(700); reveal.animate(false); reveal.tick(850);
assert.equal(reveal.stage.get(), 0);
const backingBefore = reveal.geometry.get(); const maskBefore = JSON.stringify(reveal.surfaces());
reveal.animate(true);
assert.equal(reveal.geometry.get(), backingBefore); assert.equal(JSON.stringify(reveal.surfaces()), maskBefore);
assert.equal(reveal.stage.get(), 0);
reveal.tick(1100); assert.equal(reveal.geometry.get(), 1); assert.equal(reveal.stage.get(), 1);
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
  assert.equal(attribute('pointerEvents'), settled || fullscreen ? 'box-none' : 'none');
  assert.equal(attribute('accessibilityElementsHidden'), !settled && !fullscreen);
  assert.equal(attribute('importantForAccessibility'), !settled && !fullscreen ? 'no-hide-descendants' : 'auto');
}
assert.match(source, /controlsInteractive \|\| fullscreenAlbumMode \? "box-none" : "none"/);
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
let attributionGlassStyle;
function inspectAttribution(node) {
  if (ts.isCallExpression(node) && node.expression.getText(attributionAst) === 'useAnimatedReaction') attributionReaction = node.arguments[1].getText(attributionAst);
  if (ts.isVariableDeclaration(node) && node.name.getText(attributionAst) === 'positionStyle') attributionStyle = node.initializer.arguments[0].getText(attributionAst);
  if (ts.isVariableDeclaration(node) && node.name.getText(attributionAst) === 'glassStyle') attributionGlassStyle = node.initializer.arguments[0].getText(attributionAst);
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
// Exercise actual mask and attribution style callbacks across rapid reversals,
// including a reversal while the empty backing mask retracts. Exact continuity
// is checked at the request, then bounded at 1ms intervals with native easing.
for (const initial of [0, 1]) for (const interruption of [16, 48, 150, 399, 700, 850]) {
  const h = motionHarness(initial);
  const badgeContext = { ...attributionContext, followControlsProgress: true, controlsProgress: h.geometry };
  const badge = evaluate(attributionStyle, badgeContext);
  const glass = evaluate(attributionGlassStyle, badgeContext);
  const snapshot = () => ({ masks: h.surfaces(), badge: badge(), glass: glass(), rows: h.rows() });
  h.animate(initial === 0); h.tick(interruption);
  const before = JSON.stringify(snapshot());
  h.animate(initial !== 0);
  assert.equal(JSON.stringify(snapshot()), before, 'mask, badge, glass and rows never jump on reversal');
  let previous = snapshot();
  for (let elapsed = 0; elapsed < 1100; elapsed++) {
    h.tick(1);
    const current = snapshot();
    const coordinates = state => [state.masks[0].height, state.masks[1].height,
      state.masks[1].transform[0].translateY, state.masks[2].top, state.masks[3].top];
    coordinates(current).forEach((value, index) => assert.ok(Math.abs(value - coordinates(previous)[index]) < 10,
      'mask geometry changes continuously, including the first frame after reversal'));
    assert.ok(Math.abs(current.badge.transform[1].translateY - previous.badge.transform[1].translateY) < 8);
    assert.equal(current.badge.opacity, previous.badge.opacity);
    assert.ok(Math.abs(current.glass.opacity - previous.glass.opacity) < .04);
    current.rows.forEach((row, index) => {
      assert.ok(Math.abs(row.transform[0].translateY - previous.rows[index].transform[0].translateY) < 1);
      assert.ok(Math.abs(row.opacity - previous.rows[index].opacity) < .02);
    });
    previous = current;
  }
}
console.log('Controls motion checks passed: expo-out stages, immediate interaction, backdrop hold, viewport row motion, reversals, reduced motion, hold/release/cancel, clip geometry and structural layer guards. Native touch/Metal/VoiceOver are unverified.');

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
assert.equal(style('controlsCoverageClip').paddingBottom, 36);
assert.equal(style('controlsCoverageClip').overflow, 'hidden', 'native bounds clip touch dispatch as well as pixels');
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
const clipElement = dock.parent.children.find(node => ts.isJsxElement(node) && node.openingElement.attributes.getText(ast).includes('styles.controlsCoverageClip'));
assert.equal(clipElement.openingElement.tagName.getText(ast), 'Reanimated.View');
assert.match(clipElement.openingElement.attributes.getText(ast), /pointerEvents="box-none"/);
assert.doesNotMatch(source, /controlsCoverageMask/);
const clipContent = clipElement.children.find(node => ts.isJsxElement(node) && node.openingElement.attributes.getText(ast).includes('controlsCoverageContentStyle'));
assert.match(clipContent.openingElement.attributes.getText(ast), /pointerEvents="box-none"/);
assert.match(clipContent.openingElement.attributes.getText(ast), /handleControlsDockLayout\(event.nativeEvent.layout.height\)/, 'measure the unshrunk content, never the moving clip height');
const dockComponent = clipContent.children.find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'PlaybackControlsDock');
// Resolve the actual JSX policy, including stale stored lyrics in the empty
// player and an active track whose lyrics have not arrived yet.
let revealOpening, revealPress;
const lyricInteractions = [];
function inspectReveal(node) {
  if (ts.isJsxOpeningElement(node) && node.attributes.getText(ast).includes('styles.controlsRevealZone')) {
    revealOpening = node;
    revealPress = node.parent.children.find(child => ts.isJsxSelfClosingElement(child) && child.tagName.getText(ast) === 'Pressable');
  }
  if (ts.isJsxSelfClosingElement(node) && ['RustLyricsView', 'AmllLyricsView', 'SpicyLyricsView'].includes(node.tagName.getText(ast))) {
    lyricInteractions.push(node.attributes.properties.find(property => property.name?.text === 'onUserInteraction').initializer.expression.getText(ast));
  }
  ts.forEachChild(node, inspectReveal);
}
inspectReveal(ast);
assert.ok(lyricInteractions.length >= 3);
assert.ok(lyricInteractions.every(expression => expression === 'handleControlsInteraction'));
assert.ok(revealOpening && revealPress);
const revealStyleExpression = revealOpening.attributes.properties.find(property => property.name?.text === 'style').initializer.expression.getText(ast);
const revealPolicy = evaluate(`(showEmptyState, lyrics, fillTouchStyle, styles) => (${revealStyleExpression})`, {});
const revealPressExpression = revealPress.attributes.properties.find(property => property.name?.text === 'onPress').initializer.expression.getText(ast);
for (const height of [390, 667, 844]) for (const scenario of [
  { empty: true, lyrics: [] }, { empty: true, lyrics: [{}] },
  { empty: false, lyrics: [] }, { empty: false, lyrics: [{}] },
]) {
  const h = motionHarness(0);
  const fill = evaluate(callback('fillTouchStyle'), { Math, screenHeight: height, dockTop: { value: height - 220 }, controlsOpacity: h.geometry });
  const top = () => {
    const resolved = Object.assign({}, ...revealPolicy(scenario.empty, scenario.lyrics, fill(), {
      controlsRevealZone: style('controlsRevealZone'),
    }));
    return typeof resolved.top === 'string' ? height * parseFloat(resolved.top) / 100 : resolved.top;
  };
  assert.equal(top(), height * .6);
  let reveals = 0;
  let seeks = 0;
  const revealPressHandler = evaluate(revealPressExpression, { handleControlsInteraction: () => { reveals++; h.animate(true); } });
  const tap = y => {
    if (y >= top()) revealPressHandler();
    else seeks++;
  };
  for (const fraction of [.6, .6001, .9, 1]) tap(height * fraction);
  assert.equal(reveals, 4);
  assert.equal(seeks, 0);
  tap(height * .5999);
  assert.equal(seeks, 1);
  assert.equal(reveals, 4);
  revealPressHandler(); h.tick(1100);
  assert.equal(h.visible, true); assert.equal(h.geometry.get(), 1);
}

assert.equal(style('controlsRevealZone').top, '60%');
assert.equal(style('controlsRevealZone').zIndex, 20);
for (const edge of ['bottom', 'left', 'right']) assert.equal(style('controlsRevealZone')[edge], 0);
const termination = revealPress.attributes.properties.find(p => p.name?.text === 'onResponderTerminationRequest');
assert.equal(evaluate(termination.initializer.expression.getText(ast), {})(), false,
  'a reveal press cannot transfer to an underlying renderer');
assert.equal(revealPressExpression, 'handleControlsInteraction', 'reveal has no seek or selection callback');

assert.match(source, /controlsProgress=\{controlsStageProgress\}\s+controlsCoverage=\{controlsCoverage\}/);
assert.match(source, /controlsProgress=\{controlsProgress\}\s+controlsCoverage=\{controlsCoverage\}/);
assert.ok(ts.isJsxFragment(dockComponent.attributes.properties.find(p => p.name?.text === 'fullscreenActions').initializer.expression), 'portrait always supplies fullscreen actions');
const controlsSource = fs.readFileSync(path.join(root, 'components/lyrics/playback-controls.tsx'), 'utf8');
const controlsAst = ts.createSourceFile('controls.tsx', controlsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let bottomSlotStyle;
let controlStyles;
let rowAccessHook;
const timelineGestureCallbacks = {};
const rowStyleCallbacks = {};
const revealWindows = [];
function inspectControls(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'useControlsRowAccess') rowAccessHook = node.getText(controlsAst);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['onTouchesDown', 'onBegin', 'onFinalize'].includes(node.expression.name.text)) {
    timelineGestureCallbacks[node.expression.name.text] = node.arguments[0].getText(controlsAst);
  }
  if (ts.isVariableDeclaration(node)) {
    const name = node.name.getText(controlsAst);
    if (name === 'styles') controlStyles = node.initializer.arguments[0];
    if (['timelineRevealStyle', 'transportRevealStyle', 'utilityRevealStyle'].includes(name)) {
      rowStyleCallbacks[name] = node.initializer.arguments[0].getText(controlsAst);
    }
  }
  if (ts.isCallExpression(node) && node.expression.getText(controlsAst) === 'controlsStage') {
    revealWindows.push(node.arguments.slice(1, 3).map(argument => Number(argument.getText(controlsAst))));
    assert.equal(node.arguments.length, 3, 'row translations are independent of backing geometry');
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(controlsAst) === 'bottomSlotStyle') bottomSlotStyle = node.initializer.arguments[0].getText(controlsAst);
  ts.forEachChild(node, inspectControls);
}
inspectControls(controlsAst);
const createRowAccess = evaluate(rowAccessHook, {
  controlsRowIsExposed,
  useSharedValue: value => ({ value }),
  useDerivedValue: callback => ({ get value() { return callback(); } }),
  useAnimatedProps: callback => callback,
});
for (const name of ['timeline', 'transport', 'utility']) {
  assert.match(controlsSource, new RegExp(`animatedProps=\\{${name}Access.animatedProps\\}`));
  assert.match(controlsSource, new RegExp(`${name}Access.layout.value = \\{ top: event.nativeEvent.layout.y, height: event.nativeEvent.layout.height \\}`));
}
assert.match(controlsSource, /interactionAllowed=\{timelineAccess.allowed\}/);
assert.match(controlsSource, /interactionCoverage=\{controlsCoverage\}/);
assert.match(controlsSource, /pointerEvents="box-none"\s+style=\{\[\s+styles.card/);
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
// Quantify viewport intersections using production row style callbacks and
// synthetic measured row heights, including timeline font-height variation.
// These are geometry regressions, not native Yoga or device captures.
const controlStyle = name => evaluate(controlStyles.properties.find(property => property.name.getText(controlsAst) === name).initializer.getText(controlsAst), {});
const card = controlStyle('card');
const transportHeight = controlStyle('playButtonShell').height + controlStyle('controlsRow').paddingTop;
const utilityHeight = 44;
for (const height of [390, 667, 844]) for (const bottomInset of [0, 21, 34]) for (const timelineHeight of [38, 46]) {
  const rowHeights = [timelineHeight, transportHeight, utilityHeight];
  const contentHeight = card.paddingTop + rowHeights.reduce((sum, value) => sum + value, 0) + 2 * card.gap + card.paddingBottom;
  // Same native safe-area/bottom:-25 dock placement covered above.
  const dockTop = height - contentHeight + 15 - bottomInset;
  const layoutTops = [card.paddingTop, card.paddingTop + timelineHeight + card.gap,
    card.paddingTop + timelineHeight + 2 * card.gap + transportHeight];
  for (const shown of [true, false]) {
    const h = motionHarness(shown ? 0 : 1);
    const rowStyles = ['timelineRevealStyle', 'transportRevealStyle', 'utilityRevealStyle'].map(name =>
      evaluate(rowStyleCallbacks[name], { controlsStage, controlsProgress: h.stage }));
    const viewportContext = { Math, screenHeight: height, dockTop: { value: dockTop }, controlsOpacity: h.geometry, controlsDockHeight: contentHeight };
    const coverageForViewport = evaluate(callback('controlsCoverage'), viewportContext);
    viewportContext.controlsCoverage = { get value() { return coverageForViewport(); } };
    const clipForViewport = evaluate(callback('controlsCoverageClipStyle'), viewportContext);
    const rowAccess = windows.map(([start, end], index) => {
      const access = createRowAccess(h.stage, start, end, viewportContext.controlsCoverage);
      access.layout.value = { top: layoutTops[index], height: rowHeights[index] };
      return access;
    });
    const edgeForViewport = evaluate(callback('fillTouchStyle'), viewportContext);
    const badgeForViewport = evaluate(attributionStyle, { ...attributionContext,
      controlsOffset: Math.max(0, contentHeight - 12), controlsProgress: h.geometry, followControlsProgress: true });
    h.animate(shown);
    let previousTime = 0;
    let previousOffsets = shown ? [36, 36, 36] : [0, 0, 0];
    for (const time of [16, 32, 48, 80, 100, 150, 200, 281, 350, 420, 490, 560, 630, 699, 700]) {
      h.tick(time - previousTime); previousTime = time;
      const rows = rowStyles.map(style => style());
      const offsets = rows.map(row => row.transform[0].translateY);
      const badgeBottom = height - bottomInset - 10 + badgeForViewport().transform[1].translateY;
      for (const badgeHeight of [24, 32]) {
        assert.ok(badgeBottom <= height && badgeBottom - badgeHeight >= 0, 'attribution stays in the viewport throughout smooth motion');
      }
      rows.forEach((row, index) => {
        const offset = offsets[index];
        assert.ok(offset >= 0 && offset <= 36, 'actual wrapper offset never inherits the backing travel');
        assert.ok(shown ? offset <= previousOffsets[index] : offset >= previousOffsets[index]);
        const top = dockTop + layoutTops[index] + offset;
        const bottom = top + rowHeights[index];
        const edge = edgeForViewport().top;
        const clipTop = dockTop + clipForViewport().top;
        const viewportPixels = Math.max(0, Math.min(height, bottom) - Math.max(0, top, clipTop));
        const access = rowAccess[index];
        const props = access.animatedProps();
        const exposed = row.opacity > 0 && viewportPixels > 0;
        assert.equal(access.allowed.value, exposed, 'UI-thread eligibility matches actual rendered row intersection');
        assert.equal(props.pointerEvents, exposed ? 'box-none' : 'none');
        assert.equal(props.accessibilityElementsHidden, !exposed);
        assert.equal(props.importantForAccessibility, exposed ? 'auto' : 'no-hide-descendants');
        if (!exposed) {
          assert.equal(h.interactive && props.pointerEvents !== 'none', false, 'fully hidden rows cannot receive touches');
          assert.equal(h.interactive && !props.accessibilityElementsHidden, false, 'fully hidden rows cannot expose accessibility descendants');
        } else if (shown) {
          assert.equal(h.interactive && props.pointerEvents === 'box-none', true, 'visible rows become interactive without waiting for motion completion');
        }
        // Real clipping view excludes coordinates above its native bounds. All
        // ancestors are box-none and both reveal/fill zones start at this edge.
        for (const y of [clipTop - 1, clipTop - 16]) {
          assert.equal(y >= clipTop && y < clipTop + contentHeight + 36, false, 'uncovered lyric coordinates fall outside the native dock hit bounds');
          assert.ok(y < edge + 1e-9, 'the fill and reveal zone cannot intercept that lyric coordinate');
        }

        if (viewportPixels > 0 && row.opacity > 0) {
          assert.ok(Math.max(top, clipTop) >= edge - 1e-9, 'every rendered control pixel is below the fully transparent lyric edge');
        }
        if (row.opacity > 0 && !shown) {
          assert.ok(viewportPixels > 0, 'backdrop never evicts a staggered row during hide');
          if (index < 2) assert.ok(Math.abs(viewportPixels - rowHeights[index]) < 1e-9);
          if (row.opacity >= .5) assert.ok(viewportPixels >= rowHeights[index] / 2);
        }
        if (shown && time === 48 && index === 0) {
          assert.ok(h.geometry.get() > h.stage.get(), 'show edge slightly leads the unchanged row clock');
          assert.ok(offset > 14 && row.opacity > 0 && row.opacity < 1, 'first visible timeline retains a perceptible independent slide');
        }
        if (shown && time === 150 && index === 1) {
          assert.ok(offset > 25 && row.opacity > 0, 'transport keeps its original stagger and slide while the show clip advances');
        }
      });
      if (!shown && time === 100) {
        assert.equal(offsets[0], 0); assert.equal(rows[0].opacity, 1);
        assert.equal(offsets[1], 0); assert.equal(rows[1].opacity, 1);
        assert.ok(offsets[2] > 0 && offsets[2] < 1);
      }
      if (shown && time === 350) {
        assert.ok(offsets[0] < offsets[1] && offsets[1] < offsets[2]);
        assert.ok(rows[0].opacity > rows[1].opacity && rows[1].opacity > rows[2].opacity);
      }
      if (!shown && time === 490) {
        assert.equal(rows[2].opacity, 0);
        assert.ok(rows[0].opacity > rows[1].opacity && rows[1].opacity > 0);
        assert.ok(offsets[1] > 1 && offsets[1] < 36, 'transport reverse slide is visible while timeline remains above it in its own window');
      }
      if (!shown && time === 630) {
        assert.equal(rows[1].opacity, 0); assert.equal(rows[2].opacity, 0);
        assert.ok(rows[0].opacity > 0 && offsets[0] > 1 && offsets[0] < 36, 'timeline visibly finishes last');
      }
      previousOffsets = offsets;
    }
  }
}
// No JS-state round trip: the production row hook changes native props as its
// measured rectangle, stage opacity and coverage intersection change on UI.
const unmeasured = createRowAccess({ value: 1 }, 0, .6, undefined);
assert.equal(unmeasured.allowed.value, false, 'unmeasured rows stay inert even at fully shown progress');
unmeasured.layout.value = { top: 16, height: 38 };
assert.equal(unmeasured.allowed.value, true);
const inputHarness = motionHarness(0);
const inputContext = { Math, screenHeight: 844, dockTop: { value: 624 }, controlsOpacity: inputHarness.geometry };
const inputCoverage = evaluate(callback('controlsCoverage'), inputContext);
const inputCoverageShared = { get value() { return inputCoverage(); } };
const measuredRows = [{ top: 16, height: 38 }, { top: 64, height: 88 }, { top: 162, height: 44 }];
const inputAccess = windows.map(([start, end], index) => {
  const access = createRowAccess(inputHarness.stage, start, end, inputCoverageShared);
  assert.equal(access.allowed.value, false, 'unmeasured rows start inert and inaccessible');
  access.layout.value = measuredRows[index];
  return access;
});
const timelineInput = inputAccess[0].allowed;
let failures = 0, previews = 0, seeks = 0, cancellations = 0;
const scrubActive = { value: false };
const guardContext = {
  interactionAllowed: timelineInput, interactionCoverage: inputCoverageShared, controlsTouchIsCovered, Math, trackWidth: 200,
  isScrubbingShared: scrubActive, scrubProgress: { value: 0 }, trackScaleY: { value: 1 },
  lastScrubJsCallAt: { value: 0 }, pendingSeekPositionMsShared: { value: null }, maxDuration: 100000,
  onUserInteraction: () => {}, setIsScrubbing: () => {}, flushScrubPreview: () => previews++,
  finishScrub: () => seeks++, cancelScrub: () => cancellations++,
  runOnJS: fn => fn, withTiming: value => value,
};
const touchDown = evaluate(timelineGestureCallbacks.onTouchesDown, guardContext);
const beginScrub = evaluate(timelineGestureCallbacks.onBegin, guardContext);
const finalizeScrub = evaluate(timelineGestureCallbacks.onFinalize, guardContext);
inputHarness.animate(true); inputHarness.tick(16);
assert.equal(timelineInput.value, false, 'timeline is entirely masked at 16ms');
touchDown({ allTouches: [{ absoluteY: 675 }] }, { fail: () => failures++ });
beginScrub({ x: 100, absoluteY: 675 }); finalizeScrub({ x: 100 }, false);
assert.equal(failures, 1); assert.equal(previews, 0); assert.equal(seeks, 0); assert.equal(cancellations, 0);
assert.equal(scrubActive.value, false, 'invisible touch cannot enter scrubbing');
inputHarness.tick(16);
const trackTop = measuredRows[0].top + controlsStage(inputHarness.stage.get(), ...windows[0]).transform[0].translateY;
assert.ok(trackTop + 18 < inputCoverage().top, 'the scrub track remains entirely clipped at 32ms even if its time labels start appearing');
assert.equal(Math.max(0, Math.min(trackTop + 18, 220) - Math.max(trackTop, inputCoverage().top)), 0,
  'no native hit-test coordinate intersects the hidden track');
const hiddenTrackY = 624 + trackTop + 9;
touchDown({ allTouches: [{ absoluteY: hiddenTrackY }] }, { fail: () => failures++ });
beginScrub({ x: 100, absoluteY: hiddenTrackY });
assert.equal(failures, 2); assert.equal(previews, 0); assert.equal(scrubActive.value, false);
inputHarness.tick(118);
assert.equal(timelineInput.value, true);
touchDown({ allTouches: [{ absoluteY: 650 }] }, { fail: () => failures++ }); beginScrub({ x: 100, absoluteY: 650 });
assert.equal(failures, 2); assert.equal(previews, 1); assert.equal(scrubActive.value, true);
assert.equal(inputHarness.interactive, true, 'visible scrub accepts input before 700ms completion');
// Losing eligibility cancels rather than committing an invisible seek.
inputHarness.context.liveReducedMotion = true; inputHarness.animate(false);
finalizeScrub({ x: 100 }, true);
assert.equal(seeks, 0); assert.equal(cancellations, 1); assert.equal(scrubActive.value, false);
for (const access of inputAccess) {
  assert.equal(access.animatedProps().pointerEvents, 'none');
  assert.equal(access.animatedProps().accessibilityElementsHidden, true);
}
inputHarness.animate(true);
for (const access of inputAccess) {
  assert.equal(access.allowed.value, true);
  assert.equal(access.animatedProps().accessibilityElementsHidden, false);
}
// Eligibility tracks the rendered intersection every sampled millisecond across
// rapid reversals and a reversal while only the empty backdrop is retracting.
inputHarness.context.liveReducedMotion = false;
for (const [shown, duration] of [[false, 75], [true, 20], [false, 850], [true, 200], [false, 1100]]) {
  inputHarness.animate(shown);
  for (let elapsed = 0; elapsed < duration; elapsed++) {
    inputHarness.tick(1);
    inputAccess.forEach((access, index) => {
      const row = controlsStage(inputHarness.stage.get(), ...windows[index]);
      const top = measuredRows[index].top + row.transform[0].translateY;
      const pixels = Math.max(0, Math.min(top + measuredRows[index].height, 220) - Math.max(top, inputCoverage().top));
      const expected = row.opacity > 0 && pixels > 0;
      assert.equal(access.allowed.value, expected);
      assert.equal(access.animatedProps().accessibilityElementsHidden, !expected);
    });
  }
}
// Execute the production mode handlers, measurement policy and clip worklets.
// Intrinsic row sizes and native layout events are supplied, not UIKit/Yoga.
// Unlike the viewport-only checks above, feed layout back into the next frame
// and deliver size changes while the old policy would discard measurements.
for (const scenario of ['normal', 'restoring', 'empty']) for (const bottomInset of [0, 21, 34]) {
  const h = motionHarness(1);
  const context = {
    Math, screenHeight: 844, controlsDockHeight: 0,
    controlsOpacity: h.geometry, dockTop: { value: 844 },
    dockLayout: { current: { y: 844, childY: 0 } },
    fullscreenAlbumModeRef: { current: false }, albumArtworkMorphingRef: { current: false },
    setControlsDockHeight: value => { context.controlsDockHeight = value; },
    setFullscreenAlbumMode: value => { context.fullscreenAlbumModeRef.current = value; },
    setAlbumArtworkMorphing: value => { context.albumArtworkMorphingRef.current = value; },
    setScrubPreviewPositionMs: () => {}, setTopBarMounted: () => {},
    usePlayerTourStore: { getState: () => ({ advance() {} }) },
    showControls: () => { h.context.fullscreenAlbumModeRef.current = true; h.animate(true); },
  };
  const measure = evaluate(callback('handleControlsDockLayout'), context);
  const enter = evaluate(callback('handleShowFullscreenAlbum'), context);
  const leave = evaluate(callback('handleShowLyrics'), context);
  const finish = evaluate(callback('finishLyricsModeTransition'), context);
  const coverage = evaluate(callback('controlsCoverage'), context);
  context.controlsCoverage = { get value() { return coverage(); } };
  const clip = evaluate(callback('controlsCoverageClipStyle'), context);
  const content = evaluate(callback('controlsCoverageContentStyle'), context);
  const layoutEvent = opening => evaluate(opening.attributes.properties.find(p => p.name?.text === 'onLayout').initializer.expression.getText(ast), context);
  // Model Yoga's minimum padding height, including any negative layout margin.
  // Transforms affect pixel positions but never the parent's occupied height.
  const layoutFrame = (intrinsic, height = context.screenHeight) => {
    context.screenHeight = height;
    for (let frame = 0; frame < 4; frame++) {
      const bounds = clip(), inner = content();
      assert.equal(bounds.height, undefined, `${scenario}: clipping cannot impose an at-most height on intrinsic content`);
      measure(intrinsic);
      assert.equal(context.controlsDockHeight, intrinsic, `${scenario}: measurements survive fullscreen and morph`);
      const clipHeight = Math.max(36, intrinsic + (inner.marginTop ?? 0) + 36);
      const occupied = clipHeight + bounds.marginBottom;
      assert.ok(Math.abs(occupied - intrinsic) < 1e-9, 'hide/show cannot change bottom-anchored layout height');
      layoutEvent(safeArea)({ nativeEvent: { layout: { y: height + 25 - occupied - 10 - bottomInset } } });
      layoutEvent(dock)({ nativeEvent: { layout: { y: 0 } } });
      assert.ok(Math.abs(context.dockTop.value - (height - intrinsic + 15 - bottomInset)) < 1e-9);
      const contentOffset = (inner.marginTop ?? 0) + (inner.transform?.[0].translateY ?? 0);
      assert.ok(Math.abs(bounds.top + contentOffset) < 1e-9, 'rows remain stationary as the native clip moves');
    }
  };
  layoutFrame(220);
  h.animate(false); h.tick(1100); layoutFrame(220);
  enter(); // Entry during a hidden dock snaps both reveal clocks to shown.
  assert.equal(h.geometry.get(), 1); assert.equal(h.stage.get(), 1);
  layoutFrame(228); // First changed measurement arrives during the morph.
  finish(); layoutFrame(236); // Font/metadata change while fully in album mode.
  assert.equal(context.fullscreenAlbumModeRef.current, true);
  const rowTop = context.dockTop.value + 16;
  assert.ok(rowTop >= 0 && rowTop + 38 + 10 + transportHeight < 844 - bottomInset,
    'fullscreen timeline and transport remain above the safe area');
  leave(); layoutFrame(224); finish();
  h.context.fullscreenAlbumModeRef.current = false;
  h.animate(false); h.tick(850); layoutFrame(224);
  h.animate(true); h.tick(700); layoutFrame(224);
  // Rotation remounts portrait controls after landscape, potentially in album
  // mode before a normal-mode measurement has ever been accepted.
  enter(); context.controlsDockHeight = 0; layoutFrame(180, 390);
  finish(); layoutFrame(244, 844); leave(); layoutFrame(244); finish();
}
// Regression for Yoga's min-padding clamp reported by the reviewer. Use the
// production styles with offsets on both sides of intrinsic height, including
// the hidden safe-area-34 offset H + 19 and the reported H=220, offset=300.
// This models that sizing rule, not the complete Yoga implementation.
for (const intrinsic of [180, 220, 244]) for (const inset of [0, 34]) for (const measured of [0, 100, 300]) {
  const viewport = 844, padding = style('controlsCoverageClip').paddingBottom;
  const expectedTop = viewport - intrinsic + 15 - inset;
  const context = {
    Math, controlsDockHeight: measured, screenHeight: viewport,
    dockTop: { value: expectedTop }, controlsOpacity: { value: 0 },
  };
  const productionCoverage = evaluate(callback('controlsCoverage'), context);
  const sharedCoverage = { value: { top: 0 } };
  context.controlsCoverage = sharedCoverage;
  const clip = evaluate(callback('controlsCoverageClipStyle'), context);
  const content = evaluate(callback('controlsCoverageContentStyle'), context);
  const frame = offset => {
    sharedCoverage.value = { originY: context.dockTop.value, top: offset,
      bottom: viewport - context.dockTop.value };
    const bounds = clip(), inner = content();
    const nativeHeight = Math.max(padding, intrinsic + (inner.marginTop ?? 0) + padding);
    const occupied = nativeHeight + bounds.marginBottom;
    const outerTop = viewport + 25 - occupied - 10 - inset;
    assert.ok(Math.abs(outerTop - expectedTop) < 1e-9,
      `Yoga padding clamp cannot move outer top: H=${intrinsic}, offset=${offset}, inset=${inset}, measured=${measured}`);
    assert.equal(nativeHeight, intrinsic + padding, 'native clip size is independent of coverage and stale measurement');
    const contentOffset = (inner.marginTop ?? 0) + (inner.transform?.[0].translateY ?? 0);
    assert.ok(Math.abs(bounds.top + contentOffset) < 1e-9, 'counter-translation preserves row pixel positions');
    assert.equal(bounds.top, offset, 'native hit bounds begin at the actual coverage edge');
    // Return the native layout event to the production coverage calculation.
    context.dockTop.value = outerTop;
    return { top: outerTop + bounds.top, bottom: outerTop + bounds.top + nativeHeight };
  };
  for (const offset of [0, intrinsic - .01, intrinsic, intrinsic + .01, intrinsic + 19, intrinsic + 80]) frame(offset);
  for (const progress of [0, .05, .3, .8, 1, .7, .2, 0, 1]) {
    context.controlsOpacity.value = progress;
    for (let feedback = 0; feedback < 8; feedback++) {
      const coverage = productionCoverage();
      const native = frame(coverage.top);
      assert.ok(Math.abs(native.top - (viewport - (viewport - expectedTop) * progress)) < 1e-9,
        'hide/show feedback preserves alignment with the lyric mask');
      if (progress === 0) {
        assert.ok(Math.abs(native.top - viewport) < 1e-9, 'fully hidden clip has no in-viewport hit bounds');
        assert.equal(controlsTouchIsCovered(viewport - 1, coverage), false, 'hidden scrubber cannot intercept the last screen pixel');
      }
      if (progress === 1) {
        assert.equal(native.top, expectedTop);
        assert.equal(controlsTouchIsCovered(expectedTop + 20, coverage), true, 'shown timeline hit targets remain covered');
      }
    }
  }
}
console.log('Controls geometry checks passed: safe areas, Yoga minimum-padding clamp model, fullscreen entry/morph/return measurements and layout feedback. Native Yoga/compositing remain unverified.');
require('./check-controls-lifecycle.cjs');

let attributionLayer;
function findAttributionLayer(node) {
  if (ts.isJsxOpeningElement(node) && node.attributes.getText(ast).includes('styles.lyricsAttributionLayer')) attributionLayer = node;
  ts.forEachChild(node, findAttributionLayer);
}
findAttributionLayer(ast);
const attributionPointer = attributionLayer.attributes.properties.find(p => p.name?.text === 'pointerEvents').initializer.expression.getText(ast);
for (const visible of [false, true]) {
  assert.equal(evaluate(attributionPointer, { isLandscape: false, controlsVisible: visible, fullscreenAlbumMode: false, albumArtworkMorphing: false }), visible ? 'box-none' : 'none',
    'attribution above zIndex 20 cannot intercept a hidden-controls reveal tap');
}
