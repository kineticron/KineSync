/** Worklet ports of main's AMLL InterludeDotsEl and Spicy dot animator. */
import { clamp01, splineAt, stepSpicySpring, SPICY_DOT_SCALE, SPICY_DOT_Y,
  SPICY_DOT_GLOW, SPICY_DOT_OPACITY, type SpringState } from './reference-motion';

export type NativeInterlude = { start: number; end: number };

export function amllInterludeSnapshot(time: number, start: number, end: number) {
  'worklet';
  const duration = end - start;
  const elapsed = time - start;
  if (duration <= 0 || elapsed < 0 || elapsed > duration)
    return { scale: 0, dots: [0, 0, 0] };
  const breathe = duration / Math.ceil(duration / 1500);
  let scale = Math.sin(1.5 * Math.PI - elapsed / breathe * 2) / 20 + 1;
  let opacity = 1;
  if (elapsed < 2000) scale *= 1 - 2 ** (-10 * elapsed / 2000);
  if (elapsed < 500) opacity = 0;
  else if (elapsed < 1000) opacity *= (elapsed - 500) / 500;
  const remaining = duration - elapsed;
  if (remaining < 750) {
    const p = (750 - remaining) / 750 / 2;
    const c = 2.5949095;
    const ease = (2 * p) ** 2 * ((c + 1) * 2 * p - c) / 2;
    scale *= 1 - ease;
  }
  if (remaining < 375) opacity *= clamp01(remaining / 375);
  const lightingDuration = Math.max(1, duration - 750);
  return { scale: Math.max(0, scale) * 0.7,
    dots: [0, 1, 2].map(index => clamp01(opacity * Math.min(1,
      Math.max(0.25, (elapsed - lightingDuration / 3 * index) * 3 / lightingDuration * 0.75)))) };
}

export function spicyDotTiming(start: number, end: number): [number, number][] {
  'worklet';
  const duration = Math.max(1, end - start);
  const base = duration / 3;
  const padding = -550 / 3;
  const first = Math.max(start, start + base + padding);
  const second = Math.max(first, start + base * 2 + padding * 2);
  return [[start, first], [first, second], [second, Math.max(second, end - 550)]];
}

export type DotSpringState = { scale: SpringState; y: SpringState; glow: SpringState; opacity: SpringState; time: number };
export function initialDotSpringState(): DotSpringState {
  'worklet';
  return { scale: { p: 0.75, v: 0 }, y: { p: 0, v: 0 }, glow: { p: 0, v: 0 }, opacity: { p: 0.35, v: 0 }, time: -1 };
}

export function advanceSpicyDot(state: DotSpringState, time: number, start: number, end: number, dt: number): DotSpringState {
  'worklet';
  const p = clamp01((time - start) / Math.max(1, end - start));
  const snap = state.time < 0 || time < state.time - 50 || Math.abs(time - state.time) > 250;
  const step = (previous: SpringState, goal: number, frequency: number, damping: number) => {
    'worklet';
    return snap ? { p: goal, v: 0 } : stepSpicySpring(previous, goal, frequency, damping, dt);
  };
  return { scale: step(state.scale, splineAt(SPICY_DOT_SCALE, p), 0.7, 0.6),
    y: step(state.y, splineAt(SPICY_DOT_Y, p), 1.25, 0.4),
    glow: step(state.glow, splineAt(SPICY_DOT_GLOW, p), 1, 0.5),
    opacity: step(state.opacity, splineAt(SPICY_DOT_OPACITY, p), 1, 0.5), time };
}

/** CSS linear() curve from Spicy's pre-hidden dotGroup transition. */
export function spicyDotExitEasing(progress: number) {
  'worklet';
  const xs = [0, 0.094, 0.18, 0.433, 0.514, 0.559, 0.6, 0.639, 0.676, 0.723, 0.767, 0.85, 0.927, 1];
  const ys = [0, -0.006, -0.029, -0.157, -0.185, -0.189, -0.182, -0.163, -0.133, -0.074, 0.006, 0.238, 0.566, 1];
  const p = clamp01(progress);
  let i = 1;
  while (i < xs.length - 1 && xs[i] < p) i++;
  return ys[i - 1] + (ys[i] - ys[i - 1]) * (p - xs[i - 1]) / (xs[i] - xs[i - 1]);
}
