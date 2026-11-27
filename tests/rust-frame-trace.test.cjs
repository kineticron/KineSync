const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  acceptsTraceSummary,
  applyTraceReset,
  budgetTone,
  decodeWorker,
  maxShareTraceBytes,
  shareTracePayload,
  traceScenarios,
  traceScalarPages,
} = require('../ExpoLyrics/lib/rust-frame-trace.ts');

// Run with Node 22 and --experimental-strip-types. Phone measurements use
// matched five-second clips with capture off, on/hidden, and on/visible.
// Callback estimates, CPU present calls and GPU queue intervals have distinct
// scopes. Drawable presentation is unsupported by this version of the trace.
test('budget colors use observed cadence and keep missing measurements neutral', () => {
  assert.equal(budgetTone(null, 8.33), 'neutral');
  assert.equal(budgetTone(8.3, undefined), 'neutral');
  assert.equal(budgetTone(8.3, 0), 'neutral');
  assert.equal(budgetTone(8.3, 8.33), 'good');
  assert.equal(budgetTone(9.2, 8.33), 'warn');
  assert.equal(budgetTone(17.1, 8.33), 'bad');
  assert.equal(budgetTone(17.1, 16.67), 'good');
});

test('summary decoding handles a surface with no worker snapshot', () => {
  assert.equal(decodeWorker(''), null);
  assert.equal(decodeWorker('{'), null);
  assert.deepEqual(decodeWorker('{"summary":{"presentCallHz":120}}'), { presentCallHz: 120 });
});

test('summary and Share reject stale capture identity across restart and remount', () => {
  const identity = { token: 8, generation: 4, surface: 2 };
  const session = '4:2:6';
  const expected = { ...identity, session, minimumToken: identity.token };
  const native = changes => JSON.stringify({
    callbacks: { capture: identity, session, ...changes },
    worker: { capture: identity, summary: { windowPresentCallHz: 112 } },
  });
  assert.equal(decodeWorker(JSON.stringify({ capture: identity, summary: {} }), { ...identity, surface: 3 }), null);
  assert.doesNotThrow(() => shareTracePayload(native({}), traceScenarios[0], null, expected));
  assert.throws(() => shareTracePayload(native({ session: '4:2:5' }), traceScenarios[0], null, expected), /capture changed/);
  assert.throws(() => shareTracePayload(native({ capture: { ...identity, token: 7 } }), traceScenarios[0], null, expected), /capture changed/);
  assert.throws(() => shareTracePayload(native({}), traceScenarios[0], null, { ...expected, surface: 3 }), /capture changed/);
  assert.throws(() => shareTracePayload(native({}), traceScenarios[0], null, { ...expected, token: 7 }), /capture changed/);
});

test('independent reset invalidates a detached owner before its replacement has a summary', () => {
  const session = '4:2:6';
  const gate = { session, minimumToken: 0, active: false, visibleSince: 100 };
  const reset = (token, active, currentSession = session) =>
    applyTraceReset(gate, { token, active, session: currentSession, generation: 4, surface: 2 });
  const summary = (token, currentSession = session, snapshotMs = 105) =>
    acceptsTraceSummary(gate, { token, session: currentSession, snapshotMs });
  assert.equal(summary(8), false, 'summaries cannot establish capture identity');
  assert.equal(reset(8, true), true);
  assert.equal(summary(8), true);
  assert.equal(summary(8, session, 99), false);
  assert.equal(reset(9, false), true);
  assert.equal(summary(8), false, 'queued old owner summary');
  assert.equal(summary(9), false, 'detach token is a tombstone');
  assert.equal(reset(10, true), true);
  assert.equal(summary(10), true);
  assert.equal(reset(9, false), false, 'delayed detach cannot clear replacement sample');
  assert.equal(reset(11, true, '4:2:5'), false, 'delayed stopped capture cannot replace current session');
  assert.equal(summary(10, '4:2:5'), false);
  assert.equal(summary(10), true);
});

test('compact scalar pages expose each metric and percentile, including missing GPU samples', () => {
  const labels = ['Callback interval', 'Present-call interval', 'CPU encode', 'GPU queue elapsed'];
  const distribution = { count: 10, p50: 2.1, p95: 3.4, worst: 5.6 };
  const pages = traceScalarPages(labels.map((label, index) => ({ label, stats: index < 3 ? distribution : null })));
  assert.equal(pages.length, 12);
  for (const [index, label] of labels.entries()) {
    const row = pages.slice(index * 3, index * 3 + 3);
    assert.deepEqual(row.map(page => page.label), ['p50', 'p95', 'worst'].map(key => label + ' · ' + key));
    assert.deepEqual(row.map(page => page.value), index < 3 ? [2.1, 3.4, 5.6] : [undefined, undefined, undefined]);
  }
});

test('share payload preserves raw records and separates React timing', () => {
  const native = {
    version: 1,
    callbacks: { callbacks: [{ id: 7, missedCallbackVsyncsEstimate: 0 }] },
    worker: { frames: [{ id: 7, presentMs: 12.5, gpu: { elapsedMs: 3.2 } }] },
  };
  assert.equal(traceScenarios.length, 6);
  const scenario = traceScenarios[5];
  assert.equal(scenario, 'AMLL far-return');
  assert.deepEqual(JSON.parse(shareTracePayload(JSON.stringify(native), scenario, 0.8)), {
    scenario,
    overlay: { previousReactProfilerActualDurationMs: 0.8 },
    capture: native,
  });
});

test('Share bounds final UTF-8 bytes with both trace rings occupied', () => {
  const callbacks = Array.from({ length: 1200 }, (_, id) => ({
    id, segment: 7, arrivalMs: 35e6 + id, timestampMs: 35e6 + id - 1, targetMs: 35e6 + id + 7,
    requestedHz: 120, action: 'request', warmup: false, missedCallbackVsyncsEstimate: 0,
    intervalMs: 8.333333333, recordCpuMs: 0.003341,
  }));
  const frames = Array.from({ length: 1200 }, (_, id) => ({
    id, segment: 7, workerMs: 35e6 + id, finishedMs: 35e6 + id + 1, status: 0, acquireAttempts: 2,
    acquireMs: 2.103, encodeMs: 5.222, presentMs: 35e6 + id + 1,
    gpu: { elapsedMs: 5.4321, collectedMs: 35e6 + id + 2 }, bookkeepingMs: 0.072, markerCpuMs: 0.056,
  }));
  const native = { callbacks: { records: { callbacks } }, worker: { frames } };
  const payload = shareTracePayload(JSON.stringify(native), traceScenarios[0], null);
  const headroom = maxShareTraceBytes - Buffer.byteLength(payload);
  assert.ok(headroom > 0);
  const extra = '🎵'.repeat(Math.floor(headroom / 3));
  const withMultibyteData = JSON.stringify({ ...native, extra });
  assert.ok(withMultibyteData.length < maxShareTraceBytes && Buffer.byteLength(withMultibyteData) > maxShareTraceBytes);
  assert.throws(() => shareTracePayload(withMultibyteData, traceScenarios[0], null), /share limit/);
});
