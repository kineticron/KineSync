/* global __dirname */
// Runs the production packet/store. Native storage/AppState and time are modeled;
// results concern source/store continuity, never audio latency or JSI portability.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { Buffer } = require('node:buffer');
const { execFileSync } = require('node:child_process');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const baselineIndex = process.argv.indexOf('--baseline-ref');
const baselineRef = baselineIndex < 0 ? null : process.argv[baselineIndex + 1];
if (baselineIndex >= 0 && !baselineRef) throw new Error('--baseline-ref requires a git revision');
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.00001,
  `${message}: actual=${actual}, expected=${expected}`);
const epoch = 1_800_000_000_000;
const uri = 'spotify:track:0000000000000000000001';

async function main() {
  const plugins = [{ name: 'native-stubs', setup(b) {
    b.onResolve({ filter: /^(@react-native-async-storage\/async-storage|expo-secure-store|expo-constants|react-native)$/ }, a => ({ path: a.path, namespace: 'native-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'native-stub' }, a => ({ contents: a.path === 'react-native'
      ? 'export const AppState={currentState:"background",addEventListener:()=>({remove(){}})};export const Platform={OS:"web"};'
      : 'export default {getItem:async()=>null,setItem:async()=>{}};export const getItemAsync=async()=>null;export const setItemAsync=async()=>{};export const deleteItemAsync=async()=>{};' }));
    if (baselineRef) b.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, a => {
      if (!a.path.startsWith(root + path.sep) || a.path.includes(`${path.sep}node_modules${path.sep}`)) return;
      const relative = path.relative(path.dirname(root), a.path).split(path.sep).join('/');
      return { contents: execFileSync('git', ['show', `${baselineRef}:${relative}`], { cwd: root, encoding: 'utf8' }),
        resolveDir: path.dirname(a.path), loader: a.path.endsWith('tsx') ? 'tsx' : a.path.endsWith('ts') ? 'ts' : 'js' };
    });
  } }];
  const bundle = await build({ stdin: { resolveDir: root, contents: `
    export { detectorPacket } from './lib/spotify-detector/packet';
    export { SpotifyDetector } from './lib/spotify-detector/client';
    export { usePlaybackStore } from './store/playback-store';` },
  bundle: true, platform: 'node', format: 'cjs', write: false, plugins });

  function runtime(development = false) {
    let wall = epoch, mono = 1000;
    const sockets = [], requests = [];
    class Socket {
      static OPEN = 1;
      readyState = 1;
      constructor() { sockets.push(this); }
      send() {}
      close() { this.readyState = 3; this.onclose?.(); }
      event(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    }
    const module = { exports: {} };
    vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require,
      __DEV__: development, console: { log() {}, debug() {}, warn() {}, error() {} },
      process: { env: { NODE_ENV: 'test' } }, Buffer, TextDecoder, TextEncoder, URL, AbortController,
      WebSocket: Socket, fetch: () => new Promise(resolve => requests.push(resolve)),
      Date: class extends Date { static now() { return wall; } }, performance: { now: () => mono },
      setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} });
    const { detectorPacket, SpotifyDetector, usePlaybackStore: store } = module.exports;
    store.getState().setPlaybackMode('mobile');
    const sample = (extra = {}) => ({ title: 'Synthetic', artist: 'Artist', album: 'Album', artworkUrl: '',
      uri, positionMs: 10000, durationMs: 300000, playing: true, device: 'Synthetic phone',
      activeDeviceId: 'device-A', playbackSessionId: 'session-A', sourceClockScope: 'detector-A/auth-1/route-1',
      receivedAt: wall, positionTimestampMs: epoch - 10000, sourceServerTimestampMs: epoch,
      positionObservedAt: { wallMs: wall, monotonicMs: mono }, ...extra });
    const packet = (extra = {}) => detectorPacket(sample(extra), wall, mono);
    return { store, sample, packet, sockets, requests,
      createDetector() {
        const accepted = [];
        const detector = new SpotifyDetector({ sample: value => accepted.push(value), status() {},
          ready() {}, sessionNeeded() {}, authenticated() {} });
        const capture = value => detector.capture(JSON.stringify(value), 'https://open.spotify.com');
        const configure = () => {
          assert.equal(capture({ type: 'credentials', authenticated: true, token: 'synthetic-test-credential-A', expiresAt: wall + 3600000 }), true);
          assert.equal(capture({ type: 'observerEndpoint', url: 'https://spclient.spotify.com/connect-state/v1/devices/synthetic-observer' }), true);
          assert.equal(capture({ type: 'socket', url: 'wss://dealer.spotify.com/' }), true);
        };
        const raw = (extra = {}) => ({ server_timestamp_ms: epoch,
          active_device_id: extra.activeDeviceId ?? 'device-A', player_state: {
            timestamp: extra.timestamp ?? epoch - 10000, position_as_of_timestamp: extra.positionMs ?? 10000,
            duration: 300000, is_playing: true, is_paused: false, session_id: extra.playbackSessionId ?? 'session-A',
            track: { uri, metadata: { title: 'Synthetic', artist_name: 'Artist', album_title: 'Album' } } } });
        const emit = (extra = {}) => detector.emit(raw(extra), wall, { origin: 'dealer',
          receipt: { wallMs: wall, monotonicMs: mono }, connectionId: detector.connectionId, generation: detector.generation });
        return { detector, accepted, capture, configure, raw, emit };
      },
      at(t) { wall = epoch + t; mono = 1000 + t; },
      stamp(nextWall, nextMono) { wall = nextWall; mono = nextMono; },
      ingest(p = packet()) { return store.getState().ingestPacket(p, store.getState().playbackMode); },
      position() { const s = store.getState(); return s.anchorPositionMs + (s.isPlaying ? mono - s.anchorMonotonicMs : 0); },
      get wall() { return wall; }, get mono() { return mono; } };
  }

  const results = [];
  function test(name, run) {
    try { results.push({ case: name, pass: true, ...run() }); }
    catch (error) { results.push({ case: name, pass: false, error: error.message }); }
  }
  async function testAsync(name, run) {
    try { results.push({ case: name, pass: true, ...await run() }); }
    catch (error) { results.push({ case: name, pass: false, error: error.message }); }
  }

  test('stationary-duplicate-advances-ordering-watermark-without-moving-anchor', () => {
    const h = runtime();
    h.ingest(h.packet({ playing: false }));
    const anchor = h.store.getState().anchorMonotonicMs;
    h.at(5000); h.ingest(h.packet({ playing: false }));
    assert.equal(h.store.getState().lastSourceClockMs, h.wall);
    assert.equal(h.store.getState().anchorMonotonicMs, anchor);
    h.ingest({ ...h.packet({ playing: true }), capturedAtMs: epoch + 1000 });
    assert.equal(h.store.getState().isPlaying, false, 'an old playing packet cannot undo the newer pause');
  });

  test('packet-preserves-complete-source-identity', () => {
    const r = runtime(), s = r.sample(), p = r.packet();
    for (const key of ['positionTimestampMs', 'sourceServerTimestampMs', 'activeDeviceId', 'playbackSessionId', 'sourceClockScope'])
      assert.equal(p[key], s[key], key);
    assert.equal(p.sourcePositionMs, s.positionMs);
    assert.equal(p.trackUri, uri); assert.equal(p.uri, uri);
  });

  for (const development of [false, true]) for (const delay of [500, 1000, 1273.1522079706192, 2000, 3000]) {
    test(`same-anchor-delay-${delay}-development-${development}`, () => {
      const r = runtime(development); r.ingest();
      const before = r.store.getState(); r.at(delay);
      const incoming = r.packet(); const expected = r.position();
      const result = r.ingest(incoming), actual = r.position();
      const evidence = { delayMs: delay, development, incomingMs: incoming.positionMs,
        beforeMs: expected, afterMs: actual, correctionMs: actual - expected, seekDetected: result.seekDetected };
      console.log(JSON.stringify({ sourceAnchorMeasurement: evidence, baselineRef }));
      near(actual, expected, 'same complete source must keep the running anchor');
      near(r.store.getState().anchorMonotonicMs, before.anchorMonotonicMs, 'anchor epoch preserved');
      assert.equal(result.seekDetected, false);
      return evidence;
    });
  }

  // Exact sanitized switch6 source/store data. The preceding 75ms deadband is
  // intentional; no assumption that Spotify wall and phone wall epochs agree.
  for (const development of [false, true]) test(`phone-mvvwcnh2-switch6-development-${development}`, () => {
    const r = runtime(development);
    const common = { uri, activeDeviceId: 'device-1', playbackSessionId: 'session-2',
      sourceClockScope: 'captured-detector/auth-1/route-1' };
    r.stamp(1793420684352, 417219185.547125);
    const first = r.packet({ ...common, positionMs: 19471, positionTimestampMs: 1793420683887,
      sourceServerTimestampMs: 1793420684232,
      positionObservedAt: { wallMs: 1793420684351, monotonicMs: 417219184.333333 } });
    r.stamp(1793420684352, 417219185.710958); r.ingest(first);
    near(r.store.getState().anchorPositionMs, 19817.21379196644, 'captured initial anchor');
    r.stamp(1793420692186, 417227019.93);
    r.ingest(r.packet({ ...common, positionMs: 27132, positionTimestampMs: 1793420691598,
      sourceServerTimestampMs: 1793420692041,
      positionObservedAt: { wallMs: 1793420692185, monotonicMs: 417227018.760458 } }));
    near(r.store.getState().anchorMonotonicMs, 417219185.710958, 'captured preceding sample stays in ordinary deadband');
    r.stamp(1793420729264, 417264098.057541);
    const registration = r.packet({ ...common, positionMs: 27132, positionTimestampMs: 1793420691598,
      sourceServerTimestampMs: 1793420728051,
      positionObservedAt: { wallMs: 1793420729262, monotonicMs: 417264096.343583 } });
    near(registration.positionMs, 63586.71395802498, 'captured normalized position');
    r.stamp(1793420729264, 417264098.227291);
    const expected = r.position(); const result = r.ingest(registration); const after = r.position();
    const evidence = { development, requestMs: 1273.1522079706192,
      receiptToStoreMs: 417264098.227291 - 417264096.343583,
      incomingMs: registration.positionMs, beforeMs: expected, afterMs: after, correctionMs: after - expected,
      capturedOldCorrectionMs: -1143.0161669254303, seekDetected: result.seekDetected };
    console.log(JSON.stringify({ phoneTraceReplay: evidence, baselineRef }));
    near(after, expected, 'captured same-source refresh must preserve store trajectory');
    assert.equal(result.seekDetected, false);
    return evidence;
  });

  for (const development of [false, true]) for (const target of [5000, 90000]) {
    test(`real-${target < 20000 ? 'backward' : 'forward'}-seek-development-${development}`, () => {
      const r = runtime(development); r.ingest(); r.at(3000);
      const p = r.packet({ positionMs: target, positionTimestampMs: epoch + 3000, sourceServerTimestampMs: epoch + 3000 });
      const result = r.ingest(p); near(r.position(), target, 'changed source anchor seek applies');
      assert.equal(result.seekDetected, true);
    });
    test(`same-raw-new-timestamp-${target}-development-${development}`, () => {
      const r = runtime(development); r.ingest(); r.at(3000);
      // Equal raw position with a NEW source timestamp is a real new anchor.
      const p = r.packet({ positionMs: 10000, positionTimestampMs: epoch + 3000, sourceServerTimestampMs: epoch + 3000 });
      const result = r.ingest(p); near(r.position(), 10000, 'new player timestamp with equal raw position applies');
      assert.equal(result.seekDetected, true);
    });
  }

  for (const field of ['activeDeviceId', 'playbackSessionId', 'sourceClockScope', 'uri']) {
    test(`changed-authority-${field}`, () => {
      const r = runtime(); r.ingest(); r.at(3000);
      const value = field === 'uri' ? 'spotify:track:0000000000000000000002' : `${field}-B`;
      const p = r.packet({ [field]: value }); const result = r.ingest(p);
      near(r.position(), p.positionMs, 'new authority reanchors');
      if (field === 'uri') assert.equal(result.trackChanged, true); else assert.equal(result.seekDetected, true);
    });
  }

  const required = ['positionTimestampMs', 'sourceServerTimestampMs', 'sourcePositionMs',
    'activeDeviceId', 'playbackSessionId', 'sourceClockScope', 'uri'];
  for (const field of required) test(`missing-${field}-invalidates-and-recovers`, () => {
    const r = runtime(); r.ingest(); r.at(3000);
    const p = r.packet(); delete p[field];
    if (field === 'uri') delete p.trackUri;
    r.ingest(p); near(r.position(), p.positionMs, 'incomplete packet must apply ordinary update');
    r.at(6000); const recovered = r.packet(); r.ingest(recovered);
    near(r.position(), recovered.positionMs, 'missing intermediate identity cannot borrow proof from earlier sample');
    r.at(9000); const expected = r.position(); const result = r.ingest(r.packet());
    near(r.position(), expected, 'recovery establishes a fresh complete tuple'); assert.equal(result.seekDetected, false);
  });

  const invalid = [
    ['positionTimestampMs', NaN], ['positionTimestampMs', Infinity], ['positionTimestampMs', 0],
    ['positionTimestampMs', Number.MAX_SAFE_INTEGER + 1], ['positionTimestampMs', epoch + 0.5],
    ['sourceServerTimestampMs', NaN], ['sourceServerTimestampMs', Infinity], ['sourceServerTimestampMs', epoch - 10001],
    ['sourcePositionMs', NaN], ['sourcePositionMs', Infinity], ['sourcePositionMs', -1],
    ['activeDeviceId', ''], ['playbackSessionId', ''], ['sourceClockScope', ''], ['uri', 'not-a-track'],
  ];
  for (const [field, value] of invalid) test(`invalid-${field}-${String(value)}`, () => {
    const r = runtime(); r.ingest(); r.at(3000);
    const p = r.packet(); p[field] = value; if (field === 'uri') p.trackUri = value;
    r.ingest(p); near(r.position(), p.positionMs, 'invalid identity must never suppress an update');
    r.at(6000); const restored = r.packet(); r.ingest(restored);
    near(r.position(), restored.positionMs, 'invalid intermediate identity clears old proof');
  });

  for (const field of ['trackId', 'spotifyTrackId']) test(`track-identity-mismatch-${field}`, () => {
    const r = runtime(); r.ingest(); r.at(3000);
    const p = r.packet(); p[field] = field === 'trackId' ? 'spotify-connect:0000000000000000000002' : '0000000000000000000002';
    r.ingest(p); near(r.position(), p.positionMs, 'URI/id mismatch cannot qualify as same source');
  });

  test('metadata-only-refresh-keeps-source-continuity', () => {
    const r = runtime(); r.ingest(); r.at(3000); const expected = r.position();
    r.ingest(r.packet({ title: 'Enriched title', artist: 'Enriched artist', album: 'Enriched album', artworkUrl: 'https://example.test/cover' }));
    near(r.position(), expected, 'metadata changes do not change source authority');
    assert.equal(r.store.getState().currentTrack.title, 'Enriched title');
  });
  test('optimistic-external-anchor-edit-invalidates-proof', () => {
    const r = runtime(); r.ingest(); r.at(3000);
    r.store.setState({ anchorPositionMs: 50000, anchorMonotonicMs: r.mono, playbackPosition: 50000 });
    const p = r.packet(); r.ingest(p); near(r.position(), p.positionMs, 'external seek must not inherit unrelated source proof');
  });
  test('compensation-edit-invalidates-proof', () => {
    const r = runtime(); r.ingest(); r.at(3000); r.store.getState().setPlaybackCompensationMs(-1000);
    const p = r.packet(); r.ingest(p); near(r.position(), p.positionMs - 1000, 'changed user compensation applies');
  });
  test('pause-resume-and-stationary-missing-proof', () => {
    const r = runtime(); r.ingest(); r.at(1000);
    r.ingest(r.packet({ playing: false, positionMs: 10000, positionTimestampMs: epoch + 1000, sourceServerTimestampMs: epoch + 1000 }));
    near(r.position(), 10000, 'pause position applies'); r.at(3000); near(r.position(), 10000, 'pause holds');
    const incomplete = r.packet({ playing: false, positionMs: 10000, positionTimestampMs: epoch + 1000, sourceServerTimestampMs: epoch + 1000 });
    delete incomplete.playbackSessionId; r.ingest(incomplete);
    r.at(5000); r.ingest(r.packet({ positionMs: 10000, positionTimestampMs: epoch + 5000, sourceServerTimestampMs: epoch + 5000 }));
    near(r.position(), 10000, 'resume applies new anchor'); r.at(7000); near(r.position(), 12000, 'resume advances from resume time');
  });
  for (const correction of [-40, 40]) test(`ordinary-deadband-${correction}`, () => {
    const r = runtime(); r.ingest(); r.at(1000); const expected = r.position();
    const p = r.packet({ positionMs: expected + correction, positionTimestampMs: epoch + 1000, sourceServerTimestampMs: epoch + 1000 });
    r.ingest(p); near(r.position(), expected, 'ordinary changed-source sub80ms deadband unchanged');
  });
  test('same-source-forward-correction-still-applies', () => {
    const r = runtime(); r.ingest(); r.at(1000);
    const p = r.packet({ sourceServerTimestampMs: epoch + 5000 }); r.ingest(p);
    near(r.position(), p.positionMs, 'same-source guard must not reject forward correction');
  });
  test('mode-change-clears-source-proof', () => {
    const r = runtime(); r.ingest(); r.at(3000);
    r.store.getState().setPlaybackMode('desktop'); r.store.getState().setPlaybackMode('mobile');
    const p = r.packet(); r.ingest(p); near(r.position(), p.positionMs, 'returning to mobile is a new source context');
  });
  test('same-authority-reconnect-retains-proof', () => {
    const r = runtime(); r.ingest(); r.at(3000); const expected = r.position();
    r.store.getState().setConnectionStatus('disconnected'); r.ingest(r.packet());
    near(r.position(), expected, 'connection status alone must not break same-authority proof');
  });
  test('desktop-packets-retain-original-behavior', () => {
    const r = runtime(); r.store.getState().setPlaybackMode('desktop');
    const desktop = () => ({ type: 'playback', trackId: 'desktop-track', title: 'Desktop', artist: 'Artist',
      durationMs: 300000, isPlaying: true, positionMs: 20000, capturedAtMs: r.wall, timestamp: r.wall });
    r.ingest(desktop()); r.at(3000); r.ingest(desktop());
    near(r.position(), 20000, 'legacy desktop updates still reanchor without mobile source proof');
  });

  // These run the actual detector parser, capture, ordering, scope assignment,
  // refresh/disconnect and foreground replay methods. Only transport is fake.
  test('actual-client-forwards-device-session-scope-through-packet', () => {
    const r = runtime(), client = r.createDetector(); client.configure(); client.emit();
    const s = client.accepted.at(-1); assert(s);
    const p = r.packet(s);
    assert.equal(p.activeDeviceId, 'device-A'); assert.equal(p.playbackSessionId, 'session-A');
    assert.equal(typeof p.sourceClockScope, 'string'); assert(p.sourceClockScope.length > 0);
    assert.equal(p.sourceClockScope, s.sourceClockScope);
    r.ingest(p); r.at(3000); const expected = r.position();
    client.detector.refresh(); client.emit();
    r.ingest(r.packet(client.accepted.at(-1)));
    near(r.position(), expected, 'actual source identity remains valid after explicit refresh');
    client.detector.clear();
  });
  test('actual-client-scope-survives-refresh-and-socket-generation', () => {
    const r = runtime(), client = r.createDetector(); client.configure(); client.detector.setEnabled(true); client.emit();
    const scope = client.accepted.at(-1).sourceClockScope; assert(scope);
    const generation = client.detector.generation, socket = client.detector.socket;
    client.detector.refresh();
    assert.notEqual(client.detector.generation, generation); assert.notEqual(client.detector.socket, socket);
    client.emit(); assert.equal(client.accepted.at(-1).sourceClockScope, scope);
    client.detector.clear();
  });
  for (const change of ['auth', 'observer-route', 'dealer-route', 'clear', 'new-instance']) {
    test(`actual-client-scope-changes-${change}`, () => {
      const r = runtime(), client = r.createDetector(); client.configure(); client.emit();
      const initial = client.accepted.at(-1).sourceClockScope; assert(initial);
      let nextClient = client;
      if (change === 'auth') client.capture({ type: 'credentials', authenticated: true,
        token: 'synthetic-test-credential-B', expiresAt: r.wall + 3600000 });
      else if (change === 'observer-route') client.capture({ type: 'observerEndpoint',
        url: 'https://spclient2.spotify.com/connect-state/v1/devices/synthetic-observer' });
      else if (change === 'dealer-route') client.capture({ type: 'socket', url: 'wss://dealer2.spotify.com/' });
      else if (change === 'clear') { client.detector.clear(); client.detector.setEnabled(true); client.configure(); }
      else { nextClient = r.createDetector(); nextClient.configure(); }
      // Change position only to avoid ordinary duplicate suppression in this
      // scope test; equal-anchor preservation is tested independently above.
      nextClient.emit({ positionMs: 10001 });
      assert.notEqual(nextClient.accepted.at(-1).sourceClockScope, initial);
      assert(nextClient.accepted.at(-1).sourceClockScope);
      nextClient.detector.clear(); client.detector.clear();
    });
  }
  for (const change of ['none', 'auth', 'observer-route', 'dealer-route']) {
    test(`actual-client-foreground-cache-scope-${change}`, () => {
      const r = runtime(), client = r.createDetector(); client.configure(); client.emit();
      const oldScope = client.accepted.at(-1).sourceClockScope; assert(oldScope);
      client.detector.setEnabled(false);
      if (change === 'auth') client.capture({ type: 'credentials', authenticated: true,
        token: 'synthetic-test-credential-B', expiresAt: r.wall + 3600000 });
      else if (change === 'observer-route') client.capture({ type: 'observerEndpoint',
        url: 'https://spclient2.spotify.com/connect-state/v1/devices/synthetic-observer' });
      else if (change === 'dealer-route') client.capture({ type: 'socket', url: 'wss://dealer2.spotify.com/' });
      const before = client.accepted.length; client.detector.setEnabled(true);
      assert.equal(client.accepted.length, before + 1, 'foreground republishes existing cache once');
      const replay = client.accepted.at(-1);
      assert.equal(replay.sourceClockScope, change === 'none' ? oldScope : undefined,
        'cached state must not certify an authority that never observed it');
      assert.equal(r.packet(replay).sourceClockScope, replay.sourceClockScope);
      client.detector.clear();
    });
  }
  for (const field of ['activeDeviceId', 'playbackSessionId']) {
    test(`actual-client-positive-${field}-handoff-publishes`, () => {
      const r = runtime(), client = r.createDetector(); client.configure(); client.emit();
      const before = client.accepted.length;
      client.emit({ [field]: `${field}-B` });
      assert.equal(client.accepted.length, before + 1, 'positive source handoff cannot be a duplicate');
      const p = r.packet(client.accepted.at(-1)); assert.equal(p[field], `${field}-B`);
      client.detector.clear();
    });
  }
  await testAsync('actual-client-stale-registration-generation-does-not-publish', async () => {
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    const r = runtime(), client = r.createDetector(); client.configure(); client.detector.setEnabled(true);
    const oldSocket = r.sockets.at(-1);
    oldSocket.event({ headers: { 'Spotify-Connection-Id': 'connection-old' } });
    assert.equal(r.requests.length, 1, 'old connection starts actual registration');
    client.detector.setEnabled(false); client.detector.setEnabled(true);
    const newSocket = r.sockets.at(-1); assert.notEqual(newSocket, oldSocket);
    r.requests[0]({ ok: true, status: 200, arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(client.raw())).buffer });
    await flush(); assert.equal(client.accepted.length, 0, 'completed old response cannot publish in new generation');
    oldSocket.event({ payloads: [client.raw()] });
    assert.equal(client.accepted.length, 0, 'old socket events are also ignored');
    newSocket.event({ headers: { 'Spotify-Connection-Id': 'connection-new' } });
    assert.equal(r.requests.length, 2, 'replacement connection starts its own registration');
    r.requests[1]({ ok: true, status: 200, arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(client.raw())).buffer });
    await flush(); assert.equal(client.accepted.length, 1, 'current registration publishes once');
    assert(client.accepted[0].sourceClockScope); client.detector.clear();
  });
  for (const change of ['auth', 'observer-route', 'dealer-route']) {
    await testAsync(`actual-client-inflight-registration-cannot-certify-new-${change}`, async () => {
      const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
      const r = runtime(), client = r.createDetector(); client.configure(); client.detector.setEnabled(true);
      const oldSocket = r.sockets.at(-1);
      oldSocket.event({ headers: { 'Spotify-Connection-Id': 'connection-old' } });
      assert.equal(r.requests.length, 1);
      client.emit(); r.ingest(r.packet(client.accepted.at(-1)));
      const before = client.accepted.length;
      if (change === 'auth') client.capture({ type: 'credentials', authenticated: true,
        token: 'synthetic-test-credential-B', expiresAt: r.wall + 3600000 });
      else if (change === 'observer-route') client.capture({ type: 'observerEndpoint',
        url: 'https://spclient2.spotify.com/connect-state/v1/devices/synthetic-observer' });
      else client.capture({ type: 'socket', url: 'wss://dealer2.spotify.com/' });
      r.requests[0]({ ok: true, status: 200, arrayBuffer: async () =>
        new TextEncoder().encode(JSON.stringify(client.raw())).buffer });
      await flush();
      oldSocket.event({ payloads: [client.raw({ positionMs: 10002 })] });
      assert.equal(client.accepted.length, before,
        'old auth/route registration and socket are discarded after authority changes');
      r.at(6000); client.emit({ positionMs: 10001 });
      const fresh = r.packet(client.accepted.at(-1));
      assert(fresh.sourceClockScope, 'new direct observation is scoped to current authority');
      r.ingest(fresh); near(r.position(), fresh.positionMs, 'fresh current authority applies after proof was revoked');
      client.detector.clear();
    });
  }

  for (const result of results) console.log(JSON.stringify({ sourceAnchorCheck: result, baselineRef }));
  const failed = results.filter(result => !result.pass);
  console.log(JSON.stringify({ sourceAnchorSummary: { baselineRef, passed: results.length - failed.length,
    failed: failed.length, total: results.length, deviceVerified: false } }));
  if (failed.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
