/** Preserve phase across routine sync packets; explicit seeks still land exactly. */
export function createSpicyPlaybackClock() {
  let anchor = 0;
  let anchorTime = 0;
  let playing = false;
  let correction = 0;
  let correctionDuration = 1000;
  const position = (now: number) => {
    const elapsed = Math.max(0, now - anchorTime);
    return Math.max(0, anchor + (playing ? elapsed : 0) +
      correction * Math.max(0, 1 - elapsed / correctionDuration));
  };
  return {
    position,
    sync(next: number, nextPlaying: boolean, now: number, force = false) {
      const previous = position(now);
      const continuous = playing && nextPlaying && !force && Math.abs(previous - next) < 1000;
      correction = continuous ? previous - next : 0;
      // Catch up/slow down by at most 10%, then return to normal speed. This
      // also converges if no more packets arrive; it never runs backward.
      correctionDuration = Math.max(1000, Math.abs(correction) * 10);
      anchor = next;
      anchorTime = now;
      playing = nextPlaying;
    },
  };
}
