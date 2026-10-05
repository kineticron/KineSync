/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

// Exercise the production WebView hosts across live/demo source changes and a paused sample.
for (const style of ['spicy', 'amll']) {
  const slots = [];
  let cursor = 0, pending = [], injections = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    memo: component => component,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo(compute, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: compute() }; return slots[i].value; },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps); },
    useEffect(effect, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { slots[i]?.cleanup?.(); slots[i] = { deps }; pending.push(() => { slots[i].cleanup = effect(); }); } },
  };
  const liveLine = { lineStartTime: 0, lineEndTime: 5000, syllables: [{ text: 'Live song', startTime: 0, endTime: 5000 }] };
  const demoLine = { ...liveLine, syllables: [{ text: 'Follow the lyrics', startTime: 0, endTime: 5000 }] };
  const playback = { lyrics: [liveLine], lyricsMetadata: {}, lyricsSource: 'live', anchorPositionMs: 0, anchorMonotonicMs: 0, isPlaying: true, currentTrack: { id: 'live', durationMs: 5000 } };
  const mocks = {
    react: { ...React, ...hooks }, 'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { View: 'View', Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }, StyleSheet: { create: styles => styles } },
    'react-native-webview': { __esModule: true, default: 'WebView' },
    '@/lib/lyrics-timing': { detectLyricsTimingMode: () => 'karaoke' },
    '@/store/playback-store': { usePlaybackStore: Object.assign(selector => selector(playback), { getState: () => playback }) },
    '@/components/lyrics/spicy-webview-bundle': { SPICY_WEBVIEW_JS: '', SPICY_WEBVIEW_CSS: '' },
    '@/components/lyrics/amll-webview-bundle': { AMLL_WEBVIEW_JS: '', AMLL_WEBVIEW_CSS: '' },
  };
  const context = { exports: {}, require: name => { assert.ok(name in mocks, name); return mocks[name]; }, Date, performance: { now: () => 1000 } };
  const filename = path.join(__dirname, `../components/lyrics/${style}-lyrics-view.tsx`);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, context);
  const Component = context.exports[style === 'spicy' ? 'SpicyLyricsView' : 'AmllLyricsView'];
  function render(props) {
    cursor = 0; pending = []; injections = [];
    const tree = Component({ tapToSeekEnabled: true, ...props });
    const webview = tree.props.children;
    webview.props.ref.current = { injectJavaScript: script => {
      const match = script.match(/\.receive\((.*)\); true;/);
      assert.ok(match); injections.push(JSON.parse(match[1]));
    } };
    pending.forEach(effect => effect());
    return webview;
  }
  let webview = render({});
  assert.equal(injections.length, 0);
  webview.props.onLoadEnd(); webview = render({});
  assert.equal(injections.find(packet => packet.type === 'setLyrics').lines[0].syllables[0].text, 'Live song');
  const staleLoad = webview.props.onLoadEnd;
  const staleMessage = webview.props.onMessage;
  const liveKey = webview.key;
  const demo = { demoLyrics: [demoLine], demoLayout: 'player', demoIsPlaying: true, active: true, previewPositionMs: 0 };
  webview = render(demo);
  assert.notEqual(webview.key, liveKey, 'entering the tour remounts the source');
  assert.equal(injections.length, 0, 'new source must wait for its own ready signal');
  webview.props.onLoadEnd(); webview = render(demo);
  assert.equal(injections.find(packet => packet.type === 'setLyrics').lines[0].syllables[0].text, 'Follow the lyrics');
  assert.ok(!webview.props.source.html.includes('--ks-top-padding: 12px'), 'tour uses the full player layout');
  assert.equal(injections.find(packet => packet.type === 'sync').force, false, 'demo clock anchors never reset scroll springs');
  playback.anchorPositionMs = 4200;
  playback.anchorMonotonicMs = 900;
  playback.currentTrack = { id: 'next-background-song', durationMs: 100000 };
  render(demo);
  assert.equal(injections.length, 0, 'background live anchors cannot resync the tour renderer');
  render({ ...demo, previewPositionMs: 100 });
  assert.equal(injections.find(packet => packet.type === 'sync').force, false, 'ordinary demo ticks are smooth updates');
  staleLoad(); staleMessage({ nativeEvent: { data: JSON.stringify({ type: 'ready' }) } });
  webview = render({ ...demo, demoIsPlaying: false, previewPositionMs: 3500 });
  const pause = injections.find(packet => packet.type === 'sync');
  assert.ok(pause, 'late ready events cannot invalidate the current source');
  assert.equal(pause.positionMs, 3500);
  assert.equal(pause.isPlaying, false);
  if (style === 'spicy') assert.equal(pause.active, true, 'paused lyrics remain visible');
  webview = render({});
  assert.equal(injections.length, 0, 'returning to live playback waits for the live source');
  webview.props.onLoadEnd(); render({});
  assert.equal(injections.find(packet => packet.type === 'setLyrics').lines[0].syllables[0].text, 'Live song');
  slots.forEach(slot => slot?.cleanup?.());
}
console.log('Demo renderer checks passed: live/tour WebView reloads, full player layout, stale-event protection, visible paused lyrics, and live restoration.');
