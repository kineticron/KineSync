import type { NativePaintWord } from './native-lyrics-model';

/** Flex items include their trailing pseudo-element gap when choosing a row.
 * Paragraph wrapping discards trailing spaces, which incorrectly fits extra words.
 */
export function wrapSpicyText(text: string, words: NativePaintWord[], width: number, measure: (start: number, end: number) => number) {
  let output = '';
  let cursor = 0;
  let occupied = 0;
  const laidOut: NativePaintWord[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    // A word-group is an atomic flex item unless it exceeds the entire lane;
    // only an oversized group wraps its constituent syllables.
    if (word.joined && !words[index - 1]?.joined) {
      let last = index;
      while (last < words.length - 1 && words[last].joined) last++;
      const tail = words[last];
      const groupWidth = measure(word.offset, tail.offset + tail.text.length + Number(!!tail.gapAfter));
      if (groupWidth <= width && occupied > 0 && occupied + groupWidth > width + 0.01) {
        output += '\n'; occupied = 0;
      }
    }
    const end = word.offset + word.text.length + Number(!!word.gapAfter);
    const advance = measure(word.offset, end);
    output += text.slice(cursor, word.offset);
    if (occupied > 0 && occupied + advance > width + 0.01) { output += '\n'; occupied = 0; }
    laidOut.push({ ...word, offset: output.length });
    output += text.slice(word.offset, end);
    occupied += advance;
    cursor = end;
  }
  return { text: output + text.slice(cursor), words: laidOut };
}
