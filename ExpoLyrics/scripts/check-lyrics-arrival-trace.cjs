const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../lib/lyrics-arrival-trace.ts'), 'utf8');
function load(dev) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, __DEV__: dev, performance: { now: () => 10 }, WeakMap, Object });
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
