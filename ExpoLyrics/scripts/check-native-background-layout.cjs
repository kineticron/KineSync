/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const source = buildSync({ entryPoints: [path.join(__dirname, '../components/lyrics/native/amll-background.tsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native'],
}).outputFiles[0].text;
const moduleObject = { exports: {} };
vm.runInNewContext(source, { module: moduleObject, exports: moduleObject.exports,
  require: name => name === 'react' ? { memo: fn => fn }
    : name === 'react/jsx-runtime' ? { jsx: (type, props) => ({ type, props }) }
      : name === 'react-native' ? { View: 'View' }
        : assert.fail(`Unexpected background animation/measurement dependency: ${name}`) });

// Exercise pause, cue changes and a recycled row with taller/wrapped content.
// Children must stay in natural flow so Yoga reserves their actual current height
// without requiring a new onLayout event to refill a cleared measurement cache.
let initialStyle;
for (const playing of [true, false, true]) {
  for (const active of [true, false]) {
    for (const identity of ['first-row', 'recycled-row']) {
      const children = { identity, height: identity === 'first-row' ? 40 : 120 };
      const tree = moduleObject.exports.AmllBackground({ children, fontSize: 36,
        playing, active: { value: active }, layoutActive: active, identity });
      assert.equal(tree.type, 'View');
      assert.equal(tree.props.children, children);
      assert.ok(tree.props.style.opacity > 0);
      assert.equal(tree.props.style.position, undefined);
      assert.equal(tree.props.style.height, undefined);
      assert.equal(tree.props.style.transform, undefined);
      assert.equal(tree.props.onLayout, undefined);
      initialStyle ??= tree.props.style;
      assert.deepEqual(tree.props.style, initialStyle, 'Playback state cannot change background flow or visibility');
    }
  }
}
console.log('Native AMLL backgrounds remain visible in natural flow across playback, cue changes and row recycling.');
