/** Native worklet ports of the bundled Spicy runtime and AMLL (AGPL-3.0-only).
 * Keep the reference's coefficients, units and spring equations, not fitted curves.
 */
import Spline from 'cubic-spline';

type Curve = { xs: number[]; ys: number[]; ks: number[] };
function curve(xs: number[], ys: number[]): Curve {
  const spline = new Spline(xs, ys) as unknown as { ks: ArrayLike<number> };
  return { xs, ys, ks: Array.from(spline.ks) };
}
export const SPICY_SCALE = curve([0, 0.7, 1], [0.95, 1.0505, 1]);
export const SPICY_LETTER_SCALE = curve([0, 0.7, 1], [0.95, 1.175, 1]);
export const SPICY_Y = curve([0, 0.9, 1], [0.01, -1 / 60, 0]);
export const SPICY_LETTER_Y = curve([0, 0.9, 1], [0.01, -1 / 56, 0]);
export const SPICY_GLOW = curve([0, 0.15, 0.6, 1], [0, 1, 1, 0]);

export function splineAt(c: Curve, x: number): number {
  'worklet';
  let i = 1;
  while (i < c.xs.length - 1 && c.xs[i] < x) i++;
  const dx = c.xs[i] - c.xs[i - 1];
  const t = (x - c.xs[i - 1]) / dx;
  const dy = c.ys[i] - c.ys[i - 1];
  const a = c.ks[i - 1] * dx - dy;
  const b = -c.ks[i] * dx + dy;
  return (1 - t) * c.ys[i - 1] + t * c.ys[i] + t * (1 - t) * (a * (1 - t) + b * t);
}

export type SpringState = { p: number; v: number };
/** Exact underdamped branch of spicy-upstream-runtime.Spring.Step. All Spicy word springs use d < 1. */
export function stepSpicySpring(s: SpringState, goal: number, frequency: number, damping: number, dt: number): SpringState {
  'worklet';
  const o = s.p - goal;
  if (s.v * s.v <= 1e-4 && o * o <= (1 / 3840) ** 2) return { p: goal, v: 0 };
  const f = frequency * 2 * Math.PI;
  const q = Math.exp(-damping * f * dt);
  const c = Math.sqrt(1 - damping * damping);
  const i = Math.cos(dt * f * c);
  const j = Math.sin(dt * f * c);
  const z = j / c;
  const y = j / (f * c);
  return { p: (o * (i + z * damping) + s.v * y) * q + goal,
    v: (s.v * (i - z * damping) - o * z * f) * q };
}

/** AMLL's solveSpring uses critical damping for its soft/overdamped branch. */
export function stepAmllSpring(s: SpringState, goal: number, mass: number, damping: number, stiffness: number, dt: number): SpringState {
  'worklet';
  const delta = goal - s.p;
  if (damping / (2 * Math.sqrt(stiffness * mass)) >= 1) {
    const f = Math.sqrt(stiffness / mass);
    const leftover = f * delta - s.v;
    const q = Math.exp(-f * dt);
    return { p: goal - (delta + dt * leftover) * q, v: (f * (delta + dt * leftover) - leftover) * q };
  }
  const df = Math.sqrt(4 * mass * stiffness - damping * damping);
  const leftover = (damping * delta - 2 * mass * s.v) / df;
  const f = 0.5 * df / mass;
  const d = -0.5 * damping / mass;
  const q = Math.exp(dt * d);
  const c = Math.cos(dt * f);
  const sin = Math.sin(dt * f);
  const displacement = delta * c + leftover * sin;
  return { p: goal - q * displacement, v: -q * (d * displacement - delta * f * sin + leftover * f * c) };
}

export function clamp01(value: number): number { 'worklet'; return Math.max(0, Math.min(1, value)); }
export function cubicBezier(x: number, x1: number, y1: number, x2: number, y2: number): number {
  'worklet';
  x = clamp01(x);
  if (x === 0 || x === 1) return x;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const t = (low + high) / 2;
    const bx = 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3;
    if (bx < x) low = t; else high = t;
  }
  const t = (low + high) / 2;
  return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3;
}

export function spicyScrollDuration(interval: number | undefined, seeking: boolean, interlude: boolean, distance: number): number {
  'worklet';
  if (seeking || interlude || interval === undefined) return 440;
  const ratio = (1 - (Math.min(800, Math.max(100, interval)) - 100) / 700) ** 0.2;
  return Math.round(Math.max(240, Math.min(440, (440 - ratio * 120) * (0.7 + 0.3 * clamp01(distance / 600)))));
}
export function spicyScrollEasing(progress: number): number { 'worklet'; return cubicBezier(progress, 0.22, 0.88, 0.34, 1); }

export function amllScrollSpring(command: { firstVisible: number; index: number; interval: number; interlude: boolean }, index: number) {
  'worklet';
  let delay = 0;
  let step = 0.05;
  for (let i = command.firstVisible; i < index; i++) {
    delay += step;
    if (i >= command.index) step /= 1.05;
  }
  const ratio = (1 - (Math.max(100, Math.min(800, command.interval)) - 100) / 700) ** 0.2;
  const stiffness = command.interlude ? 90 : 170 + ratio * 50;
  return { delay, stiffness, damping: command.interlude ? 15 : Math.sqrt(stiffness) * 2.2 };
}

export function amllFloat(position: number, start: number, end: number, background: boolean): number {
  'worklet';
  return -0.05 * (background ? 2 : 1) * cubicBezier((position - start) / Math.max(1000, end - start), 0, 0, 0.58, 1);
}
export function amllEmphasis(position: number, start: number, end: number, index: number, count: number, last: boolean, background: boolean) {
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
  const sample = (x: number) => {
    'worklet';
    return x < 0.5 ? cubicBezier(x * 2, 0.2, 0.4, 0.58, 1) : 1 - cubicBezier((x - 0.5) * 2, 0.3, 0, 0.58, 1);
  };
  const from = Math.max(1, Math.floor(t * 32));
  const to = Math.min(32, from + 1);
  const a = sample(from / 32);
  const pulse = a + (sample(to / 32) - a) * clamp01(t * 32 - from);
  const floatT = clamp01((position - delay + 400) / (duration * 1.4));
  const floatFrom = Math.max(1, Math.floor(floatT * 32));
  const floatTo = Math.min(32, floatFrom + 1);
  const floatA = Math.sin(floatFrom / 32 * Math.PI);
  const float = floatA + (Math.sin(floatTo / 32 * Math.PI) - floatA) * clamp01(floatT * 32 - floatFrom);
  return { scale: 1 + pulse * 0.1 * amount, x: -pulse * 0.03 * amount * (count / 2 - index),
    y: -pulse * 0.025 * amount - float * 0.05 * (background ? 2 : 1), glow: pulse * blur, radius: Math.min(0.3, blur * 0.3) };
}
