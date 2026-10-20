import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { ungzip } from 'pako';

const result = await build({ stdin: { contents: `export {SpotifyDetector,SpotifyPlaybackUnavailableError} from './lib/spotify-detector/client';
export {sampleFrom,decodeDealer,decodeStateBody,observerBody,trackHex,metadataFrom} from './lib/spotify-detector/protocol';
export {detectorPacket} from './lib/spotify-detector/packet';
export {bootstrap,bootstrapAndroidObserver} from './lib/spotify-detector/bootstrap';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false });
const { SpotifyDetector, SpotifyPlaybackUnavailableError, sampleFrom, decodeDealer, detectorPacket, trackHex, metadataFrom, bootstrap, bootstrapAndroidObserver } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const trackId = '4uLU6hMCjMI75M1A2tKUQC';
const uri = `spotify:track:${trackId}`;
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const expectedGid = [...trackId].reduce((n, c) => n * 62n + BigInt(alphabet.indexOf(c)), 0n).toString(16).padStart(32, '0');
assert.equal(trackHex(uri), expectedGid);
assert.equal(trackHex(`spotify:track:${'0'.repeat(21)}1`), '0'.repeat(31) + '1');
assert.throws(() => trackHex(`spotify:track:${'Z'.repeat(22)}`));
const metadata = { gid: expectedGid, name: 'Test', artist: [{ name: 'Artist' }, { name: 'Guest' }], album: { name: 'Album' } };
assert.equal(metadataFrom(uri, { ...metadata, gid: Buffer.from(expectedGid, 'hex').toString('base64') }).artist, 'Artist, Guest');
assert.throws(() => metadataFrom(uri, { ...metadata, gid: '0'.repeat(32) }));
const epoch = Date.now();
const state = (position = 1000, timestamp = epoch, paused = false, uri = `spotify:track:${trackId}`) => ({
  active_device_id: 'iphone', devices: { iphone: { name: 'iPhone' } }, player_state: {
    timestamp, position_as_of_timestamp: position, duration: 200000, is_playing: true, is_paused: paused,
    track: { uri, metadata: { title: 'Test', artist_name: 'Artist', album_title: 'Album', image_url: 'spotify:image:cover' } },
  },
});
const sockets = [], requests = [], samples = [], statuses = [];
let needs = 0, auth = 0, ready = 0, responseState = state(), responseStatus = 200, releaseResponse;
let holdResponse = false;
const saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, setTimeout, clearTimeout, setInterval, clearInterval };
const timers = new Map(); let timerId = 0;
class Socket {
  static OPEN = 1;
  readyState = 1; sent = [];
  constructor(url) { this.url = url; sockets.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  event(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const flush = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };
const observerUrl = 'https://guc3-spclient.spotify.com/connect-state/v1/devices/test-observer';
const observerState = { player_state: state().player_state };
assert(sampleFrom(observerState), 'native playback accepts player_state without a devices map');
const checkBootstrap = async (transport, options = {}) => {
  const { url = observerUrl, status = 200, payload = observerState, raw,
    authorization = 'Bearer request-token', origin = 'https://open.spotify.com', probe = {} } = options;
  const messages = [], pending = [], intervals = new Map(), pagehide = [];
  const work = { requestClones: 0, responseClones: 0 };
  const responseText = raw ?? JSON.stringify(payload);
  class Xhr {
    responseType = transport === 'xhr-json' ? 'json' : '';
    status = status;
    responseText = responseText;
    response = payload;
    open() {}
    setRequestHeader() {}
    addEventListener(_, fn) { this.loadend = fn; }
    getResponseHeader() { return 'application/json'; }
    send() { this.loadend?.(); }
  }
  const window = {
    fetch: async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('/api/token')) return { status: 400, json: async () => probe };
      return { status, headers: new Headers({ 'content-type': 'application/json' }),
        clone: () => { work.responseClones++; return { text: () => { const body = Promise.resolve(responseText); pending.push(body); return body; } }; } };
    },
    WebSocket: class {},
    ReactNativeWebView: { postMessage: raw => messages.push(JSON.parse(raw)) },
    addEventListener: (_, fn) => pagehide.push(fn),
  };
  runInNewContext(bootstrap, { window, XMLHttpRequest: Xhr, URL, Headers,
    location: { origin, href: `${origin}/` },
    setInterval: fn => { intervals.set(1, fn); return 1; }, clearInterval: id => intervals.delete(id) });
  await flush();
  if (transport === 'fetch') {
    const headers = { authorization, 'client-token': 'request-client' };
    if (options.requestObject) {
      await window.fetch({ url, method: 'PUT', headers, clone: () => {
        work.requestClones++;
        return { text: async () => '{"device":{}}' };
      } });
    } else await window.fetch(url, { method: 'PUT', headers });
    await Promise.all(pending);
  } else {
    const xhr = new Xhr();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Authorization', authorization);
    xhr.setRequestHeader('Client-Token', 'request-client');
    xhr.send();
  }
  await flush();
  pagehide.forEach(fn => fn());
  assert.equal(intervals.size, 0, 'pagehide cleans up the token probe');
  options.checkWork?.(work);
  return messages;
};
for (const transport of ['fetch', 'xhr-text', 'xhr-json']) {
  const messages = await checkBootstrap(transport);
  const verified = messages.filter(m => m.type === 'credentials' && m.authenticated === true);
  assert.deepEqual(verified, [{ type: 'credentials', token: 'request-token', clientToken: 'request-client',
    authenticated: true, verification: 'observer-response' }], `${transport}: player_state alone verifies the exact request bearer`);
  assert(messages.some(m => m.type === 'credentials' && m.authenticated === undefined), 'observed headers stay unverified until the response');
  assert(messages.every(m => /^(credentials|observerEndpoint|socket|notice)$/.test(m.type)), 'raw response and playback diagnostics never cross the bridge');
  for (const [reason, options] of [
    ['untrusted page', { origin: 'https://open.spotify.com.evil.test' }],
    ['untrusted endpoint', { url: 'https://guc3-spclient.spotify.com.evil.test/connect-state/v1/devices/test' }],
    ['wrong endpoint', { url: 'https://guc3-spclient.spotify.com/connect-state/v1/player/state' }],
    ['extra path segment', { url: `${observerUrl}/state` }],
    ...[201, 204, 400, 401, 403, 429, 500].map(status => [`HTTP ${status}`, { status }]),
    ...[{}, { device: {} }, { player_state: null }, { player_state: true }, { player_state: 'state' },
      { player_state: [] }, { player_state: {} }, { player_state: { unrelated: true } },
      { player_state: { is_playing: 'true' } }].map(payload => ['unrecognized state', { payload }]),
    ...['', 'Basic request-token', 'Bearer ', 'Bearer token extra'].map(authorization => ['missing/malformed bearer', { authorization }]),
    ['anonymous token probe', { payload: {}, probe: { accessToken: 'anonymous-token', isAnonymous: true } }],
    ['unverified token probe', { payload: {}, probe: { accessToken: 'unverified-token' } }],
  ]) {
    const rejected = await checkBootstrap(transport, options);
    assert.equal(rejected.filter(m => m.type === 'credentials' && m.authenticated === true).length, 0,
      `${transport}: ${reason} cannot verify credentials`);
  }
  if (transport !== 'xhr-json') {
    const malformed = await checkBootstrap(transport, { raw: '{invalid JSON' });
    assert(!malformed.some(m => m.authenticated === true), `${transport}: malformed JSON cannot verify credentials`);
  }
  for (const payload of [{ ...observerState, devices: {} }, { ...observerState, device: {} }, { player_state: { is_paused: true } }]) {
    const accepted = await checkBootstrap(transport, { payload });
    assert.equal(accepted.filter(m => m.verification === 'observer-response').length, 1,
      `${transport}: recognized playing/paused states and existing devices-map responses still verify`);
  }
}
await checkBootstrap('fetch', { requestObject: true, checkWork: work => {
  assert.deepEqual(work, { requestClones: 0, responseClones: 1 },
    'observer verification reads the response once without cloning a request for discarded diagnostics');
} });
for (const options of [
  { url: 'https://guc3-spclient.spotify.com/connect-state/v1/player/state' },
  { url: `${observerUrl}/extra` }, { status: 401 }, { status: 429 }, { authorization: 'Basic invalid' },
]) {
  await checkBootstrap('fetch', { ...options, checkWork: work => {
    assert.equal(work.responseClones, 0, 'responses ineligible to verify credentials need no diagnostic clone');
  } });
}
{
  const listeners = [], sent = [];
  class BrowserSocket {
    send(...args) { sent.push(args); return 'native-result'; }
    addEventListener(...args) { listeners.push(args); }
  }
  class Xhr { open() {} setRequestHeader() {} send() {} }
  const window = { WebSocket: BrowserSocket, fetch: async () => ({ json: async () => ({}) }),
    ReactNativeWebView: { postMessage() {} }, addEventListener() {} };
  runInNewContext(bootstrap, { window, XMLHttpRequest: Xhr, URL, Headers,
    location: { origin: 'https://open.spotify.com', href: 'https://open.spotify.com/' },
    setInterval: () => 1, clearInterval() {} });
  await flush();
  const socket = new window.WebSocket('wss://dealer.spotify.com/');
  assert.equal(socket.send, BrowserSocket.prototype.send, 'capture leaves native socket sends untouched');
  assert.equal(listeners.length, 0, 'discarded browser playback creates no message parser/listener');
  assert.equal(socket.send('opaque-message'), 'native-result');
  assert.deepEqual(sent, [['opaque-message']], 'native socket traffic still passes through unchanged');
}
try {
  globalThis.WebSocket = Socket;
  globalThis.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, ms, interval: false }); return timerId; };
  globalThis.setInterval = (fn, ms) => { timers.set(++timerId, { fn, ms, interval: true }); return timerId; };
  globalThis.clearTimeout = globalThis.clearInterval = id => timers.delete(id);
  let androidRoot = null, androidRegistrations = 0;
  const pagehide = [];
  const androidWindow = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    addEventListener: (_, fn) => pagehide.push(fn), ReactNativeWebView: { postMessage() {} } };
  const androidInstall = () => new Function('window', 'document', 'location', bootstrapAndroidObserver)(androidWindow,
    { querySelector: () => androidRoot }, { origin: 'https://open.spotify.com' });
  androidInstall();
  const discovery = [...timers.entries()].find(([, t]) => t.ms === 500);
  assert(discovery, 'Android waits for the existing SDK to mount');
  androidRoot = { __reactFiberFixture: { memoizedProps: { value: { _map: new Map([[Symbol('PlayerSDK'), { instance: { harmony: { _controller: {
    register: () => { androidRegistrations++; return Promise.resolve(); },
    getCurrentState: () => { throw new Error('bootstrap must not poll playback'); },
  } } } }]]) } } } };
  timers.delete(discovery[0]); discovery[1].fn(); await flush(); androidInstall(); await flush();
  assert.equal(androidRegistrations, 1, 'Android registers the existing observer only once');
  assert.equal(timers.size, 0, 'observer bootstrap does not create playback polling');
  pagehide.forEach(fn => fn());
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    if (options.method === 'GET') return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(metadata)).buffer };
    if (options.method === 'POST') return { ok: responseStatus === 200, status: responseStatus === 200 ? 204 : responseStatus, arrayBuffer: async () => new ArrayBuffer(0) };
    const snapshot = responseState;
    if (holdResponse) await new Promise(resolve => { releaseResponse = resolve; });
    return { ok: responseStatus === 200, status: responseStatus,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(snapshot)).buffer };
  };
  const detector = new SpotifyDetector({ sample: s => samples.push(s), status: s => statuses.push(s),
    sessionNeeded: () => needs++, authenticated: () => auth++, ready: () => ready++ });
  const capture = e => detector.capture(JSON.stringify(e), 'https://open.spotify.com/');
  detector.setEnabled(true);
  assert.equal(needs, 1);
  assert.equal(detector.capture(JSON.stringify({ type: 'credentials', token: 'secret', authenticated: true }), 'https://open.spotify.com.evil.test/'), false);
  capture({ type: 'credentials', token: 'anonymous' });
  capture({ type: 'observerEndpoint', url: `https://guc3-spclient.spotify.com/connect-state/v1/devices/hobs_${'b'.repeat(35)}` });
  capture({ type: 'socket', url: 'wss://dealer.spotify.com/?access_token=browser-token' });
  assert.equal(sockets.length, 0, 'unverified tokens cannot open a socket');
  capture({ type: 'credentials', token: 'verified', authenticated: true, expiresAt: epoch + 3600000 });
  assert.equal(sockets.length, 1);
  assert.equal(auth, 1);
  assert.equal(new URL(sockets[0].url).searchParams.get('access_token'), 'verified');
  const ws = sockets[0]; ws.onopen();
  ws.event({ headers: { 'Spotify-Connection-Id': 'our-connection' } }); await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].headers['x-spotify-connection-id'], 'our-connection');
  assert.notEqual(requests[0].url.split('/').pop(), `hobs_${'b'.repeat(35)}`);
  assert.equal(JSON.parse(requests[0].body).device.device_info.capabilities.can_be_player, false);
  assert.equal(samples.length, 1);
  const metadataRequests = requests.length;
  const matches = await Promise.all([detector.metadata(uri), detector.metadata(uri)]);
  assert.equal(matches[0].artist, 'Artist, Guest');
  assert.equal(requests.length, metadataRequests + 1, 'metadata deduplicates concurrent lookups');
  assert.equal(requests.at(-1).url, `https://guc3-spclient.spotify.com/metadata/4/track/${expectedGid}?market=from_token`);
  assert.equal(requests.at(-1).headers.authorization, 'Bearer verified');
  await detector.metadata(uri);
  assert.equal(requests.length, metadataRequests + 1, 'metadata is cached');
  const commandBody = () => JSON.parse(new TextDecoder().decode(ungzip(new Uint8Array(requests.at(-1).body))));
  await detector.control({ type: 'toggle' });
  assert.equal(commandBody().command.endpoint, 'pause');
  assert.equal(requests.at(-1).headers['content-encoding'], 'gzip');
  assert.equal(requests.at(-1).headers['x-spotify-connection-id'], 'our-connection');
  assert.equal(new URL(requests.at(-1).url).pathname, `/connect-state/v1/player/command/from/${new URL(requests[0].url).pathname.split('/').pop()}/to/iphone`);
  assert.equal(samples.length, 1, 'command acknowledgment cannot invent a clock anchor');
  await detector.control({ type: 'seek', positionMs: 999999 });
  assert.equal(commandBody().command.value, 200000);
  await assert.rejects(detector.control({ type: 'seek', positionMs: NaN }), /Invalid seek/);
  for (const [type, endpoint] of [['next', 'skip_next'], ['previous', 'skip_prev']]) {
    await detector.control({ type }); assert.equal(commandBody().command.endpoint, endpoint);
  }
    responseStatus = 403;
    await assert.rejects(detector.control({ type: 'toggle' }), /control HTTP 403/);
    responseStatus = 404;
    await assert.rejects(detector.control({ type: 'toggle' }), SpotifyPlaybackUnavailableError);
  responseStatus = 200;
  ws.event({ payloads: [state()] });
  assert.equal(samples.length, 1, 'duplicate anchors do not reset the lyrics clock');
  assert.equal(ready, 2, 'an identical anchor confirms readiness without re-ingesting');
  ws.event({ payloads: [state(1500, epoch + 500, true)] });
  assert.equal(samples.at(-1).playing, false, 'pause overrides is_playing');
  await detector.control({ type: 'toggle' });
  assert.equal(commandBody().command.endpoint, 'resume');
  ws.event({ payloads: [state(1000, epoch)] });
  assert.equal(samples.length, 2, 'old snapshots cannot rewind a newer pause');
  ws.event({ payloads: [state(60000, epoch + 1000)] });
  assert.equal(samples.at(-1).positionMs, 60000, 'seeks stay authoritative');
  assert(![...timers.values()].some(t => t.ms === 250), 'detector never schedules 250 ms polling');
  const packet = detectorPacket(samples.at(-1), epoch + 1200);
  assert.equal(packet.positionMs, 60200);
  assert.equal(packet.capturedAtMs, epoch + 1200, 'packet already projected to local time');
  assert.equal(packet.artworkUrl, 'https://i.scdn.co/image/cover');
  const paused = detectorPacket(sampleFrom(state(1500, epoch + 500, true)), epoch + 5000);
  assert.equal(paused.positionMs, 1500, 'paused clocks do not advance');
  const count = samples.length;
  detector.setEnabled(false);
  ws.event({ payloads: [state(70000, epoch + 1500)] });
  assert.equal(samples.length, count, 'disposed sockets cannot publish');
  assert.equal(timers.size, 0, 'background/disable cleans timers');
  detector.setEnabled(true);
  assert.equal(sockets.length, 2, 'foreground reconnects without a browser');
  holdResponse = true; responseState = state(61000, epoch + 2000);
  const ws2 = sockets.at(-1); ws2.event({ headers: { 'spotify-connection-id': 'second' } }); await flush();
  ws2.event({ payloads: [state(62000, epoch + 3000, true)] });
  releaseResponse(); await flush(); holdResponse = false;
  assert.equal(samples.at(-1).positionMs, 62000, 'Dealer event during registration beats older HTTP response');
  assert.equal(samples.at(-1).playing, false);
  responseStatus = 429;
  detector.refresh(); sockets.at(-1).event({ headers: { 'spotify-connection-id': 'limited' } }); await flush();
  const socketCount = sockets.length;
  detector.setEnabled(true);
  assert.equal(sockets.length, socketCount, 'rate limits cannot trigger automatic reconnect loops');
  assert(statuses.some(s => s.includes('429')));
  detector.clear();
  detector.setEnabled(true);
  assert.equal(sockets.length, socketCount, 'logout clears credentials/routes');
  detector.setEnabled(false);
  assert.equal(timers.size, 0);
  const encoded = Buffer.from(JSON.stringify(state())).toString('base64');
  assert.equal(sampleFrom(decodeDealer({ payloads: [encoded] })).artist, 'Artist');
  console.log('Spotify detector checks passed: bootstrap fetch/XHR verification, verified session, independent observer, duplicate/stale suppression, pause/seek, monotonic handoff, registration race, lifecycle cleanup and rate limits.');
} finally {
  for (const [key, value] of Object.entries(saved)) globalThis[key] = value;
}
