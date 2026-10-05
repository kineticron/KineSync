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

// Exercise the actual launch styles throughout the camera move, not just its
// final frame: the former camera path could lose the white target mid-flight.
for (const [width, height] of [[320, 568], [390, 844], [430, 932], [768, 1024], [1024, 1366]]) {
  const values = [], styles = [], effects = [];
  let stateIndex = 0;
  const mocks = {
    react: { ...React, useState: value => [stateIndex++ === 0 ? { width: 150, prefix: 53, throughE: 71, crossbarY: 24 } : value, () => {}], useEffect: effect => effects.push(effect), useCallback: callback => callback },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { Platform: { OS: 'ios' }, Text: 'Text', View: 'View', StyleSheet: { create: value => value, absoluteFill: {} }, useWindowDimensions: () => ({ width, height }) },
    'expo-splash-screen': { preventAutoHideAsync: () => Promise.resolve() },
    'react-native-reanimated': {
      __esModule: true, default: { View: 'AnimatedView' }, useReducedMotion: () => false,
      useSharedValue: value => { const shared = { value }; values.push(shared); return shared; },
      useAnimatedStyle: callback => { styles.push(callback); return {}; },
      interpolate, Extrapolation: { CLAMP: 'clamp' },
    },
    '@/constants/design': { Design: { background: '#090C13' }, Motion: {} },
    './launch-visibility': { LaunchVisibilityContext: { Provider: 'VisibilityProvider' } },
  };
  const scope = { exports: {}, require: name => { assert.ok(name in mocks, name); return mocks[name]; } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../components/ui/launch-transition.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, scope);
  scope.exports.LaunchTransition({ ready: true, children: null });
  const [progress, scale, focus] = values;
  const timing = scope.exports.launchTiming;
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
}
const splash = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8')).expo.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen')[1];
assert.equal(splash.backgroundColor, '#000000');
assert.equal(splash.dark.backgroundColor, '#000000');
assert.equal(splash.image, undefined, 'native splash has no logo');
assert.ok(fs.readFileSync(path.join(__dirname, '..', splash.android.drawable.icon), 'utf8').includes('#00000000'),
  'Android splash uses an empty transparent drawable');
console.log('Launch checks passed: central text target, overlapping zoom and content fade, no opaque white fullscreen frame, and logo-free native splash.');
