import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { patchAmllScroll } from './amll-scroll-patch.mjs';

const original = await readFile(new URL('../node_modules/@applemusic-like-lyrics/core/dist/amll-core.mjs', import.meta.url), 'utf8');
const source = patchAmllScroll(original);
const region = name => {
  const start = source.indexOf(`//#region ${name}`);
  assert.ok(start >= 0, `AMLL region exists: ${name}`);
  return source.slice(start, source.indexOf('//#endregion', start));
};
let now = 0, nextId = 0, layouts = 0;
const frames = new Map(), events = new Map(), timers = new Map();
const context = vm.createContext({
  performance: { now: () => now },
  requestAnimationFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
  cancelAnimationFrame: id => frames.delete(id),
  window: {
    setTimeout: callback => { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  },
  AbortController,
  WheelEvent: { DOM_DELTA_PIXEL: 0 },
  Duration: { fromMillis: n => n, asMillis: n => n, divDuration: (a, b) => a / b },
});
vm.runInContext(region('src/lyric-player/base/scroll.ts') + '\n' + region('src/lyric-player/base/focus.ts'), context);
const engine = new context.ScrollInteractionEngine({ addEventListener: (type, handler) => events.set(type, handler) }, {
  onInteractionStart() {}, onScrollUpdate: () => layouts++,
});
engine.updateBoundary(-10000, 10000);
const send = (type, y) => events.get(type)({ cancelable: true, preventDefault() {},
  touches: type === 'touchend' || type === 'touchcancel' ? [] : [{ screenX: 0, screenY: y }],
  changedTouches: [{ screenX: 0, screenY: y }], deltaY: y, deltaMode: 0 });
const frame = () => { now += 16; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)); };
send('touchstart', 400); now += 16; send('touchmove', 350); now += 16; send('touchmove', 300);
assert.equal(frames.size, 1, 'drag layouts coalesce to one frame');
frame(); assert.equal(layouts, 1);
send('touchend', 300); const endOffset = engine.offset;
frame(); assert.ok(engine.offset > endOffset, 'fling continues after release');
engine.resetScroll(); frame(); frame();
assert.equal(engine.offset, 0, 'Auto reset cannot be overwritten by an old inertia frame');
assert.equal(frames.size, 0);
send('touchmove', 0); send('touchend', 0); frame();
assert.equal(engine.offset, 0, 'events after reset cannot restart momentum');
send('wheel', 100); frame(); assert.equal(engine.offset, 0, 'wheel momentum cannot undo Auto reset');
now += 150;
send('touchstart', 400); now += 16; send('touchmove', 300); send('touchend', 300); frame();
send('touchstart', 200); frame(); const heldOffset = engine.offset; frame(); frame();
assert.equal(engine.offset, heldOffset, 'new touch immediately cancels the previous fling');
send('touchcancel', 200); assert.equal(frames.size, 0);
now += 1000; assert.equal(engine.canResumeAutoAlign, false, 'manual scrolling waits for the Auto button');
const focus = new context.FocusController();
const flags = { isAutoAlignSuspended: false, hasBottomContent: false, canDisplayInterlude: false };
focus.resolve({ scrollToIndex: 2 }, 10, flags);
assert.equal(focus.resolve({ scrollToIndex: 6 }, 10, { ...flags, isAutoAlignSuspended: true }).index, 2,
  'manual scroll keeps its spatial anchor across lyric changes');
send('wheel', 40); engine.dispose(); assert.equal(frames.size, 0); assert.equal(timers.size, 0);
assert.throws(() => patchAmllScroll('upstream changed'), /no longer matches upstream/);
console.log('AMLL scrolling checks passed: coalesced drag, inertia cancellation, new touch/cancel, manual anchors and upstream patch guard.');
