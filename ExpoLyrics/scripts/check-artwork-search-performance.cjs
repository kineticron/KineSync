/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const filename = path.join(__dirname, '../lib/animated-artwork.ts');
const source = fs.readFileSync(filename, 'utf8') + '\nexport { searchItunesAlbumCandidates };';
const pending = [];
const timers = new Map();
let nextId = 0;
const context = { exports: {}, URLSearchParams, AbortController,
  setTimeout: callback => { timers.set(++nextId, callback); return nextId; },
  clearTimeout: id => timers.delete(id),
  fetch: (url, { signal }) => new Promise((resolve, reject) => pending.push({ url, signal, resolve, reject })),
};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, context);
const search = context.exports.searchItunesAlbumCandidates;
const track = { artist: 'Artist', album: 'Album (Deluxe)', title: 'Song' };
(async () => {
  const resultPromise = search(track);
  assert.equal(pending.length, 3, 'all independent terms start before any finishes');
  for (let i = pending.length - 1; i >= 0; i--) {
    pending[i].resolve({ ok: true, json: async () => ({ results: [{
      collectionViewUrl: `https://music.apple.com/album/${i}`,
      collectionName: track.album, artistName: track.artist,
    }] }) });
  }
  const result = await resultPromise;
  assert.deepEqual(Array.from(result, row => row.collectionViewUrl), [
    'https://music.apple.com/album/0', 'https://music.apple.com/album/1', 'https://music.apple.com/album/2',
  ], 'completion order cannot change ranking ties');
  assert.equal(timers.size, 0);
  pending.length = 0;
  const failedPromise = search(track);
  pending[0].reject(new Error('offline'));
  assert.equal((await failedPromise).length, 0);
  assert.ok(pending.every(request => request.signal.aborted), 'one failed search cancels remaining work');
  assert.equal(timers.size, 0);
  console.log('Artwork search performance checks passed: parallel terms, deterministic ranking and failure cancellation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
