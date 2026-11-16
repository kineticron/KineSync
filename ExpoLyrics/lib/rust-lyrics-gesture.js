// Gesture contract copied from native Skia (`native-lyrics-view.tsx` row
// Pressables + list takeover). Kept renderer-agnostic so it can be unit-tested.
const LONG_PRESS_MS = 540;
const DRAG_SLOP = 4;

/**
 * @param {{
 *   hitTest: (y: number) => number | Promise<number>,
 *   scrollBy: (dy: number) => void,
 *   fling: (velocity: number) => void,
 *   setFollowing: (following: boolean) => void,
 *   tapEnabled: () => boolean,
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
  const takeOwnership = () => {
    setFollowing(false);
    onAutoFollowChange(false);
    onUserInteraction();
  };
  return {
    grant(y) {
      cancel(active);
      token += 1;
      const current = { token, index: -1, moved: false, longPressed: false, released: false, lastDy: 0, lastTime: now(), velocity: 0, timer: null, hit: null };
      active = current;
      takeOwnership();
      current.hit = Promise.resolve(hitTest(y))
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
        if (current.token !== token || index < 0) return;
        setFollowing(true);
        onAutoFollowChange(true);
        onUserInteraction();
        if (tapEnabled()) onLinePress(index);
      };
      if (current.index >= 0) press(current.index);
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

module.exports = { LONG_PRESS_MS, DRAG_SLOP, createRustLyricsGesture };
