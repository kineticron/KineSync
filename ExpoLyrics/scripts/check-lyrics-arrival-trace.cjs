const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../lib/lyrics-arrival-trace.ts'), 'utf8');
function load(dev, now = () => 10) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, __DEV__: dev, performance: { now }, WeakMap, Object });
  return exports;
}
const t = load(true); t.startArrivalCapture();
const a = {}, b = {}, enriched = {};
const ha = t.beginArrival(a, 'a'), hb = t.beginArrival(b, 'b');
t.linkArrival(enriched, ha);
assert.equal(t.arrivalHandle(enriched), ha);
assert.notEqual(ha.packet, hb.packet);
t.arrivalEvent(ha, 1, 'outgoing', 0, 8);
t.arrivalEvent(hb, 2, 'incoming', 1, 5);
t.arrivalEvent(ha, 1, 'stale-ready', 8, 8);
let s = t.snapshotArrivalCapture();
assert.equal(s.records[2].packet, ha.packet);
assert.equal(s.records[1].generation, 2);
assert.equal(s.records.length, 3); assert.match(s.accounting, /never sum/);
assert.equal('total' in s, false);
t.startArrivalCapture(); t.arrivalEvent(ha, 1, 'stale-capture');
assert.equal(t.arrivalHandle(a), undefined); assert.equal(t.snapshotArrivalCapture().records.length, 0);
const h = t.beginArrival({}, 'x');
for (let i = 0; i < 3000; i++) t.arrivalEvent(h, 3, 'bounded');
s = t.snapshotArrivalCapture(); assert.equal(s.records.length, 2048); assert.equal(s.dropped, 952);
assert.throws(() => t.arrivalSpan(h, 3, 'throws', () => { throw Error('expected'); }));
assert.equal(t.snapshotArrivalCapture().dropped, 953);
const p = load(false); p.startArrivalCapture(); assert.equal(p.beginArrival({}, 'production'), undefined);
assert.equal(p.snapshotArrivalCapture(), undefined); assert.equal(p.arrivalSpan(undefined, 0, 'work', () => 42), 42);
console.log('arrival correlation, stale capture/layers, saturation, inclusive accounting and production guards passed');

const { execFileSync } = require('node:child_process');
const plan = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'profile-lyrics-arrival.cjs'), '--plan']));
assert.equal(plan.matrix.length, 12);
assert.equal(new Set(plan.matrix.map(row => JSON.stringify(row))).size, 12);
assert.equal(plan.actualPresentation, 'unavailable');
console.log('native baseline runner matrix passed (no hardware timing measured)');

const rev1 = t.publishArrival({}, 'source-one', h), rev2 = t.publishArrival({}, 'source-two', h);
assert.notEqual(rev1.packet, rev2.packet);
assert.equal(rev1.parentPacket, h.packet); assert.equal(rev2.source, 'source-two');
console.log('same-input publication revisions and source ownership passed');

const countTrace = load(true);
const metadata = { runId: 'local-test', variant: 'baseline', sourceSha: 'a'.repeat(40), fixtureSha: 'b'.repeat(40),
  instrumentationSha: 'c'.repeat(40), configuration: 'spicy-portrait', scenario: 'cold' };
assert.equal(countTrace.exportArrivalCounters(metadata), undefined);
countTrace.startArrivalCapture();
const hc = countTrace.beginArrival({}, 'fixture');
countTrace.arrivalSpan(hc, 1, 'glyph-shaping', () => {});
countTrace.arrivalCounter(hc, 'paragraphBuilds');
countTrace.arrivalCounter(hc, 'voiceRenders');
for (let i = 0; i < 2200; i++) countTrace.arrivalEvent(hc, 1, 'filler');
countTrace.arrivalSpan(hc, 1, 'glyph-shaping', () => {});
const sidecar = countTrace.exportArrivalCounters(metadata);
assert.equal(sidecar.counters.shapingCalls, 2);
assert.equal(sidecar.counters.paragraphBuilds, 1);
assert.ok(sidecar.spanRecordsDropped > 0);
countTrace.startArrivalCapture(); countTrace.arrivalCounter(hc, 'voiceRenders');
assert.equal(countTrace.exportArrivalCounters(metadata).counters.voiceRenders, 0);
assert.equal(p.exportArrivalCounters(metadata), undefined);
const { compare } = require('./compare-lyrics-arrival-counts.cjs');
const candidate = { ...sidecar, variant: 'candidate', sourceSha: 'd'.repeat(40), counters: { ...sidecar.counters, shapingCalls: 3 } };
const compared = compare(sidecar, candidate);
assert.equal(compared.metrics.shapingCalls.delta, 1);
assert.equal(compared.metrics.shapingCalls.ratio, 1.5);
assert.equal(compared.metrics.cueBuilds.ratio, null);
for (const key of ['runId', 'fixtureSha', 'instrumentationSha', 'configuration', 'scenario', 'buildMode']) {
  assert.throws(() => compare(sidecar, { ...candidate, [key]: 'mismatch' }));
}
assert.throws(() => compare(sidecar, { ...candidate, counters: { ...candidate.counters, shapingCalls: -1 } }));
console.log('count sidecars, saturation-independent counters, production silence and same-run compatibility checks passed (test data only)');

