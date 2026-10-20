import { buildAmllWords } from '../amll-word-spacing';
import { repairSyllableClusters } from '../cluster-safe-syllables';
import { getGraphemes } from '../../../lib/graphemes';
import { getBackgroundEndTime } from '../../../lib/lyrics-layout';
import type { LyricLine, LyricSyllable } from '../../../types/bridge';
import { getSpicyWordJoins } from '../spicy-word-spacing';
import { chunkAndSplitLyricWords } from './amll-reference-word-split';
import { isCJK } from './amll-reference-is-cjk';
import type { NativeInterlude } from './native-interlude-motion';
import { spicyIsRtl, spicyPaintText, spicyWordOrigin } from './spicy-text-policy';

export type NativeLyricsStyle = 'amll' | 'spicy';
export type NativeWord = { text: string; starts: number[]; ends: number[]; weights: number[] };
export type NativePaintWord = { text: string; start: number; end: number; offset: number; emphasized: boolean; letters: string[]; joined: boolean; gapAfter?: boolean; origin?: number;
  group?: number; emphasis?: { start: number; end: number; index: number; count: number; last: boolean } };
export type NativeVoice = { words: NativeWord[]; paintWords: NativePaintWord[]; paintText: string; start: number; end: number; translation?: string };
export type NativeLyricRow = { line: LyricLine; index: number; key: string; lead: NativeVoice; backgrounds: NativeVoice[]; interlude?: NativeInterlude };

/** Keep a whole shaping run in one native Text. Never split an Indic cluster or Arabic word into Views. */
function spicyWords(syllables: LyricSyllable[]): NativeWord[] {
  const repaired = repairSyllableClusters(syllables);
  const flagged = repaired.some(part => typeof part.isPartOfWord === 'boolean');
  const words: NativeWord[] = [];
  let current: NativeWord = { text: '', starts: [], ends: [], weights: [] };
  const flush = () => {
    if (current.text) words.push(current);
    current = { text: '', starts: [], ends: [], weights: [] };
  };
  repaired.forEach((part, index) => {
    // Preserve literal spaces from KRC/QRC/YRC. Split only at a shaping-safe space.
    const fragments = flagged ? [part.text] : part.text.match(/\s+|\S+/gu) ?? [];
    const total = Math.max(1, getGraphemes(part.text).length);
    let offset = 0;
    fragments.forEach(fragment => {
      const count = getGraphemes(fragment).length;
      if (/^\s/u.test(fragment) && current.text && !/\s$/u.test(current.text)) {
        current.text += fragment;
        flush();
      } else {
        current.text += fragment;
        current.starts.push(part.startTime + (part.endTime - part.startTime) * offset / total);
        current.ends.push(part.startTime + (part.endTime - part.startTime) * (offset + count) / total);
        current.weights.push(count);
      }
      offset += count;
    });
    if (flagged && !part.isPartOfWord) {
      // Use the same punctuation/CJK spacing policy as the existing renderer.
      const pair = buildAmllWords([part, ...repaired.slice(index + 1, index + 2)], part.startTime, part.endTime);
      if (index < repaired.length - 1 && pair[0]?.word.endsWith(' ') && !current.text.endsWith(' ')) current.text += ' ';
      flush();
    }
  });
  flush();
  return words;
}

