const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const ts = require('typescript');
const { buildSync } = require('esbuild');
const { createLyricsScrollEscape } = require('../lib/lyrics-scroll-escape');
const code = buildSync({
  entryPoints: [path.resolve(__dirname, '../components/lyrics/spicy-layout-host.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['../../lib/lyrics-scroll-escape'],
}).outputFiles[0].text;
for (const boundary of [999, 1001]) {
  let now = 0, gate;
  const node = (top = 0) => ({
    offsetTop: top, offsetHeight: 80, clientHeight: 800, scrollTop: 0,
    children: [], dataset: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    closest: () => null, appendChild(child) { this.children.push(child); },
  });
  const viewport = node(), content = node();
  content.parentElement = node();
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, performance: { now: () => now },
    require: () => ({ createLyricsScrollEscape: () => (gate = createLyricsScrollEscape()) }),
    document: { createElement: () => node(500), getElementById: () => null },
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  const host = module.exports;
  const entry = fs.readFileSync(path.resolve(__dirname, '../components/lyrics/spicy-webview-entry.ts'), 'utf8');
  const input = vm.createContext({
    ignoreTouchUntilNextStart: false, touchMoved: false, longPressTimer: 0,
    staticLyricsMode: false, window: { clearTimeout() {} },
    noteLyricsUserScroll: host.noteLyricsUserScroll, scheduleFrame() {},
  });
  vm.runInContext(ts.transpileModule(entry.slice(entry.indexOf('function noteUserScroll()'), entry.indexOf('scrollViewport?.addEventListener("touchmove"')), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText, input);
  const source = [{ lineStartTime: 0, lineEndTime: 10000, syllables: [{ text: 'line', startTime: 0, endTime: 10000 }] }];
  host.initLyricsLayout(viewport, content, [], source);
  let following = true;
  const changes = [];
  const frame = () => host.scrollToActiveLine(500, following, false, value => { following = value; changes.push(value); });
  frame();
  assert.equal(gate.graceUntil, 0, 'layout and programmatic placement start no timer');
  host.setLyricsUserTouching(true);
  assert.equal(gate.graceUntil, 0, 'ordinary touch starts no timer');
  viewport.scrollTop = 600;
  input.noteUserScroll(); host.noteLyricsViewportScroll(); frame();
  assert.equal(following, false);
  assert.equal(gate.graceUntil, 1000);
  host.setLyricsUserTouching(false);
  now = boundary;
  host.setLyricsUserTouching(true);
  viewport.scrollTop = 620;
  input.noteUserScroll(); host.noteLyricsViewportScroll(); frame();
  assert.equal(gate.graceUntil, 1000, 'later scrolling does not restart grace');
  host.initLyricsLayout(viewport, content, [], source, () => {}, true);
  assert.equal(gate.graceUntil, 1000, 'same-track layout rebuild preserves the deadline');
  frame();
  host.setLyricsUserTouching(true);
  viewport.scrollTop = 500;
  input.noteUserScroll(); host.noteLyricsViewportScroll();
  host.setLyricsUserTouching(false); frame();
  assert.equal(changes.at(-1), true, 'deliberate return overrides grace');
  assert.equal(gate.graceUntil, 0);
  host.setLyricsUserTouching(true);
  viewport.scrollTop = 700;
  input.noteUserScroll(); host.noteLyricsViewportScroll(); frame();
  host.releaseLyricsUserScroll(true, true);
  assert.equal(gate.graceUntil, 0, 'resume cancels grace immediately');
  host.initLyricsLayout(viewport, content, [], source);
  assert.equal(gate.graceUntil, 0, 'track replacement starts no timer');
  host.destroyLyricsLayout();
}
