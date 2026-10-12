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
    interval: 800, instant: true, interlude: false, snap: false }), residual: shared(0), renderedResidual: shared(0), actualOffset: shared(0), spicy };
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
  const context = { useCallback: fn => fn, pendingScroll: { current: { index: 4, animated } },
    following: { current: true }, lastScrollTarget: { current: 'old' },
    scrollTo: (index, animation) => calls.push([index, animation]), backgrounds: [], lyrics: [], timing: {} };
  vm.runInNewContext(`(${retry})()`, context);
  assert.deepEqual(calls, [[4, animated]], 'A cold row measurement must preserve the original scroll animation');
  assert.equal(context.pendingScroll.current, null);
}
for (const [index, animated, snap, geometry] of [[4, true, true, true], [5, true, true, false], [4, false, true, false], [4, true, false, false]]) {
  const command = { current: { serial: 8, index: 4, offset: 600, snap } };
  const context = { useCallback: fn => fn, nativeFollowIndex: (_rows, index) => index,
    currentPosition: { current: 14000 }, following: { current: true }, active: true, staticLyrics: false,
    rows: Array.from({ length: 10 }, (_, index) => ({ lead: { start: index * 1000, end: (index + 1) * 1000 } })),
    list: 'flash', flashRef: { current: { getLayout: () => ({ y: 500 }), getFirstItemOffset: () => 150, getFirstVisibleIndex: () => 3 } },
    flatRef: {}, lastScrollTarget: { current: '' }, landscapeMode: false, fontScale: 1, showTranslatedText: true,
    viewportHeight: 800, preview: false, style: 'amll', pendingScroll: { current: null }, scrollState: command, scrollCommand: {} };
  vm.runInNewContext(ts.transpileModule(`(${scrollCallback})(${index}, ${animated})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.equal(context.scrollCommand.value.geometry, geometry,
    'The host must distinguish background reflow from lyric advances, seeks and manual-follow resumes');
}
console.log('Native scrolling checks passed: coordinated focus at 60/120 Hz in either callback order, interrupted geometry, cold retries and manual follow.');
