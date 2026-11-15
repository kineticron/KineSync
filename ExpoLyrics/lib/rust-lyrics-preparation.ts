// Immutable per-track/style preparation. No animation clock or per-frame JS work.
import { Segmenter } from '@formatjs/intl-segmenter';
import type { LyricLine } from '@/types/bridge';
import { buildNativeVoice, type NativeLyricsStyle, type NativeVoice } from '@/components/lyrics/native/native-lyrics-model';
import { spicyIsRtl } from '@/components/lyrics/native/spicy-text-policy';
import { isCJK } from '@/components/lyrics/native/amll-reference-is-cjk';
import { buildRustTrack } from './rust-lyrics-protocol';

/** Same source blocks as native-lyrics-model.ts `getBackgroundBlocks`: Spicy keeps
 *  its per-speaker blocks, every other source uses the line's background
 *  syllables as one block. Rust renders them under the parent row voice. */
function backgroundBlocks(line: LyricLine, style: NativeLyricsStyle) {
  if (style === 'spicy' && line.spicyBackgrounds?.length) return line.spicyBackgrounds;
  const syllables = line.backgroundSyllables;
  if (!syllables?.length) return [];
  return [{ syllables,
    lineStartTime: Math.min(...syllables.map(part => part.startTime)),
    lineEndTime: Math.max(...syllables.map(part => part.endTime)) }];
}

export function prepareRustTrack(trackId: string, generation: number, lines: LyricLine[],
  style: NativeLyricsStyle, fontScale = 1, landscape = false, showTranslation = true) {
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : new Segmenter(undefined, { granularity: 'word' });
  const duet = lines.some(row => landscape ? !row.oppositeAligned : !!row.oppositeAligned);
  const edges = (voice: NativeVoice) => {
    let offset = 0;
    const cjkBreaks: number[] = [];
    for (const part of segmenter.segment(voice.paintText)) {
      if (offset > 0 && part.isWordLike && Array.from(part.segment).some(isCJK)) cjkBreaks.push(offset);
      offset += part.segment.length;
    }
    return cjkBreaks;
  };
  // Background voices keep their own interval, source word timings and text so
  // Rust can shape, wrap and fill them independently of the lead.
  const paint = (voice: NativeVoice, right: boolean) => ({ ...(voice.translation ? { translation: voice.translation } : {}),
    start: voice.start, end: voice.end, text: voice.paintText, words: voice.paintWords.map((word, index) => ({
      text: word.text, offset: word.offset, start: word.start, end: word.end,
      joined: word.joined, gap_after: !!word.gapAfter, group: word.group ?? null,
      graphemes: word.letters,
      appearance: { emphasized: word.emphasized, origin: word.origin ?? 0.5, rtl: spicyIsRtl(word.text), last: index === voice.paintWords.length - 1, emphasis: word.emphasis ?? null },
    })), cjk_breaks: edges(voice), opposite: right, duet });
  const paints = lines.map(line => paint(buildNativeVoice(line.syllables, line.lineStartTime, line.lineEndTime,
    style, showTranslation ? line.translatedText : undefined), !!line.oppositeAligned));
  const backgrounds = lines.map(line => backgroundBlocks(line, style)
    // Skia drops a block that carries no shaped word; Rust rejects an empty voice.
    .map(block => buildNativeVoice(block.syllables, block.lineStartTime, block.lineEndTime, style,
      showTranslation ? line.backgroundTranslatedText : undefined))
    .filter(voice => voice.paintWords.length > 0)
    .map(voice => paint(voice, !!line.oppositeAligned)));
  return buildRustTrack(trackId, generation, lines, { settings: { style, font_scale: fontScale, landscape }, paints, backgrounds });
}
