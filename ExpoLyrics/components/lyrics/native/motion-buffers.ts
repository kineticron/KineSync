// Experimental generation-owned outputs. Equations mirror the allocating reference;
// keep strict replay parity tests whenever either implementation changes.
import type { NativePaintWord } from './native-lyrics-model';
import { clamp01, cubicBezier, SPICY_GLOW, SPICY_LETTER_SCALE, SPICY_LETTER_Y, SPICY_SCALE, SPICY_Y, splineAt, type SpringState } from './reference-motion';
import { initialWordSpringState, type WordMotion, type WordSpringState } from './reference-word-motion';
import type { AmllFloatClock } from './amll-float-clock';
type Springs = WordSpringState['word'];
export type AmllEmphasisMotion = { scale: number; x: number; y: number; glow: number; radius: number };
export type MotionBuffers = {
  words: WordSpringState[]; motions: WordMotion[]; emphasis: AmllEmphasisMotion[][];
  time: number; active: boolean; dark: number; bright: number; floatClock: AmllFloatClock; nextFloatClock: AmllFloatClock; ready: boolean; cached: boolean;
};
// Constructed once per mounted shape generation and transferred to UI ownership.
export function createMotionBuffers(words: { word: NativePaintWord; runs: unknown[] }[], spicy: boolean): MotionBuffers {
  'worklet';
  return {
    words: words.map(w => { const s = initialWordSpringState(w.word); if (!w.word.emphasized) s.letters.length = 0; return s; }),
    motions: words.map(w => ({ scale: 1, y: 0, glow: 0, gradient: 0,
      letters: spicy && w.word.emphasized ? w.word.letters.map(() => ({ scale: 1, y: 0, glow: 0, gradient: 0 })) : [] })),
    emphasis: words.map(w => !spicy && w.word.emphasized ? w.runs.map(() => ({ scale: 1, x: 0, y: 0, glow: 0, radius: 0 })) : []),
    time: -1, active: false, dark: -1, bright: -1, ready: false,
    nextFloatClock: { active: false, releasePosition: -1, elapsed: 0 },
    floatClock: { active: false, releasePosition: -1, elapsed: 0 }, cached: false,
  };
}
export function advanceFloatClockInto(clock: AmllFloatClock, previous: AmllFloatClock, active: boolean, position: number, dtMs: number) {
  'worklet';
  if (active) { clock.releasePosition = position; clock.elapsed = 0; }
  else { clock.releasePosition = previous.releasePosition; clock.elapsed = previous.active ? dtMs : previous.elapsed + dtMs; }
  clock.active = active;
}
export function stepSpicySpringInto(s: SpringState, goal: number, frequency: number, damping: number, dt: number): void {
  'worklet';
  const o = s.p - goal;
  if (s.v * s.v <= 1e-4 && o * o <= (1 / 3840) ** 2) { s.p = goal; s.v = 0; return; }
  const f = frequency * 2 * Math.PI;
  const q = Math.exp(-damping * f * dt);
  const c = Math.sqrt(1 - damping * damping);
  const i = Math.cos(dt * f * c);
  const j = Math.sin(dt * f * c);
  const z = j / c;
  const y = j / (f * c);
  const p = (o * (i + z * damping) + s.v * y) * q + goal;
  s.v = (s.v * (i - z * damping) - o * z * f) * q;
  s.p = p;
}

export function amllEmphasisInto(out: AmllEmphasisMotion, position: number, start: number, end: number, index: number, count: number, last: boolean, background: boolean) {
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
  const a = emphasisSample(from / 32);
  const pulse = a + (emphasisSample(to / 32) - a) * clamp01(t * 32 - from);
  const floatT = clamp01((position - delay + 400) / (duration * 1.4));
  const floatFrom = Math.max(1, Math.floor(floatT * 32));
  const floatTo = Math.min(32, floatFrom + 1);
  const floatA = Math.sin(floatFrom / 32 * Math.PI);
  const float = floatA + (Math.sin(floatTo / 32 * Math.PI) - floatA) * clamp01(floatT * 32 - floatFrom);
  out.scale = 1 + pulse * 0.1 * amount;
  out.x = -pulse * 0.03 * amount * (count / 2 - index);
  out.y = -pulse * 0.025 * amount - float * 0.05 * (background ? 2 : 1);
  out.glow = pulse * blur;
  out.radius = Math.min(0.3, blur * 0.3);
}

