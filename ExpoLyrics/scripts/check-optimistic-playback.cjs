const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

const app = path.join(__dirname, '..');

function load(relative, globals = {}, dependencies = {}) {
  const exports = {};
  const { outputText } = ts.transpileModule(readFileSync(path.join(app, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  runInNewContext(outputText, {
    exports, ...globals,
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), 'unexpected dependency ' + name);
      return dependencies[name];
    },
  });
  return exports;
}

function loadDesktop(file, globals, overrides = {}) {
  const filename = path.join(app, '../DesktopBridge/src', file);
  const desktopRequire = createRequire(filename);
  const module = { exports: {} };
  runInNewContext(readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer, ...globals,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : desktopRequire(name),
  });
  return module.exports;
}

const queueModule = load('lib/playback-command-queue.ts');
const { PlaybackCommandQueue, PLAYBACK_CONFIRMATION_MS, PLAYBACK_INTENT_TTL_MS } = queueModule;

function fakeClock() {
  let now = 1000;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      timers.set(++id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(key) { timers.delete(key); },
    advance(delay) {
      const end = now + delay;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [key, { fn, at }] = next;
        timers.delete(key);
        now = at;
        fn();
      }
      now = end;
    },
  };
}

function harness(sendResult = () => 'sent') {
  const clock = fakeClock();
  const queue = new PlaybackCommandQueue(clock);
  const sent = [];
  let revision = 0;
  const send = (command, before) => {
    sent.push({ command, before });
    return sendResult(command);
  };
  queue.setTransport('account one', send);
  return {
    clock, queue, sent, send,
    types: () => sent.map(({ command }) => command.type),
    view: queue.getSnapshot,
    observe(patch = {}, state = {}) {
      queue.update({ ready: true, targetId: 'speaker', ...state,
        observation: { revision: ++revision, trackId: 'A', playing: true,
          durationMs: 100_000, positionMs: 5000, observedAt: clock.now(), ...patch },
      });
    },
  };
}

test('offline desired play coalesces and resolves against fresh real playback', () => {
  const h = harness();
  h.observe();
  h.queue.update({ ready: false });
  h.queue.toggle();
  assert.equal(h.view().playing, false);
  assert.equal(h.view().anchor.isPlaying, false);
  h.queue.toggle();
  assert.equal(h.view().playing, true);
  h.queue.toggle();
  assert.equal(h.view().playing, false);
  assert.equal(h.view().playPending, true);
  assert.deepEqual(h.types(), []);
  h.observe({ playing: false });
  assert.deepEqual(h.types(), [], 'the new real pause already satisfies the desired state');
  assert.equal(h.view().playPending, false);
  assert.equal(h.view().anchor, undefined);
});

test('a later play intent masks the old acknowledgement until it can dispatch', async () => {
  let release;
  const h = harness(() => h.sent.length === 1 ? new Promise(resolve => { release = resolve; }) : 'sent');
  h.observe();
  h.queue.toggle();
  assert.equal(h.view().playing, false);
  h.queue.toggle();
  assert.equal(h.view().playing, true);
  h.observe({ playing: false });
  assert.equal(h.sent.length, 1, 'an observation can precede the HTTP response');
  assert.equal(h.view().playing, true);
  release('sent');
  await Promise.resolve();
  assert.deepEqual(h.sent.map(({ command }) => command.playing), [false, true]);
  h.observe({ playing: true });
  assert.equal(h.view().playPending, false);
  h.observe({ playing: false });
  assert.equal(h.view().playing, undefined, 'external pause is visible and causes no replay');
  assert.equal(h.sent.length, 2);
});

test('skip taps keep order and count across a disconnect without replaying the ambiguous send', () => {
  const h = harness();
  h.observe();
  h.queue.enqueue({ type: 'next' });
  h.queue.enqueue({ type: 'next' });
  h.queue.enqueue({ type: 'previous' });
  assert.deepEqual(h.types(), ['next']);
  assert.equal(h.view().nextPending, true);
  assert.equal(h.view().previousPending, true);
  h.queue.update({ ready: false });
  h.clock.advance(PLAYBACK_CONFIRMATION_MS);
  assert.deepEqual(h.types(), ['next']);
  h.observe();
  assert.deepEqual(h.types(), ['next', 'next']);
  h.observe({ trackId: 'B' });
  assert.deepEqual(h.types(), ['next', 'next', 'previous']);
  assert.equal(h.view().nextPending, false);
  h.observe({ trackId: 'A' });
  assert.equal(h.view().previousPending, false);
});

test('latest seek wins while queued and old confirmation keeps the newer preview', () => {
  const h = harness();
  h.observe();
  h.queue.update({ ready: false });
  h.queue.enqueue({ type: 'seek', positionMs: 9000 });
  h.queue.enqueue({ type: 'seek', positionMs: 15_000 });
  assert.equal(h.view().anchor.anchorPositionMs, 15_000);
  h.observe();
  assert.deepEqual(h.sent.map(({ command }) => command.positionMs), [15_000]);
  h.queue.enqueue({ type: 'seek', positionMs: 20_000 });
  h.queue.enqueue({ type: 'seek', positionMs: 26_000 });
  const anchor = h.view().anchor;
  h.observe({ positionMs: 15_100 });
  assert.equal(h.view().anchor, anchor);
  assert.deepEqual(h.sent.map(({ command }) => command.positionMs), [15_000, 26_000]);
  assert.equal(h.view().seekPending, true);
  h.observe({ positionMs: 26_100 });
  assert.equal(h.view().seekPending, false);
  assert.equal(h.view().anchor, undefined);
});

test('play intent changes reanchor the running seek at its current position', () => {
  const h = harness();
  h.observe();
  h.queue.enqueue({ type: 'seek', positionMs: 20_000 });
  h.clock.advance(2000);
  h.queue.toggle();
  assert.equal(h.view().anchor.anchorPositionMs, 22_000);
  assert.equal(h.view().anchor.anchorMonotonicMs, h.clock.now());
  assert.equal(h.view().anchor.isPlaying, false);
  h.clock.advance(500);
  h.queue.toggle();
  assert.equal(h.view().anchor.anchorPositionMs, 22_000, 'resume starts where the preview paused');
  assert.equal(h.view().anchor.isPlaying, true);
  assert.equal(h.view().seekPreviewPositionMs, 20_000);
  h.queue.enqueue({ type: 'seek', positionMs: 35_000 });
  assert.equal(h.view().anchor.anchorPositionMs, 35_000, 'a new seek still repositions the preview');
});

test('track and same-item session changes invalidate seeks from the old epoch', () => {
  for (const change of [{ trackId: 'B' }, { sessionId: 'different session' }, {}]) {
    const h = harness();
    h.observe({ sessionId: 'session' });
    const startEpoch = h.view().seekEpoch;
    h.queue.enqueue({ type: 'next' });
    h.queue.enqueue({ type: 'seek', positionMs: 30_000 });
    assert.equal(h.view().seekPending, true);
    h.observe({ positionMs: 0, sessionId: 'session', ...change });
    assert.notEqual(h.view().seekEpoch, startEpoch);
    assert.equal(h.view().seekPending, false);
    assert.equal(h.queue.enqueue({ type: 'seek', positionMs: 12_000 }, startEpoch), false,
      'a release from the previous playback instance cannot seek the current instance');
    h.observe({ sessionId: 'session' });
    assert.deepEqual(h.types(), ['next']);
  }
});

