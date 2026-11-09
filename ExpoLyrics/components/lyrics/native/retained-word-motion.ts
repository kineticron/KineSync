import type { NativePaintWord } from './native-lyrics-model';
import type { WordMotion, WordSpringState } from './reference-word-motion';
import { clamp01, SPICY_GLOW, SPICY_LETTER_SCALE, SPICY_LETTER_Y, SPICY_SCALE, SPICY_Y, splineAt, type SpringState } from './reference-motion';

type Springs = WordSpringState['word'];

// Same underdamped equation and snap threshold as stepSpicySpring, writing
// into one layout-owned buffer. No frame-local spring objects or motion arrays.
function stepSpring(s: SpringState, goal: number, frequency: number, damping: number, dt: number, snap: boolean) {
  'worklet';
  const o = s.p - goal;
  if (snap || s.v * s.v <= 1e-4 && o * o <= (1 / 3840) ** 2) { s.p = goal; s.v = 0; return; }
  const f = frequency * 2 * Math.PI;
  const q = Math.exp(-damping * f * dt);
  const c = Math.sqrt(1 - damping * damping);
  const i = Math.cos(dt * f * c), j = Math.sin(dt * f * c);
  const z = j / c, y = j / (f * c);
  const p = (o * (i + z * damping) + s.v * y) * q + goal;
  s.v = (s.v * (i - z * damping) - o * z * f) * q;
  s.p = p;
}
function stepSprings(s: Springs, snap: boolean, dt: number, scale: number, y: number, glow: number) {
  'worklet';
  stepSpring(s.scale, scale, 0.88, 0.64, dt, snap);
  stepSpring(s.y, y, 1.45, 0.4, dt, snap);
  stepSpring(s.glow, glow, 1.18, 0.56, dt, snap);
}

export function advanceRetainedWordMotion(word: NativePaintWord, previous: WordSpringState, motion: WordMotion, time: number, dt: number) {
  'worklet';
  const snap = previous.previousPosition < 0 || time < previous.previousPosition || Math.abs(time - previous.previousPosition) > 1000;
  const end = word.emphasized ? word.end - 250 : word.end;
  const p = clamp01((time - word.start) / Math.max(1, end - word.start));
  stepSprings(previous.word, snap, dt, splineAt(SPICY_SCALE, p), splineAt(SPICY_Y, p), splineAt(SPICY_GLOW, p));
  const letterDuration = (end - word.start) / Math.max(1, word.letters.length);
  const activeLetter = time >= word.start && time < end ? Math.min(word.letters.length - 1, Math.floor((time - word.start) / letterDuration)) : -1;
  const activeProgress = activeLetter >= 0 ? clamp01((time - word.start - activeLetter * letterDuration) / letterDuration) : 0;
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
    const next = previous.letters[i];
    stepSprings(next, snap, dt, scale, y, glow);
    const letter = motion.letters[i];
    letter.scale = next.scale.p; letter.y = next.y.p * 2; letter.glow = next.glow.p;
    letter.gradient = notSung ? -0.2 : sung ? 1 : i === activeLetter ? -0.2 + 1.2 * Math.sin(activeProgress * Math.PI / 2) : -0.2;
  }
  let settled = previous.word.scale.v === 0 && previous.word.y.v === 0 && previous.word.glow.v === 0;
  if (word.emphasized) for (let i = 0; i < previous.letters.length; i++) {
    const s = previous.letters[i];
    settled = settled && s.scale.v === 0 && s.y.v === 0 && s.glow.v === 0;
  }
  previous.previousPosition = time; previous.settled = settled;
  motion.scale = previous.word.scale.p; motion.y = previous.word.y.p;
  motion.glow = previous.word.glow.p; motion.gradient = -0.2 + 1.2 * p;
}
