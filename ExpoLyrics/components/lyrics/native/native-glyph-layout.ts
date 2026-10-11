import type { SkPoint, SkRect } from '@shopify/react-native-skia';

/** Keep ink intersecting a layout slice; a ligature may be painted in two clipped slices. */
export function selectGlyphSlice(run: { glyphs: number[]; positions: SkPoint[]; bounds: SkRect[]; origin: SkPoint }, rects: SkRect[]) {
  const glyphs: number[] = [];
  const positions: SkPoint[] = [];
  run.glyphs.forEach((glyph, index) => {
    const x = run.origin.x + run.positions[index].x;
    const y = run.origin.y + run.positions[index].y;
    const ink = run.bounds[index];
    if (rects.some(rect => x + ink.x < rect.x + rect.width && x + ink.x + ink.width > rect.x &&
      y + ink.y < rect.y + rect.height && y + ink.y + ink.height > rect.y)) {
      glyphs.push(glyph);
      positions.push({ x, y });
    }
  });
  return { glyphs, positions };
}
