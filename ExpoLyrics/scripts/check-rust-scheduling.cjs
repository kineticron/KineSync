/* Execute the native wakeup delay and callback guards with controlled clocks.
 * Source wiring checks complement the Rust continuous-history differential.
 * This does not compile UIKit or claim phone scheduling proof. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const swift = read('../modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift');
const rust = read('../../native/lyrics-renderer/src/ffi.rs');
const header = read('../../native/lyrics-renderer/include/KineSyncLyrics.h');
const js = read('../components/lyrics/rust/rust-lyrics-view.tsx');
const cue = swift.slice(swift.indexOf('  private func scheduleCue()'), swift.indexOf('  fileprivate func tick'));
const guard = cue.match(/guard let self,([\s\S]*?)else \{ return \}/)[1];
const condition = guard.split(',').map(part => part.trim().replace(/\bnil\b/g, 'null')).join(' && ');
const current = new Function('self', 'epoch', 'revision', 'deadline', `return ${condition};`);
const delayExpression = cue.match(/let delay = ([^\n]+)/)[1]
  .replace(/\bmax\(/g, 'Math.max(').replace(/CACurrentMediaTime\(\)/g, 'now');
const delay = new Function('deadline', 'now', 'hz', `return ${delayExpression};`);
assert.ok(Math.abs(delay(10000, 9, 120) - (1 - 1 / 120)) < 1e-12);
assert.ok(Math.abs(delay(10000, 9, 60) - (1 - 1 / 60)) < 1e-12);
assert.equal(delay(10000, 12, 60), 0, 'late wakeups must use a fresh display target');

const valid = {
  session: 1, frameRevision: 2, nextCueNativeMs: 10000, cueDeadline: 10000, cueWork: {}, window: {},
  foreground: true, enabled: true, failed: false, anchor: { playing: true, rate: 1 },
};
// A cancelled work item can still reach its callback. Execute the actual Swift
// guard expression for each lifetime/input change, not just cancellation flags.
for (const change of [
  { session: 2 }, { frameRevision: 3 }, { nextCueNativeMs: 11000 },
  { cueDeadline: -1 }, { cueWork: null }, { window: null }, { foreground: false }, { enabled: false }, { failed: true },
  { anchor: { playing: false, rate: 1 } }, { anchor: { playing: true, rate: 0 } },
]) {
  const callbacks = [];
  const state = { ...valid, ...change };
  const fakeTimer = () => { if (current(state, 1, 2, 10000)) callbacks.push('render'); };
  fakeTimer();
  assert.deepEqual(callbacks, [], JSON.stringify(change));
}
assert.equal(current(valid, 1, 2, 10000), true);
assert.equal(current({ ...valid, anchor: { playing: true, rate: 0.5 } }, 1, 2, 10000), true);

const lifecycle = swift.slice(swift.indexOf('  private func lifecycle()'), swift.indexOf('  private func cancelCue()'));
assert.match(lifecycle, /\(dirty \|\| animating\)/);
const continuousGuard = lifecycle.match(/if visible[^\n]+\(dirty \|\| animating\)/)[0];
assert.doesNotMatch(continuousGuard, /anchor\?\.playing/, 'playback alone must not arm continuous drawing');
assert.match(lifecycle, /!busy && retryWork == nil && !retryBlocked \{[\s\S]*resumePending = anchor\?\.playing == true[\s\S]*scheduleCue\(\)/);
assert.match(cue, /cueWork != nil && cueDeadline == nextCueNativeMs \{ return \}/, 'at most one cue timer');
assert.match(swift, /private func markDirty\(\) \{\s*cancelCue\(\)\s*nextCueNativeMs = -1/);
assert.match(swift, /if !visible \{[^\n]*cancelCue\(\)/);
assert.match(swift, /deinit \{\s*cueWork\?\.cancel\(\)/);
assert.match(swift, /self\.frameRevision == requestedRevision, renderedGeneration == self\.generation/);
assert.match(swift, /if result != 0 && resumeStepMs > 0 \{ self\.resumePending = true \}/);
assert.match(swift, /kr_render\(self.handle, frameTarget, sampled, resumeStepMs\)/);
assert.match(swift, /kr_abi_version\(\) == 10/);
assert.match(js, /api\.abiVersion\(\) !== 10/);
assert.match(rust, /fn kr_abi_version\(\) -> u32 \{\s*10/);
assert.match(header, /double next_cue_native_ms;\s*uint32_t visible_changes;/);
assert.match(header, /kr_render\([^;]+double resume_step_ms\);/);
console.log('Rust idle scheduling PASS: native wake delay/guards, stale timer rejection, lifecycle cancellation, resume step and ABI10 wiring. UIKit compilation/device cadence remain separate.');
