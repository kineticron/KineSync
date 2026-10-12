import { calcBalancedBreaks, type ChildNodeInfo } from './amll-reference-line-break';
import type { NativePaintWord } from './native-lyrics-model';
import { Segmenter } from '@formatjs/intl-segmenter';

let segmenter: Pick<Segmenter, 'segment'> | Intl.Segmenter | undefined;

/** Match AMLL's DOM child boundaries, measuring shaped text instead of DOM elements. */
export function balanceAmllText(text: string, words: NativePaintWord[], width: number,
  measure: (start: number, end: number) => number): { text: string; words: NativePaintWord[] } {
  segmenter ??= typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : new Segmenter(undefined, { granularity: 'word' });
  const children: ChildNodeInfo[] = [];
  const starts: number[] = [];
  let cursor = 0;
  const append = (start: number, end: number) => {
    if (end <= start) return;
    const content = text.slice(start, end);
    children.push({ text: content, isSpace: /^\s+$/u.test(content), width: measure(start, end) });
    starts.push(start);
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    append(cursor, word.offset);
    let last = word;
    while (word.group !== undefined && words[i + 1]?.group === word.group) last = words[++i];
    const end = last.offset + last.text.trimEnd().length;
    append(word.offset, end);
    append(end, last.offset + last.text.length);
    cursor = last.offset + last.text.length;
  }
  append(cursor, text.length);
  const breaks = calcBalancedBreaks(children, width, text, segmenter).map(index => starts[index]);
  if (!breaks.length) return { text, words };
  // DOM whitespace collapses at a line boundary; SkParagraph preserves it
  // after an explicit newline. Replace boundary spaces instead of inserting a
  // newline in front of them, and remap all timing offsets through the edit.
  const edits = breaks.map(offset => {
    let start = offset;
    let end = offset;
    while (start > 0 && /[^\S\n]/u.test(text[start - 1])) start--;
    while (end < text.length && /[^\S\n]/u.test(text[end])) end++;
    return { start, end };
  }).filter((edit, index, all) => index === 0 || edit.start > all[index - 1].end);
  const remap = (offset: number) => {
    let delta = 0;
    for (const edit of edits) {
      if (offset < edit.start) break;
      if (offset < edit.end) return edit.start + delta + 1;
      delta += 1 - (edit.end - edit.start);
    }
    return offset + delta;
  };
  let balanced = '';
  cursor = 0;
  for (const edit of edits) { balanced += text.slice(cursor, edit.start) + '\n'; cursor = edit.end; }
  balanced += text.slice(cursor);
  return { text: balanced, words: words.map(word => ({ ...word, offset: remap(word.offset) })) };
}
