import assert from 'node:assert/strict';
import { REQUIRED_SCREENSHOTS, validateComparison } from './compare-simulator-screenshots.mjs';
const valid = () => ({ results: REQUIRED_SCREENSHOTS.map(filename => ({ filename, status: 'DIFFERENT', differenceRatio: 1, branchNonBlank: true, baselineNonBlank: true, branchWidth: filename.includes('rotation') ? 200 : 100, branchHeight: filename.includes('rotation') ? 100 : 200, baselineWidth: filename.includes('rotation') ? 200 : 100, baselineHeight: filename.includes('rotation') ? 100 : 200 })) });
assert.deepEqual(validateComparison(valid()), [], 'Valid differing screenshots must pass');
for (const mutate of [c => c.results.pop(), c => c.results[0].status = 'MISSING_IN_BRANCH', c => c.results[6].branchWidth = 50, c => c.results[0].baselineNonBlank = false]) {
 const c = valid(); mutate(c); assert.ok(validateComparison(c).length);
}
console.log('Artifact acceptance regression passed');
