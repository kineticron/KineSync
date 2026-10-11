import type { NativePaintWord } from './native-lyrics-model';
import { clamp01, SPICY_GLOW, SPICY_LETTER_SCALE, SPICY_LETTER_Y, SPICY_SCALE, SPICY_Y, splineAt, stepSpicySpring, type SpringState } from './reference-motion';
type Springs = { scale: SpringState; y: SpringState; glow: SpringState };
export type WordMotion = { scale: number; y: number; glow: number; gradient: number; letters: Omit<WordMotion, 'letters'>[] };
const initial = (): Springs => { 'worklet'; return { scale: { p: 0.95, v: 0 }, y: { p: 0.01, v: 0 }, glow: { p: 0, v: 0 } }; };

export type WordSpringState = { identity: string; word: Springs; letters: Springs[]; previousPosition: number; settled: boolean };
export const initialWordSpringState = (word: NativePaintWord): WordSpringState => {
  'worklet';
  return { identity: `${word.start}:${word.end}:${word.text}`, word: initial(), letters: word.letters.map(initial), previousPosition: -1, settled: false };
};
export function advanceReferenceWordMotion(word: NativePaintWord, previous: WordSpringState, time: number, dt: number) {
  'worklet';
  const identity = `${word.start}:${word.end}:${word.text}`;
  const snap = previous.identity !== identity || previous.previousPosition < 0 || time < previous.previousPosition || Math.abs(time - previous.previousPosition) > 1000;
  const end = word.emphasized ? word.end - 250 : word.end;
  const p = clamp01((time - word.start) / Math.max(1, end - word.start));
  const step = (s: Springs, scale: number, y: number, glow: number): Springs => {
    'worklet';
    return snap ? { scale: { p: scale, v: 0 }, y: { p: y, v: 0 }, glow: { p: glow, v: 0 } }
      : { scale: stepSpicySpring(s.scale, scale, 0.88, 0.64, dt), y: stepSpicySpring(s.y, y, 1.45, 0.4, dt),
          glow: stepSpicySpring(s.glow, glow, 1.18, 0.56, dt) };
  };
  const parent = step(previous.word, splineAt(SPICY_SCALE, p), splineAt(SPICY_Y, p), splineAt(SPICY_GLOW, p));
  const letterDuration = (end - word.start) / Math.max(1, word.letters.length);
  const activeLetter = time >= word.start && time < end ? Math.min(word.letters.length - 1, Math.floor((time - word.start) / letterDuration)) : -1;
  const activeProgress = activeLetter >= 0 ? clamp01((time - word.start - activeLetter * letterDuration) / letterDuration) : 0;
  const letters: Springs[] = [];
  const letterMotion: Omit<WordMotion, 'letters'>[] = [];
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
    const next = step(previous.letters[i] ?? initial(), scale, y, glow);
    letters.push(next);
    letterMotion.push({ scale: next.scale.p, y: next.y.p * 2, glow: next.glow.p,
      gradient: notSung ? -0.2 : sung ? 1 : i === activeLetter ? -0.2 + 1.2 * Math.sin(activeProgress * Math.PI / 2) : -0.2 });
  }
  const settled = [parent, ...letters].every(s => s.scale.v === 0 && s.y.v === 0 && s.glow.v === 0);
  return { state: { identity, word: parent, letters, previousPosition: time, settled },
    motion: { scale: parent.scale.p, y: parent.y.p, glow: parent.glow.p, gradient: -0.2 + 1.2 * p, letters: letterMotion } };
}
