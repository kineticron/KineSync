const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('source health probes run at bounded concurrency and retain per-provider and report order', async () => {
  const sources = ['a', 'b', 'c', 'd', 'e'];
  const pending = [];
  const activeSources = new Set();
  let maxActive = 0;
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: () => ({
    getAvailableLyricsSources: () => sources,
    getTemporarilyDisabledLyricsSources: () => [],
    normalizeLyricsSourceKey: source => source,
    probeLyricsSource: (track, source) => {
      assert.ok(!activeSources.has(source), 'one outstanding request per provider');
      activeSources.add(source);
      maxActive = Math.max(maxActive, activeSources.size);
      return new Promise(resolve => pending.push(() => {
        activeSources.delete(source);
        resolve({ ok: track.trackId === 'first' });
      }));
    },
  }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/lyricsSourceHealth.js'), 'utf8'), context);
  let done = false;
  const resultPromise = module.exports.runLyricsSourceHealthCheck({ tracks: [
    { trackId: 'first', title: 'One', artist: 'Artist' },
    { trackId: 'second', title: 'Two', artist: 'Artist' },
  ] }).then(result => { done = true; return result; });
  assert.equal(pending.length, 3, 'three providers start before any finishes');
  while (!done) {
    pending.pop()?.();
    await new Promise(resolve => setImmediate(resolve));
  }
  const report = await resultPromise;
  assert.equal(maxActive, 3);
  assert.deepEqual(Array.from(report.sourceResults, result => result.source), sources);
  for (const result of report.sourceResults) {
    assert.deepEqual(Array.from(result.trackResults, result => result.track.trackId), ['first', 'second']);
    assert.equal(result.passCount, 1);
    assert.equal(result.isHealthy, true);
  }
  assert.equal(report.allHealthy, true);
});
