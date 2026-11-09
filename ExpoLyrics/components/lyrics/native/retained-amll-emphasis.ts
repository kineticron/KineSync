import { clamp01, cubicBezier } from './reference-motion';
export type AmllEmphasis = { scale: number; x: number; y: number; glow: number; radius: number };
function sample(x: number) {
    'worklet';
    return x < 0.5 ? cubicBezier(x * 2, 0.2, 0.4, 0.58, 1) : 1 - cubicBezier((x - 0.5) * 2, 0.3, 0, 0.58, 1);
}

// Exact reference keyframe equations with a layout-owned output cell.
export function retainedAmllEmphasis(out: AmllEmphasis, position: number, start: number, end: number, index: number, count: number, last: boolean, background: boolean) {
  'worklet';
  let duration = Math.max(1000, end - start);
  let amount = duration / 2000;
  amount = (amount > 1 ? Math.sqrt(amount) : amount ** 3) * 0.6;
  let blur = duration / 3000;
  blur = (blur > 1 ? Math.sqrt(blur) : blur ** 3) * 0.5;
  if (last) { amount *= 1.6; blur *= 1.5; duration *= 1.2; }
  amount = Math.min(1.2, amount);
  blur = Math.min(0.8, blur);
  const delay = start + duration / 2.5 / Math.max(1, count) * index;
  // Web Animations linearly interpolates the reference's 32 sampled keyframes.
  const t = clamp01((position - delay) / duration);
  const from = Math.max(1, Math.floor(t * 32));
  const to = Math.min(32, from + 1);
  const a = sample(from / 32);
  const pulse = a + (sample(to / 32) - a) * clamp01(t * 32 - from);
  const floatT = clamp01((position - delay + 400) / (duration * 1.4));
  const floatFrom = Math.max(1, Math.floor(floatT * 32));
  const floatTo = Math.min(32, floatFrom + 1);
  const floatA = Math.sin(floatFrom / 32 * Math.PI);
  const float = floatA + (Math.sin(floatTo / 32 * Math.PI) - floatA) * clamp01(floatT * 32 - floatFrom);
  out.scale = 1 + pulse * 0.1 * amount;
  out.x = -pulse * 0.03 * amount * (count / 2 - index);
  out.y = -pulse * 0.025 * amount - float * 0.05 * (background ? 2 : 1);
  out.glow = pulse * blur; out.radius = Math.min(0.3, blur * 0.3);
  return out;
}
