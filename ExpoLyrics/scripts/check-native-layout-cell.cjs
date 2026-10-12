/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const source = buildSync({ entryPoints: [path.join(__dirname, '../components/lyrics/native/amll-layout-cell.tsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native', 'react-native-reanimated', './reference-scroll'],
}).outputFiles[0].text;
const host = { command: { value: { firstVisible: 0, index: 5, interval: 800, interlude: false } } };
const sharedValues = [];
let hookIndex = 0;
const react = { forwardRef: fn => fn, useContext: () => host, useMemo: fn => fn() };
const reanimated = { default: { View: 'View' },
  useSharedValue: value => sharedValues[hookIndex++] ?? (sharedValues[hookIndex - 1] = { value }),
  defineAnimation: (_initial, factory) => factory() };
const moduleObject = { exports: {} };
vm.runInNewContext(source, { module: moduleObject, exports: moduleObject.exports,
  require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx: (type, props) => ({ type, props }) }
    : name === 'react-native-reanimated' ? reanimated : {} });
function layoutFor(index) {
  hookIndex = 0;
  return moduleObject.exports.AmllLayoutCell({ index }, null).props.layout;
}
function start(layout, from, to, now) {
  const result = layout({ currentOriginY: from, targetOriginY: to });
  assert.deepEqual(Object.keys(result.initialValues), ['transform']);
  assert.deepEqual(Object.keys(result.animations), ['transform'], 'Only transforms animate; Yoga geometry stays at its final target');
  const animation = result.animations.transform[0].translateY;
  animation.onStart(animation, result.initialValues.transform[0].translateY, now, null);
  return animation;
}
for (const fps of [60, 120]) {
  sharedValues.length = 0;
  const layout = layoutFor(5);
  let animation = start(layout, 500, 700, 0);
  assert.equal(animation.current, -200);
  for (let frame = 1; frame <= fps / 4; frame++) animation.onFrame(animation, frame * 1000 / fps);
  const oldPosition = 700 + animation.current;
  const oldVelocity = animation.velocity;
  animation = start(layout, 700, 500, 250);
  assert.ok(Math.abs(500 + animation.current - oldPosition) < 0.001, 'Reversing pause layout must preserve the visual position');
  assert.equal(animation.velocity, oldVelocity, 'Interrupted layout keeps its velocity');
  for (let frame = 1; frame <= fps * 3; frame++) animation.onFrame(animation, 250 + frame * 1000 / fps);
  assert.equal(animation.current, 0);
  // A recycled slot must not fly in from the previous row's coordinates.
  const recycled = start(layoutFor(20), 500, 2000, 4000);
  assert.equal(recycled.current, 0);
  assert.equal(recycled.velocity, 0);
}
console.log('Native AMLL cell layout checks passed: transform-only animation, 60/120 Hz interruption continuity and recycled-cell reset.');
