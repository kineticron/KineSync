export type AmllFloatClock = { active: boolean; releasePosition: number; elapsed: number };
export function advanceAmllFloatClock(previous: AmllFloatClock, active: boolean, position: number, dtMs: number): AmllFloatClock {
  'worklet';
  if (active) return { active: true, releasePosition: position, elapsed: 0 };
  // WAAPI disable() reverses from the actual animation time at wall-clock speed,
  // even when playback is paused. A freshly mounted inactive line stays at rest.
  return { active: false, releasePosition: previous.releasePosition,
    elapsed: previous.active ? dtMs : previous.elapsed + dtMs };
}
export function amllWordFloatPosition(clock: AmllFloatClock, position: number, start: number, end: number) {
  'worklet';
  if (clock.active) return position;
  return Math.min(clock.releasePosition, start + Math.max(1000, end - start)) - clock.elapsed;
}
