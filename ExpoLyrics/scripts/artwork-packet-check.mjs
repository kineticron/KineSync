import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { build } from 'esbuild';

const bundled = await build({
  stdin: {
    contents: [
      'export { validateInboundBridgePacket } from "./lib/bridge-validation";',
      'export { resolvePacketArtworkUrl } from "./lib/artwork";',
      'export { shouldAcceptPlaybackPacket } from "./lib/playback-source";',
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  logLevel: 'silent',
  platform: 'node',
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  bundled.outputFiles[0].text,
).toString('base64')}`;
const {
  resolvePacketArtworkUrl,
  shouldAcceptPlaybackPacket,
  validateInboundBridgePacket,
} = await import(
  moduleUrl
);

const playback = {
  type: 'playback',
  trackId: 'track-1',
  title: 'Track',
  artist: 'Artist',
  durationMs: 180_000,
  positionMs: 1_000,
  isPlaying: true,
  timestamp: Date.now(),
};
const artworkUrl = 'https://i.scdn.co/image/test-cover';
const initial = validateInboundBridgePacket(
  JSON.stringify({ ...playback, artworkUrl }),
);
const heartbeat = validateInboundBridgePacket(
  JSON.stringify({ ...playback, positionMs: 2_000 }),
);

assert(initial && initial.type === 'playback');
assert.equal(initial.artworkUrl, artworkUrl);
assert(heartbeat && heartbeat.type === 'playback');
assert.equal(
  Object.prototype.hasOwnProperty.call(heartbeat, 'artworkUrl'),
  false,
  'a heartbeat that omits artwork must not be normalized into an explicit clear',
);

assert.equal(shouldAcceptPlaybackPacket('desktop', 'desktop'), true);
assert.equal(shouldAcceptPlaybackPacket('desktop', 'mobile'), false);
assert.equal(shouldAcceptPlaybackPacket('mobile', 'mobile'), true);
assert.equal(shouldAcceptPlaybackPacket('mobile', 'desktop'), false);

assert.equal(resolvePacketArtworkUrl(initial.artworkUrl, heartbeat), artworkUrl);
assert.equal(
  resolvePacketArtworkUrl(initial.artworkUrl, { artworkUrl: '' }),
  undefined,
  'an explicit empty field used by mobile-only playback must still clear stale art',
);

console.log('Artwork packet retention regression check passed.');