export function advanceWordMotionInto(word: NativePaintWord, previous: WordSpringState, motion: WordMotion, time: number, dt: number) {
  'worklet';
  const identity = `${word.start}:${word.end}:${word.text}`;
  const snap = previous.identity !== identity || previous.previousPosition < 0 || time < previous.previousPosition || Math.abs(time - previous.previousPosition) > 1000;
  const end = word.emphasized ? word.end - 250 : word.end;
  const p = clamp01((time - word.start) / Math.max(1, end - word.start));
  const parent = previous.word;
  stepSprings(parent, splineAt(SPICY_SCALE, p), splineAt(SPICY_Y, p), splineAt(SPICY_GLOW, p), snap, dt);
  const letterDuration = (end - word.start) / Math.max(1, word.letters.length);
  const activeLetter = time >= word.start && time < end ? Math.min(word.letters.length - 1, Math.floor((time - word.start) / letterDuration)) : -1;
  const activeProgress = activeLetter >= 0 ? clamp01((time - word.start - activeLetter * letterDuration) / letterDuration) : 0;
  const letters = previous.letters;
  const letterMotion = motion.letters;
  let settled = parent.scale.v === 0 && parent.y.v === 0 && parent.glow.v === 0;
  if (word.emphasized) for (let i = 0; i < word.letters.length; i++) {
    const letterStart = word.start + i * letterDuration;
    const sung = time >= letterStart + letterDuration;
    const notSung = time < letterStart;
    let scale = 0.95;
    let y = 0.01;
    let glow = 0;
    if (time >= end) { scale = 1; y = 0; }
    else if (activeLetter >= 0 && !notSung) {
      const distance = Math.abs(i - activeLetter);
      const falloff = 1 / (1 + distance ** 2.8);
      scale += (splineAt(SPICY_LETTER_SCALE, activeProgress) - 0.95) * falloff;
      y += (splineAt(SPICY_LETTER_Y, activeProgress) - 0.01) * falloff;
      glow = splineAt(SPICY_GLOW, activeProgress) / (1 + distance * 0.9);
    }
    const next = letters[i];
    stepSprings(next, scale, y, glow, snap, dt);
    const m = letterMotion[i];
    m.scale = next.scale.p; m.y = next.y.p * 2; m.glow = next.glow.p;
    m.gradient = notSung ? -0.2 : sung ? 1 : i === activeLetter ? -0.2 + 1.2 * Math.sin(activeProgress * Math.PI / 2) : -0.2;
    settled = settled && next.scale.v === 0 && next.y.v === 0 && next.glow.v === 0;
  }
  previous.identity = identity;
  previous.previousPosition = time;
  previous.settled = settled;
  motion.scale = parent.scale.p; motion.y = parent.y.p; motion.glow = parent.glow.p;
  motion.gradient = -0.2 + 1.2 * p;
}

function stepSprings(s: Springs, scale: number, y: number, glow: number, snap: boolean, dt: number) {
    'worklet';
    if (snap) {
      s.scale.p = scale; s.scale.v = 0;
      s.y.p = y; s.y.v = 0;
      s.glow.p = glow; s.glow.v = 0;
    } else {
      stepSpicySpringInto(s.scale, scale, 0.88, 0.64, dt);
      stepSpicySpringInto(s.y, y, 1.45, 0.4, dt);
      stepSpicySpringInto(s.glow, glow, 1.18, 0.56, dt);
    }
}

function emphasisSample(x: number) {
  'worklet';
  return x < 0.5 ? cubicBezier(x * 2, 0.2, 0.4, 0.58, 1) : 1 - cubicBezier((x - 0.5) * 2, 0.3, 0, 0.58, 1);
}
