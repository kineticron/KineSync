import type { LyricLine, LyricSyllable } from '@/types/bridge';
export const ARRIVAL_LAB_WORKLOAD = 'synthetic-paused-delayed-arrival-initialized-host-v2';
/** Bounded synthetic complexity, not captured provider data or a fidelity oracle. */
export function buildArrivalFixture(overlap: boolean): LyricLine[] {
  const phrases = [
    ['A ', 'long ', 'melody ', 'crosses ', 'the ', 'night ', 'with ', 'many ', 'voices'],
    ['你', '好 ', '世', '界 ', '歌', '声'], ['مرحبا ', 'بالعالم ', 'من ', 'جديد'],
    ['of', 'fice ', 'af', 'fluent ', '👩🏽‍🚀 ', 'hearts ', '❤️'], ['नमस्ते ', 'दुनिया ', 'また ', '会おう'],
  ];
  const syllables = (parts: string[], start: number, duration: number): LyricSyllable[] => parts.map((text, i) => ({
    text, startTime: start + duration * i / parts.length, endTime: start + duration * (i + 1) / parts.length,
  }));
  return Array.from({ length: 100 }, (_, index) => {
    const start = index * 2000, end = start + (overlap ? 8000 : 1800);
    const parts = index % 7 === 0 ? [...phrases[0], ...phrases[3]] : phrases[index % phrases.length];
    const backgrounds = index % 4 === 0 ? [0, 1].map(offset => ({ lineStartTime: start + offset * 300,
      lineEndTime: end + offset * 600, syllables: syllables(['echo ', 'harmony ', '声'], start + offset * 300, end - start) })) : [];
    return { lineStartTime: start, lineEndTime: end, syllables: syllables(parts, start, 1800), oppositeAligned: index % 5 === 0,
      ...(index % 3 === 0 ? { translatedText: 'A translated phrase with its own wrapping and line height' } : {}),
      ...(backgrounds.length ? { spicyBackgrounds: backgrounds, backgroundSyllables: backgrounds[0].syllables,
        backgroundTranslatedText: 'Layered harmony' } : {}) };
  });
}
