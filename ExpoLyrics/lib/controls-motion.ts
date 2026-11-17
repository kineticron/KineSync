/** Shared UI-thread stage mapping. Reversing progress reverses the reveal order. */
export function controlsStage(progress: number, start: number, end: number) {
  'worklet';
  const opacity = Math.max(0, Math.min(1, (progress - start) / (end - start)));
  return { opacity, transform: [{ translateY: 8 * (1 - opacity) }] };
}
