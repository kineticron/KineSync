type IntlSegmenterConstructor = new (
  locale?: string,
  options?: { granularity: "grapheme" },
) => {
  segment(input: string): Iterable<{ segment: string }>;
};

const graphemeCache = new Map<string, string[]>();
const MAX_GRAPHEME_CACHE_ENTRIES = 2_000;

export function getGraphemes(text: string) {
  const cached = graphemeCache.get(text);
  if (cached) {
    graphemeCache.delete(text);
    graphemeCache.set(text, cached);
    return cached;
  }

  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: IntlSegmenterConstructor;
    }
  ).Segmenter;
  const graphemes = Segmenter
    ? Array.from(
        new Segmenter(undefined, { granularity: "grapheme" }).segment(text),
        (part) => part.segment,
      )
    : Array.from(text);

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
