const assert = require('node:assert/strict');
const fs = require('node:fs');

const scenarios = ['amll:on', 'amll:off', 'spicy:on', 'spicy:off'];
const sha256 = /^[a-f0-9]{64}$/;

function checkArm(run, version, renderer) {
  assert.equal(run.version, version);
  assert.equal(run.renderer, renderer);
  assert.equal(run.debuggable, false, 'Use the verified release APK');
  assert.match(run.apkSha256, sha256);
  assert.match(run.driverSha256, sha256);
  assert.match(run.traceSha256, sha256);
  assert.equal(run.device.physical, true);
  assert.ok(run.device.model && run.device.buildFingerprint && run.device.apiLevel);
  assert.ok(Number.isFinite(run.device.refreshHz) && run.device.refreshHz > 0);
  assert.equal(run.capture, 'surfaceflinger-frame-timeline');
  assert.deepEqual(run.windows.map(window => window.scenario), scenarios, 'Use the same four scenarios in order');
  return new Map(run.windows.map(window => [window.scenario, window]));
}

function summarize(window) {
  const { startNs, endNs, presents, jsThread } = window;
  assert.ok(Number.isSafeInteger(startNs) && Number.isSafeInteger(endNs) && endNs > startNs);
  assert.ok(window.trackId && Number.isSafeInteger(window.trackStartMs) && window.trackStartMs >= 0);
  assert.match(window.lyricsSha256, sha256);
  assert.ok(presents.length >= 2, 'Missing actual presentation timestamps');
  const intervals = [];
  let janky = 0;
  let previous;
  for (const { timestampNs, jank } of presents) {
    assert.ok(Number.isSafeInteger(timestampNs) && timestampNs >= startNs && timestampNs < endNs);
    assert.equal(typeof jank, 'boolean', 'Each presented frame needs a FrameTimeline jank classification');
    if (previous !== undefined) {
      assert.ok(timestampNs > previous, 'Present timestamps must be unique and ordered');
      intervals.push((timestampNs - previous) / 1e6);
    }
    previous = timestampNs;
    janky += Number(jank);
  }
  intervals.sort((left, right) => left - right);
  const seconds = (endNs - startNs) / 1e9;
  if (jsThread !== undefined && jsThread !== null) {
    assert.ok(typeof jsThread.name === 'string' && jsThread.name.length);
    assert.ok(Number.isSafeInteger(jsThread.runningNs) && jsThread.runningNs >= 0 && jsThread.runningNs <= endNs - startNs);
  }
  return {
    seconds,
    presentedFrames: presents.length,
    presentedFps: presents.length / seconds,
    presentIntervalP50Ms: intervals[Math.ceil(intervals.length * 0.50) - 1],
    presentIntervalP95Ms: intervals[Math.ceil(intervals.length * 0.95) - 1],
    presentIntervalWorstMs: intervals.at(-1),
    jankyPresentedFrames: janky,
    presentedFrameJankPercent: janky / presents.length * 100,
    jsThread: jsThread ? { name: jsThread.name, cpuMs: jsThread.runningNs / 1e6,
      percentOfOneCpu: jsThread.runningNs / (endNs - startNs) * 100 } : null,
  };
}

function compareRuns(skia, rust) {
  const before = checkArm(skia, '1.2.8', 'skia');
  const after = checkArm(rust, '1.3.0', 'rust');
  assert.deepEqual(rust.device, skia.device, 'Match physical device model, OS and refresh settings');
  assert.equal(rust.driverSha256, skia.driverSha256, 'Use the same scenario driver');
  assert.notEqual(rust.apkSha256, skia.apkSha256);
  assert.notEqual(rust.traceSha256, skia.traceSha256);
  return {
    device: skia.device,
    apkSha256: { skia: skia.apkSha256, rust: rust.apkSha256 },
    traceSha256: { skia: skia.traceSha256, rust: rust.traceSha256 },
    driverSha256: skia.driverSha256,
    scenarios: scenarios.map(scenario => {
      const a = before.get(scenario);
      const b = after.get(scenario);
      for (const field of ['trackId', 'trackStartMs', 'lyricsSha256']) {
        assert.equal(b[field], a[field], `${scenario}: ${field} differs`);
      }
      const skiaMetrics = summarize(a);
      const rustMetrics = summarize(b);
      assert.equal(rustMetrics.seconds, skiaMetrics.seconds, `${scenario}: window lengths differ`);
      return { scenario, trackId: a.trackId, trackStartMs: a.trackStartMs, lyricsSha256: a.lyricsSha256,
        skia: skiaMetrics, rust: rustMetrics };
    }),
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node compare-renderer-runs.cjs SKIA.json RUST.json');
    const [skia, rust] = process.argv.slice(2).map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log(JSON.stringify(compareRuns(skia, rust), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { compareRuns };
