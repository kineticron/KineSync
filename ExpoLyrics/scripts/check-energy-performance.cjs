/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const timelineModule = { exports: {} };
vm.runInThisContext(`(function(exports){${ts.transpileModule(
  fs.readFileSync(path.join(root, 'components/lyrics/active-line-timeline.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText}\n})`)(timelineModule.exports);
const { createActiveLineTimeline } = timelineModule.exports;
let seed = 42;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
for (let song = 0; song < 100; song++) {
  const ranges = Array.from({ length: 100 }, (_, index) => {
    const start = Math.floor(random() * 1000);
    return { start, end: start + 1 + Math.floor(random() * 200), index };
  });
  const lookup = createActiveLineTimeline(ranges);
  for (const position of [-1, 2000, ...ranges.flatMap(r => [r.start - 0.01, r.start, r.end - 0.01, r.end])]) {
    assert.equal(lookup(position), ranges.find(r => position >= r.start && position < r.end)?.index ?? -1,
      'indexed lookup preserves first-match overlaps, gaps, exact boundaries and seeks');
  }
}
assert.equal(createActiveLineTimeline([])(0), -1);

// Execute the production AMLL scheduler with deterministic frames and visibility.
const entry = fs.readFileSync(path.join(root, 'components/lyrics/amll-webview-entry.ts'), 'utf8');
const frames = new Map();
let nextId = 0, updates = 0, resumes = 0, pauses = 0;
const document = { visibilityState: 'visible', addEventListener() {} };
const context = vm.createContext({
  performance: { now: () => 100 }, document,
  rendererActive: true, staticLyricsMode: false, isPlaying: true, previewPositionMs: null,
  sourceLines: [{}], durationMs: 1000, frameRequestId: null, animateUntilMs: 0, lastFrameMs: 0,
  IDLE_ANIMATION_GRACE_MS: 750, activeSourceIndex: -1, longPressTimer: 0, touchStartSourceIndex: -1,
  getProjectedPosition: () => 100, findActiveSource: () => 0, post() {},
  player: { setCurrentTime() {}, update() { updates++; }, pause() { pauses++; }, resume() { resumes++; } },
  window: { clearTimeout() {} },
  requestAnimationFrame: cb => { frames.set(++nextId, cb); return nextId; },
  cancelAnimationFrame: id => frames.delete(id),
});
vm.runInContext(entry.slice(entry.indexOf('function playbackNeedsFrames()'), entry.indexOf('window.KineSyncLyrics =')), context);
context.scheduleFrame();
assert.equal(frames.size, 1);
context.rendererActive = false;
context.updateSuspension();
assert.equal(frames.size, 0, 'inactive renderer cancels pending work');
for (let i = 0; i < 100; i++) context.scheduleFrame(750);
assert.equal(frames.size, 0, 'inactive updates cannot restart the loop');
context.frame();
assert.equal(updates, 0, 'late callback cannot render while suspended');
context.rendererActive = true;
context.updateSuspension();
assert.equal(frames.size, 1);
assert.equal(resumes, 1);
document.visibilityState = 'hidden';
context.updateSuspension();
assert.equal(frames.size, 0);
assert.equal(pauses, 2);

// Keep the desktop's visible 50ms diagnostics cadence, with no idle/hidden timer.
const html = fs.readFileSync(path.join(root, '../DesktopBridge/src/index.html'), 'utf8');
const timers = new Map();
let now = 0;
const desktop = vm.createContext({
  document: { hidden: false, addEventListener() {} }, monotonicNow: () => now,
  clampPosition: (p, d) => Math.max(0, d > 0 ? Math.min(p, d) : p),
  fmtTime: p => String(Math.floor(p / 1000)), setText() {},
  setInterval: (cb, delay) => { assert.equal(delay, 50); timers.set(++nextId, cb); return nextId; },
  clearInterval: id => timers.delete(id),
});
vm.runInContext(html.slice(html.indexOf('      const playbackClock ='), html.indexOf('      window.bridgeStatus.onStatus')) +
  '\n globalThis.clock = playbackClock; globalThis.refresh = updatePlaybackRendering;', desktop);
desktop.refresh(); assert.equal(timers.size, 0);
desktop.clock.isPlaying = true; desktop.clock.durationMs = 1000;
desktop.refresh(); assert.equal(timers.size, 1);
desktop.document.hidden = true; desktop.refresh(); assert.equal(timers.size, 0);
now = 500; desktop.document.hidden = false; desktop.refresh(); assert.equal(timers.size, 1);
now = 1000; [...timers.values()][0](); assert.equal(timers.size, 0);
desktop.refresh(); assert.equal(timers.size, 0, 'finished track stays asleep');
console.log('Energy performance checks passed: 40,200 indexed timeline comparisons, AMLL suspension/resume and desktop idle/hidden/end cleanup.');
