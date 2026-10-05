/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../lib/spotify-browser.ts'), 'utf8');
const marker = 'export const installBrowserControlScript = String.raw`';
const start = source.indexOf(marker) + marker.length;
const script = source.slice(start, source.indexOf('`;', start));
const flush = () => new Promise(resolve => setImmediate(resolve));
const makeState = (name, id, paused) => ({
  position: 33738, duration: 203520, paused, playback_speed: paused ? 0 : 1,
  track_window: { current_track: {
    name, uri: `spotify:track:${id}`, artists: [{ name: 'EXO' }],
    album: { name: 'Album', images: [{ url: 'https://i.scdn.co/image/small', width: 64 }, { url: 'https://i.scdn.co/image/large', width: 640 }] },
  } },
});

async function run({ failRegistration = false } = {}) {
  let state = makeState('Obsession', '7fK0csBoqbcgUuWGV0cpoD', true);
  let registrations = 0, clock = 1000, resolvePending;
  const posted = [], timers = new Map();
  let timerId = 0;
  const controller = {
    register() {
      registrations++;
      return failRegistration ? Promise.reject(new Error('offline')) : Promise.resolve();
    },
    getCurrentState() { return resolvePending === false ? new Promise(resolve => { resolvePending = resolve; }) : Promise.resolve(state); },
  };
  const container = {
    _map: new Map([[Symbol('PlayerSDK'), { instance: { harmony: { _controller: controller } } }]]),
    resolve() { throw new Error('must use the existing SDK instance'); },
  };
  const footer = {
    __reactFiberTest: { memoizedProps: {}, return: { memoizedProps: { value: container } } },
    querySelector: () => null, querySelectorAll: () => [],
  };
  const document = {
    body: {}, visibilityState: 'hidden', addEventListener() {},
    querySelector: selector => selector.includes('now-playing-bar') ? footer : null,
    querySelectorAll: () => [],
  };
  const navigator = { mediaSession: { playbackState: 'none', metadata: null } };
  const win = {
    __spotifyBrowserLabEnableConnectObserver: true,
    ReactNativeWebView: { postMessage: raw => posted.push(JSON.parse(raw)) },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    __spotifyBrowserLabKnownMedia: [],
  };
  class MutationObserver { observe() {} }
  new Function('window', 'document', 'navigator', 'performance', 'MutationObserver', 'Date', script)(
    win, document, navigator, { now: () => clock }, MutationObserver, { now: () => clock },
  );
  await flush();
  if (failRegistration) {
    assert.equal(registrations, 1);
    win.__spotifyBrowserControl({ type: 'readMetadata' }); await flush();
    assert.equal(registrations, 1, 'failed registration must back off');
    win.__spotifyBrowserControl({ type: 'diagnostics' });
    const diagnostics = posted.findLast(e => e.type === 'diagnostics');
    assert.equal(diagnostics.connectObserver.registered, false);
    assert.equal(diagnostics.connectObserver.error, 'offline');
    failRegistration = false;
    clock += 10000;
    win.__spotifyBrowserControl({ type: 'readMetadata' }); await flush();
    assert.equal(registrations, 2, 'retry registration after the backoff');
    assert.equal(posted.findLast(e => e.type === 'metadata').title, 'Obsession');
    return;
  }
  assert.equal(registrations, 1, 'register the observer before local playback');
  const metadata = posted.findLast(e => e.type === 'metadata');
  assert.equal(metadata.title, 'Obsession');
  assert.equal(metadata.artist, 'EXO');
  assert.equal(metadata.spotifyTrackId, '7fK0csBoqbcgUuWGV0cpoD');
  assert.equal(metadata.artworkUrl, 'https://i.scdn.co/image/large');
  let playback = posted.findLast(e => e.type === 'playback');
  assert.equal(playback.source, 'spotify-connect');
  assert.equal(playback.isPlaying, false, 'paused state must display before any tap');
  assert.equal(playback.positionMs, 33738);

  state = makeState('Remote next song', '1111111111111111111111', false);
  // Even a stale DOM/MediaSession must not overwrite the Connect identity.
  navigator.mediaSession.metadata = { title: 'Stale song', artist: 'Stale artist' };
  win.__spotifyBrowserControl({ type: 'readMetadata' }); await flush();
  assert.equal(posted.findLast(e => e.type === 'metadata').title, 'Remote next song');
  assert.equal(posted.findLast(e => e.type === 'playback').isPlaying, true);
  assert.equal(registrations, 1, 'polling must reuse the registered observer');
  clock += 250;
  win.__spotifyBrowserControl({ type: 'diagnostics' });
  const diagnostics = posted.findLast(e => e.type === 'diagnostics');
  assert.equal(diagnostics.playback.source, 'spotify-connect');
  assert.equal(diagnostics.playback.positionMs, 33988, 'advance the remote clock between samples');
  await flush();

  resolvePending = false;
  win.__spotifyBrowserControl({ type: 'readMetadata' }); await flush();
  assert.equal(typeof resolvePending, 'function');
  win.__spotifyBrowserControl({ type: 'setMonitoring', enabled: false });
  const count = posted.length;
  resolvePending(makeState('Late background song', '2222222222222222222222', false));
  await flush();
  assert.equal(posted.length, count, 'late async state must not update after native monitoring stops');
  assert.equal(timers.size, 0);
  resolvePending = undefined;
  win.__spotifyBrowserControl({ type: 'setMonitoring', enabled: true }); await flush();
  assert.equal(posted.findLast(e => e.type === 'metadata').title, 'Remote next song');
  assert.equal(registrations, 1);
}

(async () => {
  await run(); await run({ failRegistration: true });
  console.log('Spotify Connect checks passed: startup, paused state, remote changes, clock, stale DOM, registration backoff and background cancellation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
