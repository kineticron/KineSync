/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const code = buildSync({ entryPoints: [path.join(__dirname, '../lib/native-clock-diagnostics.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
function load(dev) {
  let now = 1000;
  const lines = [], module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, __DEV__: dev,
    performance: { now: () => now }, Date: { now: () => 1800000000000 + now },
    console: { log: (...args) => lines.push(args) } });
  return { api: module.exports, lines, advance: ms => { now += ms; } };
}
(async () => {
  const release = load(false);
  assert.equal(release.api.beginNativeClockCapture('spicy/flash/canvas', 1), null);
  release.api.emitNativeClockDiagnostic('test', {});
  assert.equal(release.lines.length, 0);
  assert.equal(release.api.NATIVE_CLOCK_HTTP_TRACE_SCRIPT, '');
  const dev = load(true);
  dev.api.setNativeClockStoreReader(() => ({ anchorPositionMs: 20000, anchorMonotonicMs: 1000, isPlaying: true }));
  const first = dev.api.beginNativeClockCapture('spicy/flash/canvas', 1);
  dev.api.reportNativeUiClock(first, 'ui-clock-frame', { nativeNow: 1000, position: 20000, playing: true, fallback: false });
  assert.equal(JSON.parse(dev.lines.at(-1)[1]).uiMinusStoreAtReceipt, 0);
  dev.advance(1000);
  const second = dev.api.beginNativeClockCapture('amll/flash/canvas', 2);
  assert.equal(second.from, 'spicy/flash/canvas');
  assert.equal(second.to, 'amll/flash/canvas');
  for (let i = 0; i < 100; i++) dev.api.emitNativeClockDiagnostic('bounded', { generation: i });
  assert.equal(dev.lines.filter(line => JSON.parse(line[1]).switchId === second.switchId).length, 80);
  const third = dev.api.beginNativeClockCapture('spicy/flash/canvas', 3);
  assert.equal(third.from, 'amll/flash/canvas');
  dev.advance(15001); dev.api.emitNativeClockDiagnostic('expired', {});
  assert.equal(dev.api.nativeClockCaptureActive(), false);
  for (let instance = 4; instance < 20; instance++) {
    dev.api.beginNativeClockCapture('amll/flash/canvas', instance);
    for (let i = 0; i < 100; i++) dev.api.emitNativeClockDiagnostic('session-limit', {});
  }
  assert.equal(dev.lines.length, 600);
  const posted = [];
  const browser = { ReactNativeWebView: { postMessage: text => posted.push(JSON.parse(text)) },
    fetch: async input => ({ status: input.includes('/devices/ok') ? 200 : 410 }) };
  function XHR() {}
  XHR.prototype.open = function () {};
  vm.runInNewContext(dev.api.NATIVE_CLOCK_HTTP_TRACE_SCRIPT, { window: browser, URL,
    location: { href: 'https://open.spotify.com/' }, XMLHttpRequest: XHR, Date });
  await browser.fetch('https://spclient.spotify.com/connect-state/v1/devices/ok');
  for (let i = 0; i < 20; i++) await browser.fetch('https://spclient.spotify.com/connect-state/v1/devices/private-device?token=private-token');
  assert.equal(posted.length, 12);
  assert.ok(posted.every(row => row.status === 410 && row.endpoint === 'browser-device-registration'));
  assert.ok(!JSON.stringify(posted).includes('private-'));
  console.log('Native switch diagnostics passed: release silence, both switch directions, UI/store comparison, 15s/80-line capture and 600-line session caps, browser410-only/12-message limit and no URL/ID/token forwarding.');
})().catch(error => { console.error(error); process.exitCode = 1; });
