/* global __dirname */
// Deterministic renderer integration, not an iOS/JSI runtime test. The native
// wrappers, packet-transition HOC, view, row, Skia voice, glyph-picture frame,
// playback store, ready gate and installed Reanimated definition/setter execute.
// React scheduling, native transport, fonts, paragraph geometry and canvas are
// substituted. RN uptime, UI performance and frame timestamps have distinct epochs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');

const root = path.resolve(__dirname, '..');
const baselineIndex = process.argv.indexOf('--baseline');
const baselineClock = baselineIndex < 0 ? null : path.resolve(process.argv[baselineIndex + 1]);
const baselineStoreIndex = process.argv.indexOf('--baseline-store');
const baselineStore = baselineStoreIndex < 0 ? null : path.resolve(process.argv[baselineStoreIndex + 1]);
const transformed = new Map();
function compile(filename) {
  if (!transformed.has(filename)) transformed.set(filename, babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false, presets: ['babel-preset-expo'],
    caller: { name: 'metro', platform: 'ios', supportsStaticESM: false }, envName: 'production',
  }).code);
  return transformed.get(filename);
}
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.00001,
  `${message}: actual=${actual}, expected=${expected}`);
const reanimatedRoot = path.join(root, 'node_modules/react-native-reanimated/src');

