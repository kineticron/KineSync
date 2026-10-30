import { buildAmllShapingWords, buildAmllWords } from '../amll-word-spacing';
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

// Row caches are scoped to shaping mode; switching renderers/static mode must
// build the corresponding source representation rather than reusing another one.
const rowModes = new WeakMap<NativeLyricRow[], { style: NativeLyricsStyle; staticLyrics: boolean }>();

/** Translation-independent geometry identity, including every source paint field. */
export function nativeScrollSourceKey(rows: NativeLyricRow[]) {
  const source = (voice: NativeVoice) => [voice.start, voice.end, voice.words, voice.paintText, voice.paintWords];
  return JSON.stringify(rows.map(row => [row.key, row.line.oppositeAligned, row.line.spicyLyricsStartTime,
    source(row.lead), row.backgrounds.map(source), row.interlude]));
}

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
    const timedGraphemeCount = (part as LyricSyllable & { timedGraphemeCount?: number }).timedGraphemeCount;
    const total = Math.max(1, Number.isFinite(timedGraphemeCount) ? Number(timedGraphemeCount) : getGraphemes(part.text).length);
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
    const sourceWords = buildAmllShapingWords(syllables, start, end);
    const chunks = chunkAndSplitLyricWords(sourceWords);
    const timedSegments = buildAmllWords(syllables, start, end);
    const emphasizes = (word: typeof sourceWords[number]) => word.endTime - word.startTime >= 1000 &&
      (isCJK(word.word) || word.word.trim().length >= 2 && word.word.trim().length <= 7);
    paintText = '';
    paintWords = [];
    const chunkRanges: { start: number; end: number; words: typeof sourceWords[number][] }[] = [];
    let rangeStart = 0;
    chunks.forEach(input => {
      const chunk = Array.isArray(input) ? input : [input];
      const text = chunk.map(word => word.word).join('');
      chunkRanges.push({ start: rangeStart, end: rangeStart + text.length, words: chunk });
      rangeStart += text.length;
    });
    // A provider timing atom cannot be split across native shaping chunks.
    // Merge only the chunk ranges it actually overlaps so text continuity and
    // the original animation interval are both retained.
    let timedOffset = 0;
    timedSegments.forEach(segment => {
      const sourceOffset = timedOffset;
      const endOffset = sourceOffset + segment.word.length;
      const overlapping = chunkRanges.flatMap((range, index) =>
        endOffset > range.start && sourceOffset < range.end ? [index] : []);
      if (overlapping.length > 1) {
        const first = overlapping[0];
        const last = overlapping.at(-1)!;
        chunkRanges.splice(first, last - first + 1, {
          start: chunkRanges[first].start,
          end: chunkRanges[last].end,
          words: chunkRanges.slice(first, last + 1).flatMap(range => range.words),
        });
      }
      timedOffset = endOffset;
    });
    let sourceOffset = 0;
    let emphasisIndex = 0;
    timedSegments.forEach(segment => {
      const segmentEnd = sourceOffset + segment.word.length;
      const group = Math.max(0, chunkRanges.findIndex(range => segmentEnd > range.start && sourceOffset < range.end));
      const range = chunkRanges[group];
      const text = range?.words.map(word => word.word).join('') ?? segment.word;
      const from = range ? Math.min(...range.words.map(word => word.startTime)) : segment.startTime;
      const to = range ? Math.max(...range.words.map(word => word.endTime)) : segment.endTime;
      const emphasized = range ? range.words.some(emphasizes) || !isCJK(text) &&
        emphasizes({ word: text, startTime: from, endTime: to }) : false;
      const letters = getGraphemes(segment.word.trim());
      const count = range?.words.reduce((sum, word) => sum + getGraphemes(word.word.trim()).length, 0) ?? letters.length;
      if (segment.word.trim()) {
        paintWords.push({ text: segment.word, offset: paintText.length, start: segment.startTime, end: segment.endTime,
          emphasized, letters, joined: false, group,
          emphasis: { start: from, end: to, index: emphasisIndex, count, last: group === chunkRanges.length - 1 } });
        emphasisIndex += letters.length;
      }
      paintText += segment.word;
      sourceOffset = segmentEnd;
      if (range && sourceOffset >= range.end) emphasisIndex = 0;
    });
  }
  return {
    start, end, translation, paintWords, paintText,
    words: style === 'amll'
      ? spicyWords(buildAmllWords(syllables, start, end).map(word => ({ text: word.word, startTime: word.startTime,
        endTime: word.endTime, timedGraphemeCount: word.timedGraphemeCount })))
      : spicyWords(syllables),
  };
}

function sameSyllables(a: LyricSyllable[] | undefined, b: LyricSyllable[] | undefined) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((part, index) => {
    const other = b[index];
    return part.text === other.text && part.startTime === other.startTime && part.endTime === other.endTime &&
      part.isPartOfWord === other.isPartOfWord && (part.graphemes === other.graphemes ||
        !!part.graphemes && !!other.graphemes && part.graphemes.length === other.graphemes.length &&
        part.graphemes.every((cluster, clusterIndex) => cluster === other.graphemes![clusterIndex]));
  });
}

function getBackgroundBlocks(line: LyricLine, style: NativeLyricsStyle) {
  return style === 'spicy' && line.spicyBackgrounds?.length
    ? line.spicyBackgrounds
    : line.backgroundSyllables?.length
      ? [{ syllables: line.backgroundSyllables,
          lineStartTime: Math.min(...line.backgroundSyllables.map(part => part.startTime)),
          lineEndTime: Math.max(...line.backgroundSyllables.map(part => part.endTime)) }]
      : [];
}