export function buildNativeVoice(syllables: LyricSyllable[], start: number, end: number, style: NativeLyricsStyle, translation?: string): NativeVoice {
  const parts = style === 'amll'
    ? buildAmllWords(syllables, start, end).map(word => ({ text: word.word, startTime: word.startTime, endTime: word.endTime }))
    : repairSyllableClusters(syllables).map(part => ({ ...part, text: spicyPaintText(part.text) }));
  const joins = getSpicyWordJoins(parts);
  const rtlLine = parts.some(part => spicyIsRtl(part.text));
  let offset = 0;
  let paintText = '';
  let paintWords: NativePaintWord[] = parts.map((part, index) => {
    const text = part.text;
    const letters = getGraphemes(text);
    const duration = part.endTime - part.startTime;
    const rtl = spicyIsRtl(text);
    const emphasized = !rtl && duration >= 1000 && (style === 'spicy' ||
      /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(text) || text.trim().length > 1 && text.trim().length <= 7);
    const gap = style === 'spicy' && typeof (part as LyricSyllable).isPartOfWord === 'boolean' && !joins[index] && index < parts.length - 1 && !/\s$/u.test(text) ? ' ' : '';
    const word = { text, start: part.startTime, end: Math.max(part.startTime + 1, part.endTime), offset,
      emphasized, letters, joined: joins[index], gapAfter: !!gap, origin: spicyWordOrigin(joins[index], !!joins[index - 1], rtlLine) };
    paintText += text + gap;
    offset += text.length + gap.length;
    return word;
  });
  if (style === 'amll') {
    const sourceWords = buildAmllWords(syllables, start, end);
    const chunks = chunkAndSplitLyricWords(sourceWords);
    const emphasizes = (word: typeof sourceWords[number]) => word.endTime - word.startTime >= 1000 &&
      (isCJK(word.word) || word.word.trim().length >= 2 && word.word.trim().length <= 7);
    paintText = '';
    paintWords = [];
    chunks.forEach((input, group) => {
      const chunk = Array.isArray(input) ? input : [input];
      const text = chunk.map(word => word.word).join('');
      const from = Math.min(...chunk.map(word => word.startTime));
      const to = Math.max(...chunk.map(word => word.endTime));
      const emphasized = chunk.some(emphasizes) || !isCJK(text) && emphasizes({ word: text, startTime: from, endTime: to });
      const count = chunk.reduce((sum, word) => sum + getGraphemes(word.word.trim()).length, 0);
      let index = 0;
      for (const word of chunk) {
        if (word.word.trim()) {
          const letters = getGraphemes(word.word.trim());
          paintWords.push({ text: word.word, offset: paintText.length, start: word.startTime, end: word.endTime,
            emphasized, letters, joined: false, group,
            emphasis: { start: from, end: to, index, count, last: text.includes(sourceWords.at(-1)?.word ?? '') } });
          index += letters.length;
        }
        paintText += word.word;
      }
    });
  }
  return {
    start, end, translation, paintWords, paintText,
    words: style === 'amll'
      ? spicyWords(buildAmllWords(syllables, start, end).map(word => ({ text: word.word, startTime: word.startTime, endTime: word.endTime })))
      : spicyWords(syllables),
  };
}

export function buildNativeRows(lyrics: LyricLine[], style: NativeLyricsStyle, staticLyrics = false): NativeLyricRow[] {
  const voice = (parts: LyricSyllable[], start: number, end: number, translation?: string) => staticLyrics
    ? buildNativeVoice([{ text: parts.map(part => part.text).join(''), startTime: 0, endTime: 0 }], 0, 0, 'spicy', translation)
    : buildNativeVoice(parts, start, end, style, translation);
  const rows: NativeLyricRow[] = lyrics.map((line, index) => ({
    line, index, key: `${index}:${line.lineStartTime}-${line.lineEndTime}`,
    lead: voice(line.syllables, line.lineStartTime, line.lineEndTime, line.translatedText),
    backgrounds: (style === 'spicy' && line.spicyBackgrounds?.length
      ? line.spicyBackgrounds
      : line.backgroundSyllables?.length
        ? [{ syllables: line.backgroundSyllables,
            lineStartTime: Math.min(...line.backgroundSyllables.map(part => part.startTime)),
            lineEndTime: Math.max(...line.backgroundSyllables.map(part => part.endTime)) }]
        : []).map(block => voice(block.syllables, block.lineStartTime, block.lineEndTime, line.backgroundTranslatedText)),
  }));
  let coveredEnd = style === 'spicy' ? lyrics.find(line => line.spicyLyricsStartTime !== undefined)?.spicyLyricsStartTime ?? 0 : 0;
  for (const row of rows) {
    if (!staticLyrics && row.lead.start - coveredEnd >= 3000)
      row.interlude = { start: coveredEnd, end: row.lead.start };
    coveredEnd = Math.max(coveredEnd, getBackgroundEndTime(row.line));
  }
  return rows;
}

export function nativeWordProgress(position: number, starts: number[], ends: number[], weights: number[]) {
  'worklet';
  let revealed = 0;
  let total = 0;
  for (let i = 0; i < starts.length; i++) {
    const weight = weights[i];
    total += weight;
    revealed += weight * Math.max(0, Math.min(1, (position - starts[i]) / Math.max(1, ends[i] - starts[i])));
  }
  return total ? revealed / total : 0;
}

/** During a break, follow the slot before the upcoming line rather than the passed lyric. */
export function nativeFollowIndex(rows: NativeLyricRow[], index: number, position: number) {
  const interludeIndex = rows.findIndex(row => row.interlude && position >= row.interlude.start && position < row.interlude.end);
  return interludeIndex >= 0 ? interludeIndex : index;
}