function scenario({ initialPacket, development = false } = {}) {
  let now = 10000, currentInstance, renderDirty = false, frameId = 0, definitionTransfers = 0, hostTransfers = 0;
  let tree, rootElement, layoutWidth = 360;
  const modules = new Map(), instances = new Map(), uiQueue = [], rnQueue = [], raf = new Map(), frameHooks = new Set();
  const sharedValues = new WeakSet(), nativeObjects = new WeakSet(), nativeFunctions = new Set(), hydrated = new WeakMap();
  const appListeners = new Set(), subscriptions = new Set(), storeEvents = [], glyphFrames = [];
  const nativeNow = () => now;
  nativeFunctions.add(nativeNow);
  const ui = vm.createContext({ __DEV__: development, __RUNTIME_KIND: 2, performance: { now: () => now + 900000 }, console,
    requestAnimationFrame: fn => { const id = ++frameId; raf.set(id, fn); return id; } });
  ui.global = ui;
  ui._getAnimationTimestamp = () => now + 420000;
  const rn = vm.createContext({ __DEV__: development, __RUNTIME_KIND: 1, performance: { now: nativeNow }, console,
    process: { env: { EXPO_PUBLIC_NATIVE_LYRICS: '1' } },
    Date: { now: () => 1700000000000 + now }, setInterval: () => 1, clearInterval() {} });
  rn.global = rn;

  function onUI(value) {
    if (typeof value === 'function') {
      if (nativeFunctions.has(value)) { if (value === nativeNow) hostTransfers++; return value; }
      if (hydrated.has(value)) return hydrated.get(value);
      if (!value.__initData) return { remote: value };
      if (value.__isAnimationDefinition) definitionTransfers++;
      const receiver = { __closure: onUI(value.__closure ?? {}) };
      const bound = vm.runInContext(`(${value.__initData.code})`, ui).bind(receiver);
      receiver._recur = bound;
      hydrated.set(value, bound);
      return bound;
    }
    if (!value || typeof value !== 'object' || sharedValues.has(value) || nativeObjects.has(value)) return value;
    if (hydrated.has(value)) return hydrated.get(value);
    const copy = Array.isArray(value) ? [] : {};
    hydrated.set(value, copy);
    for (const [key, entry] of Object.entries(value)) copy[key] = onUI(entry);
    return copy;
  }
  const invokeUI = (fn, ...args) => onUI(fn)(...args);
  const scheduleOnUI = (fn, ...args) => uiQueue.push(() => invokeUI(fn, ...args));
  const scheduleOnRN = (fn, ...args) => rnQueue.push(() => (fn.remote ?? fn)(...args));
  nativeFunctions.add(scheduleOnUI); nativeFunctions.add(scheduleOnRN);

  function slot(create) {
    assert(currentInstance, 'Hooks execute inside a mounted production component');
    const index = currentInstance.cursor++;
    return currentInstance.slots[index] ??= create();
  }
  const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const memo = (create, deps) => {
    const item = slot(() => ({}));
    if (!same(item.deps, deps)) Object.assign(item, { deps, value: create() });
    return item.value;
  };
  const react = {
    memo: fn => fn,
    useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
    useRef: initial => slot(() => ({ current: initial })),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: initial => {
      const item = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [item.value, next => { const value = typeof next === 'function' ? next(item.value) : next;
        if (!Object.is(value, item.value)) { item.value = value; renderDirty = true; } }];
    },
    useEffect: (setup, deps) => {
      const item = slot(() => ({}));
      if (!same(item.deps, deps)) Object.assign(item, { setup, deps, dirty: true });
    },
    createContext: initial => {
      const context = { current: initial }; context.Provider = { context }; return context;
    },
    useContext: context => context.current,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });

  function createStore(initialize) {
    let state;
    function set(patch) {
      const previous = state;
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      renderDirty = true;
      for (const listener of subscriptions) listener(state, previous);
    }
    state = initialize(set, () => state);
    const store = selector => {
      const item = slot(() => ({}));
      const next = selector(state);
      const keys = next && typeof next === 'object' ? Object.keys(next) : [];
      if (!item.initialized || !(Object.is(next, item.value) || keys.length &&
        keys.length === Object.keys(item.value ?? {}).length && keys.every(key => Object.is(next[key], item.value[key])))) item.value = next;
      item.initialized = true;
      return item.value;
    };
    store.getState = () => state; store.setState = set;
    store.subscribe = callback => { subscriptions.add(callback); return () => subscriptions.delete(callback); };
    return store;
  }
  const appState = { currentState: 'active', addEventListener: (_, callback) => {
    appListeners.add(callback); return { remove: () => appListeners.delete(callback) };
  } };

  let valueSetter;
  function shared(initial) {
    const item = { _value: initial, _animation: null };
    sharedValues.add(item);
    Object.defineProperty(item, 'value', { get: () => item._value, set: value => {
      if (uiExecuting) valueSetter(item, value);
      else uiQueue.push(() => valueSetter(item, typeof value === 'function' ? onUI(value) : value));
    } });
    item.modify = callback => { item._value = callback(item._value); };
    item.get = () => item.value; item.set = value => { item.value = value; };
    return item;
  }
  let uiExecuting = false;
  const reanimated = {
    __esModule: true, default: { View: 'Animated.View' },
    useSharedValue: initial => slot(() => shared(initial)),
    useDerivedValue: callback => memo(() => {
      const compute = onUI(callback), item = { get value() { return compute(); } };
      sharedValues.add(item); return item;
    }, [callback]),
    useAnimatedStyle: callback => { slot(() => ({})); return { compute: onUI(callback) }; },
    useAnimatedReaction: (prepare, reactToChange) => {
      const item = slot(() => ({ previous: null }));
      item.prepare = onUI(prepare); item.react = onUI(reactToChange); item.reaction = true;
    },
    useFrameCallback: callback => {
      const item = slot(() => { const frame = { active: false }; frameHooks.add(frame);
        return { frame, setActive: active => { frame.active = active; } }; });
      item.frame.callback = onUI(callback); item.frame.owner = currentInstance;
      return item;
    },
    useReducedMotion: () => { slot(() => ({})); return false; },
  };

  function native(value) {
    if (typeof value === 'function') nativeFunctions.add(value);
    else if (value && typeof value === 'object') { nativeObjects.add(value);
      for (const entry of Object.values(value)) if (typeof entry === 'function') nativeFunctions.add(entry); }
    return value;
  }
  const paint = () => native({ setAntiAlias() {}, setShader() {}, setBlendMode() {}, setColor() {}, setAlphaf() {}, setImageFilter() {} });
  const canvas = native(Object.fromEntries(['save', 'restore', 'translate', 'scale', 'clipPath', 'saveLayer', 'drawPicture', 'drawGlyphs', 'drawPaint'].map(name => [name, () => {}])));
  let pictureSerial = 0;
  const createPicture = native(draw => { draw(canvas); return native({ picture: ++pictureSerial }); });
  const Skia = native({ XYWHRect: (x, y, width, height) => ({ x, y, width, height }), Paint: paint, Color: color => color,
    PathBuilder: native({ Make: () => { const builder = native({ addRect: () => builder, addPath: () => builder, detach: () => native({}) }); return builder; } }),
    Shader: native({ MakeLinearGradient: () => native({}) }), ImageFilter: native({ MakeBlur: () => native({}) }),
    ParagraphBuilder: native({ Make: () => {
      let text = '';
      const builder = { addText: value => { text += value; return builder; }, pushStyle: () => builder, pop: () => builder,
        build: () => ({ layout() {}, getHeight: () => 30,
          getRectsForRange: (start, end) => end > start ? [{ x: start * 12, y: 0, width: (end - start) * 12, height: 30 }] : [],
          getLineMetrics: () => [{ baseline: 25, ascent: 25, descent: 5 }], extendedVisit() {}, text }) };
      return builder;
    } }),
  });
  const skia = { Skia, createPicture, Picture: 'Picture', BlendMode: { SrcIn: 5, SrcOver: 3 }, ClipOp: { Intersect: 0 },
    TileMode: { Clamp: 0, Decal: 1 }, TextAlign: { Left: 0, Right: 1 } };
  for (const name of ['Blur', 'Canvas', 'Group', 'LinearGradient', 'Mask', 'Paint', 'Paragraph', 'Rect']) skia[name] = name;
  const fontContext = react.createContext({ fakeFonts: true });
  const localMocks = new Map([
    ['components/lyrics/native/native-lyrics-fonts.ts', { NativeLyricsFontContext: fontContext, useNativeLyricsFonts: () => ({ fakeFonts: true }) }],
    ['components/lyrics/native/reference-scroll.tsx', {
      initialScrollCommand: { serial: 0, offset: 0, delta: 0, index: 0, firstVisible: 0, interval: 800, instant: true },
      ReferenceScrollContext: react.createContext(null), ReferenceScrollView: 'ReferenceScrollView', useReferenceRowScroll: () => ({}) }],
    ['components/lyrics/native/amll-layout-cell.tsx', { AmllLayoutCell: 'AmllLayoutCell' }],
    ['components/lyrics/native/use-reference-line-motion.ts', { useReferenceLineMotion: () => reanimated.useSharedValue({ scale: 1, dark: 0.2, bright: 1 }) }],
    ['components/lyrics/native/native-interlude.tsx', { NativeInterludeView: () => null }],
    ['lib/lyrics-enrich.ts', { enrichLyrics: lines => lines }], ['lib/network.ts', {}], ['lib/bridge-settings.ts', {}],
    ['lib/artwork.ts', { resolvePacketArtworkUrl: () => undefined }],
  ]);
  const worklets = { RuntimeKind: { ReactNative: 1, UI: 2 }, scheduleOnUI, scheduleOnRN,
    isWorkletFunction: native(value => !!value?.__workletHash), createSerializable: native(value => value), serializableMappingCache: new WeakMap() };
  const external = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, zustand: { create: createStore }, 'zustand/react/shallow': { useShallow: selector => selector },
    'react-native': { AppState: appState, Platform: { OS: 'web' }, FlatList: 'FlatList', Linking: {},
      View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: value => value, absoluteFill: {} } },
    'expo-router': { useFocusEffect: callback => react.useEffect(callback, [callback]) },
    '@shopify/flash-list': { FlashList: 'FlashList', useMappingHelper: () => ({ getMappingKey: index => index }),
      useRecyclingState: (...args) => react.useState(args[0]) },
    '@shopify/react-native-skia': skia, 'react-native-reanimated': reanimated, 'react-native-worklets': worklets,
    'react-native-gesture-handler': { Pressable: 'Pressable' }, '@react-native-masked-view/masked-view': 'MaskedView',
    'expo-linear-gradient': { LinearGradient: 'LinearGradient' }, 'expo-image': { Image: 'Image' },
    '@react-native-async-storage/async-storage': { getItem: async () => null, setItem: async () => {} },
  };
  function resolveFile(target) {
    return [target, `${target}.ts`, `${target}.tsx`, `${target}.native.ts`, `${target}.native.tsx`].find(filename => fs.existsSync(filename) && fs.statSync(filename).isFile());
  }
  function load(filename) {
    filename = resolveFile(filename);
    assert(filename, 'Every local module resolves');
    const relative = path.relative(root, filename);
    if (localMocks.has(relative)) return localMocks.get(relative);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const localRequire = name => {
      if (name in external) return external[name];
      if (name === '../Colors') return { isColor: native(() => false) };
      if (name === '../common') return {};
      if (name.endsWith('/matrixUtils')) return { isAffineMatrixFlat: native(() => false) };
      if (name === '../commonTypes') return { ReduceMotion: { System: 'system', Always: 'always', Never: 'never' } };
      if (name === '../ReducedMotion') return { ReducedMotionManager: { jsValue: false, uiValue: shared(false) } };
      if (name === './util' && filename.startsWith(reanimatedRoot)) return load(path.join(reanimatedRoot, 'animation/util.native.ts'));
      if (name.startsWith('@/')) return load(path.join(root, name.slice(2)));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name));
      return require(name);
    };
    const source = baselineClock && relative === 'components/lyrics/native/use-native-lyrics-clock.ts' ? baselineClock
      : baselineStore && relative === 'store/playback-store.ts' ? baselineStore : filename;
    vm.runInContext(`(function(require,module,exports){${compile(source)}\n})`, rn)(localRequire, module, module.exports);
    return module.exports;
  }
  const animationUtil = load(path.join(reanimatedRoot, 'animation/util.native.ts'));
  valueSetter = onUI(load(path.join(reanimatedRoot, 'valueSetter.ts')).valueSetter);
  // Installed native definition returns a worklet on RN, not an eagerly
  // constructed animation object. This invariant is asserted again at handoff.
  Object.assign(reanimated, animationUtil, load(path.join(reanimatedRoot, 'animation/timing.ts')));
  reanimated.Easing = native({ linear: native(x => x), bezier: native(() => native(x => x)) });
  const store = load(path.join(root, 'store/playback-store.ts')).usePlaybackStore;
  store.setState({ playbackMode: 'mobile' });
  const ingest = patch => {
    const before = store.getState();
    const result = before.ingestPacket({ type: 'playback', trackId: 'song-a', title: 'Clock', artist: 'Fixture',
      durationMs: 180000, positionMs: 20000 + now - 10000, isPlaying: true, timestamp: 1700000000000 + now, ...patch }, 'mobile');
    storeEvents.push({ before: before.anchorPositionMs, after: store.getState().anchorPositionMs, now, ...result });
    return result;
  };
  ingest(initialPacket);
  const lyrics = [{ lineStartTime: 19000, lineEndTime: 80000,
    syllables: [{ text: 'clock', startTime: 19000, endTime: 80000 }] }];
  store.setState({ lyrics, lyricsSource: 'fixture-syllable' });
  const ready = load(path.join(root, 'components/lyrics/native/native-renderer-ready-refresh.ts'));
  let refreshes = 0, nextRefresh;
  const unregister = ready.registerNativeRendererReadyResync({ canResync: () => true, resyncPlayback: () => { refreshes++; nextRefresh?.(); } });
  const wrappers = {
    spicy: load(path.join(root, 'components/lyrics/spicy-lyrics-view.native.tsx')).SpicyLyricsView,
    amll: load(path.join(root, 'components/lyrics/amll-lyrics-view.native.tsx')).AmllLyricsView,
  };
  const NativeGlyphPicture = load(path.join(root, 'components/lyrics/native/native-glyph-picture.tsx')).NativeGlyphPicture;
  const NativeLyricRowView = load(path.join(root, 'components/lyrics/native/native-lyric-row.tsx')).NativeLyricRowView;
  let seenPaths;
  function cleanup(instance) { for (const item of instance.slots) item.cleanup?.(); }
  function walk(element, key) {
    if (!element || typeof element !== 'object') return element;
    if (Array.isArray(element)) return element.map((child, i) => walk(child, `${key}/${i}`));
    const { type, props } = element;
    if (!type) return element;
    if (typeof type === 'object' && type.context) {
      const previous = type.context.current; type.context.current = props.value;
      const result = walk(props.children, `${key}/context`); type.context.current = previous; return result;
    }
    if (typeof type === 'function') {
      let instance = instances.get(key);
      if (instance?.type !== type) { if (instance) cleanup(instance); instance = { type, cursor: 0, slots: [], props }; instances.set(key, instance); }
      seenPaths.add(key); instance.cursor = 0; instance.props = props;
      const previous = currentInstance; currentInstance = instance;
      const result = type(props); currentInstance = previous;
      if (type === NativeGlyphPicture) glyphFrames.push(instance);
      if (type === NativeLyricRowView) instance.rowPosition = props.position;
      return walk(result, `${key}/render`);
    }
    if (type === 'FlashList') return { ...element, children: props.data.map((item, index) => walk(props.renderItem({ item, index }), `${key}/row-${index}`)) };
    // A deterministic native layout report drives the actual SkiaVoice width
    // state, so the real row/voice/glyph-picture prop plumbing runs end to end.
    if (props.onLayout && type === 'Animated.View') props.onLayout({ nativeEvent: { layout: { width: layoutWidth, height: 120 } } });
    return { ...element, children: walk(props.children, `${key}/children`) };
  }
  function render() {
    for (let pass = 0; pass < 12; pass++) {
      renderDirty = false; seenPaths = new Set(); glyphFrames.length = 0;
      tree = walk(rootElement, 'root');
      for (const [key, instance] of instances) if (!seenPaths.has(key)) { cleanup(instance); instances.delete(key); }
      // Effects are deferred until the production render tree finishes.
      for (const instance of [...instances.values()].reverse()) for (const item of instance.slots) if (item.dirty) {
        item.dirty = false; item.cleanup?.(); item.cleanup = item.setup();
      }
      if (!renderDirty) return;
    }
    throw Error('Renderer integration did not settle');
  }
  function mount(style, { landscapeMode = false, width = 360 } = {}) {
    assert.equal(instances.size, 0, 'Switch mounts fresh wrapper after outgoing cleanup');
    layoutWidth = width;
    rootElement = jsx(wrappers[style], { active: true, tapToSeekEnabled: true, autoFollowEnabled: false, landscapeMode });
    render();
    assert(glyphFrames.length > 0, 'Actual NativeSkiaVoice must mount actual NativeGlyphPicture');
    const rowPositions = [...instances.values()].filter(instance => instance.type === NativeLyricRowView).map(instance => instance.rowPosition);
    for (const picture of glyphFrames) assert(rowPositions.includes(picture.props.position), 'Picture consumes the exact shared position from NativeLyricsView.renderItem');
  }
  function unmount() {
    for (const instance of [...instances.values()].reverse()) cleanup(instance);
    instances.clear(); glyphFrames.length = 0;
  }
  function drainUI() {
    uiExecuting = true;
    try { while (uiQueue.length) uiQueue.shift()(); } finally { uiExecuting = false; }
  }
  function flush() {
    drainUI();
    while (rnQueue.length) rnQueue.shift()();
    if (renderDirty && instances.size) render();
    drainUI();
  }
  function frame(ms = 0) {
    now += ms; uiExecuting = true;
    try {
      const callbacks = [...raf.values()]; raf.clear(); for (const callback of callbacks) callback(now + 420000);
      for (const instance of instances.values()) for (const item of instance.slots) if (item.reaction) {
        const value = item.prepare(); item.react(value, item.previous); item.previous = value;
      }
      for (const item of frameHooks) if (item.active) item.callback({ timestamp: now + 420000, timeSincePreviousFrame: ms });
    } finally { uiExecuting = false; }
    flush();
  }
  function findFlash(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) return node.map(findFlash).find(Boolean);
    return node.type === 'FlashList' ? node : findFlash(node.children);
  }
  function observed() {
    assert(glyphFrames.length, 'A real glyph-picture consumer stays mounted');
    return glyphFrames.map(instance => {
      const state = instance.slots.find(item => item._value?.floatClock);
      assert(state, 'Inspect actual production glyph-picture frame state');
      return { style: instance.props.spicy ? 'spicy' : 'amll', position: instance.props.position.value, consumed: state.value.time };
    });
  }
  return { store, ingest, mount, unmount, flush, frame, observed, get now() { return now; }, advance: ms => { now += ms; },
    packet: sample => load(path.join(root, 'lib/spotify-detector/packet.ts')).detectorPacket(sample, 1700000000000 + now, now),
    rowSeekVersions: () => [...instances.values()].filter(instance => instance.type === NativeLyricRowView)
      .map(instance => instance.props.seekVersion.value),
    get definitionTransfers() { return definitionTransfers; }, get hostTransfers() { return hostTransfers; },
    get refreshes() { return refreshes; }, get subscriptions() { return subscriptions.size; },
    get appListeners() { return appListeners.size; },
    onRefresh: callback => { nextRefresh = callback; }, ready: () => findFlash(tree).props.onLoad(),
    getReadyCallback: () => findFlash(tree).props.onLoad,
    stop() { unmount(); flush(); unregister(); },
  };
}

