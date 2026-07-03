type IntlSegmenterConstructor = new (
  locale?: string,
  options?: { granularity: "grapheme" },
) => {
  segment(input: string): Iterable<{ segment: string }>;
};

const graphemeCache = new Map<string, string[]>();

export function getGraphemes(text: string) {
  const cached = graphemeCache.get(text);
  if (cached) {
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
  return graphemes;
}

export function getGraphemeCount(text: string) {
  return getGraphemes(text).length;
}
