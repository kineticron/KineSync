// Follow ownership is a single ordered command stream shared by the JS view and
// the native surfaces. Every touch, tap, parent change and track reset issues a
// fresh epoch. Native events and true commands carry that epoch so a delayed
// release cannot reclaim the viewport after a newer touch on the same song.
const { nextFollowState, desiredFollow, clearFollowReset } = require('./rust-lyrics-gesture.js');

function createRustLyricsFollow() {
  let state = { trackId: '', resetPending: true };
  let desired = true;
  let followEnabled = true;
  let epoch = 0;
  let last = null;

  return {
    sync(trackId, enabled) {
      const previousTrack = state.trackId;
      const previousEnabled = followEnabled;
      state = nextFollowState(state, trackId, enabled);
      followEnabled = enabled;
      // A new track starts following even when the parent still carries the
      // previous song's manual false. Same-track parent changes are explicit.
      if (trackId !== previousTrack || enabled !== previousEnabled) desired = desiredFollow(state, enabled);
    },
    get epoch() { return epoch; },
    get desired() { return desired; },
    get resetPending() { return state.resetPending; },
    // Follow epochs carry ownership only. They never start or extend grace.
    // Native true commands cancel grace immediately, including explicit resume.
    issue(value, generation, gesture = false) {
      epoch += 1;
      if (!value) state = clearFollowReset(state);
      desired = value;
      last = { value, epoch, generation, gesture };
      return { ...last };
    },
    // Parent/effect reconciliation uses the latest local intent, not a render
    // captured value, so an older render cannot reassert true after a new touch.
    reconcile(generation) {
      if (last && last.value === desired && last.generation === generation) return null;
      return this.issue(desired, generation);
    },
    // A ready surface replays the current intent with a fresh epoch, so a queued
    // unmount or recreate cannot restore an older ownership value.
    reassert(generation) {
      return this.issue(desired, generation);
    },
    // Native release recaptures follow only for the exact latest ownership
    // epoch. A newer touch, command or track revision makes the event stale.
    accept(ownershipEpoch, generation) {
      if (!last || ownershipEpoch !== epoch || generation !== last.generation) return false;
      desired = true;
      state = clearFollowReset(state);
      last = { value: true, epoch, generation, gesture: false };
      return true;
    },
  };
}

module.exports = { createRustLyricsFollow };
