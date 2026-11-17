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
const windows = [[0, .70], [.15, .85], [.30, 1]];
for (const progress of [-1, 0, .125, .375, .625, .9975, 1, 2]) {
  const stages = windows.map(([a, b]) => controlsStage(progress, a, b));
  for (const stage of stages) {
    assert.ok(stage.opacity >= 0 && stage.opacity <= 1);
    assert.ok(stage.transform[0].translateY >= 0 && stage.transform[0].translateY <= 8);
  }
  assert.ok(stages[0].opacity >= stages[1].opacity && stages[1].opacity >= stages[2].opacity);
}
assert.match(source, /bezier\(0\.16, 1, 0\.3, 1\)/);
// Deterministic clock substitute tests the real transition callbacks, including
// stale completions. Native Reanimated interpolation and hit testing need a phone.
for (const interruption of [50, 150, 250, 399]) {
  let now = 0, value = 0, animation = null, interactive = false;
  const completions = [];
  const progress = {
    get: () => animation ? animation.from + (animation.target - animation.from) * Math.min(1, (now - animation.start) / 400) : value,
    set value(next) {
      if (typeof next === 'number') { value = next; animation = null; }
      else { animation = { ...next, from: value, start: now }; }
    },
  };
  const context = {
    ...common, controlsGeneration: { current: 0 }, controlsOpacity: progress,
    liveReducedMotion: false, fullscreenAlbumModeRef: { current: false },
    setControlsInteractive: next => { interactive = next; }, setControlsVisible: () => {},
    cancelAnimation: () => { value = progress.get(); animation = null; },
    CONTROLS_EASE: 'configured cubic', runOnJS: fn => fn,
    withTiming: (target, options, completion) => {
      assert.equal(options.duration, 400);
      completions.push(completion);
      return { target };
    },
  };
  context.finishControlsTransition = evaluate(callback('finishControlsTransition'), context);
  const animate = evaluate(callback('animateControls'), context);
  animate(true);
  now = interruption;
  const before = progress.get();
  const stagesBefore = windows.map(([a, b]) => controlsStage(before, a, b).opacity);
  animate(false);
  assert.equal(progress.get(), before, `no snap when reversed at ${interruption}ms`);
  windows.forEach(([a, b], index) => assert.equal(controlsStage(progress.get(), a, b).opacity, stagesBefore[index]));
  completions[0](true);
  assert.equal(interactive, false, 'stale reveal cannot enable hidden controls');
  animate(true);
  completions[1](true);
  assert.equal(interactive, false, 'stale hide cannot alter new reveal');
  now += 400;
  completions[2](true);
  assert.equal(interactive, true);
  context.liveReducedMotion = true;
  animate(false);
  assert.equal(progress.get(), 0);
  assert.equal(interactive, false);
  animate(true);
  assert.equal(progress.get(), 1);
  assert.equal(interactive, true);
}
// Execute actual touch handlers and idle callback, with a fake timer.
for (const gesture of ['scrub', 'previous long hold', 'next long hold']) {
  for (const terminal of ['onTouchEnd', 'onTouchCancel']) {
    let pending = null, hidden = 0;
    const context = {
      controlsTouchActive: { current: false }, controlsScrubActive: { current: false }, controlsIdleTimerRef: { current: null },
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
      handler('onTouchCancel')();
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
// The changing wrapper is a clip, never the native renderer's viewport.
assert.match(source, /collapsable=\{false\}\s+style=\{\[styles.lyricsWrap, lyricsViewportStyle, foregroundClipStyle\]\}/);
assert.match(source, /position: 'absolute', left: 0, right: 0, top: 0, height: Math.max\(0, screenHeight - lyricTop\)/);
assert.doesNotMatch(callback('foregroundClipStyle'), /translate|scale/);
for (const height of [667, 844, 390]) for (const top of [60, 110]) for (const dockTop of [height - 180, height - 260]) {
  for (const p of [0, .125, .375, .625, .9975, 1]) {
    const context = { screenHeight: height, lyricTop: top, dockTop: { value: dockTop }, controlsOpacity: { value: p }, Math };
    const clip = evaluate(callback('foregroundClipStyle'), context)();
    const fill = evaluate(callback('fillTouchStyle'), context)();
    assert.equal(clip.height + top, fill.top, 'touch blocker and clip meet at every frame');
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
assert.match(callback('lyricsBottomBlurOpacityStyle'), /translateY: -Math.max\(0, screenHeight - dockTop.value\) \* controlsOpacity.value/);
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
console.log('Controls motion checks passed: stages, four reversal times, stale completions, reduced motion, hold/release/cancel, clip geometry and structural layer guards. Native touch/Metal/VoiceOver are unverified.');