module.exports = { scenario, near };
if (require.main === module) {
const results = [];
for (const [from, to] of [['spicy', 'amll'], ['amll', 'spicy']]) for (const blockedMs of [1000, 2000, 3000]) for (const refreshMode of ['preserved', 'regressed']) {
  const run = scenario();
  const expected = () => 20000 + run.now - 10000;
  const assertConsumers = (target, message) => {
    for (const output of run.observed()) { near(output.position, target, `${message} shared position`); near(output.consumed, target, `${message} glyph-consumed time`); }
  };
  run.mount(from); run.flush(); run.frame(); assertConsumers(expected(), 'Outgoing renderer');
  run.unmount(); run.flush();
  assert.equal(run.subscriptions, 0, 'Outgoing hook releases its store subscription');
  const listenersAfterUnmount = run.appListeners;
  run.mount(to); run.advance(blockedMs); run.flush(); run.frame();
  const mountDrift = baselineClock ? -blockedMs : 0;
  assertConsumers(expected() + mountDrift, 'Incoming renderer after blocked mount');
  assert.equal(run.subscriptions, 1, 'Incoming renderer owns exactly one clock subscription');
  assert.ok(run.appListeners > listenersAfterUnmount, 'Incoming renderer installs its lifecycle observers');
  const beforeReady = run.observed()[0].consumed - expected();
  const preservedAnchor = run.store.getState().anchorMonotonicMs;
  run.onRefresh(() => run.ingest({ positionMs: expected() + (refreshMode === 'preserved' ? 60 : -3000) }));
  run.ready(); run.flush(); run.frame();
  const refreshDrift = refreshMode === 'preserved' ? mountDrift : -3000;
  if (refreshMode === 'preserved') assert.equal(run.store.getState().anchorMonotonicMs, preservedAnchor,
    'Accurate ready refresh within 80ms preserves the existing store anchor');
  else assert.equal(run.store.getState().anchorMonotonicMs, run.now,
    'Accepted regressed readiness response creates a fresh backwards anchor');
  assertConsumers(expected() + refreshDrift, `After ${refreshMode}-anchor readiness refresh`);
  const afterReady = run.observed()[0].consumed - expected();
  run.ready(); assert.equal(run.refreshes, 1, 'Repeated native readiness triggers exactly one refresh');
  for (let i = 0; i < 120; i++) run.frame(1000 / 30);
  assertConsumers(expected() + refreshDrift, 'Incoming renderer after four seconds at 30fps');
  const after4s = run.observed()[0].consumed - expected();
  assert.ok(run.definitionTransfers >= 2, 'Installed native defineAnimation must return and transfer real animation-definition worklets');
  if (!baselineClock) assert.ok(run.hostTransfers > 0, 'Production closure captures the RN uptime host function in the modeled transport');

  // Refresh can only be as authoritative as its accepted source packet. This
  // deliberately accepted stale POSITION has a fresh source timestamp: the
  // real store reanchors backwards and the real renderer faithfully follows.
  const targetBeforeRegressedResponse = expected();
  run.ingest({ positionMs: targetBeforeRegressedResponse - 3000 }); run.flush(); run.frame();
  assertConsumers(targetBeforeRegressedResponse - 3000, 'Accepted fresh-timestamp response with regressed position');
  const regressedDrift = run.observed()[0].consumed - expected();
  const anchorAfterRegression = run.store.getState().anchorPositionMs;
  run.ingest({ positionMs: 0, timestamp: 1700000000000 + run.now - 5000 }); run.flush(); run.frame();
  assert.equal(run.store.getState().anchorPositionMs, anchorAfterRegression, 'Real store rejects source timestamps older than its 250ms tolerance');
  near(run.observed()[0].consumed - expected(), -3000, 'Rejected old response cannot replace latest accepted anchor');
  results.push({ direction: `${from}->${to}`, blockedMountMs: blockedMs, fps: 30, refreshMode,
    beforeReadyDriftMs: Math.round(beforeReady), afterReadyDriftMs: Math.round(afterReady), after4sDriftMs: Math.round(after4s),
    acceptedRegressedSourceDriftMs: Math.round(regressedDrift), definitionTransfers: run.definitionTransfers });
  run.stop(); assert.equal(run.subscriptions, 0, 'Final unmount cleans store observers');
}
console.log(JSON.stringify({ implementation: baselineClock ? 'old-native-clock' : 'fixed-native-clock',
  consumption: 'native-wrapper/view/row/voice/glyph-picture', rendererSwitch: results }));
console.log('Both native switch directions passed: outgoing cleanup, real animation-definition handoff, 1-3s blocked mount, 30fps, actual glyph time consumption, preserved readiness refresh and accepted/rejected stale-source controls.');
console.log('Limits: modeled native transport and Skia geometry; no device runtime, LPM, Bluetooth, source-clock accuracy or visual-fidelity claim.');
}
