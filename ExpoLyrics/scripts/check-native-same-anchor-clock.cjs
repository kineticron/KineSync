/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');

(async () => {
  // Bundle production detector packet and store with native stubs.
  const bundle = await build({
    stdin: {
      resolveDir: root,
      contents: `
        export * from './lib/spotify-detector/timing-diagnostics';
        export { projectedPosition, clusterPositionAge } from './lib/spotify-detector/protocol';
        export { detectorPacket } from './lib/spotify-detector/packet';
        export { usePlaybackStore } from './store/playback-store';
        export { NativeRendererReadyRefreshGate, registerNativeRendererReadyResync, requestNativeRendererReadyResync } from './components/lyrics/native/native-renderer-ready-refresh';
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
    NativeRendererReadyRefreshGate,
    registerNativeRendererReadyResync,
    requestNativeRendererReadyResync,
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

  // 2) Advance time by 26389ms (elapsed time: 36389ms total from start)
  mono = 36389;
  wall = 1793420727989;
  const runningPositionBeforeRequest = initialAnchorPosition + (mono - initialAnchorMono);
  assert.equal(runningPositionBeforeRequest, 63521, 'Continuous playback advances on monotonic clock');

  // Switch occurs, triggering delayed 1273ms registration response with SAME source anchor.
  // Spotify server created snapshot 62ms after request start (clusterAge = 36453ms).
  // Phone received response after 1273.15ms network/thread delay.
  mono = 36389 + 1273.15; // 37662.15
  wall = 1793420727989 + 1273.15; // 1793420729262.15
  const expectedContinuousPosition = initialAnchorPosition + (mono - initialAnchorMono); // 64794.15

  const delayedSameAnchorSample = {
    title: 'Song A',
    artist: 'Artist A',
    album: 'Album A',
    artworkUrl: 'https://example.com/art.jpg',
    uri: trackUri,
    positionMs: sourceRawPositionMs, // Identical 27132
    durationMs: 180000,
    playing: true,
    device: 'Phone',
    receivedAt: wall,
    positionTimestampMs: sourcePlayerTimestampMs, // Identical 1793420691598
    sourceServerTimestampMs: 1793420728051, // serverTimestamp - playerTimestamp = 36453ms
    positionObservedAt: { wallMs: wall, monotonicMs: mono },
  };

  const delayedPacket = detectorPacket(delayedSameAnchorSample, wall, mono);
  // Due to omitted 1211ms transit time, normalized position is 63585ms instead of 64794.15ms.
  // Delta is -1209.15ms (regressed by > 80ms deadband).
  assert.equal(delayedPacket.positionMs, 63585);
  const regressionDelta = delayedPacket.positionMs - expectedContinuousPosition;
  assert.ok(regressionDelta < -1000, `Delayed sample regresses by ~1200ms (${regressionDelta}ms)`);

  // Ingest delayed packet
  const ingestResult = store.getState().ingestPacket(delayedPacket, 'mobile');
  assert.equal(ingestResult.trackChanged, false, 'Track is unchanged');
  assert.equal(ingestResult.seekDetected, false, 'Delayed packet is not recognized as a seek');

  // Verify store anchor is PRESERVED
  assert.equal(store.getState().anchorMonotonicMs, initialAnchorMono, 'Store running anchor monotonic time is preserved across delayed same-anchor snapshot');
  assert.equal(store.getState().anchorPositionMs, initialAnchorPosition, 'Store running anchor position is preserved across delayed same-anchor snapshot');

  // Verify drift is EXACTLY 0ms
  const currentRunningPosition = store.getState().anchorPositionMs + (mono - store.getState().anchorMonotonicMs);
  const drift = currentRunningPosition - expectedContinuousPosition;
  assert.equal(Math.abs(drift), 0, `Delayed 1273ms same-anchor response produces exactly 0ms drift (actual: ${drift}ms)`);
  assert.equal(store.getState().playbackPosition, expectedContinuousPosition, 'Store playbackPosition matches continuous running projection');

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

  // 4) Real track change still re-anchors
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

  // 5) Native renderer ready refresh gate logic
  // Simulate the renderer identity update in NativeLyricsView
  let resyncCount = 0;
  const unregister = registerNativeRendererReadyResync({
    canResync: () => true,
    resyncPlayback: () => { resyncCount++; },
  });

  const gate = new NativeRendererReadyRefreshGate();

  // First mount: style 'spicy', track 'track-1', lyrics length 1
  let currentStyle = 'spicy';
  let currentList = 'flash';
  let currentReveal = 'word';
  let currentDemo = false;
  let currentTrackId = 'track-1';
  let currentSource = 'spotify';
  let currentLyrics = [{ lineStartTime: 0, lineEndTime: 5000, syllables: [] }];

  let rendererIdentity = {
    style: currentStyle, list: currentList, reveal: currentReveal,
    demo: currentDemo, trackId: currentTrackId, source: currentSource, lyrics: currentLyrics,
    generation: 0,
  };

  function updateRendererIdentity(nextStyle, nextList, nextReveal, nextTrackId, nextSource, nextLyrics) {
    const prior = rendererIdentity;
    currentStyle = nextStyle; currentList = nextList; currentReveal = nextReveal;
    currentTrackId = nextTrackId; currentSource = nextSource; currentLyrics = nextLyrics;
    const isContentIdentityChanged = prior.demo !== currentDemo ||
      prior.trackId !== currentTrackId ||
      prior.source !== currentSource ||
      prior.lyrics !== currentLyrics;
    const isPresentationChanged = prior.style !== currentStyle ||
      prior.list !== currentList ||
      prior.reveal !== currentReveal;
    if (isContentIdentityChanged || isPresentationChanged) {
      rendererIdentity = {
        style: currentStyle, list: currentList, reveal: currentReveal, demo: currentDemo,
        trackId: currentTrackId, source: currentSource, lyrics: currentLyrics,
        generation: isContentIdentityChanged ? prior.generation + 1 : prior.generation,
      };
    }
  }

  // First mount
  let readyKey = `renderer-${rendererIdentity.generation}`;
  assert.equal(readyKey, 'renderer-0');
  let readyGen = gate.begin(readyKey);
  assert.equal(readyGen, 1, 'First mount starts gate generation 1');
  let dispatched = gate.onReady(readyGen, true, requestNativeRendererReadyResync);
  assert.equal(dispatched, true, 'First mount dispatches detector resync');
  assert.equal(resyncCount, 1, 'Resync dispatched exactly once on initial mount');

  // Presentation change: switch style 'spicy' -> 'amll' (track and lyrics unchanged)
  updateRendererIdentity('amll', currentList, currentReveal, currentTrackId, currentSource, currentLyrics);
  readyKey = `renderer-${rendererIdentity.generation}`;
  assert.equal(readyKey, 'renderer-0', 'Presentation change preserves rendererIdentity generation');
  readyGen = gate.begin(readyKey);
  assert.equal(readyGen, 1, 'Gate generation is unchanged on presentation change');
  dispatched = gate.onReady(readyGen, true, requestNativeRendererReadyResync);
  assert.equal(dispatched, false, 'Presentation change does NOT dispatch detector resync');
  assert.equal(resyncCount, 1, 'Resync count remains 1 after renderer switch');

  // Presentation change: switch list and reveal modes (track and lyrics unchanged)
  updateRendererIdentity('amll', 'flat', 'line', currentTrackId, currentSource, currentLyrics);
  readyKey = `renderer-${rendererIdentity.generation}`;
  assert.equal(readyKey, 'renderer-0');
  readyGen = gate.begin(readyKey);
  dispatched = gate.onReady(readyGen, true, requestNativeRendererReadyResync);
  assert.equal(dispatched, false, 'List/reveal presentation change does NOT dispatch detector resync');
  assert.equal(resyncCount, 1, 'Resync count remains 1');

  // Real track change: trackId changes to 'track-2'
  updateRendererIdentity('amll', 'flat', 'line', 'track-2', currentSource, currentLyrics);
  readyKey = `renderer-${rendererIdentity.generation}`;
  assert.equal(readyKey, 'renderer-1', 'Track change increments rendererIdentity generation');
  readyGen = gate.begin(readyKey);
  assert.equal(readyGen, 2, 'Gate generation increments on real track change');
  dispatched = gate.onReady(readyGen, true, requestNativeRendererReadyResync);
  assert.equal(dispatched, true, 'Real track change dispatches detector resync');
  assert.equal(resyncCount, 2, 'Resync count increments to 2 on real track change');

  // Real lyrics change: new lyrics payload
  const newLyrics = [{ lineStartTime: 1000, lineEndTime: 8000, syllables: [] }];
  updateRendererIdentity('amll', 'flat', 'line', 'track-2', currentSource, newLyrics);
  readyKey = `renderer-${rendererIdentity.generation}`;
  assert.equal(readyKey, 'renderer-2', 'Lyrics change increments rendererIdentity generation');
  readyGen = gate.begin(readyKey);
  assert.equal(readyGen, 3, 'Gate generation increments on lyrics change');
  dispatched = gate.onReady(readyGen, true, requestNativeRendererReadyResync);
  assert.equal(dispatched, true, 'Lyrics change dispatches detector resync');
  assert.equal(resyncCount, 3, 'Resync count increments to 3 on real lyrics change');

  unregister();
  console.log('Deterministic same-anchor regression checks passed:');
  console.log(' - Delayed 1273ms same-anchor response => running anchor preserved, 0ms drift');
  console.log(' - Real user seek (90000ms) => re-anchors to new seek position');
  console.log(' - Real track change => re-anchors to new track and clears old state');
  console.log(' - Renderer presentation switch (spicy <-> amll) => no resync dispatched');
  console.log(' - Real track / lyrics changes and first mount => resync dispatched as expected');
})();
