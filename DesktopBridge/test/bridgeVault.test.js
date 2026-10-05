const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachBridgeVault } = require('../src/bridgeVault');
const { dispatchClientPacket, isDesktopPacket, sanitizeClientPacket } = require('../src/bridgeProtocol');

const lyrics = [{ lineStartTime: 0, lineEndTime: 5000, translatedText: 'Translation', syllables: [{ text: 'Song', startTime: 0, endTime: 5000 }] }];
const entries = Array.from({ length: 53 }, (_, i) => ({ vaultId: `spotify_${i}`, title: `Song ${i}`, artist: 'Artist', lineCount: 1, translatedLineCount: 1, entryDir: 'private-path' }));
function request(store, packet) {
  const transport = new EventEmitter();
  attachBridgeVault(transport, () => store);
  let response;
  assert.equal(dispatchClientPacket(transport, { requestId: 'request-1', ...packet }, value => { response = value; }), true);
  assert.equal(isDesktopPacket(response), true);
  assert.equal(response.requestId, 'request-1');
  return response;
}

test('desktop vault catalog supports pagination and searching without exposing paths or lyric payloads', () => {
  const store = { listEntries: () => entries };
  const first = request(store, { type: 'vault:list' });
  assert.equal(first.entries.length, 50);
  assert.equal(first.nextOffset, 50);
  assert.equal(first.total, 53);
  assert.equal(first.entries[0].entryDir, undefined);
  const second = request(store, { type: 'vault:list', offset: first.nextOffset });
  assert.equal(second.entries.length, 3);
  assert.equal(second.nextOffset, null);
  const filtered = request(store, { type: 'vault:list', query: 'song 52' });
  assert.deepEqual(filtered.entries, [{ vaultId: 'spotify_52', title: 'Song 52', artist: 'Artist', lineCount: 1, translatedLineCount: 1 }]);
});

test('desktop vault download preserves song identity, lyrics, translations, and metadata', () => {
  const full = { lyrics, manifest: { title: 'Song', artist: 'Artist', album: 'Album', durationMs: 5000, spotifyTrackId: '123', originalSource: 'ttml-import', metadata: { credits: { songwriters: ['Writer'] } } } };
  const result = request({ getEntry: id => { assert.equal(id, 'spotify_123'); return full; } }, { type: 'vault:get', vaultId: 'spotify_123' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.entry.lyrics, lyrics);
  assert.equal(result.entry.track.spotifyTrackId, '123');
  assert.equal(result.entry.track.durationMs, 5000);
  assert.deepEqual(result.entry.metadata, full.manifest.metadata);
  assert.equal(result.entry.originalSource, 'ttml-import');
});

test('desktop vault rejects traversal and reports missing entries and unavailable stores', () => {
  assert.equal(sanitizeClientPacket({ type: 'vault:get', requestId: 'x', vaultId: '../secrets' }), null);
  assert.equal(sanitizeClientPacket({ type: 'vault:list', requestId: '' }), null);
  assert.equal(request(null, { type: 'vault:list' }).ok, false);
  assert.equal(request({ getEntry: () => null }, { type: 'vault:get', vaultId: 'spotify_missing' }).ok, false);
  assert.equal(request({ getEntry: () => { throw new Error('Read failed'); } }, { type: 'vault:get', vaultId: 'spotify_missing' }).error, 'Read failed');
});
