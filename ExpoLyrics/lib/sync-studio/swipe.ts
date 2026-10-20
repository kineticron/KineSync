/**
 * Slide-to-sync (like Musixmatch): a bar under the line drives a highlighter
 * across the line's characters. The whole bar always spans the whole line, so
 * a short or a long line takes the same slide. A word is synced the moment
 * the highlighter passes its last character: that ends it and starts the next.
 */

// Indic viramas join a consonant to the next one (क्ष), so they stay one character.
const JOINERS = /[्্੍્୍்్್്්္្‍]$/u;

/** User-perceived characters: base letters with their marks, conjuncts kept whole. */
export function characters(text: string): string[] {
  const clusters = String(text || '').trim().match(/\P{M}\p{M}*/gu) ?? [];
  const merged: string[] = [];
  for (const cluster of clusters) {
    if (merged.length && JOINERS.test(merged[merged.length - 1])) merged[merged.length - 1] += cluster;
    else merged.push(cluster);
  }
  return merged.filter((cluster) => cluster.trim());
}

export type ScrubPlan = { counts: number[]; starts: number[]; total: number };

/** Character counts per word and where each word begins along the line. */
export function scrubPlan(words: string[]): ScrubPlan {
  const counts = words.map((word) => Math.max(1, characters(word).length));
  const starts: number[] = [];
  let total = 0;
  for (const count of counts) { starts.push(total); total += count; }
  return { counts, starts, total };
}

/** Characters highlighted for a bar position (0..1). */
export const highlightedCharacters = (plan: ScrubPlan, progress: number) => Math.max(0, Math.min(1, progress)) * plan.total;

/**
 * The last word the highlighter has reached: the first word as soon as it
 * moves, each later word once every character of the word before it is lit.
 */
export function reachedWord(plan: ScrubPlan, lit: number) {
  if (lit <= 0) return -1;
  let reached = 0;
  for (let i = 1; i < plan.starts.length; i++) if (lit >= plan.starts[i]) reached = i;
  return reached;
}

/** The highlighter has passed the last character of the last word. */
export const lineComplete = (plan: ScrubPlan, lit: number) => plan.total > 0 && lit >= plan.total - 1e-6;

/** Left part of the bar where sliding syncs nothing, to get moving before a short first word ("I"). */
export const FREE_ZONE_PX = 36;

/**
 * Where the puck is (0..1 along the bar) for a finger. The slide is measured
 * from where the finger landed to the right edge, so the full line fits
 * whatever the landing point. It can move back as well as forward.
 */
export function barPosition(x: number, startX: number, width: number) {
  const room = Math.max(24, width - Math.min(startX, width * 0.6));
  return Math.max(0, Math.min(1, (x - startX) / room));
}

/** How much of the line is lit for a puck position: nothing inside the free zone, then the whole line. */
export function lineProgress(position: number, startX: number, width: number) {
  const room = Math.max(24, width - Math.min(startX, width * 0.6));
  const free = Math.min(0.4, FREE_ZONE_PX / room);
  return Math.max(0, Math.min(1, (position - free) / (1 - free)));
}

/** Free-zone width as a fraction of the bar for drawing, from where the finger landed. */
export function freeZoneFraction(startX: number, width: number) {
  const room = Math.max(24, width - Math.min(startX, width * 0.6));
  return Math.min(0.4, FREE_ZONE_PX / room);
}
