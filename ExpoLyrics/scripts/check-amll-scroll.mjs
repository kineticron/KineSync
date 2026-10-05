import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { patchAmllScroll } from './amll-scroll-patch.mjs';

const original = await readFile(new URL('../node_modules/@applemusic-like-lyrics/core/dist/amll-core.mjs', import.meta.url), 'utf8');
const source = patchAmllScroll(original);
const start = source.indexOf('function attachPlayerScrollHandlers(');
const end = source.indexOf('\n//#endregion', start);
let now = 0, nextId = 0, layouts = 0;
const frames = new Map(), events = new Map();
const context = vm.createContext({
  performance: { now: () => now },
  requestAnimationFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
  cancelAnimationFrame: id => frames.delete(id),
  window: { addEventListener() {} },
  document: { elementFromPoint: () => null }, HTMLElement: class {},
  clampPlayerScrollOffset: state => { state.scrollOffset = Math.max(-10000, Math.min(10000, state.scrollOffset)); },
});
vm.runInContext(source.slice(start, end), context);
const state = { scrollOffset: 0, isUserScrolling: false };
context.attachPlayerScrollHandlers({ addEventListener: (type, handler) => events.set(type, handler) }, state, {
  onBeginScroll: () => true, onEndScroll() {}, onLayout: () => layouts++, containsTarget: () => false,
});
const send = (type, y) => events.get(type)({ preventDefault() {}, touches: [{ screenX: 0, screenY: y }], changedTouches: [{ screenX: 0, screenY: y }] });
const frame = () => { now += 16; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)); };
send('touchstart', 400); now += 16; send('touchmove', 350); now += 16; send('touchmove', 300);
assert.equal(frames.size, 1, 'drag layouts coalesce to one frame');
frame(); assert.equal(layouts, 1);
send('touchend', 300); const endOffset = state.scrollOffset;
frame(); assert.ok(state.scrollOffset > endOffset, 'fling continues smoothly after release');
state.cancelMomentum(); state.scrollOffset = 0; frame(); frame();
assert.equal(state.scrollOffset, 0, 'Auto scroll reset cannot be overwritten by an old inertia frame');
assert.equal(frames.size, 0);
send('touchstart', 400); now += 16; send('touchmove', 300); send('touchend', 300); frame();
send('touchstart', 200); frame(); const heldOffset = state.scrollOffset; frame(); frame();
assert.equal(state.scrollOffset, heldOffset, 'a new finger immediately cancels the previous fling');
send('touchcancel', 200); assert.equal(state.isUserScrolling, false); assert.equal(frames.size, 0);
state.cancelMomentum(); send('touchmove', 0); send('touchend', 0); frame();
assert.equal(state.scrollOffset, heldOffset, 'cancelled touch events cannot restart momentum');
assert.ok(source.includes('this.scrollState.cancelMomentum?.();'), 'production reset calls the gesture cancellation');
assert.ok(source.includes('this.scrollState.manualAlignIndex ??'), 'manual scroll keeps its spatial anchor across lyric changes');
assert.throws(() => patchAmllScroll('upstream changed'), /no longer matches upstream/);
console.log('AMLL scrolling checks passed: coalesced drag, inertia cancellation, new touch/cancel, manual anchors and upstream patch guard.');
