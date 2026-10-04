import { splitGraphemes } from "unicode-segmenter/grapheme";

const graphemeCache = new Map<string, string[]>();
const MAX_GRAPHEME_CACHE_ENTRIES = 2_000;

export function getGraphemes(text: string) {
  const cached = graphemeCache.get(text);
  if (cached) {
    return cached;
  }

  // Bundle the same Unicode rules for Hermes and both WebViews, including
  // Indic conjuncts. Older Intl implementations and code-point fallbacks can
  // detach vowel signs, viramas, tone marks and emoji components.
  const graphemes = Array.from(splitGraphemes(text));

  graphemeCache.set(text, graphemes);
  if (graphemeCache.size > MAX_GRAPHEME_CACHE_ENTRIES) {
    const oldestKey = graphemeCache.keys().next().value;
    if (typeof oldestKey === "string") {
      graphemeCache.delete(oldestKey);
    }
  }
  return graphemes;
}

export function getGraphemeCount(text: string) {
  return getGraphemes(text).length;
}
