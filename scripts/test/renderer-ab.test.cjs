const assert = require('node:assert/strict');
const { test } = require('node:test');
const { compareRuns } = require('../android-production-ui/compare-renderer-runs.cjs');

function arm(version, renderer) {
  const hash = digit => digit.repeat(64);
  return {
    version, renderer, debuggable: false,
    apkSha256: hash(renderer === 'skia' ? 'a' : 'b'),
    traceSha256: hash(renderer === 'skia' ? 'c' : 'd'),
    driverSha256: hash('e'),
    capture: 'surfaceflinger-frame-timeline',
    device: { physical: true, model: 'Pixel 8a', apiLevel: 35, buildFingerprint: 'fixture', refreshHz: 60 },
    windows: ['amll:on', 'amll:off', 'spicy:on', 'spicy:off'].map(scenario => ({
      scenario, trackId: 'same-song', trackStartMs: 30000, lyricsSha256: hash('f'),
      startNs: 1000000000, endNs: 2000000000,
      presents: [
        { timestampNs: 1100000000, jank: false },
        { timestampNs: 1110000000, jank: false },
        { timestampNs: 1130000000, jank: false },
        { timestampNs: 1160000000, jank: true },
      ],
      jsThread: renderer === 'skia' ? { name: 'mqt_js', runningNs: 250000000 } : null,
    })),
  };
}

test('reports presentation intervals, classified jank and available JS CPU evidence', () => {
  const { scenarios } = compareRuns(arm('1.2.8', 'skia'), arm('1.3.0', 'rust'));
  assert.equal(scenarios.length, 4);
  const { skia, rust } = scenarios[0];
  assert.equal(skia.presentedFps, 4);
  assert.equal(skia.presentIntervalP50Ms, 20);
  assert.equal(skia.presentIntervalP95Ms, 30);
  assert.equal(skia.presentIntervalWorstMs, 30);
  assert.equal(skia.presentedFrameJankPercent, 25);
  assert.deepEqual(skia.jsThread, { name: 'mqt_js', cpuMs: 250, percentOfOneCpu: 25 });
  assert.equal(rust.jsThread, null);
});

test('rejects a nonmatching device, workload, window or presentation sample', () => {
  const skia = arm('1.2.8', 'skia');
  const rust = arm('1.3.0', 'rust');
  for (const [edit, message] of [
    [run => { run.device.model = 'Pixel 8'; }, /Match physical device/],
    [run => { run.debuggable = true; }, /verified release APK/],
    [run => { run.windows.pop(); }, /same four scenarios/],
    [run => { run.windows[0].trackId = 'different-song'; }, /trackId differs/],
    [run => { run.windows[0].endNs++; }, /window lengths differ/],
    [run => { run.windows[0].presents[1].timestampNs = run.windows[0].presents[0].timestampNs; }, /unique and ordered/],
  ]) {
    const edited = structuredClone(rust);
    edit(edited);
    assert.throws(() => compareRuns(skia, edited), message);
  }
});
