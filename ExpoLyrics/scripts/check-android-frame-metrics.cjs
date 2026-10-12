const assert = require('node:assert/strict');
const { collectPresentTimes, summarizePresentTimes } = require('./android-frame-metrics.cjs');
const records = new Set();
collectPresentTimes('16666666\n1 0 1\n1 9223372036854775807 1\n1 10000000 1\n1 20000000 1\n1 40000000 1', 15000000, records);
collectPresentTimes('1 20000000 1\n1 40000000 1\n1 60000000 1', 15000000, records);
assert.deepEqual(summarizePresentTimes(records, 1), { presentedFrames: 3, presentedFramesPerSecond: 3,
  presentIntervalP50Ms: 20, presentIntervalP95Ms: 20, presentIntervalP99Ms: 20 });
assert.equal(summarizePresentTimes(new Set(), 1).presentIntervalP95Ms, null, 'idle data cannot imply an animation FPS result');
console.log('Android presentation metrics checks passed: timestamp columns, pending fences, recording boundary, ring deduplication and idle samples.');
