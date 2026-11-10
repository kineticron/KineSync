import type { ShapedGlyphWord } from './native-glyph-picture';
import type { WordMotion } from './reference-word-motion';
import { amllEmphasis, amllFloat, clamp01 } from './reference-motion';
import { amllWordFloatPosition, type AmllFloatClock } from './amll-float-clock';
import type { ReferenceLineMotion } from './use-reference-line-motion';

export function changedScalar(previous: number, next: number, enabled: boolean, force = false, epsilon = 0.001) {
  'worklet';
  return previous !== next && (!enabled || force || !Number.isFinite(previous) || !Number.isFinite(next) || Math.abs(next - previous) >= epsilon);
}
export function changedPresentation(previous: number[], next: number[], force: boolean) {
  'worklet';
  return force || previous.length !== next.length || next.some((value, index) => changedScalar(previous[index], value, true));
}
/** Values in reference/normalized units. Compare to the LAST PUBLISHED frame, never
 * the previous integration step, so small deltas accumulate and motion cannot freeze.
 */
export function glyphPresentation(words: ShapedGlyphWord[], motions: WordMotion[], time: number, spicy: boolean, background: boolean,
  line: ReferenceLineMotion, clock: AmllFloatClock) {
  'worklet';
  const values = [line.bright, line.dark];
  words.forEach((word, index) => {
    if (spicy) {
      const m = motions[index]; values.push(m.scale, m.y, m.glow, m.gradient);
      m.letters.forEach(letter => values.push(letter.scale, letter.y, letter.glow, letter.gradient));
    } else {
      values.push(clamp01((time - word.word.start) / Math.max(1, word.word.end - word.word.start)),
        amllFloat(amllWordFloatPosition(clock, time, word.word.start, word.word.end), word.word.start, word.word.end, background));
      if (word.word.emphasized) word.runs.forEach((_run, letter) => {
        const m = amllEmphasis(time, word.word.emphasis?.start ?? word.word.start, word.word.emphasis?.end ?? word.word.end,
          (word.word.emphasis?.index ?? 0) + letter, word.word.emphasis?.count ?? word.word.letters.length,
          word.word.emphasis?.last ?? index === words.length - 1, background);
        values.push(m.scale, m.x, m.y, m.glow, m.radius);
      });
    }
  });
  return values;
}
