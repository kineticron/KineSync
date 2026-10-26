import type { SkPoint, SkRect } from '@shopify/react-native-skia';

/** Shaping may split one syllable into fallback-font or punctuation boxes. */
export function glyphRowExtent(rect: SkRect, rects: SkRect[]) {
  'worklet';
  let left = rect.x;
  let right = rect.x + rect.width;
  for (const slice of rects) {
    // getRectsForRange uses tight font bounds, so fallback runs on the same
    // baseline can have different tops/heights. Match shapeGlyphWords' rows.
    const overlap = Math.min(slice.y + slice.height, rect.y + rect.height) - Math.max(slice.y, rect.y);
    if (overlap <= Math.min(slice.height, rect.height) / 2) continue;
    left = Math.min(left, slice.x);
    right = Math.max(right, slice.x + slice.width);
  }
  return { x: left, width: right - left };
}

/** All letters on a syllable's row share one reveal edge, even when scaled separately. */
export function amllRevealStart(rect: SkRect, syllableRects: SkRect[], advanced: number, before: number, fade: number) {
  'worklet';
  let consumed = 0;
  for (const slice of syllableRects) {
    if (Math.abs(slice.y - rect.y) < 1) return slice.x + advanced - before - consumed - fade * 2;
    consumed += slice.width;
  }
  return rect.x + advanced - before - fade * 2;
}

/** Share horizontal ligature ink, but assign each glyph to its own baseline row. */
export function selectGlyphSlice(run: { glyphs: number[]; positions: SkPoint[]; bounds: SkRect[]; origin: SkPoint; advances?: number[] }, rects: SkRect[]) {
  const glyphs: number[] = [];
  const positions: SkPoint[] = [];
  run.glyphs.forEach((glyph, index) => {
    const x = run.origin.x + run.positions[index].x;
    const y = run.origin.y + run.positions[index].y;
    const ink = run.bounds[index];
    // Ink can overhang into another syllable (notably Hangul and descenders).
    // The shaped advance owns the glyph; a multi-letter ligature can still
    // span several slices. Zero-advance combining marks retain ink selection.
    const advance = run.advances?.[index];
    const left = advance && advance > 0 ? x : x + ink.x;
    const right = advance && advance > 0 ? x + advance : x + ink.x + ink.width;
    if (rects.some(rect => y > rect.y && y <= rect.y + rect.height &&
      left < rect.x + rect.width - 0.01 && right > rect.x + 0.01 &&
      y + ink.y < rect.y + rect.height && y + ink.y + ink.height > rect.y)) {
      glyphs.push(glyph);
      positions.push({ x, y });
    }
  });
  return { glyphs, positions };
}
