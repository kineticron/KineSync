/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');

function load(file, mocks, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, ...globals,
    require: name => { assert.ok(Object.hasOwn(mocks, name), `Missing test boundary ${name}`); return mocks[name]; } });
  return module.exports;
}

function hooks() {
  let cursor = 0, dirty = false, now = 1000, writes = 0, callbacks = 0;
  const slots = [], pending = [], timers = new Map(), appListeners = new Set();
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (fn, deps) => { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; };
  const react = {
    memo: fn => fn, useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps), useRef: value => memo(() => ({ current: value }), []),
    useState: initial => {
      const state = memo(() => ({ value: typeof initial === 'function' ? initial() : initial }), []);
      return [state.value, value => { const next = typeof value === 'function' ? value(state.value) : value;
        if (!Object.is(state.value, next)) { writes++; dirty = true; state.value = next; } }];
    },
    useEffect: (fn, deps) => {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) {
        const old = slots[i]; slots[i] = { deps };
        pending.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const app = { currentState: 'active', addEventListener(_name, fn) { appListeners.add(fn); return { remove: () => appListeners.delete(fn) }; } };
  const native = { AppState: app, BackHandler: { addEventListener: () => ({ remove() {} }) }, StyleSheet: { create: x => x },
    View: 'View', Text: 'Text', TextInput: 'TextInput', FlatList: 'FlatList', ScrollView: 'ScrollView', Modal: 'Modal',
    KeyboardAvoidingView: 'KeyboardAvoidingView', ActivityIndicator: 'ActivityIndicator', Platform: { OS: 'ios' },
    useWindowDimensions: () => ({ width: 390, height: 844 }) };
  const timerGlobals = { performance: { now: () => now },
    setTimeout(fn, delay) { const id = {}; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval() { throw new Error('A continuous React preview timer is forbidden'); } };
  return { react, native, app, timers, get writes() { return writes; }, get callbacks() { return callbacks; },
    globals: timerGlobals,
    mocks: { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': native,
      'expo-router': { useFocusEffect: fn => react.useEffect(fn, [fn]), router: {} } },
    run(fn) { let output, count = 0; do { assert.ok(count++ < 12, 'Hooks must settle'); dirty = false; cursor = 0; output = fn(); pending.splice(0).forEach(effect => effect()); } while (dirty); return output; },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > target) break;
        timers.delete(entry[0]); now = entry[1].at; callbacks++; entry[1].fn();
      }
      now = target;
    },
    foreground(value) { app.currentState = value; appListeners.forEach(fn => fn(value)); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}
const nodes = (node, type) => !node ? [] : Array.isArray(node) ? node.flatMap(child => nodes(child, type))
  : [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];

function checkDemoClocks() {
  const h = hooks();
  let tour = { active: true, pending: false, isPlaying: true, anchorPositionMs: 0, anchorMonotonicMs: 1000, seek: position => {
    tour = { ...tour, anchorPositionMs: position, anchorMonotonicMs: h.globals.performance.now() };
  } };
  const useStore = Object.assign(() => tour, { getState: () => tour });
  const { usePlayerTour } = load('hooks/use-player-tour.ts', { ...h.mocks,
    '@/store/player-tour-store': { usePlayerTourStore: useStore, TOUR_DURATION_MS: 25000,
      getTourPosition: state => state.anchorPositionMs + (state.isPlaying ? h.globals.performance.now() - state.anchorMonotonicMs : 0) },
  }, h.globals);
  h.run(() => usePlayerTour(true));
  const before = h.writes;
  h.advance(24900);
  assert.equal(h.callbacks, 0); assert.equal(h.writes, before, 'Normal tour playback causes no React position updates');
  h.advance(100); h.run(() => usePlayerTour(true));
  assert.equal(h.callbacks, 1); assert.equal(tour.anchorPositionMs, 0);
  tour = { ...tour, isPlaying: false, anchorPositionMs: 7000 };
  h.advance(25000);
  assert.equal(tour.anchorPositionMs, 7000, 'A queued loop callback cannot reset playback paused before effect cleanup');
  tour = { ...tour, isPlaying: false }; h.run(() => usePlayerTour(true));
  assert.equal(h.timers.size, 0, 'Pause cancels the loop boundary timer');
  tour = { ...tour, isPlaying: true }; h.run(() => usePlayerTour(true));
  h.foreground('background'); h.run(() => usePlayerTour(true));
  assert.equal(h.timers.size, 0); h.unmount();

  const p = hooks();
  const { RendererPreview } = load('components/onboarding/renderer-preview.tsx', { ...p.mocks,
    '@react-native-vector-icons/ionicons': 'Icon', 'expo-blur': { BlurView: 'BlurView' },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '@/components/lyrics/amll-lyrics-view': { AmllLyricsView: 'amll' }, '@/components/lyrics/spicy-lyrics-view': { SpicyLyricsView: 'spicy' },
    '@/components/ui/motion-pressable': { MotionPressable: 'Button' }, '@/constants/design': { Design: {} },
    '@/store/playback-store': { usePlaybackStore: selector => selector({ lyricsStyle: 'spicy', setLyricsStyle() {} }) },
    '@/lib/onboarding-demo-lyrics': { DEMO_LYRICS: [] },
  }, p.globals);
  let tree = p.run(() => RendererPreview({ active: true }));
  const anchor = nodes(tree, 'amll')[0].props.demoPlayback;
  const writes = p.writes;
  p.advance(24900); tree = p.run(() => RendererPreview({ active: true }));
  assert.equal(p.writes, writes); assert.equal(nodes(tree, 'amll')[0].props.demoPlayback, anchor);
  p.advance(100); tree = p.run(() => RendererPreview({ active: true }));
  assert.equal(nodes(tree, 'amll')[0].props.demoPlayback.anchorMonotonicMs, 26000);
  p.run(() => RendererPreview({ active: false })); assert.equal(p.timers.size, 0); p.unmount();
  console.log('Tour/onboarding: zero 100ms position updates; one timer callback per 25s loop, pause/background cleanup passed.');
}

function checkNativeClock() {
  const h = hooks(), timings = [], subscriptions = new Set();
  const { useNativeLyricsClock } = load('components/lyrics/native/use-native-lyrics-clock.ts', { ...h.mocks,
    '@/store/playback-store': { usePlaybackStore: { getState: () => ({ anchorPositionMs: 99999, isPlaying: true }),
      subscribe: fn => { subscriptions.add(fn); return () => subscriptions.delete(fn); } } },
    'react-native-reanimated': { useSharedValue: value => h.react.useMemo(() => ({ value }), []), cancelAnimation() {}, Easing: { linear: 'linear' },
      withTiming: (target, config) => { timings.push({ target, config }); return target; } },
  }, h.globals);
  let anchor = { anchorPositionMs: 4000, anchorMonotonicMs: 500, isPlaying: true };
  const render = preview => h.run(() => useNativeLyricsClock({ active: true, duration: 25000, demo: true, demoPlayback: anchor, preview }));
  render(null); assert.equal(timings.at(-1).config.duration, 20500); assert.equal(subscriptions.size, 0);
  const count = timings.length; h.advance(1000); render(null); assert.equal(timings.length, count, 'An unchanged demo anchor never restarts the UI tween');
  anchor = { ...anchor, isPlaying: false }; assert.equal(render(null).position.value, 4000);
  anchor = { ...anchor, isPlaying: true }; assert.equal(render(7000).position.value, 7000, 'A scrub preview holds at the requested position');
  h.foreground('background'); assert.equal(render(null).running.value, false); h.unmount();
  console.log('Native demo clock: projected anchors, UI tween reuse, pause, scrub hold, and background cleanup passed.');
}

function checkCueTimeline() {
  const source = buildSync({ entryPoints: [path.join(root, 'components/lyrics/native/native-cue-timeline.ts')], bundle: true,
    platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports });
  const layout = load('lib/lyrics-layout.ts', {});
  const lyrics = [0, 4500, 13000, 15000].map((start, index) => ({ lineStartTime: start, lineEndTime: start + 2000,
    syllables: [{ text: 'lead', startTime: start, endTime: start + 2000 }],
    backgroundSyllables: index === 0 ? Array.from({ length: 100 }, (_, i) => ({ text: 'bg', startTime: i * 40, endTime: i * 40 + 40 })) : undefined }));
  const { cues, windows } = module.exports.buildNativeCueTimeline(lyrics);
  assert.ok(cues.length < 20, '100 background syllables must not become 200 RN cue notifications');
  for (let time = 0; time <= 18000; time += 7) {
    const index = Math.max(0, cues.findLastIndex(cue => cue <= time));
    const expected = layout.getPlaybackWindowState(time, lyrics);
    for (const key of Object.keys(expected).filter(key => key !== 'pauseProgress')) assert.equal(windows[index][key], expected[key], `${time}ms ${key}`);
    assert.deepEqual(layout.getAutoScrollTargetRange(windows[index], time, lyrics), layout.getAutoScrollTargetRange(expected, time, lyrics));
  }
  console.log(`Native cues: 100 background syllables produce ${cues.length} line-state cues; exact presentation/scroll parity across overlaps, pauses and seeks passed.`);
}

async function checkVault() {
  const h = hooks(); let rowReads = 0;
  const catalog = Array.from({ length: 1000 }, (_, index) => ({ vaultId: String(index), track: { title: `Song ${index}`, artist: 'Artist' },
    get lineCount() { rowReads++; return 100; } }));
  const state = { currentTrack: { id: 'old', title: 'Old' }, lyrics: [{}] }, saved = [];
  const useStore = Object.assign(selector => selector(state), { getState: () => state });
  const clearSharedPayloads = () => {};
  const { default: VaultScreen } = load('app/(tabs)/vault.tsx', { ...h.mocks,
    '@shopify/flash-list': { FlashList: 'FlashList' },
    '@react-native-vector-icons/ionicons': 'Icon', 'expo-file-system': {}, 'expo-sharing': {}, 'expo-blur': { BlurView: 'BlurView' },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' }, '@/components/ui/motion-pressable': { MotionPressable: 'Button' },
    '@/components/ui/promotional-backdrop': { PromotionalBackdrop: 'Backdrop' }, '@/components/lyrics/bridged-artwork-image': { BridgedArtworkImage: 'Artwork' },
    '@/components/lyrics/desktop-vault-catalog': { DesktopVaultCatalog: 'Desktop' }, '@/constants/design': { Design: {} },
    '@/hooks/use-vault-incoming-share': { useVaultIncomingShare: () => ({ resolvedSharedPayloads: [], clearSharedPayloads }) },
    '@/lib/mobile-lyrics-vault': { readVaultCatalog: async () => catalog, saveMobileVaultLyrics: async entry => saved.push(entry) },
    '@/lib/lyrics-ttml-import': {}, '@/lib/lyrics-ttml-export': {}, '@/lib/lyrics-policy': {}, '@/store/playback-store': { usePlaybackStore: useStore },
  }, h.globals);
  h.run(VaultScreen); await new Promise(setImmediate);
  let list = nodes(h.run(VaultScreen), 'FlashList')[0];
  assert.equal(list.props.data.length, 1000); assert.equal(rowReads, 0, 'Catalog loading must not construct all row subtrees');
  for (const item of list.props.data.slice(0, 6)) list.props.renderItem({ item });
  assert.equal(rowReads, 12, 'Six requested visible rows construct only six subtrees (two line-count reads per row)');
  const search = nodes(list.props.ListHeaderComponent, 'TextInput').find(node => node.props.accessibilityLabel === 'Search vault');
  search.props.onChangeText('song 999'); list = nodes(h.run(VaultScreen), 'FlashList')[0]; assert.equal(list.props.data.length, 1);
  state.currentTrack = { id: 'new', title: 'Newest' }; state.lyrics = [{ newest: true }];
  const save = nodes(list.props.ListHeaderComponent, 'Button').find(node => node.props.accessibilityLabel === 'Save current song to vault');
  save.props.onPress(); await new Promise(setImmediate);
  assert.equal(saved[0].track.id, 'new'); assert.equal(saved[0].lyrics[0].newest, true, 'Saving reads current playback without keeping a large lyric subscription');
  h.unmount();
  console.log('1,000-song vault: only requested rows construct subtrees, lazy remaining rows, search and fresh playback save passed.');
}

function checkClosedMenu() {
  const h = hooks(), selectors = [];
  let reads = 0;
  const state = { get lyrics() { reads++; return []; }, get lyricsSource() { reads++; return 'test'; },
    get lyricsStatusMessage() { reads++; return 'ready'; }, get bridgeTiming() { reads++; return {}; },
    get driftOffset() { reads++; return 42; } };
  const { SettingsMenu } = load('components/lyrics/settings-menu.tsx', { ...h.mocks,
    '@react-native-vector-icons/ionicons': 'Icon', 'expo-blur': { BlurView: 'BlurView' },
    'react-native-gesture-handler': { GestureHandlerRootView: 'Root' },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    '@/lib/lyrics-timing': { getLyricsTimingLabel: () => 'Line' }, '@/lib/network': {}, '@/lib/bridge-settings': {}, '@/lib/bridge-client': {},
    '@/components/ui/motion-pressable': { MotionPressable: 'Button' },
    'expo-camera': { CameraView: 'Camera', useCameraPermissions: () => [{ granted: false }, () => {}] },
    'react-native-reanimated': { __esModule: true, default: { View: 'AnimatedView' }, useReducedMotion: () => false,
      FadeInDown: { duration: () => ({ reduceMotion: () => ({}) }) }, ReduceMotion: { System: 0 } },
    '@/store/playback-store': { usePlaybackStore: fn => { selectors.push(fn); return fn(state); } },
  }, h.globals);
  h.run(() => SettingsMenu({ open: false }));
  const closed = [...selectors];
  for (let i = 0; i < 600; i++) for (const selector of closed) selector(state);
  assert.equal(reads, 0, 'A closed menu cannot read lyric/diagnostic packets on store updates');
  h.run(() => SettingsMenu({ open: true })); assert.ok(reads >= 4, 'Opening the menu subscribes to current diagnostics');
  h.unmount();
  console.log('Closed settings: zero lyric/diagnostic reads across 600 playback updates; fresh subscriptions on open passed.');
}

function checkTranslationSelector() {
  const { hasLyricsTranslation } = load('lib/lyrics-timing.ts', {});
  let reads = 0;
  const lyrics = Array.from({ length: 1000 }, () => ({ get translatedText() { reads++; return ''; } }));
  assert.equal(hasLyricsTranslation(lyrics), false);
  assert.equal(reads, 1000);
  for (let i = 0; i < 600; i++) assert.equal(hasLyricsTranslation(lyrics), false);
  assert.equal(reads, 1000, '600 unrelated playback updates must not scan the lyrics again');
  assert.equal(hasLyricsTranslation([{ translatedText: 'new translation' }]), true, 'A new immutable packet invalidates the result');
  assert.equal(hasLyricsTranslation([{ backgroundTranslatedText: 'background' }]), true);
  console.log('Translation selector: 1,000 reads once, zero rescans over 600 playback updates, new/translated background packets passed.');
}

function checkPlayerNotificationsAndCatalogMerge() {
  const source = fs.readFileSync(path.join(root, 'app/(tabs)/index.tsx'), 'utf8');
  const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks = {};
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ['handleActiveLineChange', 'openShareLyrics'].includes(node.name.getText(ast)))
      callbacks[node.name.getText(ast)] = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const lyrics = Array.from({ length: 20 }, (_, id) => ({ id }));
  const pushed = [];
  const context = { result: {}, activeLineIndex: { current: -1 }, resolvedArtworkUrl: 'art', router: { push: route => pushed.push(route) },
    usePlayerTourStore: { getState: () => ({ active: false }) },
    usePlaybackStore: { getState: () => ({ lyrics }) }, setActiveLineIndex() { throw new Error('Line notifications cannot trigger a player render'); } };
  for (const [name, callback] of Object.entries(callbacks)) vm.runInNewContext(ts.transpileModule(`result.${name} = ${callback}`, {}).outputText, context);
  for (let i = 0; i < 600; i++) context.result.handleActiveLineChange(i % 20);
  context.result.handleActiveLineChange(7);
  context.result.openShareLyrics();
  assert.equal(pushed[0].params.line, '7', 'Sharing reads the most recent line without React state');

  const catalog = fs.readFileSync(path.join(root, 'components/lyrics/desktop-vault-catalog.tsx'), 'utf8');
  const catalogAst = ts.createSourceFile('desktop.tsx', catalog, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let mergeSource;
  function findMerge(node) {
    if (ts.isCallExpression(node) && node.expression.getText(catalogAst) === 'setEntries' && ts.isArrowFunction(node.arguments[0])) mergeSource = node.arguments[0].getText(catalogAst);
    ts.forEachChild(node, findMerge);
  }
  findMerge(catalogAst);
  let reads = 0;
  const entry = id => ({ get vaultId() { reads++; return String(id); } });
  const previous = Array.from({ length: 1000 }, (_, i) => entry(i));
  const incoming = Array.from({ length: 200 }, (_, i) => entry(i + 900));
  const mergeContext = { offset: 1000, result: { entries: incoming }, merge: null };
  vm.runInNewContext(ts.transpileModule(`merge = ${mergeSource}`, {}).outputText, mergeContext);
  const merged = mergeContext.merge(previous);
  assert.equal(merged.length, 1100); assert.equal(merged[900], previous[900], 'Overlapping pages retain the first version');
  assert.ok(reads <= (previous.length + incoming.length) * 2, 'Catalog pagination cannot perform quadratic duplicate scans');
  console.log('Player line notifications: no React state writes; sharing stays current. Desktop pagination: linear duplicate checks over 1,200 entries passed.');
}

function checkCanvasPresentation() {
  const source = fs.readFileSync(path.join(root, 'components/lyrics/native/native-lyrics-view.tsx'), 'utf8');
  const ast = ts.createSourceFile('native.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'updateWindow') callback = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let renders = 0, scrolls = 0, notifications = 0;
  const lyrics = [{}];
  const context = { update: null, mounted: { current: true }, generation: { current: 1 }, latestLyrics: { current: lyrics }, lyrics,
    active: true, AppState: { currentState: 'active' }, currentPosition: { current: 0 }, backgrounds: [], timing: {}, reveal: 'canvas',
    activeIndex: { current: -1 }, lastScrollTarget: { current: '' }, getPlaybackWindowState: time => ({ activeLineStartIndex: time }),
    getAutoScrollTargetRange: () => ({ startIndex: 0 }), setWindow: () => renders++, scrollTo: () => scrolls++, onActiveLineChange: () => notifications++ };
  vm.runInNewContext(ts.transpileModule(`update = ${callback}`, {}).outputText, context);
  for (let cue = 0; cue < 100; cue++) context.update(cue, 1);
  assert.equal(renders, 0); assert.equal(scrolls, 100); assert.equal(notifications, 100);
  context.reveal = 'clip'; context.update(100, 1); assert.equal(renders, 1, 'Experimental React presentation still receives its required state');
  context.update(101, 0); assert.equal(renders, 1, 'Old packet callbacks stay invalidated');
  console.log('Native canvas: 100 line cues issue scroll/active notifications with zero React presentation updates; clip fallback and stale packets passed.');
}

(async () => { checkDemoClocks(); checkNativeClock(); checkCueTimeline(); await checkVault(); checkClosedMenu(); checkTranslationSelector(); checkPlayerNotificationsAndCatalogMerge(); checkCanvasPresentation(); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
