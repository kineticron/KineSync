/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');
const React = require('react');

// Exercise track changes with a native animation already in flight. Layout
// events are deliberately delivered late, as they can be on a busy device.
let current;
let reducedMotion = false;
const animations = [];
const listeners = new Set();
function slot(create) {
  const index = current.cursor++;
  return current.slots[index] ?? (current.slots[index] = create());
}
function recordEffect(effect, deps) {
  const hook = slot(() => ({}));
  if (!hook.deps || deps.some((value, index) => !Object.is(value, hook.deps[index]))) {
    current.effects.push(() => {
      hook.cleanup?.();
      hook.cleanup = effect();
      hook.deps = deps;
    });
  }
}
class Value {
  constructor(value) { this.value = value; }
  setValue(value) { this.value = value; }
  stopAnimation() {}
}
const mocks = {
  react: {
    ...React,
    memo: component => component,
    useCallback: callback => callback,
    useRef: value => slot(() => ({ current: value })),
    useState: initial => {
      const hook = slot(() => ({ value: initial }));
      return [hook.value, value => { hook.value = value; }];
    },
    useEffect: recordEffect,
  },
  'expo-router': { useFocusEffect: effect => recordEffect(effect, []) },
  'react-native-reanimated': { useReducedMotion: () => reducedMotion },
  'react-native': {
    View: 'View', Text: 'Text', ScrollView: 'ScrollView',
    StyleSheet: { create: styles => styles }, Easing: { linear: value => value },
    AppState: { currentState: 'active', addEventListener: (_, callback) => {
      listeners.add(callback);
      return { remove: () => listeners.delete(callback) };
    } },
    Animated: {
      Value, Text: 'Animated.Text', delay: duration => ({ duration }),
      timing: (value, options) => ({ value, options }), sequence: steps => steps,
      loop: steps => {
        const animation = { steps, active: false,
          start() { this.active = true; }, stop() { this.active = false; } };
        animations.push(animation);
        return animation;
      },
    },
  },
};
const filename = path.resolve(__dirname, '../components/ui/marquee-text.tsx');
const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
  filename, babelrc: false, configFile: false, presets: ['babel-preset-expo'],
  caller: { name: 'metro', platform: 'ios', supportsStaticESM: false },
});
const loaded = { exports: {} };
vm.runInNewContext(code, {
  module: loaded, exports: loaded.exports,
  require: name => mocks[name] ?? require(name),
});

let mounted;
function render(text) {
  const element = loaded.exports.MarqueeText({ children: text });
  if (!mounted || mounted.key !== element.key) {
    mounted?.slots.forEach(hook => hook.cleanup?.());
    mounted = { key: element.key, slots: [], effects: [] };
  }
  current = mounted;
  current.cursor = 0;
  const tree = element.type(element.props);
  current.effects.splice(0).forEach(effect => effect());
  return tree;
}
function measure(text, contentWidth) {
  let tree = render(text);
  const scroll = tree.props.children;
  scroll.props.onLayout({ nativeEvent: { layout: { width: 120 } } });
  scroll.props.onContentSizeChange(contentWidth);
  tree = render(text);
  return tree.props.children;
}

const longTitle = 'A long title that needs to scroll';
const oldScroll = measure(longTitle, 420);
const oldAnimation = animations.at(-1);
assert.equal(oldAnimation.active, true);
assert.equal(oldAnimation.steps[1].options.toValue, -300);
const oldOffset = oldScroll.props.children.props.style.at(-1).transform[0].translateX;
oldOffset.setValue(-180);

let tree = render('Short');
const newOffset = tree.props.children.props.children.props.style.at(-1).transform[0].translateX;
assert.notEqual(newOffset, oldOffset, 'track changes must get a fresh native animation value');
assert.equal(newOffset.value, 0, 'new labels must start at the leading edge');
assert.equal(oldAnimation.active, false, 'the outgoing track animation must stop');
assert.equal(listeners.size, 1, 'track changes must clean up app-state subscriptions');
assert.equal(animations.length, 1, 'do not animate using the outgoing track measurements');

oldScroll.props.onContentSizeChange(900);
render('Short');
assert.equal(animations.length, 1, 'late outgoing layout events must not start a new animation');
measure('Short', 60);
assert.equal(animations.length, 1, 'short labels should stay still');

measure(longTitle, 300);
assert.equal(animations.at(-1).steps[1].options.toValue, -180, 'returning to a song must use fresh measurements');
reducedMotion = true;
tree = render('Reduced motion');
assert.equal(tree.props.children.type, 'Text');
assert.equal(tree.props.children.props.numberOfLines, 1);
assert.equal(tree.props.style[0].overflow, 'hidden');
assert.equal(animations.at(-1).active, false);
mounted.slots.forEach(hook => hook.cleanup?.());
assert.equal(listeners.size, 0);
console.log('Marquee track-change checks passed.');