function sameBackgroundBlock(a: ReturnType<typeof getBackgroundBlocks>[number] | undefined,
  b: ReturnType<typeof getBackgroundBlocks>[number] | undefined) {
  return a === b || !!a && !!b && a.lineStartTime === b.lineStartTime && a.lineEndTime === b.lineEndTime &&
    sameSyllables(a.syllables, b.syllables);
}

function sameBackgroundBlocks(a: LyricLine, b: LyricLine) {
  const left = a.spicyBackgrounds ?? [], right = b.spicyBackgrounds ?? [];
  return left.length === right.length && left.every((block, index) => sameBackgroundBlock(block, right[index]));
}

function sameLineExceptTranslations(a: LyricLine, b: LyricLine) {
  const ignored = new Set(['translatedText', 'backgroundTranslatedText']);
  const leftKeys = Object.keys(a).filter(key => !ignored.has(key));
  const rightKeys = Object.keys(b).filter(key => !ignored.has(key));
  if (leftKeys.length !== rightKeys.length || leftKeys.some(key => !rightKeys.includes(key))) return false;
  return leftKeys.every(key => {
    if (key === 'syllables') return sameSyllables(a.syllables, b.syllables);
    if (key === 'backgroundSyllables') return sameSyllables(a.backgroundSyllables, b.backgroundSyllables);
    if (key === 'spicyBackgrounds') return sameBackgroundBlocks(a, b);
    return Object.is(a[key as keyof LyricLine], b[key as keyof LyricLine]);
  });
}

function sameLeadSource(a: LyricLine, b: LyricLine) {
  return a.lineStartTime === b.lineStartTime && a.lineEndTime === b.lineEndTime && sameSyllables(a.syllables, b.syllables);
}

function reuseVoice(previous: NativeVoice | undefined, parts: LyricSyllable[], start: number, end: number,
  style: NativeLyricsStyle, staticLyrics: boolean, translation: string | undefined) {
  if (!previous) return buildNativeVoice(staticLyrics
    ? [{ text: parts.map(part => part.text).join(''), startTime: 0, endTime: 0 }]
    : parts, staticLyrics ? 0 : start, staticLyrics ? 0 : end, staticLyrics ? 'spicy' : style, translation);
  return previous.translation === translation ? previous : { ...previous, translation };
}

/** Reuse unchanged row/voice inputs across immutable lyric packets, including translation-only clones. */
export function buildNativeRows(lyrics: LyricLine[], style: NativeLyricsStyle, staticLyrics = false,
  previousRows?: NativeLyricRow[]): NativeLyricRow[] {
  const priorMode = previousRows && rowModes.get(previousRows);
  if (priorMode?.style !== style || priorMode?.staticLyrics !== staticLyrics) previousRows = undefined;
  const previousByKey = new Map(previousRows?.map(row => [row.key, row]) ?? []);
  const rows: NativeLyricRow[] = lyrics.map((line, index) => {
    const key = `${index}:${line.lineStartTime}-${line.lineEndTime}`;
    const previous = previousByKey.get(key);
    const sameSourceLine = !!previous && sameLineExceptTranslations(previous.line, line);
    const sameTranslations = sameSourceLine && previous?.line.translatedText === line.translatedText &&
      previous.line.backgroundTranslatedText === line.backgroundTranslatedText;
    const sourceLine = sameTranslations ? previous!.line : line;
    const lead = reuseVoice(previous && sameLeadSource(previous.line, line) ? previous.lead : undefined,
      line.syllables, line.lineStartTime, line.lineEndTime, style, staticLyrics, line.translatedText);
    const blocks = getBackgroundBlocks(line, style);
    const oldBlocks = previous ? getBackgroundBlocks(previous.line, style) : [];
    const backgrounds = blocks.map((block, blockIndex) => reuseVoice(
      previous && sameBackgroundBlock(oldBlocks[blockIndex], block) ? previous.backgrounds[blockIndex] : undefined,
      block.syllables, block.lineStartTime, block.lineEndTime, style, staticLyrics, line.backgroundTranslatedText));
    const stableBackgrounds = previous && backgrounds.length === previous.backgrounds.length &&
      backgrounds.every((voice, voiceIndex) => voice === previous.backgrounds[voiceIndex]) ? previous.backgrounds : backgrounds;
    return { line: sourceLine, index, key, lead, backgrounds: stableBackgrounds,
      ...(sameTranslations ? { prior: previous } : {}) } as NativeLyricRow & { prior?: NativeLyricRow };
  });
  let coveredEnd = style === 'spicy' ? lyrics.find(line => line.spicyLyricsStartTime !== undefined)?.spicyLyricsStartTime ?? 0 : 0;
  const result: NativeLyricRow[] = [];
  for (const candidate of rows) {
    const row = candidate as NativeLyricRow & { prior?: NativeLyricRow };
    const interlude = !staticLyrics && row.lead.start - coveredEnd >= 3000
      ? { start: coveredEnd, end: row.lead.start } : undefined;
    coveredEnd = Math.max(coveredEnd, getBackgroundEndTime(row.line));
    const previous = row.prior;
    if (previous && previous.interlude?.start === interlude?.start && previous.interlude?.end === interlude?.end) {
      result.push(previous);
      continue;
    }
    result.push(interlude ? { line: row.line, index: row.index, key: row.key, lead: row.lead,
      backgrounds: row.backgrounds, interlude } : { line: row.line, index: row.index, key: row.key,
      lead: row.lead, backgrounds: row.backgrounds });
  }
  if (previousRows && result.length === previousRows.length && result.every((row, index) => row === previousRows[index])) return previousRows;
  rowModes.set(result, { style, staticLyrics });
  return result;
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
