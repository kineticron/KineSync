import { useCallback, useEffect } from 'react';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';
import type { NativePaintWord } from './native-lyrics-model';
import { advanceReferenceWordMotion, initialWordSpringState, type WordMotion } from './reference-word-motion';
export type { WordMotion } from './reference-word-motion';

/** Same frame integration, seek snapping, neighboring-letter falloff and sung settlement as Spicy. */
export function useReferenceWordMotion(word: NativePaintWord, position: SharedValue<number>, enabled: boolean) {
  const identity = `${word.start}:${word.end}:${word.text}`;
  const springs = useSharedValue(initialWordSpringState(word));
  const motion = useSharedValue<WordMotion>({ scale: 0.95, y: 0.01, glow: 0, gradient: -0.2,
    letters: word.letters.map(() => ({ scale: 0.95, y: 0.02, glow: 0, gradient: -0.2 })) });
  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    const time = position.value;
    const previous = springs.value;
    if (previous.identity === identity && time === previous.previousPosition && previous.settled) return;
    if (previous.identity === identity && previous.settled && previous.previousPosition >= 0 &&
      (time < word.start && previous.previousPosition < word.start || time > word.end && previous.previousPosition > word.end)) {
      // Keep the clock current even when no pixels change. Otherwise a word that
      // waits longer than one second mistakes normal playback for a seek.
      springs.modify(state => { state.previousPosition = time; return state; }, false);
      return;
    }
    const dt = Math.min(0.064, Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000));
    const next = advanceReferenceWordMotion(word, previous, time, dt);
    springs.value = next.state;
    motion.value = next.motion;
  }, [identity, motion, position, springs, word]), false);
  useEffect(() => { frame.setActive(enabled); return () => frame.setActive(false); }, [enabled, frame]);
  return motion;
}