const perfArtifact = { heartbeat: { samples: 10, blocksOver50Ms: 2, blocksOver100Ms: 1, maxDelayMs: 150, p50Ms: 1, p95Ms: 140 } };
assert.equal(compare(sidecar, candidate, perfArtifact, perfArtifact).legacyHeartbeat.blocksOver50Ms.delta, 0);
assert.throws(() => compare(sidecar, candidate, perfArtifact));

let clock = 0;
const timed = load(true, () => clock);
timed.startArrivalCapture();
const timedHandle = timed.beginArrival({}, 'fixture');
timed.arrivalSpan(timedHandle, 1, 'glyph-shaping', () => { clock += 60; });
assert.equal(timed.exportArrivalCounters(metadata).counters.instrumentedSpansOver50Ms, 1);
timed.arrivalSpan(timedHandle, 1, 'old-capture', () => { timed.startArrivalCapture(); clock += 60; });
assert.equal(timed.exportArrivalCounters(metadata).counters.instrumentedSpansOver50Ms, 0);
assert.throws(() => compare(sidecar, { ...candidate, counters: {} }));

const os = require('node:os');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arrival-sidecar-test-'));
try {
  const beforeFile = path.join(directory, 'baseline.json'), afterFile = path.join(directory, 'candidate.json');
  const legacyBefore = path.join(directory, 'baseline-perf.json'), legacyAfter = path.join(directory, 'candidate-perf.json');
  const output = path.join(directory, 'comparison.json');
  fs.writeFileSync(beforeFile, JSON.stringify(sidecar)); fs.writeFileSync(afterFile, JSON.stringify(candidate));
  const legacy = JSON.stringify({ ...perfArtifact, summary: { success: true }, stages: ['unchanged-contract'], custom: 'preserve' });
  fs.writeFileSync(legacyBefore, legacy); fs.writeFileSync(legacyAfter, legacy);
  const args = [path.join(__dirname, 'compare-lyrics-arrival-counts.cjs'), beforeFile, afterFile, output, legacyBefore, legacyAfter];
  execFileSync(process.execPath, args);
  assert.equal(JSON.parse(fs.readFileSync(output)).metrics.shapingCalls.delta, 1);
  assert.equal(fs.readFileSync(legacyBefore, 'utf8'), legacy);
  assert.equal(fs.readFileSync(legacyAfter, 'utf8'), legacy);
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), /Command failed/);
  console.log('comparison CLI preserves legacy artifacts and refuses output overwrite; no perf gate');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }

const { createVoiceHarness, currentCode } = require('./check-native-translation-toggle.cjs');
for (const spicy of [false, true]) {
  const trace = load(true); trace.startArrivalCapture();
  const handle = trace.beginArrival({}, 'native-hook-test');
  const harness = createVoiceHarness(currentCode, spicy, { dev: true, arrivalTrace: trace, arrivalHandle: handle });
  const voice = { words: [{ text: 'sing', starts: [0], ends: [500], weights: [4] }], paintText: 'sing',
    paintWords: [{ text: 'sing', start: 0, end: 500, offset: 0, emphasized: false, letters: ['s','i','n','g'], joined: false, gapAfter: true }],
    start: 0, end: 500, translation: 'initial translation' };
  harness.render(voice).props.onLayout({ nativeEvent: { layout: { width: 240 } } });
  harness.render(voice); harness.render(voice);
  const exported = trace.exportArrivalCounters(metadata).counters;
  assert.equal(exported.voiceRenders, 3);
  assert.equal(exported.paragraphBuilds, harness.counters.paragraphBuilds);
  assert.equal(exported.shapingCalls, harness.counters.glyphShapePasses);
}
console.log('native voice constructor/shaping/render counters match mocked native calls for both styles; no device measurement');

countTrace.arrivalSpan(hc, 1, 'glyph-shaping', () => 42);
assert.equal(countTrace.exportArrivalCounters(metadata).counters.shapingCalls, 0, 'stale spans execute work without contaminating new capture counters');
const producerHandle = countTrace.beginArrival({}, 'producer');
countTrace.arrivalEvent(producerHandle, 2, 'stage-producer-attribution', undefined, undefined, undefined, { model: 1, cues: 1 });
countTrace.snapshotArrivalCapture().records.at(-1).producers.model = 999;
assert.equal(countTrace.snapshotArrivalCapture().records.at(-1).producers.model, 1, 'snapshots cannot mutate stored producer attribution');
