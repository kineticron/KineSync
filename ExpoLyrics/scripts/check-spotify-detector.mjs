import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ stdin: { contents: `export {SpotifyDetector} from './lib/spotify-detector/client';
export {sampleFrom,decodeDealer,decodeStateBody,observerBody} from './lib/spotify-detector/protocol';
export {detectorPacket} from './lib/spotify-detector/packet';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false });
const { SpotifyDetector, sampleFrom, decodeDealer, detectorPacket } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const trackId = 'a'.repeat(22);
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
try {
  globalThis.WebSocket = Socket;
  globalThis.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, ms, interval: false }); return timerId; };
  globalThis.setInterval = (fn, ms) => { timers.set(++timerId, { fn, ms, interval: true }); return timerId; };
  globalThis.clearTimeout = globalThis.clearInterval = id => timers.delete(id);
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
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
  ws.event({ payloads: [state()] });
  assert.equal(samples.length, 1, 'duplicate anchors do not reset the lyrics clock');
  assert.equal(ready, 2, 'an identical anchor confirms readiness without re-ingesting');
  ws.event({ payloads: [state(1500, epoch + 500, true)] });
  assert.equal(samples.at(-1).playing, false, 'pause overrides is_playing');
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
  console.log('Spotify detector checks passed: verified session, independent observer, duplicate/stale suppression, pause/seek, monotonic handoff, registration race, lifecycle cleanup and rate limits.');
} finally {
  for (const [key, value] of Object.entries(saved)) globalThis[key] = value;
}
