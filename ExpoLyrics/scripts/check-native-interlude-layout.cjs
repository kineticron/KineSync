/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const source = buildSync({ entryPoints: [path.join(__dirname, '../components/lyrics/native/native-interlude.tsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native', 'react-native-reanimated', '@shopify/react-native-skia', './native-lyrics-fonts'],
}).outputFiles[0].text;
for (const [spicy, right] of [[false, false], [false, true], [true, false]]) {
  const reactions = [];
  const animations = new Map();
  const styles = [];
  const shared = value => ({ value });
  let pendingAnimation;
  const reanimated = {
    default: {}, Easing: { bezier: () => progress => progress },
    useSharedValue: initial => {
      let current = initial;
      const value = {};
      Object.defineProperty(value, 'value', { get: () => current, set: next => {
        if (pendingAnimation) { animations.set(value, { from: current, elapsed: 0, ...pendingAnimation }); pendingAnimation = undefined; }
        else { animations.delete(value); current = next; }
      } });
      return value;
    },
    useDerivedValue: fn => ({ get value() { return fn(); } }),
    useAnimatedReaction: (prepare, react) => reactions.push({ prepare, react, previous: null }),
    useAnimatedStyle: fn => { styles.push(fn); return {}; },
    withTiming: (to, config) => { pendingAnimation = { to, easing: progress => progress, ...config }; return to; },
  };
  const react = { memo: fn => fn };
  const moduleObject = { exports: {} };
  vm.runInNewContext(source, { module: moduleObject, exports: moduleObject.exports,
    require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      : name === 'react-native' ? { StyleSheet: { create: styles => styles } } : reanimated });
  const position = shared(999);
  const seekVersion = shared(0);
  const tree = moduleObject.exports.NativeInterludeView({ interlude: { start: 1000, end: 9000 }, position, seekVersion,
    spicy, fontSize: 36, viewportWidth: 390, right });
  const placement = tree.props.children.props.style[1];
  assert.equal(placement.paddingHorizontal, 0, 'The lyric lane already supplies the horizontal inset');
  if (!spicy) {
    assert.equal(placement.transformOrigin, right ? 'right center' : 'left center', 'Breathing preserves the aligned edge');
    assert.equal(right ? placement.right : placement.left, 0, 'Dots anchor directly to the lyric edge');
  }
  const flush = () => {
    for (const reaction of reactions) {
      const next = reaction.prepare(); reaction.react(next, reaction.previous); reaction.previous = next;
    }
  };
  const tick = milliseconds => {
    for (const [value, animation] of [...animations]) {
      animation.elapsed += milliseconds;
      const progress = Math.min(1, animation.elapsed / animation.duration);
      const next = animation.from + (animation.to - animation.from) * animation.easing(progress);
      value.value = next;
      if (progress < 1) animations.set(value, animation);
    }
  };
  flush();
  assert.equal(styles[0]().height, 0);
  position.value = 1000; flush();
  assert.equal(styles[0]().height, 0, 'A natural break entry cannot jump adjacent lyrics');
  tick(100);
  const intermediateHeight = styles[0]().height;
  assert.ok(intermediateHeight > 0, 'The slot opens gradually');
  tick(400);
  const openHeight = styles[0]().height;
  assert.ok(openHeight > intermediateHeight);
  position.value = 9000 - (spicy ? 500 : 625); flush();
  assert.equal(styles[0]().height, openHeight, 'Exit keeps the slot mounted at its starting height');
  tick(100);
  assert.ok(styles[0]().height > 0 && styles[0]().height < openHeight, 'Surrounding lyrics shift throughout collapse');
  tick(400);
  assert.equal(styles[0]().height, 0, 'No empty gap remains after the break');
  position.value = 4000; seekVersion.value++; flush();
  assert.equal(styles[0]().height, openHeight, 'Seeking into a break restores its media-time layout immediately');
  position.value = 10000; seekVersion.value++; flush();
  assert.equal(styles[0]().height, 0, 'Seeking out cannot leave a stale break slot');
}
console.log('Native interlude layout checks passed: gradual entry/exit, zero residual space and seeks.');
