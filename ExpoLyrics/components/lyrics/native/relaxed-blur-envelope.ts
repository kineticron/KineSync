export type BlurEnvelope = { top: number; bottom: number };
/** Screen-space envelope. Expansion is immediate; contraction only at semantic changes or rest.
 * Unknown bounds open the mask. Padding absorbs ordinary scroll/spring frames; a breach
 * expands before presentation instead of clipping protected ink during arbitrary drags/seeks.
 */
export function relaxBlurEnvelope(previous: BlurEnvelope, target: BlurEnvelope, reset: boolean, settled: boolean, padding = 96): BlurEnvelope {
  'worklet';
  if (!Number.isFinite(target.top) || !Number.isFinite(target.bottom)) return { top: -Infinity, bottom: Infinity };
  const top = target.top - padding, bottom = target.bottom + padding;
  if (reset || settled) return { top, bottom };
  return { top: Math.min(previous.top, top), bottom: Math.max(previous.bottom, bottom) };
}
