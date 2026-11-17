// Gesture contract copied from native Skia (`native-lyrics-view.tsx` row
// Pressables + list takeover). Kept renderer-agnostic so it can be unit-tested.
const LONG_PRESS_MS = 540;
const DRAG_SLOP = 4;

/**
 * Follow ownership is keyed by track identity. A new song starts following
 * even when the parent still carries the previous song's manual false. Same
 * track revisions (translation, credits, layout) never reset ownership.
 * @param {{ trackId: string, resetPending: boolean }} state
 * @param {string} trackId
 * @param {boolean} followEnabled
 */
function nextFollowState(state, trackId, followEnabled) {
  if (state.trackId !== trackId) return { trackId, resetPending: true };
  if (state.resetPending && followEnabled) return { ...state, resetPending: false };
  return state;
}

/** The follow value to send for this render. A pending track reset wins over a
 * stale parent false until the parent acknowledges the new track. */
function desiredFollow(state, followEnabled) {
  return state.resetPending ? true : followEnabled;
}

/** A real touch or explicit follow false ends the new-track reset window. */
function clearFollowReset(state) {
  return state.resetPending ? { ...state, resetPending: false } : state;
}

/**
 * @param {{
 *   hitTest: (y: number, x: number) => number | Promise<number>,
 *   scrollBy: (dy: number) => void,
 *   fling: (velocity: number) => void,
 *   setFollowing: (following: boolean) => void,
 *   tapEnabled: () => boolean,
 *   onFooterPress?: (target: number) => void,
 *   onLinePress: (index: number) => void,
 *   onLineLongPress: (index: number) => void,
 *   onAutoFollowChange: (enabled: boolean) => void,
 *   onUserInteraction: () => void,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   now?: () => number,
 * }} options
 */
function createRustLyricsGesture({
  hitTest,
  scrollBy,
  fling = () => {},
  setFollowing = () => {},
  tapEnabled,
  onLinePress,
  onFooterPress = () => {},
  onLineLongPress,
  onAutoFollowChange,
  onUserInteraction,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => performance.now(),
}) {
  let active = null;
  let token = 0;
  const cancel = (current) => {
    if (current?.timer != null) clearTimer(current.timer);
    if (current) current.timer = null;
  };
  // Skia `takeOwnership`: the viewport belongs to the user from touch-down, even
  // if the gesture ends as a tap. A tap re-enables follow in `release`.
  // Ownership alone never starts escape grace. Native manual scroll-away
  // samples own that deadline, independently of touches and later gestures.
  const takeOwnership = () => {
    setFollowing(false);
    onAutoFollowChange(false);
    onUserInteraction();
  };
  return {
    grant(y, x = 0) {
      cancel(active);
      token += 1;
      const current = { token, index: -1, moved: false, longPressed: false, released: false, lastDy: 0, lastTime: now(), velocity: 0, timer: null, hit: null };
      active = current;
      takeOwnership();
      current.hit = Promise.resolve(hitTest(y, x))
        .then((index) => {
          if (Number.isInteger(index)) current.index = index;
          return current.index;
        })
        .catch(() => -1);
      const press = () => {
        if (current.index >= 0) {
          onLineLongPress(current.index);
        } else {
          // A slow first hit test must still select, not silently drop the hold.
          void current.hit.then((index) => { if (current.token === token && current.longPressed && index >= 0) onLineLongPress(index); });
        }
      };
      current.timer = setTimer(() => {
        if (active !== current || current.moved || current.longPressed) return;
        current.longPressed = true;
        current.timer = null;
        onUserInteraction();
        press();
      }, LONG_PRESS_MS);
    },
    move(dy) {
      if (!active) return;
      if (!active.moved && Math.abs(dy) <= DRAG_SLOP) return;
      active.moved = true;
      cancel(active);
      const delta = dy - active.lastDy;
      const stamp = now();
      const interval = Math.max(1, stamp - active.lastTime);
      // iOS keeps a trimmed velocity so a small final sample cannot erase a
      // fast flick; positive content offset means the finger moved up.
      active.velocity = active.velocity * 0.8 + (delta / interval) * 0.2;
      active.lastDy = dy;
      active.lastTime = stamp;
      // PanResponder dy grows downward; content offset grows upward.
      if (delta !== 0) scrollBy(-delta);
    },
    release() {
      if (!active) return;
      const current = active;
      active = null;
      current.released = true;
      cancel(current);
      if (current.moved) {
        fling(-current.velocity);
        return;
      }
      if (current.longPressed) return;
      // A fast tap can release before the native hit test resolves; finish the
      // press when it lands instead of dropping the seek. A tap outside every
      // row never restores follow (Skia only presses actual rows).
      const press = (index) => {
        if (current.token !== token || index === -1) return;
        if (index <= -2 && index >= -4) {
          onUserInteraction();
          onFooterPress(index);
          return;
        }
        if (index < 0) return;
        setFollowing(true);
        onAutoFollowChange(true);
        onUserInteraction();
        if (tapEnabled()) onLinePress(index);
      };
      if (current.index !== -1) press(current.index);
      else void current.hit.then(press);
    },
    terminate() {
      token += 1;
      if (!active) return;
      const current = active;
      cancel(current);
      active = null;
      // Ending outside the content still rebounds instead of stranding the
      // rubber band when the surface is torn down mid-drag.
      if (current.moved) fling(0);
    },
    isActive() {
      return active !== null;
    },
    get token() {
      return token;
    },
  };
}

module.exports = { LONG_PRESS_MS, DRAG_SLOP, createRustLyricsGesture, nextFollowState, desiredFollow, clearFollowReset };
