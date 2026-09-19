type IntlSegmenterConstructor = new (
  locale?: string,
  options?: { granularity: "grapheme" },
) => {
  segment(input: string): Iterable<{ segment: string }>;
};

const graphemeCache = new Map<string, string[]>();
const MAX_GRAPHEME_CACHE_ENTRIES = 2_000;

// One shared segmenter: constructing Intl.Segmenter loads ICU break data
// (~ms on mobile) and row grouping calls into this per syllable, so a fresh
// instance per cache miss freezes the JS thread while scrolling.
let sharedSegmenter:
  | { segment(input: string): Iterable<{ segment: string }> }
  | null
  | undefined;

function getSegmenter() {
  if (sharedSegmenter !== undefined) {
    return sharedSegmenter;
  }
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: IntlSegmenterConstructor;
    }
  ).Segmenter;
  sharedSegmenter = Segmenter
    ? new Segmenter(undefined, { granularity: "grapheme" })
    : null;
  return sharedSegmenter;
}

export function getGraphemes(text: string) {
  const cached = graphemeCache.get(text);
  if (cached) {
    return cached;
  }

  const segmenter = getSegmenter();
  const graphemes = segmenter
    ? Array.from(segmenter.segment(text), (part) => part.segment)
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
