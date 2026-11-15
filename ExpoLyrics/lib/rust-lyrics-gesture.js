// Gesture contract copied from native Skia (`native-lyrics-view.tsx` row
// Pressables + list takeover). Kept renderer-agnostic so it can be unit-tested.
const LONG_PRESS_MS = 540;
const DRAG_SLOP = 4;

/**
 * @param {{
 *   hitTest: (y: number) => number | Promise<number>,
 *   scrollBy: (dy: number) => void,
 *   setFollowing: (following: boolean) => void,
 *   tapEnabled: () => boolean,
 *   onLinePress: (index: number) => void,
 *   onLineLongPress: (index: number) => void,
 *   onAutoFollowChange: (enabled: boolean) => void,
 *   onUserInteraction: () => void,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 * }} options
 */
function createRustLyricsGesture({
  hitTest,
  scrollBy,
  setFollowing,
  tapEnabled,
  onLinePress,
  onLineLongPress,
  onAutoFollowChange,
  onUserInteraction,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
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
      token += 1;
      const current = { token, index: -1, moved: false, longPressed: false, lastDy: 0, timer: null };
      active = current;
      takeOwnership();
      current.timer = setTimer(() => {
        if (active !== current || current.moved || current.longPressed) return;
        current.longPressed = true;
        current.timer = null;
        onUserInteraction();
        if (current.index >= 0) onLineLongPress(current.index);
      }, LONG_PRESS_MS);
      Promise.resolve(hitTest(y))
        .then((index) => {
          if (active === current) current.index = Number.isInteger(index) ? index : -1;
        })
        .catch(() => {});
    },
    move(dy) {
      if (!active) return;
      if (!active.moved && Math.abs(dy) <= DRAG_SLOP) return;
      active.moved = true;
      cancel(active);
      const delta = dy - active.lastDy;
      active.lastDy = dy;
      if (delta !== 0) scrollBy(delta);
    },
    release() {
      if (!active) return;
      const current = active;
      active = null;
      cancel(current);
      if (current.moved || current.longPressed || current.index < 0) return;
      // Skia `press`: seek only when tap-to-seek is enabled, and restore follow
      // before the seek so the new anchor takes ownership of the viewport.
      setFollowing(true);
      onAutoFollowChange(true);
      onUserInteraction();
      if (tapEnabled()) onLinePress(current.index);
    },
    terminate() {
      if (!active) return;
      cancel(active);
      active = null;
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
