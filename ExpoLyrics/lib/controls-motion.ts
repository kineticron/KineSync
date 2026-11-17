/** Shared UI-thread stage mapping. Reversing progress reverses the reveal order. */
export function controlsStage(progress: number, start: number, end: number) {
  'worklet';
  const localProgress = Math.max(0, Math.min(1, (progress - start) / (end - start)));
  const eased = localProgress === 1 ? 1 : 1 - Math.pow(2, -10 * localProgress);
  return { opacity: eased, transform: [{ translateY: 36 * (1 - eased) }] };
}

/** Unknown initial lifecycle state must not strand the idle policy. */
export function controlsAppIsForeground(state: string | null) {
  return state !== 'background' && state !== 'inactive';
}

/** UI-thread eligibility for the visible intersection of a measured row. */
export function controlsRowIsExposed(
  progress: number, start: number, end: number,
  top: number, height: number, clipTop: number, viewportBottom: number,
) {
  'worklet';
  const stage = controlsStage(progress, start, end);
  const translatedTop = top + stage.transform[0].translateY;
  return height > 0 && stage.opacity > 0 &&
    translatedTop + height > clipTop && translatedTop < viewportBottom;
}

/** Gesture-handler may receive native events outside a clipped ancestor. */
export function controlsTouchIsCovered(
  absoluteY: number, coverage?: { top: number; bottom: number; originY: number },
) {
  'worklet';
  return !coverage || (absoluteY >= coverage.originY + coverage.top &&
    absoluteY < coverage.originY + coverage.bottom);
}

/** Advance show slightly ahead of the row clock, retaining its exact finish. */
export function controlsShowEdge(progress: number) {
  'worklet';
  const local = Math.max(0, Math.min(1, progress));
  return local + 0.24 * local * (1 - local);
}
