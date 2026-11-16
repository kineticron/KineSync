// Frozen source contracts and synthetic scheduling; no device performance inference.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const baseline = 'cbb467f40e6473632b64efd04ecc483c64da9c01';
const read = p => execFileSync('git', ['show', `${baseline}:${p}`], {encoding:'utf8'});
const gpu = read('native/lyrics-renderer/src/gpu.rs');
const swift = read('ExpoLyrics/modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift');
assert.match(gpu, /queue.present\(frame\);\s*self.gpu.device.poll\(PollType::wait_indefinitely/);
assert.match(gpu, /base_color: Color::from_rgb8\(14, 12, 18\)/);
assert.match(gpu, /desired_maximum_frame_latency = 1/);
assert.match(swift, /if busy \{ busyCallbacks/);
const schedule = (limit) => {
 let completed = [], accepted = 0, blocked = 0, max = 0;
 for(let i=0;i<1200;i++) { const now=i*1000/120;
  completed=completed.filter(t=>t>now);
  if(completed.length===limit) { blocked++; continue; }
  completed.push(now+14); accepted++; max=Math.max(max,completed.length);
 }
 assert.equal(accepted+blocked,1200); assert.ok(max<=limit);
 return {accepted,blocked,maxOutstanding:max};
};
console.log(JSON.stringify({baseline,phoneReported:{requestedHz:120,callbackHz:120,hudPresentCallsFps:40,cpuEncodeMs:2.47,workerPresentWaitMs:11.44,callbacks:1990,submitted:620,busy:1370},
 synthetic14msCompletion:{one:schedule(1),two:schedule(2),note:'Independent 14ms completion model, not a measured GPU or prediction'},
 blurAtScale3:{fullResolutionPasses:4,sigmas:[7.5,18],tapsPerPixel:2*47+2*109,rgba8FullSizeTargets:6},
 defects:['worker occupied through explicit GPU wait','opaque Vello base and default opaque surface','present rate counts returned calls, not scanout']},null,2));
