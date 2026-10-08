/* global __dirname */
// Execute the actual injected controller against normalized Android slider
// shapes. Millisecond lyric timestamps must never be divided by slider units.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../lib/spotify-browser.ts'), 'utf8');
const marker = 'export const installBrowserControlScript = String.raw`';
const start = source.indexOf(marker) + marker.length;
const script = source.slice(start, source.indexOf('`;', start));

async function run({ maximum = 1, minimum = 0, durationMs = 180000, connect = true, clocks = true, input = true, targetMs = 45000 } = {}) {
  const posted = [], events = [];
  let value = minimum;
  class Input {
    get value() { return String(value); }
    set value(next) { value = Math.max(minimum, Math.min(maximum, Number(next))); }
    type = 'range'; min = String(minimum); max = String(maximum); step = '0.001';
    getAttribute(name) { return { 'aria-valuemax': String(maximum), 'aria-valuenow': this.value }[name] ?? null; }
    dispatchEvent(event) { events.push(event); }
    getBoundingClientRect() { return { left: 20, top: 100, width: 400, height: 20 }; }
  }
  const slider = new Input();
  const clock = { tagName: 'SPAN', textContent: `${Math.floor(durationMs / 60000)}:${String(Math.floor(durationMs / 1000) % 60).padStart(2, '0')}`,
    getAttribute: () => null, getBoundingClientRect: () => ({ left: 430, top: 100, width: 30, height: 20 }) };
  const position = { getAttribute: () => '10000' };
  const controller = { register: async () => {}, getCurrentState: async () => ({ position: 10000, duration: durationMs, paused: true,
    track_window: { current_track: { name: 'Song', uri: `spotify:track:${'1'.repeat(22)}`, artists: [{ name: 'Artist' }] } } }) };
  const elapsed = { ...clock, textContent: '0:10', getBoundingClientRect: () => ({ left: 0, top: 100, width: 30, height: 20 }) };
  const root = { textContent: `0:10 ${clock.textContent}`, querySelector: () => slider, querySelectorAll: () => clocks ? [elapsed, clock] : [],
    __reactFiberTest: { memoizedProps: { value: { _map: new Map([[Symbol('PlayerSDK'), { instance: { harmony: { _controller: controller } } }]]) } } } };
  slider.parentElement = root;
  const document = { body: {}, visibilityState: 'hidden', addEventListener() {}, querySelectorAll: () => [],
    querySelector: selector => selector.includes('playback-duration') ? position :
      selector.includes('playback-progressbar') || selector.includes('Change progress') ? slider :
      selector.includes('now-playing-bar') ? root : null };
  const navigator = { mediaSession: { playbackState: 'paused', metadata: null } };
  class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  const win = { navigator, __spotifyBrowserLabEnableConnectObserver: connect,
    ReactNativeWebView: { postMessage: raw => posted.push(JSON.parse(raw)) }, setTimeout: () => 1, clearTimeout() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
  new Function('window', 'document', 'navigator', 'performance', 'MutationObserver', 'HTMLInputElement', 'Event', 'MouseEvent', script)(
    win, document, navigator, { now: () => 1000 }, class { observe() {} }, input ? Input : class {}, Event, Event);
  await new Promise(resolve => setImmediate(resolve));
  win.__spotifyBrowserControl({ type: 'seek', positionMs: targetMs });
  return { value, events, posted };
}

(async () => {
  const normalized = await run({ clocks: false });
  assert.equal(normalized.value, 0.25, '45-second lyric tap in a 180-second song must seek to 25%, not the end');
  const percent = await run({ maximum: 100, targetMs: 90000 });
  assert.equal(percent.value, 50, 'percentage slider is not a 100-second song');
  const visible = await run({ connect: false });
  assert.equal(visible.value, 0.25, 'visible duration clocks work without Connect');
  const offset = await run({ minimum: 10, maximum: 110 });
  assert.equal(offset.value, 35, 'nonzero range minimum is preserved');
  const milliseconds = await run({ maximum: 180000, connect: false });
  assert.equal(milliseconds.value, 45000, 'millisecond sliders retain their existing units');
  const seconds = await run({ maximum: 180, connect: false });
  assert.equal(seconds.value, 45, 'second sliders retain their existing units');
  assert.equal((await run({ targetMs: -1000 })).value, 0, 'negative targets clamp to the start');
  assert.equal((await run({ targetMs: 999999 })).value, 1, 'intentional end seeks still clamp correctly');
  const role = await run({ input: false });
  assert.equal(role.events.find(e => e.type === 'click').clientX, 120, 'role slider uses the same track fraction');
  const unknown = await run({ connect: false, clocks: false });
  assert.equal(unknown.events.length, 0, 'unknown normalized duration must not cause an end-of-song seek');
  assert(unknown.posted.some(e => e.type === 'error' && /duration/i.test(e.message)));
  const invalid = await run({ targetMs: NaN });
  assert.equal(invalid.events.length, 0, 'non-finite lyric timestamps cannot move the player');
  console.log('Spotify seek checks passed: normalized/percent/offset ranges, Connect and visible duration, role sliders, missing duration and invalid timestamps.');
})().catch(error => { console.error(error); process.exitCode = 1; });
