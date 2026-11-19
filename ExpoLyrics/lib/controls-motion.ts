/** Shared UI-thread stage mapping. Reversing progress reverses the reveal order. */
export function controlsStage(progress: number, start: number, end: number, backdropOffset = 0) {
  'worklet';
  const localProgress = Math.max(0, Math.min(1, (progress - start) / (end - start)));
  const eased = localProgress === 1 ? 1 : 1 - Math.pow(2, -10 * localProgress);
  // Row layout tops are at or below dockTop. Keeping translation at least the
  // backdrop offset puts the entire row below the mask's fully transparent edge.
  const translateY = Math.max(36 * (1 - eased), backdropOffset);
  return { opacity: eased, transform: [{ translateY }] };
}

/** Unknown initial lifecycle state must not strand the idle policy. */
export function controlsAppIsForeground(state: string | null) {
  return state !== 'background' && state !== 'inactive';
}
