// Immutable per-track/style preparation. No animation clock or per-frame JS work.
import { Segmenter } from '@formatjs/intl-segmenter';
import type { LyricLine } from '@/types/bridge';
import { buildNativeVoice, type NativeLyricsStyle } from '@/components/lyrics/native/native-lyrics-model';
import { isCJK } from '@/components/lyrics/native/amll-reference-is-cjk';
import { buildRustTrack } from './rust-lyrics-protocol';

export function prepareRustTrack(trackId: string, generation: number, lines: LyricLine[],
  style: NativeLyricsStyle, fontScale = 1, landscape = false) {
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : new Segmenter(undefined, { granularity: 'word' });
  const paints = lines.map(line => {
    const voice = buildNativeVoice(line.syllables, line.lineStartTime, line.lineEndTime, style);
    let offset = 0;
    const cjkBreaks: number[] = [];
    for (const part of segmenter.segment(voice.paintText)) {
      if (offset > 0 && part.isWordLike && Array.from(part.segment).some(isCJK)) cjkBreaks.push(offset);
      offset += part.segment.length;
    }
    return { text: voice.paintText, words: voice.paintWords.map(word => ({
      text: word.text, offset: word.offset, start: word.start, end: word.end,
      joined: word.joined, gap_after: !!word.gapAfter, group: word.group ?? null,
      graphemes: word.letters,
    })), cjk_breaks: cjkBreaks, opposite: !!line.oppositeAligned,
      duet: lines.some(row => landscape ? !row.oppositeAligned : !!row.oppositeAligned) };
  });
  return buildRustTrack(trackId, generation, lines, { settings: { style, font_scale: fontScale, landscape }, paints });
}
