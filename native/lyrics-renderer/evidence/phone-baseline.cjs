// Frozen source diagnosis, not a Swift runtime or device performance benchmark.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const baseline = '4bcfe6e29c200965013b6165546d69b8e1189a50';
const read = file => execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' });
const swift = read('ExpoLyrics/modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift');
const gpu = read('native/lyrics-renderer/src/gpu.rs');
const scene = read('native/lyrics-renderer/src/scene.rs');
const player = read('ExpoLyrics/app/(tabs)/index.tsx');
const protocol = read('ExpoLyrics/lib/rust-lyrics-protocol.js');
const protocolModule = { exports: {} };
new Function('module', protocol)(protocolModule);
const { anchorChanged, projectPosition } = protocolModule.exports;
const state = { currentTrack: { id: 'song', durationMs: 10000 }, anchorPositionMs: 500, anchorMonotonicMs: 1000, isPlaying: true };
assert.equal(anchorChanged({ ...state, positionMs: 750 }, state), false);
assert.equal(anchorChanged({ ...state, isPlaying: false }, state), true);
assert.equal(projectPosition(state, 1250), 750);
assert.equal(projectPosition({ ...state, isPlaying: false }, 1250), 500);
assert.ok(swift.includes('dirty || (anchor?.playing == true && (anchor?.rate ?? 1) > 0)'));
assert.ok(!swift.includes('preferredFrameRateRange') && !swift.includes('targetTimestamp'));
assert.ok(swift.includes('queue.sync') && swift.includes('if busy { skipped &+= 1; return }'));
assert.ok(scene.includes('positions[active] = anchor'));
assert.ok(gpu.includes('self.filter.encode(') && gpu.includes('let timestamp_supported = adapter.features().contains(wanted)'));
assert.match(player, /const lyricsViewportStyle[\s\S]*?bottom: 0,/);
// Synthetic callback trace isolates counter semantics: all callbacks delivered;
// a 40ms worker rejects some, without any absent display callbacks.
let busyUntil = -1, submitted = 0, busy = 0;
for (let i = 0; i < 120; i++) {
  const now = i / 120;
  if (now < busyUntil) busy++;
  else { submitted++; busyUntil = now + 0.040; }
}
assert.equal(submitted + busy, 120);
console.log(JSON.stringify({ baseline, protocol: 'position-only ticks send no anchors; playing advances; pause freezes',
  source: { playingLoopAlreadyContinuous: true, preferredRateMissing: true, targetTimestampMissing: true,
    workerAndPresentWaits: (gpu.match(/wait_indefinitely/g) || []).length,
    mainSyncBarriers: (swift.match(/queue.sync/g) || []).length, activeLinePositionSnaps: true,
    portraitViewportExtendsToBottom: true, timestampGateDoesNotGateBlur: true },
  syntheticTrace: { callbacks: 120, submitted, busy, absentCallbacks: 0, note: 'Synthetic 40ms worker, not measured hardware' }
}, null, 2));
