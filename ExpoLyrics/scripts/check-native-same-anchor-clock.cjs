/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { build, buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');

(async () => {
  // Bundle production detector packet, store, and refresh gate with native stubs.
  const bundle = await build({
    stdin: {
      resolveDir: root,
      contents: `
        export * from './lib/spotify-detector/timing-diagnostics';
        export { projectedPosition, clusterPositionAge } from './lib/spotify-detector/protocol';
        export { detectorPacket } from './lib/spotify-detector/packet';
        export { usePlaybackStore } from './store/playback-store';
        export {
          NativeRendererReadyRefreshGate,
          registerNativeRendererReadyResync,
          requestNativeRendererReadyResync,
          getSharedNativeRendererReadyRefreshGate,
          getRendererContentKey,
          resetNativeRendererReadyRefreshForTests,
        } from './components/lyrics/native/native-renderer-ready-refresh';
      `,
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [{
      name: 'native-stubs',
      setup(b) {
        b.onResolve({ filter: /^(@react-native-async-storage\/async-storage|expo-secure-store|expo-constants|react-native)$/ }, a => ({ path: a.path, namespace: 'native-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'native-stub' }, a => ({ contents: a.path === 'react-native'
          ? 'export const AppState={currentState:"active",addEventListener:()=>({remove(){}})};export const Platform={OS:"web"};'
          : 'export default {getItem:async()=>null,setItem:async()=>{}};export const getItemAsync=async()=>null;export const setItemAsync=async()=>{};export const deleteItemAsync=async()=>{};' }));
      },
    }],
  });

  let wall = 1793420701600;
  let mono = 10000;
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    console,
    process: { env: { NODE_ENV: 'test' } },
    Buffer,
    TextDecoder,
    TextEncoder,
    URL,
    Date: class extends Date { static now() { return wall; } },
    performance: { now: () => mono },
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  });
  context.global = context;

  vm.runInContext(bundle.outputFiles[0].text, context);
  const {
    usePlaybackStore,
    detectorPacket,
    registerNativeRendererReadyResync,
    resetNativeRendererReadyRefreshForTests,
  } = context.module.exports;

  const store = usePlaybackStore;
  store.setState({ playbackMode: 'mobile' });

  // 1) Test continuous playback anchor initialization
  // Spotify source player timestamp and position from trace
  const sourcePlayerTimestampMs = 1793420691598;
  const sourceRawPositionMs = 27132;
  const trackUri = 'spotify:track:0000000000000000000001';

  // Packet 1: Initial continuous playback packet at mono = 10000, server snapshot is 10s into playing
  const initialSample = {
    title: 'Song A',
    artist: 'Artist A',
    album: 'Album A',
    artworkUrl: 'https://example.com/art.jpg',
    uri: trackUri,
    positionMs: sourceRawPositionMs,
    durationMs: 180000,
    playing: true,
    device: 'Phone',
    receivedAt: wall,
    positionTimestampMs: sourcePlayerTimestampMs,
    sourceServerTimestampMs: sourcePlayerTimestampMs + 10000,
    positionObservedAt: { wallMs: wall, monotonicMs: mono },
  };

  const packet1 = detectorPacket(initialSample, wall, mono);
  assert.equal(packet1.positionTimestampMs, sourcePlayerTimestampMs, 'Packet carries source positionTimestampMs');
  assert.equal(packet1.sourcePositionMs, sourceRawPositionMs, 'Packet carries sourcePositionMs');
  assert.equal(packet1.positionMs, 37132, 'Initial projected position is 27132 + 10000ms cluster age');

  store.getState().ingestPacket(packet1, 'mobile');
  const initialAnchorPosition = store.getState().anchorPositionMs;
  const initialAnchorMono = store.getState().anchorMonotonicMs;
  assert.equal(initialAnchorPosition, 37132, 'Initial anchor position matches packet');
  assert.equal(initialAnchorMono, 10000, 'Initial anchor monotonic matches receipt time');

  // Helper to test delayed identical source anchor samples
  function verifyDelayedIdenticalSample(delayMs, baseElapsedMs, serverLagMs) {
    const requestStartMono = 10000 + baseElapsedMs;
    const requestStartWall = sourcePlayerTimestampMs + baseElapsedMs;
    mono = requestStartMono + delayMs;
    wall = requestStartWall + delayMs;

    const expectedContinuousPosition = initialAnchorPosition + (mono - initialAnchorMono);
    const serverTimestamp = requestStartWall + serverLagMs;

    const delayedSample = {
      title: 'Song A',
      artist: 'Artist A',
      album: 'Album A',
      artworkUrl: 'https://example.com/art.jpg',
      uri: trackUri,
      positionMs: sourceRawPositionMs, // Identical continuous source anchor 27132
      durationMs: 180000,
      playing: true,
      device: 'Phone',
      receivedAt: wall,
      positionTimestampMs: sourcePlayerTimestampMs, // Identical continuous player timestamp 1793420691598
      sourceServerTimestampMs: serverTimestamp,
      positionObservedAt: { wallMs: wall, monotonicMs: mono },
    };

    const delayedPacket = detectorPacket(delayedSample, wall, mono);
    assert.equal(delayedPacket.positionTimestampMs, sourcePlayerTimestampMs, `Delayed ${delayMs}ms carries exact source positionTimestampMs`);
    assert.equal(delayedPacket.sourcePositionMs, sourceRawPositionMs, `Delayed ${delayMs}ms carries exact sourcePositionMs`);
    assert.equal(delayedPacket.uri, trackUri, `Delayed ${delayMs}ms carries exact track URI`);

    const ingestResult = store.getState().ingestPacket(delayedPacket, 'mobile');
    assert.equal(ingestResult.trackChanged, false, `Track is unchanged on ${delayMs}ms delay`);
    assert.equal(ingestResult.seekDetected, false, `Delayed ${delayMs}ms packet repeating identical anchor is NOT misclassified as seek`);

    // Verify store running anchor is preserved
    assert.equal(store.getState().anchorMonotonicMs, initialAnchorMono, `Store anchor monotonic preserved on ${delayMs}ms delay`);
    assert.equal(store.getState().anchorPositionMs, initialAnchorPosition, `Store anchor position preserved on ${delayMs}ms delay`);

    // Verify drift is EXACTLY 0ms
    const currentRunningPosition = store.getState().anchorPositionMs + (mono - store.getState().anchorMonotonicMs);
    const drift = currentRunningPosition - expectedContinuousPosition;
    assert.equal(Math.abs(drift), 0, `Delayed ${delayMs}ms same-anchor produces exactly 0ms drift (actual: ${drift}ms)`);
    assert.equal(store.getState().playbackPosition, expectedContinuousPosition, `Store playbackPosition matches continuous running projection on ${delayMs}ms delay`);
  }

  // 2) Reproduce delayed identical samples at 1273ms, 1900ms, 2800ms, and 5000ms
  // Case A: 1273ms (reproducing trace snapshot: serverLag 62ms)
  verifyDelayedIdenticalSample(1273.15, 26389, 62);

  // Case B: 1900ms (crosses >= 1800ms threshold)
  verifyDelayedIdenticalSample(1900, 28000, 70);

  // Case C: 2800ms (gap found in review: projected delta ~2700ms >= 1800ms)
  verifyDelayedIdenticalSample(2800, 31000, 80);

  // Case D: 5000ms (extreme network / thread freeze delay: projected delta ~4900ms >= 1800ms)
  verifyDelayedIdenticalSample(5000, 35000, 100);

  // 3) Real seek still re-anchors
  mono = 50000;
  wall = 1793420741600;
  const seekTargetPosition = 90000;
  const seekTimestamp = sourcePlayerTimestampMs + 45000;

  const seekSample = {
    title: 'Song A',
    artist: 'Artist A',
    album: 'Album A',
    artworkUrl: 'https://example.com/art.jpg',
    uri: trackUri,
    positionMs: seekTargetPosition,
    durationMs: 180000,
    playing: true,
    device: 'Phone',
    receivedAt: wall,
    positionTimestampMs: seekTimestamp,
    sourceServerTimestampMs: seekTimestamp,
    positionObservedAt: { wallMs: wall, monotonicMs: mono },
  };

  const seekPacket = detectorPacket(seekSample, wall, mono);
  const seekResult = store.getState().ingestPacket(seekPacket, 'mobile');
  assert.equal(seekResult.seekDetected, true, 'Real seek is detected');
  assert.equal(store.getState().anchorPositionMs, seekTargetPosition, 'Real seek updates store anchor position');
  assert.equal(store.getState().anchorMonotonicMs, mono, 'Real seek updates store anchor monotonic time');

  // 4) Real pause and resume work
  mono = 55000;
  wall = 1793420746600;
  const pauseSample = {
    ...seekSample,
    playing: false,
    receivedAt: wall,
    positionTimestampMs: seekTimestamp + 5000,
    sourceServerTimestampMs: seekTimestamp + 5000,
    positionObservedAt: { wallMs: wall, monotonicMs: mono },
  };
  const pausePacket = detectorPacket(pauseSample, wall, mono);
  store.getState().ingestPacket(pausePacket, 'mobile');
  assert.equal(store.getState().isPlaying, false, 'Real pause updates store isPlaying');

  mono = 58000;
  wall = 1793420749600;
  const resumeSample = {
    ...pauseSample,
    playing: true,
    receivedAt: wall,
    positionTimestampMs: seekTimestamp + 5000,
    sourceServerTimestampMs: seekTimestamp + 5000,
    positionObservedAt: { wallMs: wall, monotonicMs: mono },
  };
  const resumePacket = detectorPacket(resumeSample, wall, mono);
  store.getState().ingestPacket(resumePacket, 'mobile');
  assert.equal(store.getState().isPlaying, true, 'Real resume updates store isPlaying');

  // 5) Real track change still re-anchors
  mono = 60000;
  wall = 1793420751600;
  const nextTrackUri = 'spotify:track:0000000000000000000002';
  const nextTrackSample = {
    title: 'Song B',
    artist: 'Artist B',
    album: 'Album B',
    artworkUrl: 'https://example.com/art2.jpg',
    uri: nextTrackUri,
    positionMs: 0,
    durationMs: 200000,
    playing: true,
    device: 'Phone',
    receivedAt: wall,
    positionTimestampMs: 1793420750000,
    sourceServerTimestampMs: 1793420750000,
    positionObservedAt: { wallMs: wall, monotonicMs: mono },
  };

  const nextTrackPacket = detectorPacket(nextTrackSample, wall, mono);
  const trackChangeResult = store.getState().ingestPacket(nextTrackPacket, 'mobile');
  assert.equal(trackChangeResult.trackChanged, true, 'Track change is detected');
  assert.equal(store.getState().currentTrack.id, 'spotify-connect:0000000000000000000002', 'Track identity updated');
  assert.equal(store.getState().anchorPositionMs, 0, 'New track re-anchors to initial position');
  assert.equal(store.getState().anchorMonotonicMs, mono, 'New track updates anchor monotonic time');

  // 6) Real remount gate lifecycle test:
  // Tests actual NativeLyricsView component mounting/unmounting across:
  // - genuine FIRST renderer mount
  // - both renderer switch directions: Spicy -> AMLL, AMLL -> Spicy
  // - both portrait-landscape directions: Portrait -> Landscape, Landscape -> Portrait
  // - content changes (song change)
  // - foreground semantics
  resetNativeRendererReadyRefreshForTests();

  const viewSource = path.join(root, 'components/lyrics/native/native-lyrics-view.tsx');
  const viewCode = buildSync({
    entryPoints: [viewSource],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['*'],
  }).outputFiles[0].text;

  let currentAppStatus = 'active';
  const appListeners = new Set();
  const appState = {
    get currentState() { return currentAppStatus; },
    addEventListener: (_type, listener) => {
      appListeners.add(listener);
      return { remove: () => appListeners.delete(listener) };
    },
  };

  let playbackCurrentTrack = { id: 'track-1' };
  let playbackLyrics = [{ lineStartTime: 0, lineEndTime: 5000, syllables: [{ text: 'Song 1 Line', startTime: 0, endTime: 5000 }] }];
  let playbackSource = 'spotify';

  let currentHookSlots = [];
  let currentCleanups = [];
  let hookCursor = 0;

  const jsx = (type, props) => ({ type, props: props ?? {} });
  const react = {
    memo: fn => fn,
    createContext: () => ({ Provider: 'Provider' }),
    useRef(value) {
      const index = hookCursor++;
      return currentHookSlots[index] ??= { current: value };
    },
    useState(value) {
      const index = hookCursor++;
      const slot = currentHookSlots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useMemo(fn, deps) {
      const index = hookCursor++;
      const old = currentHookSlots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) currentHookSlots[index] = { deps, value: fn() };
      return currentHookSlots[index].value;
    },
    useCallback(fn, deps) {
      const index = hookCursor++;
      const old = currentHookSlots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) currentHookSlots[index] = { deps, value: fn };
      return currentHookSlots[index].value;
    },
    useEffect(fn, deps) {
      const index = hookCursor++;
      const old = currentHookSlots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        old?.cleanup?.();
        const cleanup = fn();
        currentHookSlots[index] = { deps, cleanup };
        if (typeof cleanup === 'function') currentCleanups.push(cleanup);
      }
    },
  };

  const sharedPlayback = {
    playbackMode: 'mobile',
    connectionStatus: 'disconnected',
    get currentTrack() { return playbackCurrentTrack; },
    get lyrics() { return playbackLyrics; },
    get lyricsSource() { return playbackSource; },
    isPlaying: true,
    lyricsStatusMessage: '',
    lyricsMetadata: {},
    durationMs: 180000,
    anchorPositionMs: 10000,
    anchorMonotonicMs: 10000,
  };

  const modules = {
    react,
    '@/lib/native-clock-diagnostics': { emitNativeClockDiagnostic() {} },
    'react-native': { AppState: appState, FlatList: 'FlatList', Linking: { openURL() {} }, Pressable: 'Pressable', StyleSheet: { create: x => x }, Text: 'Text', View: 'View' },
    'expo-image': { Image: 'Image' },
    '@shopify/flash-list': { FlashList: 'FlashList' },
    'react-native-reanimated': { useAnimatedReaction() {}, useDerivedValue: fn => ({ value: fn() }), useSharedValue: value => ({ value }) },
    'react-native-worklets': { scheduleOnRN() {} },
    '../lyrics-packet-transition': { useLyricsPacketTransition: () => null, withLyricsPacketTransition: component => component },
    '@/store/playback-store': {
      usePlaybackStore: Object.assign(selector => selector(sharedPlayback), { getState: () => sharedPlayback }),
    },
    '@/lib/lyrics-timing': { detectLyricsTimingMode: () => 'synced' },
    '@/lib/lyrics-layout': {
      getAutoScrollTargetRange: () => null,
      getBackgroundActiveLines: () => [],
      getLyricTimingIndex: () => ({}),
      getPlaybackWindowState: () => ({ visualActiveLineStartIndex: 0, visualActiveLineEndIndex: 0, focusLineIndex: 0 }),
    },
    './native-lyrics-model': {
      buildNativeRows: () => [{ key: 'row', line: {}, backgrounds: [], index: 0 }],
      nativeFollowIndex: (_rows, index) => index,
      nativeScrollSourceKey: () => 'mock-source',
    },
    './native-lyric-row': { NativeLyricRowView: 'NativeLyricRowView' },
    './use-native-lyrics-clock': { useNativeLyricsClock: () => ({ position: { value: 0 }, running: false, seekVersion: 0 }) },
    './native-lyrics-fonts': { NativeLyricsFontContext: { Provider: 'Provider' }, useNativeLyricsFonts: () => undefined },
    './reference-scroll': {
      initialScrollCommand: { serial: 0, offset: 0, delta: 0, index: 0, firstVisible: 0, interval: 800, instant: true, interlude: false, snap: false },
      ReferenceScrollContext: { Provider: 'Provider' },
      ReferenceScrollView: 'ReferenceScrollView',
    },
    './amll-layout-cell': { AmllLayoutCell: 'AmllLayoutCell' },
    '../use-playback-timeline-clock': {},
    './native-cue-timeline': { buildNativeCueTimeline: () => ({ cues: [0], windows: [{ visualActiveLineStartIndex: 0, visualActiveLineEndIndex: 0 }] }) },
    './native-renderer-ready-refresh': context.module.exports,
    'react/jsx-runtime': { jsx, jsxs: jsx },
  };

  const viewModule = { exports: {} };
  vm.runInNewContext(viewCode, {
    __DEV__: false,
    module: viewModule,
    exports: viewModule.exports,
    require: name => { assert(name in modules, `native view mock missing ${name}`); return modules[name]; },
  });
  const NativeLyricsView = viewModule.exports.NativeLyricsView;

  let resyncCount = 0;
  const unregisterResync = registerNativeRendererReadyResync({
    canResync: () => true,
    resyncPlayback: () => { resyncCount++; },
  });

  const findFlash = node => !node || typeof node !== 'object' ? null : node.type === 'FlashList' ? node :
    (Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]).map(findFlash).find(Boolean);

  // Mounts a REAL separate component instance (simulating distinct React tree nodes)
  function mountLyricsWrapper(props) {
    const slots = [];
    const cleanups = [];
    currentHookSlots = slots;
    currentCleanups = cleanups;
    hookCursor = 0;
    const tree = NativeLyricsView({
      active: true,
      tapToSeekEnabled: true,
      demoLyrics: undefined,
      autoFollowEnabled: false,
      ...props,
    });
    const flash = findFlash(tree);
    assert(flash?.props?.onContentSizeChange, 'Rendered native lyrics tree exposes FlashList onContentSizeChange');

    return {
      triggerContentReady() {
        flash.props.onContentSizeChange();
      },
      unmount() {
        cleanups.forEach(cleanup => cleanup());
      },
    };
  }

  // Step 1: Genuine FIRST renderer mount (Portrait Spicy)
  let wrapper = mountLyricsWrapper({ style: 'spicy', landscapeMode: false });
  wrapper.triggerContentReady();
  assert.equal(resyncCount, 1, 'Genuine FIRST renderer mount dispatches detector resync');

  // Step 2: Renderer switch direction 1 (Spicy -> AMLL in portrait)
  // Actual UI unmounts Spicy and mounts AmllLyricsView
  wrapper.unmount();
  wrapper = mountLyricsWrapper({ style: 'amll', landscapeMode: false });
  wrapper.triggerContentReady();
  assert.equal(resyncCount, 1, 'Renderer switch (Spicy -> AMLL) avoids repeated detector resync on presentation-only remount');

  // Step 3: Renderer switch direction 2 (AMLL -> Spicy in portrait)
  // Actual UI unmounts AMLL and mounts SpicyLyricsView
  wrapper.unmount();
  wrapper = mountLyricsWrapper({ style: 'spicy', landscapeMode: false });
  wrapper.triggerContentReady();
  assert.equal(resyncCount, 1, 'Renderer switch (AMLL -> Spicy) avoids repeated detector resync on presentation-only remount');

  // Step 4: Orientation switch direction 1 (Portrait -> Landscape)
  // Actual UI unmounts portrait branch and mounts landscape branch
  wrapper.unmount();
  wrapper = mountLyricsWrapper({ style: 'spicy', landscapeMode: true, fontScale: 0.88 });
  wrapper.triggerContentReady();
  assert.equal(resyncCount, 1, 'Orientation switch (Portrait -> Landscape) avoids repeated detector resync on presentation-only remount');

  // Step 5: Orientation switch direction 2 (Landscape -> Portrait)
  // Actual UI unmounts landscape branch and mounts portrait branch
  wrapper.unmount();
  wrapper = mountLyricsWrapper({ style: 'spicy', landscapeMode: false });
  wrapper.triggerContentReady();
  assert.equal(resyncCount, 1, 'Orientation switch (Landscape -> Portrait) avoids repeated detector resync on presentation-only remount');

  // Step 6: Content change (Song A -> Song B)
  // Genuine content change increments generation and dispatches resync
  playbackCurrentTrack = { id: 'track-2' };
  playbackLyrics = [{ lineStartTime: 1000, lineEndTime: 6000, syllables: [{ text: 'Song 2 Line', startTime: 1000, endTime: 6000 }] }];
  wrapper.unmount();
  wrapper = mountLyricsWrapper({ style: 'spicy', landscapeMode: false });
  wrapper.triggerContentReady();
  assert.equal(resyncCount, 2, 'Content change (track/lyrics) dispatches genuine detector resync');

  // Step 7: Foreground semantics (background -> active)
  // App backgrounding followed by active foreground dispatches resync
  for (const listener of appListeners) listener('background');
  currentAppStatus = 'background';
  currentAppStatus = 'active';
  for (const listener of appListeners) listener('active');
  assert.equal(resyncCount, 3, 'Foreground transition dispatches genuine detector resync');

  wrapper.unmount();
  unregisterResync();

  console.log('Deterministic same-anchor regression checks passed:');
  console.log(' - Delayed 1273ms, 1900ms, 2800ms, and 5000ms identical samples => running anchor preserved, 0ms drift, no seek misclassification');
  console.log(' - Real user seek (90000ms) => re-anchors to new seek position and sets seekDetected: true');
  console.log(' - Real pause & resume => updates store play state');
  console.log(' - Real track change => re-anchors to new track and clears old state');
  console.log(' - Real remount gate lifecycle: genuine FIRST mount dispatches resync');
  console.log(' - Real remount gate lifecycle: Spicy -> AMLL avoids repeated resync');
  console.log(' - Real remount gate lifecycle: AMLL -> Spicy avoids repeated resync');
  console.log(' - Real remount gate lifecycle: Portrait -> Landscape avoids repeated resync');
  console.log(' - Real remount gate lifecycle: Landscape -> Portrait avoids repeated resync');
  console.log(' - Real remount gate lifecycle: genuine content change (track-2) dispatches resync');
  console.log(' - Real remount gate lifecycle: foreground transition dispatches resync');
})();
