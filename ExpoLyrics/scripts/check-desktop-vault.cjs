/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { attachBridgeVault } = require('../../DesktopBridge/src/bridgeVault');
const { dispatchClientPacket } = require('../../DesktopBridge/src/bridgeProtocol');

function load(relative, dependencies, globals = {}) {
  const context = { exports: {}, require: name => { assert.ok(name in dependencies, `Unexpected import ${name}`); return dependencies[name]; }, Date, URL, setTimeout, clearTimeout, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.exports;
}
const validation = load('lib/bridge-validation.ts', { '@/lib/artwork': { normalizeBridgeArtworkUri: value => value } });
let raw = null;
const vault = load('lib/mobile-lyrics-vault.ts', { '@react-native-async-storage/async-storage': { getItem: async () => raw, setItem: async (_, value) => { raw = value; } } });
const transport = new EventEmitter();
const lyrics = [{ lineStartTime: 0, lineEndTime: 1000, translatedText: 'Translation', syllables: [{ text: 'Test', startTime: 0, endTime: 1000 }] }];
const catalog = Array.from({ length: 53 }, (_, i) => ({ vaultId: `spotify_${i}`, title: `Song ${i}`, artist: 'Artist', lineCount: 1, translatedLineCount: 1 }));
let unavailable = false;
attachBridgeVault(transport, () => ({
  listEntries: () => catalog,
  getEntry: id => unavailable ? null : ({ lyrics, manifest: { title: catalog.find(entry => entry.vaultId === id).title, artist: 'Artist', durationMs: 1000, spotifyTrackId: id.slice(8), originalSource: 'ttml-import', metadata: { credits: { songwriters: ['Writer'] }, ttml: { content: '<tt custom="keep"><body><p>Test</p></body></tt>' } } } }),
}));
const requests = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  static current;
  constructor() { FakeSocket.current = this; }
  send(raw) {
    const packet = JSON.parse(raw);
    requests.push(packet);
    if (packet.type === 'hello') this.onmessage({ data: JSON.stringify({ type: 'hello:ack', ok: true }) });
    else dispatchClientPacket(transport, packet, reply => this.onmessage({ data: JSON.stringify(reply) }));
  }
  close() {}
}
const state = { serverUrl: 'ws://localhost:1234', handshakeKey: 'test-key', setConnectionStatus() {}, setErrorMessage() {} };
const { bridgeClient } = load('lib/bridge-client.ts', {
  '@/store/playback-store': { usePlaybackStore: { getState: () => state }, startPlaybackClock() {}, stopPlaybackClock() {} },
  '@/lib/network': { isValidBridgeKey: () => true, parseBridgeWebSocketUrl: value => value },
  '@/lib/bridge-validation': validation,
}, { WebSocket: FakeSocket });
const { transferDesktopVaultToMobile } = load('lib/desktop-vault-transfer.ts', { '@/lib/bridge-client': { bridgeClient }, '@/lib/mobile-lyrics-vault': vault });

async function main() {
  await assert.rejects(bridgeClient.browseDesktopVault(), /not connected/);
  bridgeClient.connect(); FakeSocket.current.onopen();
  const searched = await bridgeClient.browseDesktopVault('Song 52');
  assert.equal(searched.entries.length, 1);
  const progress = [];
  const result = await transferDesktopVaultToMobile((completed, total) => progress.push([completed, total]));
  assert.equal(result.transferred, 53);
  assert.equal(result.failed, 0);
  assert.deepEqual(progress.at(-1), [53, 53]);
  assert.deepEqual(requests.filter(packet => packet.type === 'vault:list' && packet.query === '').map(packet => packet.offset), [0, 50]);
  assert.equal(JSON.parse(raw).length, 53);
  const saved = JSON.parse(raw).find(entry => entry.track.spotifyTrackId === '52');
  assert.deepEqual(saved.lyrics, lyrics);
  assert.deepEqual(saved.metadata, { credits: { songwriters: ['Writer'] }, ttml: { content: '<tt custom="keep"><body><p>Test</p></body></tt>' } });
  assert.equal(saved.originalSource, 'ttml-import');
  await transferDesktopVaultToMobile(() => {});
  assert.equal(JSON.parse(raw).length, 53, 'repeated transfers update existing songs');
  catalog.push(...Array.from({ length: 52 }, (_, i) => ({ vaultId: `spotify_${i + 53}`, title: `Song ${i + 53}`, artist: 'Artist', lineCount: 1, translatedLineCount: 1 })));
  raw = null;
  const capacity = await transferDesktopVaultToMobile(() => {});
  assert.equal(capacity.transferred, 100);
  assert.equal(capacity.failed, 5);
  assert.match(capacity.error, /100 songs/);
  assert.equal(JSON.parse(raw).length, 100, 'capacity failures preserve successfully transferred songs');
  unavailable = true;
  const partial = await transferDesktopVaultToMobile(() => {});
  assert.equal(partial.transferred, 0);
  assert.equal(partial.failed, 105);
  assert.match(partial.error, /no longer available/);

  const fullPacket = { type: 'vault:get:result', requestId: 'test', ok: true, entry: { vaultId: 'spotify_1', track: { id: '1', title: 'Song', artist: 'Artist', durationMs: 1000 }, lyrics } };
  assert.ok(validation.validateInboundBridgePacket(JSON.stringify(fullPacket)));
  assert.equal(validation.validateInboundBridgePacket(JSON.stringify({ ...fullPacket, entry: { ...fullPacket.entry, lyrics: [{ ...lyrics[0], lineEndTime: -1 }] } })), null);
  assert.equal(validation.validateInboundBridgePacket(JSON.stringify({ type: 'vault:list:result', requestId: 'test', ok: true, entries: catalog, total: 53, nextOffset: null })), null);

  transport.removeAllListeners('vaultListRequested');
  const pending = bridgeClient.browseDesktopVault();
  const rejected = assert.rejects(pending, /disconnected/);
  FakeSocket.current.onclose(); bridgeClient.disconnect();
  await rejected;
  console.log('Desktop vault checks passed: validated protocol, paginated browse, transfer all regardless of search, translations/metadata, deduplication, partial failures, and disconnect cleanup.');
}
main().catch(error => { bridgeClient.disconnect(); console.error(error); process.exitCode = 1; });