test('timeline release carries its original epoch and installs the seek clock before clearing its hold', () => {
  const h = harness();
  const source = ts.createSourceFile('playback-controls.tsx',
    readFileSync(path.join(app, 'components/lyrics/playback-controls.tsx'), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks = {};
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'finishScrub') {
      callbacks.finish = node.initializer.arguments[0].getText(source);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (name === 'onBegin' || name === 'onFinalize') callbacks[name] = node.arguments[0].getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const playback = fakeStore({ playbackPosition: 5000, anchorPositionMs: 5000,
    anchorMonotonicMs: h.clock.now(), isPlaying: false });
  const shared = value => ({ value });
  const { usePlaybackTimelineClock } = load('components/lyrics/use-playback-timeline-clock.ts', {
    performance: { now: h.clock.now },
  }, {
    react: { useCallback: value => value },
    'expo-router': { useFocusEffect: effect => effect() },
    'react-native': { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    'react-native-reanimated': { useSharedValue: shared, cancelAnimation() {}, withTiming: value => value, Easing: {} },
    '@/store/playback-store': { usePlaybackStore: playback },
  });
  h.observe({ playing: false });
  const { position, sync } = usePlaybackTimelineClock(100_000, {
    getSnapshot: () => h.view().anchor, subscribe: h.queue.subscribe,
  });
  const releases = [];
  const hold = {
    current: null,
    set value(value) {
      this.current = value;
      if (value === null) releases.push(position.value);
    },
  };
  const context = {
    interactionAllowed: undefined, interactionCoverage: undefined, controlsTouchIsCovered: () => true,
    controlsDisabled: false, trackWidth: 100, maxDuration: 100_000,
    isScrubbingShared: shared(false), scrubProgress: shared(0), scrubEpoch: shared(null),
    trackScaleY: shared(1), lastScrubJsCallAt: shared(0), pendingSeekPositionMsShared: hold,
    seekEpoch: h.view().seekEpoch, syncTimelineClock: sync, setIsScrubbing() {}, flushScrubPreview() {},
    onScrubPreview() {}, onUserInteraction() {}, withTiming: value => value, runOnJS: fn => fn,
    onSeek: (positionMs, epoch) => h.queue.enqueue({ type: 'seek', positionMs }, epoch),
  };
  const evaluate = key => runInNewContext(ts.transpileModule(`(${callbacks[key]})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  context.finishScrub = evaluate('finish');
  const begin = evaluate('onBegin');
  const finalize = evaluate('onFinalize');
  begin({ x: 20, absoluteY: 0 });
  h.observe({ trackId: 'B', positionMs: 6000, playing: false });
  playback.update({ anchorPositionMs: 6000 });
  context.seekEpoch = h.view().seekEpoch;
  finalize({ x: 30 }, true);
  assert.deepEqual(h.types(), [], 'release cannot retarget the gesture after playback changes');
  assert.deepEqual(releases, [6000]);

  begin({ x: 20, absoluteY: 0 });
  finalize({ x: 30 }, true);
  assert.equal(h.sent[0].command.positionMs, 30_000);
  assert.deepEqual(releases, [6000, 30_000], 'the new anchor is visible before release, without a render');
  assert.equal(h.view().seekPreviewPositionMs, 30_000);
  h.clock.advance(PLAYBACK_CONFIRMATION_MS);
  assert.equal(position.value, 6000, 'the clock rolls back when the queued seek expires');
  assert.equal(h.view().seekPreviewPositionMs, undefined);

  h.observe({ trackId: 'B', sessionId: 'same-session', positionMs: 1500, playing: false });
  context.seekEpoch = h.view().seekEpoch;
  const beforeRestart = context.seekEpoch;
  begin({ x: 20, absoluteY: 0 });
  h.observe({ trackId: 'B', sessionId: 'same-session', positionMs: 1460, playing: false });
  assert.equal(h.view().seekEpoch, beforeRestart, 'ordinary position jitter preserves the held scrub');
  h.observe({ trackId: 'B', sessionId: 'same-session', positionMs: 0, playing: false });
  playback.update({ anchorPositionMs: 0 });
  context.seekEpoch = h.view().seekEpoch;
  assert.notEqual(context.seekEpoch, beforeRestart, 'an external restart invalidates the playback instance');
  finalize({ x: 40 }, true);
  assert.deepEqual(h.types(), ['seek'], 'release cannot seek the restarted item');
  assert.equal(releases.at(-1), 0);
});

test('unconfirmed operations roll back and wait for fresh evidence before a queued send', () => {
  const h = harness();
  h.observe();
  h.queue.toggle();
  h.queue.enqueue({ type: 'next' });
  const playingAnchor = h.view().anchor;
  h.clock.advance(PLAYBACK_CONFIRMATION_MS - 1);
  h.observe({ positionMs: 9980 });
  assert.equal(h.view().anchor, playingAnchor, 'a disagreeing observation stays behind one bounded preview');
  h.clock.advance(1);
  assert.equal(h.view().playing, undefined);
  assert.equal(h.view().anchor, undefined);
  assert.deepEqual(h.types(), ['play']);
  h.observe({ positionMs: 10_000 });
  assert.deepEqual(h.types(), ['play', 'next']);
});

test('definite rejection rolls back immediately and stale queued work expires', () => {
  const h = harness(() => 'rejected');
  h.observe();
  h.queue.toggle();
  assert.equal(h.view().playPending, false);
  h.queue.update({ ready: false });
  h.queue.enqueue({ type: 'next' });
  h.queue.enqueue({ type: 'seek', positionMs: 9000 });
  h.clock.advance(PLAYBACK_INTENT_TTL_MS - 1);
  assert.equal(h.view().nextPending, true);
  assert.equal(h.view().seekPending, true);
  h.clock.advance(1);
  assert.equal(h.view().nextPending, false);
  assert.equal(h.view().seekPending, false);
  h.observe();
  assert.deepEqual(h.types(), ['play']);
});

test('explicit restrictions apply even during reconnect and cancel newly restricted work', () => {
  const h = harness();
  h.observe({}, { blocked: { next: true } });
  h.queue.update({ ready: false });
  assert.equal(h.queue.enqueue({ type: 'next' }), false);
  assert.equal(h.queue.enqueue({ type: 'seek', positionMs: 9000 }), true);
  h.observe({}, { blocked: { seek: true } });
  assert.equal(h.view().seekPending, false);
  assert.deepEqual(h.types(), []);
  assert.equal(h.view().blocked.seek, true);
  assert.equal(h.queue.toggle(), true);
  assert.deepEqual(h.types(), ['play']);
});

test('device and account handoffs discard queued work and isolate stale responses', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  h.observe();
  h.queue.enqueue({ type: 'next' });
  const oldResponse = release;
  h.queue.enqueue({ type: 'previous' });
  h.observe({ trackId: 'B' }, { targetId: 'new speaker' });
  assert.equal(h.view().nextPending, false);
  assert.equal(h.view().previousPending, false);
  h.observe({ revision: 1, trackId: 'A' });
  h.queue.enqueue({ type: 'next' });
  assert.equal(h.sent.at(-1).before.trackId, 'B');
  oldResponse('rejected');
  await Promise.resolve();
  assert.equal(h.view().nextPending, true);
  h.queue.setTransport('account two', h.send);
  assert.equal(h.view().nextPending, false);
  h.queue.enqueue({ type: 'previous' });
  h.observe({ trackId: 'C' });
  assert.deepEqual(h.types(), ['next', 'next', 'previous']);
});

test('desktop resync keeps its place before subsequent commands and leaves the controls clock alone', () => {
  const h = harness();
  h.observe();
  h.queue.enqueue({ type: 'resync' });
  h.queue.enqueue({ type: 'next' });
  assert.equal(h.view().anchor, undefined);
  assert.equal(h.view().playPending, true);
  h.observe({ playing: false });
  assert.deepEqual(h.types(), ['resync']);
  h.observe({ playing: true });
  assert.deepEqual(h.types(), ['resync', 'next']);
});

function fakeStore(initial) {
  let current = initial;
  const listeners = new Set();
  return {
    getState: () => current,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update(patch) {
      const previous = current;
      current = { ...current, ...patch };
      for (const fn of listeners) fn(current, previous);
    },
  };
}

function bridgeHarness() {
  const clock = fakeClock();
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
    receive(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
    playbackCommands() { return this.sent.filter(({ type }) => type.startsWith('playback:')); }
  }
  const playback = fakeStore({
    playbackMode: 'desktop', connectionStatus: 'disconnected', serverUrl: 'ws://desktop', handshakeKey: 'key',
    simulatedLatencyMs: 0, packetDropRate: 0, isPlaying: true, playbackPosition: 5000,
    setConnectionStatus(connectionStatus) { playback.update({ connectionStatus }); },
    setErrorMessage(message) { assert.fail(message); },
    ingestPacket(packet, mode) {
      if (mode !== playback.getState().playbackMode || packet.reject) return { accepted: false };
      playback.update({ isPlaying: packet.isPlaying, playbackPosition: packet.positionMs });
      return { accepted: true, trackChanged: false };
    },
  });
  const session = fakeStore({ signedIn: true, loggedOut: false });
  const tour = fakeStore({ active: false, pending: false });
  const shared = {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, performance: { now: clock.now },
    WebSocket: Socket,
  };
  const playbackStore = { usePlaybackStore: playback, startPlaybackClock() {}, stopPlaybackClock() {} };
  const appState = {
    currentState: 'active',
    addEventListener(_type, listener) { this.listener = listener; },
    move(state) { this.currentState = state; this.listener(state); },
  };
  const optimistic = load('lib/optimistic-playback.ts', shared, {
    'react-native': { AppState: appState, Platform: { OS: 'ios' } },
    '@/store/playback-store': playbackStore,
    '@/store/player-tour-store': { usePlayerTourStore: tour },
    '@/store/spotify-session-store': { useSpotifySessionStore: session },
    './playback-command-queue': queueModule,
  });
  const { bridgeClient } = load('lib/bridge-client.ts', shared, {
    '@/store/playback-store': playbackStore,
    '@/lib/network': { isValidBridgeKey: key => !!key, parseBridgeWebSocketUrl: url => url },
    '@/lib/bridge-validation': { validateInboundBridgePacket: JSON.parse },
    '@/lib/optimistic-playback': optimistic,
  });

  let timestamp = 0;
  return {
    playback, session, sockets, bridgeClient, optimistic, appState, clock,
    hello(socket, ok = true, fields = {}) { socket.receive({ type: 'hello:ack', ok, ...fields }); },
    packet(socket, patch = {}) {
      socket.receive({ type: 'playback', trackId: 'A', positionMs: 5000, durationMs: 90_000,
        isPlaying: true, activeDeviceId: 'speaker', controlSnapshot: true, guardedSeek: true, timestamp: ++timestamp, ...patch });
    },
  };
}

test('the actual bridge waits for authenticated, accepted playback and resolves desired state against it', () => {
  const h = bridgeHarness();
  h.bridgeClient.connect();
  const [first] = h.sockets;
  first.onopen();
  h.packet(first);
  h.bridgeClient.togglePlayPause();
  assert.equal(h.optimistic.playbackCommands.getSnapshot().playPending, false,
    'a cached playing bit has no authority before the selected scope observes playback');
  assert.deepEqual(first.playbackCommands(), []);
  h.hello(first);
  h.packet(first, { reject: true });
  assert.deepEqual(first.playbackCommands(), [], 'hello alone and rejected playback cannot drain commands');
  h.packet(first, { isPlaying: true });
  assert.deepEqual(first.playbackCommands(), [], 'there is no deferred cold toggle to invert the player');
  h.bridgeClient.togglePlayPause();
  assert.equal(h.optimistic.playbackCommands.getSnapshot().playing, false);
  assert.equal(h.playback.getState().isPlaying, true, 'preview never changes authoritative playback');
  assert.deepEqual(first.playbackCommands().map(packet => packet.type), ['playback:playPause']);
  assert.equal(first.playbackCommands()[0].desiredPlaying, false);
  h.bridgeClient.skipNext();
  const staleMessage = first.onmessage;
  h.bridgeClient.reconnectNow();
  const second = h.sockets[1];
  h.hello(second);
  staleMessage({ data: JSON.stringify({ type: 'playback', trackId: 'old', isPlaying: false }) });
  assert.deepEqual(second.playbackCommands(), []);
  h.packet(second, { isPlaying: false });
  assert.deepEqual(second.playbackCommands().map(packet => packet.type), ['playback:next']);
  h.bridgeClient.skipPrevious();
  h.playback.update({ handshakeKey: 'replacement-key' });
  h.packet(second, { trackId: 'B', isPlaying: false });
  assert.equal(h.optimistic.playbackCommands.getSnapshot().previousPending, false);
  assert.deepEqual(second.playbackCommands().map(packet => packet.type), ['playback:next']);
});

test('legacy desktop clients retain toggle compatibility after a progressing playback frame', () => {
  const h = bridgeHarness();
  h.bridgeClient.connect();
  const [socket] = h.sockets;
  h.hello(socket);
  h.packet(socket, { controlSnapshot: undefined, guardedSeek: undefined, activeDeviceId: undefined });
  h.bridgeClient.togglePlayPause();
  assert.deepEqual(socket.playbackCommands(), [], 'an unmarked first frame might be a relay replay');
  h.packet(socket, { controlSnapshot: undefined, guardedSeek: undefined, activeDeviceId: undefined });
  h.bridgeClient.togglePlayPause();
  assert.deepEqual(socket.playbackCommands(), [{ type: 'playback:playPause', expiresAtMs: 12_002 }]);
});

test('guarded seek uses negotiated relay support and survives the real relay sanitizer', () => {
  const clock = fakeClock();
  let relaySocketServer;
  class RelaySocketServer extends EventEmitter {
    clients = new Set();
    constructor() { super(); relaySocketServer = this; }
  }
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent = [];
    send(raw) { this.sent.push(JSON.parse(raw)); }
    receive(packet) { this.emit('message', JSON.stringify(packet)); }
  }
  const { createHostedRelayServer } = loadDesktop('relayServer.js', {
    process: { env: {} }, URL, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: () => 1, clearInterval() {},
  }, { ws: { WebSocket: Socket, WebSocketServer: RelaySocketServer }, 'node:http': { createServer: () => ({}) } });
  const relay = createHostedRelayServer({ getRegistrationKey: () => 'key' });
  const desktop = new Socket();
  const relayPhone = new Socket();
  relaySocketServer.emit('connection', desktop, { headers: {}, url: '/' });
  desktop.receive({ type: 'relay:register', role: 'desktop', bridgeId: 'test', key: 'key' });
  relaySocketServer.emit('connection', relayPhone, { headers: {}, url: '/bridge/test' });
  relayPhone.receive({ type: 'hello', key: 'key' });
  const ack = relayPhone.sent.find(packet => packet.type === 'hello:ack');
  assert.equal(ack.guardedSeek, true);
  for (const hello of [{}, ack, { ...ack, guardedSeek: undefined }]) {
    const h = bridgeHarness();
    h.bridgeClient.connect();
    const [phone] = h.sockets;
    h.hello(phone, true, hello);
    h.packet(phone, { playbackSessionId: 'session-A' });
    h.bridgeClient.seekTo(20_000);
    if (hello.role === 'client' && !hello.guardedSeek) {
      assert.deepEqual(phone.playbackCommands(), [], 'a legacy relay cannot silently downgrade a guarded seek');
      assert.equal(h.optimistic.playbackCommands.getSnapshot().blocked.seek, true);
      continue;
    }
    const [command] = phone.playbackCommands();
    assert.equal(command.type, 'playback:seek:guarded');
    if (!hello.role) continue;
    relayPhone.receive(command);
    assert.deepEqual(desktop.sent.at(-1), {
      type: 'playback:seek:guarded', positionMs: 20_000,
      expectedPlayback: { deviceId: 'speaker', sessionId: 'session-A', trackId: 'A' },
      expiresAtMs: command.expiresAtMs,
    });
    const sent = desktop.sent.length;
    relayPhone.receive({ ...command, expectedPlayback: undefined });
    assert.equal(desktop.sent.length, sent, 'the relay rejects a guarded opcode with missing identity');
  }
  const player = readFileSync(path.join(app, 'app/(tabs)/index.tsx'), 'utf8');
  const start = player.indexOf('  const handlePlaybackPrevious =');
  const end = player.indexOf('  const handleLineLongPress =', start);
  assert(start >= 0 && end > start);
  const { outputText: invokePrevious } = ts.transpileModule(
    `${player.slice(start, end)}\nhandlePlaybackPrevious();`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  for (const hello of [{}, ack, { ...ack, guardedSeek: undefined }]) {
    const h = bridgeHarness();
    h.bridgeClient.connect();
    const [phone] = h.sockets;
    h.hello(phone, true, hello);
    const legacy = { controlSnapshot: undefined, guardedSeek: undefined, activeDeviceId: undefined };
    h.packet(phone, legacy);
    h.packet(phone, legacy);
    runInNewContext(invokePrevious, {
      ...h.optimistic, useCallback: fn => fn,
      usePlayerTourStore: { getState: () => ({ active: false }) },
      usePlaybackStore: h.playback, bridgeClient: h.bridgeClient,
      handleSeek: position => h.bridgeClient.seekTo(position),
    });
    const [command] = phone.playbackCommands();
    assert.equal(command.type, 'playback:seek', 'Previous above three seconds seeks on legacy desktops via LAN or either relay');
    assert.equal(command.positionMs, 0);
    assert.equal(command.expectedPlayback, undefined);
    if (hello.guardedSeek) {
      relayPhone.receive(command);
      assert.deepEqual(desktop.sent.at(-1), command);
    }
  }
  relay.stop();
});

test('scoped Windows commands serialize through native completion and drop expired work', async () => {
  const h = bridgeHarness();
  const clock = h.clock;
  const desktopNow = () => clock.now() + 100_000;
  const dispatched = [];
  const { createPlaybackController } = loadDesktop('playbackController.js', {
    Date: { now: desktopNow }, process: { platform: 'win32', env: {} },
  }, { 'node:child_process': { spawn: () => assert.fail('scoped Windows commands must never fall back') } });
  const controller = createPlaybackController({
    executeWindowsPlayback: (_identity, action) => new Promise((resolve, reject) => {
      dispatched.push({ action, resolve, reject });
    }),
  });
  const snapshot = () => ({ trackId: 'A', playbackSessionId: 'session-A' });
  const submit = type => controller.executeCommand({
    type: `playback:${type}`, expectedPlayback: { trackId: 'A', sessionId: 'session-A' },
  }, snapshot);

  const next = submit('next');
  const unknown = assert.rejects(next, /outcome unknown/);
  await Promise.resolve();
  assert.equal(dispatched[0].action, 'next');
  const previous = submit('previous');
  await Promise.resolve();
  assert.equal(dispatched.length, 1);
  dispatched[0].reject(new Error('Windows playback outcome unknown; the command was not retried.'));
  await unknown;
  await Promise.resolve();
  assert.deepEqual(dispatched.map(entry => entry.action), ['next', 'previous']);
  dispatched[1].resolve();
  await previous;

  const { sanitizeClientPacket } = require('../../DesktopBridge/src/bridgeProtocol');
  h.bridgeClient.connect();
  const [phone] = h.sockets;
  h.hello(phone, true, { role: 'client' }); // Old relay forwards non-seek packets intact.
  const observe = () => h.packet(phone, {
    timestamp: desktopNow(), activeDeviceId: undefined, playbackSessionId: 'session-A',
    playbackSource: 'windows-media-session-native',
  });
  observe();
  const appDeadlineOnDesktop = desktopNow() + PLAYBACK_INTENT_TTL_MS;
  h.bridgeClient.skipNext();
  h.bridgeClient.skipPrevious();
  const execute = packet => controller.executeCommand(sanitizeClientPacket(packet), snapshot);
  const slow = execute(phone.playbackCommands()[0]);
  await Promise.resolve();
  clock.advance(PLAYBACK_CONFIRMATION_MS);
  observe();
  const waiting = phone.playbackCommands()[1];
  assert.equal(waiting.type, 'playback:previous');
  assert.equal(waiting.expiresAtMs, appDeadlineOnDesktop);
  const expired = assert.rejects(execute(waiting), /expired before dispatch/);
  clock.advance(PLAYBACK_INTENT_TTL_MS - PLAYBACK_CONFIRMATION_MS);
  assert.equal(dispatched.length, 3, 'the desktop waits for completion even after mobile confirmation expires');
  dispatched[2].resolve();
  await Promise.all([slow, expired]);
  assert.equal(dispatched.length, 3, 'the expired intent never reaches the watcher');
});

test('legacy Windows seek releases expired preparation without a late dispatch', async () => {
  for (const stage of ['build', 'helper', 'api-token', 'api-player', 'api-player-before-timer', 'api-devices']) {
    const clock = fakeClock();
    let wallClockOffset = 0;
    const helperInstalled = stage !== 'build';
    let built = helperInstalled;
    let finishToken;
    let finishLookup;
    const requests = [];
    const children = [];
    const dispatched = [];
    const flush = () => new Promise(resolve => setImmediate(resolve));
    const spawn = (command, args) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {},
      });
      children.push({ child, command, args: Array.from(args) });
      return child;
    };
    const { createPlaybackController } = loadDesktop('playbackController.js', {
      process: { platform: 'win32', env: {} }, Date: { now: () => clock.now() + wallClockOffset },
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      AbortController,
      fetch: (url, options) => {
        requests.push({ url, method: options.method ?? 'GET', signal: options.signal });
        if (stage === 'api-devices' && url.endsWith('/player')) return Promise.resolve({ ok: false });
        // Simulate an adapter that ignores abort, including a late response.
        return new Promise(resolve => { finishLookup = resolve; });
      },
    }, {
      'node:fs': { existsSync: () => built }, 'node:child_process': { spawn },
      './dotnetExecutable': { getDotnetExecutable: () => 'dotnet' },
      './nativeRuntimePaths': { resolvePackagedNativePath: value => value },
    });
    const controller = createPlaybackController({
      executeWindowsPlayback: async (_expected, action) => { dispatched.push(action); },
    });
    controller.setSpotifyAccessTokenGetter(() => stage === 'api-token'
      ? new Promise(resolve => { finishToken = resolve; }) : 'fixture-token');
    const ttl = stage === 'helper' ? 1000 : PLAYBACK_INTENT_TTL_MS;
    const expiresAtMs = clock.now() + ttl;
    const result = controller.executeCommand({ type: 'playback:seek', positionMs: 14000, expiresAtMs }, () => ({}));
    const expired = assert.rejects(result, /expired before dispatch/);
    await flush();
    assert.equal(children.length, 1);
    if (helperInstalled) assert.deepEqual(children[0].args.slice(1), ['seek-before', '14000', String(expiresAtMs)]);
    else assert.equal(children[0].args[0], 'build');

    if (stage.startsWith('api-')) {
      // Discovery only gets the time left after native attempts.
      clock.advance(4000);
      children[0].child.stderr.emit('data', "Unsupported command 'seek-before'.");
      children[0].child.emit('close', 1);
      await flush();
      assert.equal(children[1].command, 'powershell.exe');
      assert(children[1].args.at(-1).includes(`-ge ${expiresAtMs}`));
      children[1].child.emit('close', 2);
      await flush();
    }
    if (stage === 'api-token') assert.equal(typeof finishToken, 'function');
    const expectedRequests = [];
    if (stage.startsWith('api-player') || stage === 'api-devices') expectedRequests.push('GET player');
    if (stage === 'api-devices') expectedRequests.push('GET devices');
    const readEndpoints = () => requests.map(({ method, url }) => `${method} ${new URL(url).pathname.split('/').at(-1)}`);
    assert.deepEqual(readEndpoints(), expectedRequests);

    clock.advance(expiresAtMs - clock.now() - 1);
    const next = controller.executeCommand({
      type: 'playback:next', expectedPlayback: { sessionId: 'session', trackId: 'track' },
    }, () => ({ playbackSessionId: 'session', trackId: 'track' }));
    await flush();
    assert.deepEqual(dispatched, [], 'the seek owns the serialized slot before expiry');
    if (stage === 'api-player-before-timer') {
      // An I/O callback can observe expiry before the timer callback runs.
      wallClockOffset = 1;
      finishLookup({ ok: false });
      finishLookup = undefined;
    } else {
      clock.advance(1);
    }
    await flush();

    if (stage === 'helper') {
      assert.deepEqual(dispatched, [], 'a potentially mutating child retains the slot at expiry');
      children[0].child.stderr.emit('data', "Unsupported command 'seek-before'.");
      children[0].child.emit('close', 1);
      await flush();
    }
    assert.deepEqual(dispatched, ['next'], `the following command runs after ${stage} releases the slot`);
    assert(requests.every(({ signal }) => signal.aborted), 'discovery receives the intent deadline signal');
    await Promise.all([expired, next]);

    const childCount = children.length;
    if (stage === 'build') {
      built = true;
      children[0].child.emit('close', 0);
    }
    if (finishToken) finishToken('late-token');
    if (finishLookup) {
      finishLookup({
        ok: true,
        json: async () => stage === 'api-devices' ? { devices: [{ id: 'device', is_active: true }] } : {},
      });
    }
    await flush();
    assert.equal(children.length, childCount, 'late preparation cannot launch a mutating child');
    assert.deepEqual(readEndpoints(), expectedRequests, 'late discovery cannot issue another fetch or a seek PUT');
  }
});

test('an ambiguous Windows seek holds its queue slot through child close and never falls back', async () => {
  for (const executable of ['dotnet', 'powershell.exe']) {
    const clock = fakeClock();
    const children = [];
    const { createPlaybackController } = loadDesktop('playbackController.js', {
      process: { platform: 'win32', env: {} }, Date: { now: clock.now },
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      AbortController,
    }, {
      'node:fs': { existsSync: () => true },
      'node:child_process': { spawn(command) {
        const child = Object.assign(new EventEmitter(), {
          command, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false,
          kill() { this.killed = true; this.emit('error', new Error('termination requested')); },
        });
        children.push(child);
        return child;
      } },
      './dotnetExecutable': { getDotnetExecutable: () => 'dotnet' },
      './nativeRuntimePaths': { resolvePackagedNativePath: value => value },
    });
    const dispatched = [];
    const controller = createPlaybackController({
      executeWindowsPlayback: async (_expected, action) => { dispatched.push(action); },
    });
    let apiFallbacks = 0;
    controller.setSpotifyAccessTokenGetter(() => { apiFallbacks++; return 'fixture-token'; });
    const snapshot = () => ({ playbackSessionId: 'session', trackId: 'track' });
    const seek = controller.executeCommand({ type: 'playback:seek', positionMs: 1000 }, snapshot);
    const rejected = assert.rejects(seek, /playback outcome unknown/);
    await new Promise(resolve => setImmediate(resolve));
    children[0].emit('spawn');
    if (executable === 'powershell.exe') {
      children[0].stderr.emit('data', "Unsupported command 'seek-before'.");
      children[0].emit('close', 1);
      await new Promise(resolve => setImmediate(resolve));
      children[1].emit('spawn');
    }
    const stalled = children.at(-1);
    assert.equal(stalled.command, executable);
    const next = controller.executeCommand({
      type: 'playback:next', expectedPlayback: { sessionId: 'session', trackId: 'track' },
    }, snapshot);
    clock.advance(8_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stalled.killed, true);
    assert.deepEqual(dispatched, [], 'a timeout or kill error does not free the serialized slot');
    stalled.emit('close', null);
    await Promise.all([rejected, next]);
    assert.deepEqual(dispatched, ['next']);
    assert.equal(apiFallbacks, 0, 'ambiguous seek must not try Spotify API');
    assert.deepEqual(children.map(child => child.command),
      executable === 'dotnet' ? ['dotnet'] : ['dotnet', 'powershell.exe']);
  }
});

test('desktop recovery cancels intents when the watcher cannot identify the player', () => {
  const h = bridgeHarness();
  h.bridgeClient.connect();
  const [first] = h.sockets;
  h.hello(first);
  h.packet(first, { activeDeviceId: undefined });
  h.bridgeClient.reconnectNow();
  h.bridgeClient.skipNext();
  const second = h.sockets.at(-1);
  h.hello(second);
  h.packet(second, { activeDeviceId: undefined });
  assert.deepEqual(second.playbackCommands(), []);
  assert.equal(h.optimistic.playbackCommands.getSnapshot().nextPending, false);
  h.bridgeClient.skipNext();
  assert.equal(second.playbackCommands()[0].type, 'playback:next', 'fresh taps still work on the unidentified local player');
});

test('the Windows watcher revokes control after silent loss and guards same-song session replacement', async () => {
  const h = bridgeHarness();
  const clock = h.clock;
  let readNativeSnapshot, project, lastPacket;
  let selectedSession = 'session-A';
  const nativeCommands = [];
  class WindowsMediaSessionWatcher {
    constructor(onSnapshot) { readNativeSnapshot = onSnapshot; }
    start() {}
    stop() {}
    executeCommand(action, sessionId, title, artist, positionMs, expiresAtMs, complete) {
      assert.equal(title, 'Track');
      assert.equal(artist, 'Artist');
      assert(expiresAtMs > clock.now());
      if (sessionId !== selectedSession) return complete(new Error('Windows playback session changed before dispatch.'));
      nativeCommands.push({ action, sessionId, positionMs });
      complete(null);
    }
  }
  const { createSpotifyDetector } = loadDesktop('spotifyDetector.js', {
    process: { platform: 'win32', env: {} }, Date: { now: clock.now },
    setInterval: fn => { project = fn; return 1; }, clearInterval() {},
  }, {
    'node:perf_hooks': { performance: { now: clock.now } },
    [path.resolve(app, '../DesktopBridge/native/windows-media-session')]: { WindowsMediaSessionWatcher },
    './artworkResolver': { getCachedRemoteArtwork() {}, resolveRemoteArtworkUrl: async () => ({}) },
    './lyrics': { mergeNativePlaybackArtist: value => value },
  });
  h.bridgeClient.connect();
  const [socket] = h.sockets;
  h.hello(socket);
  const detector = createSpotifyDetector();
  const { createPlaybackController } = loadDesktop('playbackController.js', {
    process: { platform: 'win32', env: {} }, Date: { now: clock.now },
  }, {
    'node:child_process': { spawn: () => assert.fail('scoped commands must stay on the native session') },
  });
  const controller = createPlaybackController({ executeWindowsPlayback: detector.executeWindowsPlayback });
  detector.on('snapshot', packet => {
    lastPacket = packet;
    socket.receive({ type: 'playback', ...packet });
  });
  detector.start();
  const native = (positionMs, capturedAtMs = clock.now()) => readNativeSnapshot({
    title: 'Track', artist: 'Artist', album: 'Album', artworkUrl: 'https://example.test/art.jpg',
    source: 'windows-media-session-native', capturedAtMs,
    activeDeviceId: 'Spotify.exe', playbackSessionId: selectedSession,
    positionMs, durationMs: 90_000, isPlaying: true,
  });
  native(5000);
  assert.equal(lastPacket.scopedPlayback, true);
  const queue = h.optimistic.playbackCommands;
  const initialEpoch = queue.getSnapshot().seekEpoch;
  assert.equal(typeof initialEpoch, 'number');
  clock.advance(8000); // Normal steady-playback heartbeat.
  native(13000);
  assert.equal(lastPacket.controlSnapshot, true);
  clock.advance(11_999);
  project();
  assert.equal(queue.getSnapshot().seekEpoch, initialEpoch, 'a real heartbeat renews the lease');
  assert.equal(lastPacket.controlSnapshot, false);
  clock.advance(1);
  project(); // The native watcher never reports an error or an empty snapshot.
  assert.equal(lastPacket.trackId, '');
  assert.equal(lastPacket.controlSnapshot, true);
  assert.equal(queue.getSnapshot().seekEpoch, undefined);
  h.bridgeClient.skipNext();
  clock.advance(100);
  project();
  assert.deepEqual(socket.playbackCommands(), [], 'projection traffic on the open socket cannot restore control');
  native(13000, clock.now() - 12_000);
  assert.equal(queue.getSnapshot().seekEpoch, undefined, 'an old native callback cannot restore control');
  clock.advance(1);
  native(1000);
  assert.equal(typeof queue.getSnapshot().seekEpoch, 'number');
  h.bridgeClient.skipNext();
  assert.equal(socket.playbackCommands()[0].type, 'playback:next');
  // Wait out the skip, then model a held scrub plus a packet already in transit.
  clock.advance(PLAYBACK_CONFIRMATION_MS);
  native(6000);
  const oldEpoch = queue.getSnapshot().seekEpoch;
  const seek = { type: 'seek', positionMs: 20000 };
  assert(h.optimistic.submitPlaybackCommand(seek, oldEpoch));
  const sent = socket.playbackCommands().at(-1);
  assert.equal(sent.type, 'playback:seek:guarded');
  assert.equal(sent.expectedPlayback.sessionId, 'session-A');
  const trackId = lastPacket.trackId;
  const commands = [
    sent,
    { ...sent, type: 'playback:playPause', desiredPlaying: true, positionMs: undefined },
    { ...sent, type: 'playback:playPause', desiredPlaying: false, positionMs: undefined },
    ...['next', 'previous', 'resync'].map(type => ({ ...sent, type: `playback:${type}`, positionMs: undefined })),
  ];
  selectedSession = 'session-B';
  for (const command of commands) {
    await assert.rejects(controller.executeCommand(command, () => lastPacket), /session changed before dispatch/);
  }
  assert.deepEqual(nativeCommands, []);
  clock.advance(1);
  native(6000);
  assert.equal(lastPacket.trackId, trackId);
  assert.notEqual(queue.getSnapshot().seekEpoch, oldEpoch);
  assert.equal(h.optimistic.submitPlaybackCommand(seek, oldEpoch), false);
  assert(h.optimistic.submitPlaybackCommand(seek, queue.getSnapshot().seekEpoch));
  const current = socket.playbackCommands().at(-1);
  await controller.executeCommand(current, () => lastPacket);
  for (const command of commands.slice(1)) {
    await controller.executeCommand({ ...command, expectedPlayback: current.expectedPlayback }, () => lastPacket);
  }
  assert.deepEqual(nativeCommands.map(command => command.action), ['seek', 'play', 'pause', 'next', 'previous', 'resync']);
  assert(nativeCommands.every(command => command.sessionId === 'session-B'));
  assert.equal(nativeCommands[0].positionMs, 20000);
  detector.stop();
  const stoppedPacket = lastPacket;
  clock.advance(1);
  native(6100);
  assert.equal(lastPacket, stoppedPacket, 'a callback queued by a stopped watcher cannot restore authority');
  h.bridgeClient.disconnect();
});

test('an old Windows addon supplies fresh display snapshots and requires an update for scoped control', async () => {
  const h = bridgeHarness();
  let publish;
  let latest;
  class WindowsMediaSessionWatcher {
    constructor(onSnapshot) { publish = onSnapshot; }
    start() {}
    stop() {}
  }
  const { createSpotifyDetector } = loadDesktop('spotifyDetector.js', {
    process: { platform: 'win32', env: {} }, Date: { now: h.clock.now },
    setInterval: () => 1, clearInterval() {},
  }, {
    'node:perf_hooks': { performance: { now: h.clock.now } },
    [path.resolve(app, '../DesktopBridge/native/windows-media-session')]: { WindowsMediaSessionWatcher },
    './artworkResolver': { getCachedRemoteArtwork() {}, resolveRemoteArtworkUrl: async () => ({}) },
    './lyrics': { mergeNativePlaybackArtist: value => value },
  });
  const { createPlaybackController } = loadDesktop('playbackController.js', {
    process: { platform: 'win32', env: {} }, Date: { now: h.clock.now },
  }, {
    'node:child_process': { spawn: () => assert.fail('scoped playback must not fall back to an unbound player') },
  });
  h.bridgeClient.connect();
  const [socket] = h.sockets;
  h.hello(socket);
  const detector = createSpotifyDetector();
  detector.on('snapshot', packet => {
    latest = packet;
    socket.receive({ type: 'playback', ...packet });
  });
  detector.start();
  h.bridgeClient.skipNext(); // Queued before the bridge learns the source capabilities.
  h.clock.advance(1);
  publish({
    title: 'Track', artist: 'Artist', album: 'Album', artworkUrl: 'https://example.test/art.jpg',
    source: 'windows-media-session-native', capturedAtMs: h.clock.now(),
    positionMs: 5_000, durationMs: 90_000, isPlaying: true,
  });
  assert.equal(latest.controlSnapshot, true);
  assert.equal(latest.scopedPlayback, false);
  assert.equal(latest.guardedSeek, false);
  assert.equal(h.playback.getState().playbackPosition, 5_000);
  assert.match(detector.getStatus().detectorError, /Update the Windows media session addon/);
  const view = h.optimistic.playbackCommands.getSnapshot();
  assert.equal(view.nextPending, false);
  for (const [operation, command] of [
    ['pause', { type: 'play', playing: false }], ['resume', { type: 'play', playing: true }],
    ['next', { type: 'next' }], ['previous', { type: 'previous' }],
    ['seek', { type: 'seek', positionMs: 1000 }], ['resync', { type: 'resync' }],
  ]) {
    assert.equal(view.blocked[operation], true);
    assert.equal(h.optimistic.submitPlaybackCommand(command), false);
  }
  assert.deepEqual(socket.playbackCommands(), []);
  const controller = createPlaybackController({ executeWindowsPlayback: detector.executeWindowsPlayback });
  await assert.rejects(controller.executeCommand({
    type: 'playback:next', expectedPlayback: { trackId: latest.trackId },
  }, () => latest), /Update the Windows media session addon/);
  detector.stop();
  h.bridgeClient.disconnect();
});

test('desktop detector, relay, mobile queue and controller agree on freshness, target and desired playback', async () => {
  const h = bridgeHarness();
  const clock = h.clock;
  const globals = {
    process: { platform: 'linux', env: { MEDIA_SESSION_PROVIDER: 'mpris' } },
    Date: { now: clock.now }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  };
  const { MprisSpotifyClient } = require('../../DesktopBridge/src/linuxMpris');
  let deviceId = 'org.mpris.MediaPlayer2.spotify.old';
  let sessionId = '/com/spotify/track/old';
  let playing = true;
  const calls = [];
  const player = {
    Metadata(reply) { reply(null, { 'xesam:title': 'Same track', 'xesam:artist': 'Artist', 'xesam:album': 'Album',
      'mpris:trackid': sessionId, 'mpris:length': 90_000_000, 'mpris:artUrl': 'https://example.test/cover.jpg' }); },
    PlaybackStatus(reply) { reply(null, playing ? 'Playing' : 'Paused'); },
    Position(reply) { reply(null, 5_000_000); },
    Pause(reply) { calls.push('Pause'); playing = false; reply(null); },
    PlayPause(reply) { calls.push('PlayPause'); playing = !playing; reply(null); },
  };
  const mpris = new MprisSpotifyClient({ playerPrefix: 'org.mpris.MediaPlayer2.spotify' });
  mpris.ensureBus = () => ({
    listNames: reply => reply(null, [deviceId]),
    getService: name => ({
      getInterface(_path, _interface, reply) {
        assert.equal(name, deviceId);
        reply(null, player);
      },
    }),
  });
  let receiver, sourceError, emitProjection, snapshot, relaySocket, execution;
  class Watcher {
    constructor(onSnapshot, onError) { receiver = onSnapshot; sourceError = onError; }
    start() {}
    stop() {}
  }
  class RelaySocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent = [];
    constructor() { super(); relaySocket = this; }
    send(raw) {
      const packet = JSON.parse(raw);
      this.sent.push(packet);
      if (packet.type === 'playback') h.sockets.at(-1)?.receive(packet);
    }
    close() {}
    receive(packet) { this.emit('message', JSON.stringify(packet)); }
  }
  const { createBridgeRelayClient } = loadDesktop('bridgeRelayClient.js', globals, { ws: { WebSocket: RelaySocket } });
  const { createSpotifyDetector } = loadDesktop('spotifyDetector.js', {
    ...globals, setInterval: fn => { emitProjection = fn; return 1; }, clearInterval() {},
  }, {
    'node:perf_hooks': { performance: { now: clock.now } },
    './linuxMpris': { LinuxMprisProcessWatcher: Watcher },
    './artworkResolver': { getCachedRemoteArtwork() {}, resolveRemoteArtworkUrl: async () => ({}) },
    './lyrics': { mergeNativePlaybackArtist: value => value },
  });
  const { createPlaybackController } = loadDesktop('playbackController.js', globals, {
    './linuxMpris': { MprisSpotifyClient: class { constructor() { return mpris; } } },
  });
  const controller = createPlaybackController();
  const relay = createBridgeRelayClient({
    getRelayUrl: () => 'ws://relay', getBridgeId: () => 'desktop', getBridgeKey: () => 'key',
  });
  relay.on('playbackCommand', packet => { execution = controller.executeCommand(packet, () => snapshot); });
  const detector = createSpotifyDetector();
  detector.on('error', () => {});
  detector.on('snapshot', packet => { snapshot = packet; relay.broadcastPlayback(packet); });
  h.bridgeClient.connect();
  const [first] = h.sockets;
  h.hello(first);
  relay.start();
  relaySocket.receive({ type: 'relay:registered', ok: true });
  detector.start();
  receiver(await mpris.readSnapshot());
  assert.equal(snapshot.activeDeviceId, deviceId);
  assert.equal(snapshot.playbackSessionId, sessionId);
  assert.equal(snapshot.controlSnapshot, true);
  h.bridgeClient.togglePlayPause();
  const pause = first.playbackCommands()[0];
  assert.equal(pause.desiredPlaying, false);
  playing = false; // An external pause happens before the desktop runs the command.
  relaySocket.receive(pause);
  await execution;
  assert.deepEqual(calls, ['Pause']);
  assert.equal(playing, false, 'the desktop executes the requested state even when toggle would resume');

  h.bridgeClient.skipNext();
  h.bridgeClient.seekTo(30_000);
  h.bridgeClient.reconnectNow();
  const second = h.sockets.at(-1);
  clock.advance(501);
  receiver(await mpris.readSnapshot()); // A source observation that the new socket misses before auth.
  h.hello(second);
  relaySocket.receive({ type: 'relay:status', clients: 1 });
  assert.equal(relaySocket.sent.at(-1).playbackCached, true);
  assert.equal(h.optimistic.playbackCommands.getSnapshot().nextPending, true);
  assert.deepEqual(second.playbackCommands(), [], 'a cached packet newer than the old mobile watermark still cannot dispatch');
  clock.advance(501);
  emitProjection();
  assert.equal(relaySocket.sent.at(-1).controlSnapshot, false);
  assert.deepEqual(second.playbackCommands(), [], 'timeline projections cannot dispatch');

  const oldTarget = pause.expectedPlayback;
  deviceId = 'org.mpris.MediaPlayer2.spotify.replacement';
  sessionId = '/com/spotify/track/replacement';
  relaySocket.receive({ type: 'playback:seek:guarded', positionMs: 30_000, expectedPlayback: oldTarget });
  await assert.rejects(execution, /target changed/, 'MPRIS rejects a handoff even before the next detector snapshot');
  clock.advance(1);
  receiver(await mpris.readSnapshot());
  assert.equal(snapshot.activeDeviceId, deviceId);
  assert.equal(snapshot.playbackSessionId, sessionId);
  assert.equal(h.optimistic.playbackCommands.getSnapshot().nextPending, false);
  assert.equal(h.optimistic.playbackCommands.getSnapshot().seekPending, false);
  assert.deepEqual(second.playbackCommands(), [], 'fresh production identity cancels work for the other player');
  relaySocket.receive({ type: 'playback:seek:guarded', positionMs: 30_000, expectedPlayback: oldTarget });
  await assert.rejects(execution, /target changed/);

  relaySocket.receive({ type: 'playback:playPause' });
  await execution;
  assert.deepEqual(calls, ['Pause', 'PlayPause'], 'older mobile clients keep legacy toggle behavior');

  sourceError('MPRIS player disappeared');
  assert.equal(snapshot.trackId, '', 'source loss revokes the last desktop control snapshot');
  assert.equal(snapshot.controlSnapshot, true, 'source loss sends an authoritative idle observation');
  const queue = h.optimistic.playbackCommands;
  assert.equal(queue.getSnapshot().seekEpoch, undefined);
  h.bridgeClient.skipNext();
  clock.advance(501);
  emitProjection();
  assert.deepEqual(second.playbackCommands(), [], 'idle projections cannot revive command authority');
  detector.stop();
  relay.stop();
  h.bridgeClient.disconnect();
});

test('the actual bridge requires playback received after foreground recovery', () => {
  const h = bridgeHarness();
  h.bridgeClient.connect();
  const [socket] = h.sockets;
  h.hello(socket);
  h.packet(socket, { activeDeviceId: 'speaker' });
  h.playback.update({ simulatedLatencyMs: 200 });
  h.packet(socket, { activeDeviceId: 'speaker' });
  h.appState.move('background');
  h.bridgeClient.skipNext();
  h.appState.move('active');
  assert.equal(h.optimistic.playbackCommands.getSnapshot().nextPending, true);
  h.clock.advance(200);
  assert.deepEqual(socket.playbackCommands(), [], 'a delayed packet received before suspension cannot reopen dispatch');
  h.playback.update({ simulatedLatencyMs: 0 });
  h.packet(socket, { activeDeviceId: 'new speaker', trackId: 'B' });
  assert.equal(h.optimistic.playbackCommands.getSnapshot().nextPending, false);
  assert.deepEqual(socket.playbackCommands(), [], 'fresh playback reveals a new target and cancels the old tap');

  h.appState.move('inactive');
  h.bridgeClient.togglePlayPause();
  h.appState.move('active');
  assert.deepEqual(socket.playbackCommands(), []);
  h.packet(socket, { activeDeviceId: 'new speaker', trackId: 'B', isPlaying: false });
  assert.equal(h.optimistic.playbackCommands.getSnapshot().playPending, false);
  assert.deepEqual(socket.playbackCommands(), [], 'the resumed desktop is already paused');
});

test('mobile dispatch authority stays separate from tap acceptance, account and mode', () => {
  const h = bridgeHarness();
  h.playback.update({ playbackMode: 'mobile' });
  const commands = [];
  let version = 0;
  let state = { ready: false };
  const unregister = h.optimistic.registerPlaybackCommandTransport('mobile', {
    accountVersion: () => version,
    read: () => state,
    send: command => { commands.push(command.type); return 'sent'; },
  });
  h.optimistic.submitPlaybackCommand({ type: 'next' });
  assert.equal(h.optimistic.nativePlaybackBlocked('next'), false);
  assert.equal(h.optimistic.playbackCommands.getSnapshot().nextPending, true);
  assert.deepEqual(commands, []);
  version++;
  state = { ready: true, targetId: 'speaker', observation: {
    revision: 1, trackId: 'A', positionMs: 0, durationMs: 100_000, playing: false, observedAt: 1000,
  } };
  h.optimistic.refreshPlaybackCommands();
  assert.equal(h.optimistic.playbackCommands.getSnapshot().nextPending, false);
  h.optimistic.submitPlaybackCommand({ type: 'next' });
  assert.deepEqual(commands, ['next']);
  h.optimistic.submitPlaybackCommand({ type: 'previous' });
  h.session.update({ signedIn: false, loggedOut: true });
  assert.equal(h.optimistic.playbackCommands.getSnapshot().previousPending, false);
  assert.equal(h.optimistic.submitPlaybackCommand({ type: 'previous' }), false);
  h.session.update({ signedIn: true, loggedOut: false });
  assert.equal(h.optimistic.submitPlaybackCommand({ type: 'previous' }), true);
  h.playback.update({ playbackMode: 'desktop' });
  h.optimistic.refreshPlaybackCommands();
  h.playback.update({ playbackMode: 'mobile' });
  assert.equal(h.optimistic.playbackCommands.getSnapshot().previousPending, false);
  unregister();
});
