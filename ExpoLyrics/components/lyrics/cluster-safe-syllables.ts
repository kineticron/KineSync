import { getGraphemes } from "../../lib/graphemes";

type TimedSyllable = {
  text?: string;
  startTime?: number;
  endTime?: number;
  isPartOfWord?: boolean;
};

/**
 * A provider's timing boundary must not become a shaping boundary inside a
 * character. Segment the complete text before building individual DOM boxes.
 * Only tokens touching an unsafe boundary are combined; safe tokens and their
 * timestamps remain unchanged. A repaired token spans the original timing
 * windows and inherits the last fragment's word-boundary flag. Input is never
 * mutated, so source timing remains available to the host.
 */
export function repairSyllableClusters<T extends TimedSyllable>(syllables: T[]): T[] {
  if (syllables.length < 2) return syllables;
  const text = syllables.map((part) => String(part.text || "")).join("");
  const boundaries = new Set<number>([0]);
  let offset = 0;
  for (const grapheme of getGraphemes(text)) {
    offset += grapheme.length;
    boundaries.add(offset);
  }

  const repaired: T[] = [];
  offset = 0;
  let pending: T | undefined;
  syllables.forEach((part, index) => {
    if (pending) {
      const starts = [pending.startTime, part.startTime].filter(Number.isFinite) as number[];
      const ends = [pending.endTime, part.endTime].filter(Number.isFinite) as number[];
      pending = {
        ...pending,
        text: String(pending.text || "") + String(part.text || ""),
        startTime: starts.length ? Math.min(...starts) : undefined,
        endTime: ends.length ? Math.max(...ends) : undefined,
        isPartOfWord: part.isPartOfWord,
      };
    } else {
      pending = part;
    }
    offset += String(part.text || "").length;
    if (boundaries.has(offset) || index === syllables.length - 1) {
      repaired.push(pending);
      pending = undefined;
    }
  });
  return repaired;
}
