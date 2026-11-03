'use strict';
// Dependency audit: node builtins and the actual QQ/Kugou adapter declarations
// only. No renderer imports, network, or conversion wrappers are executed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function adapter(name, globals = {}) {
  const context = vm.createContext(globals);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/lyrics/parts', name), 'utf8'), context);
  return context;
}
test('ranked probes bound concurrency, preserve rank consumption and stop queued work', async () => {
  const context = adapter('03-qq-sources.js');
  const gates = Array.from({length:6}, deferred), starts = [];
  context.items = gates;
  context.mapper = (_, index) => { starts.push(index); return gates[index].promise; };
  const pool = vm.runInContext('createRankedProbePool(items, 2, mapper)', context);
  assert.deepEqual(starts, [0,1]);
  gates[1].resolve('lower'); await flush();
  assert.deepEqual(starts, [0,1,2]);
  let firstReady = false; pool.read(0).then(() => {firstReady = true;});
  assert.equal(await pool.read(1), 'lower'); assert.equal(firstReady, false);
  gates[0].resolve('higher'); assert.equal(await pool.read(0), 'higher');
  pool.stop(); const count = starts.length;
  gates[2].resolve('finished'); await flush();
  assert.equal(starts.length, count, 'stopping never starts queued candidates');
  assert.equal(await pool.read(5), null);
});
test('QQ starts bounded independent searches immediately and reuses first desktop query', async () => {
  const starts = [], gates = new Map();
  const context = adapter('03-qq-sources.js', {
    MAX_QUERY_VARIANTS:3, buildQueryVariants:() => ['one','two','three','four'],
    trackNeedsFeaturedVariantVerification:() => false,
  });
  context.start = (kind, query) => {
    const key = `${kind}:${query}`; starts.push(key); const gate = deferred(); gates.set(key, gate); return gate.promise;
  };
  // Replace transport boundaries only; execute real orchestration/deduplication.
  vm.runInContext(`fetchQQDesktopSearchSongs = q => start('desktop', q);
    collectQQSongsFromLegacyClientSearch = qs => Promise.all(qs.map(q => start('legacy',q))).then(xs => xs.flat());
    rankQQDirectSearchSongs = (_, songs) => songs;
    qqDirectSearchNeedsLegacySupplement = () => true;`, context);
  const result = vm.runInContext('searchQQDirectSongPool({})', context);
  assert.equal(starts.length,6); assert.equal(new Set(starts).size,6);
  assert.equal(starts.filter(key => key === 'desktop:one').length,1);
  for (const [key, gate] of gates) gate.resolve([key]);
  assert.equal((await result).ranked.length,6);
});
test('Kugou title corroboration and query variants share one operation-local request', async () => {
  const starts = [], gates = new Map();
  const context = adapter('04-kugou-source.js', {
    getSpotifyPrimaryArtist:x => x, normalizeCoreTitle:x => x,
    needsExactShortTextMatch:() => true, buildQueryVariants:() => [],
    start:q => { starts.push(q); const gate = deferred(); gates.set(q,gate); return gate.promise; },
  });
  vm.runInContext('searchKugouSongs = start', context);
  const result = vm.runInContext('collectRankedKugouSearchCandidates({title:"Song",artist:"Artist"})', context);
  assert(starts.length > 1, 'variants start before title corroboration resolves');
  assert.equal(starts.filter(q => q === 'Song Artist').length,1);
  for (const gate of gates.values()) gate.resolve({data:{info:[]}});
  assert.equal((await result).length,0);
});
