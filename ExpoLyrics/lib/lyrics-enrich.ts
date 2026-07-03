import type { LyricLine, LyricSyllable } from "@/types/bridge";

import { getGraphemes } from "./graphemes";

function enrichSyllable(syllable: LyricSyllable): LyricSyllable {
  if (syllable.graphemes?.length) {
    return syllable;
  }
  return {
    ...syllable,
    graphemes: getGraphemes(syllable.text),
  };
}

export function enrichLyrics(lyrics: LyricLine[]): LyricLine[] {
  return lyrics.map((line) => ({
    ...line,
    syllables: line.syllables.map(enrichSyllable),
    backgroundSyllables: line.backgroundSyllables?.map(enrichSyllable),
  }));
}
