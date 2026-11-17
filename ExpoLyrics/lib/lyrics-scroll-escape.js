const ESCAPE_GRACE_MS = 1000;

// Only input samples may authorize a return. Playback, timers, rebound and
// momentum can never manufacture an intentional reversal toward the target.
function createLyricsScrollEscape() {
  let offset = 0;
  let graceUntil = 0;
  let escaped = false;
  let returning = false;
  let inputTarget = NaN;
  return {
    get graceUntil() { return graceUntil; },
    begin(value) {
      offset = value;
      returning = false;
      inputTarget = NaN;
    },
    move(value, target, now, input = true) {
      const delta = value - offset;
      const previous = offset;
      offset = value;
      if (!Number.isFinite(target) || !Number.isFinite(delta)) {
        returning = false;
        return;
      }
      if (Math.abs(delta) < 0.5) return;
      const toward = delta * (target - previous) > 0 && Math.abs(value - target) < Math.abs(previous - target);
      if (!toward) {
        if (input && !escaped) {
          graceUntil = now + ESCAPE_GRACE_MS;
          escaped = true;
        }
        returning = false;
      } else if (input) {
        returning = true;
        inputTarget = target;
      }
    },
    release(target, radius, now, velocity = 0) {
      const resume = returning && Number.isFinite(target) &&
        Math.abs(target - inputTarget) <= 1 && Math.abs(offset - target) <= radius &&
        velocity * (offset - target) <= 0;
      returning = false;
      if (resume) { graceUntil = 0; escaped = false; }
      return resume;
    },
    reset(value = offset) {
      offset = value;
      graceUntil = 0;
      escaped = false;
      returning = false;
      inputTarget = NaN;
    },
  };
}

module.exports = { ESCAPE_GRACE_MS, createLyricsScrollEscape };
