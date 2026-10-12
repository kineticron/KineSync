/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const moduleObject = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'fixtures/amll-layout-main.cjs'), 'utf8'), {
  module: moduleObject, v1: () => undefined, _1: () => ({ shouldUpdate: false }),
  T1: () => ({}), dd: () => 0, si: { Bottom: 'bottom', Center: 'center', Top: 'top' }, window: { innerWidth: 390 },
});
const transforms = [];
const groups = [0, 1, 2].map(index => ({ setTransform: (top, _force, delay) => { transforms[index] = { top, delay }; } }));
const sizes = new Map(groups.map(group => [group, [390, 80]]));
const player = { timelineState: { currentTime: 1500, scrollToIndex: 1, bufferedGroups: new Set([1]) },
  currentLyricGroups: groups, lyricGroupSize: sizes, getEnableSpring: () => true,
  layoutState: { targetAlignIndex: 1, lastInterludeState: false, interludeDotsSize: [0, 0], alignPosition: 0.08, alignAnchor: 'top' },
  scrollState: { scrollOffset: 0, isScrolled: false, scrollBoundary: {} },
  size: [390, 800], interludeDots: { setInterlude() {} },
  bottomLine: { setFocused() {}, setTransform() {} } };
moduleObject.exports.call(player, false);
const focusedTop = transforms[1].top;
assert.ok(transforms[2].delay > 0, 'The reference staggers ordinary lyric advances');
for (const group of groups) sizes.set(group, [390, 120]); // Paused backgrounds reveal.
moduleObject.exports.call(player, true); // ResizeObserver recomputes geometry with zero stagger.
assert.equal(transforms[1].top, focusedTop, 'The WebView subtracts heights before the focus to preserve its anchor');
assert.ok(transforms.every(transform => transform.delay === 0), 'A geometry update does not renew the lyric stagger');
assert.equal(transforms[2].top - focusedTop, 120, 'Background lyrics remain in the paused layout');
console.log('Main AMLL layout reference checks passed: paused background flow, preserved focus and zero geometry stagger.');
