export const TOP_BAR_ARTWORK_TOP = 18;
export const TOP_BAR_ARTWORK_SIZE = 56;
export const TOP_BAR_PADDING_BOTTOM = 10;
export const TOP_BAR_CONTENT_HEIGHT =
  TOP_BAR_ARTWORK_TOP + TOP_BAR_ARTWORK_SIZE + TOP_BAR_PADDING_BOTTOM;
export const LYRICS_WRAP_MARGIN_TOP = 10;

export const LANDSCAPE_FONT_SCALE = 0.9;
export const LANDSCAPE_LEFT_PANE_PADDING = 12;
export const LANDSCAPE_LYRICS_PADDING = 6;
export const LANDSCAPE_LYRICS_HORIZONTAL_INSET = 4;
/**
 * Symmetric list inset so 1.05× active-line scale and glow are not clipped in
 * landscape. Sized for ~560px-wide lyric lanes: (1.05 - 1) / 2 * 560 ≈ 14px.
 */
export const LANDSCAPE_LYRICS_EDGE_BLEED = 16;
/** Lets scaled line rows expand into {@link LANDSCAPE_LYRICS_EDGE_BLEED}. */
export const LANDSCAPE_LINE_SCALE_BLEED = 14;
/** Landscape lyric lane width — wide but leaves room to read alignment. */
export const LANDSCAPE_LYRIC_TEXT_LANE_WIDTH = "90%";
export const LANDSCAPE_VERTICAL_PADDING = 12;
export const LANDSCAPE_META_BELOW_RESERVE = 76;
export const LANDSCAPE_MAX_ARTWORK_SIZE = 248;
export const LANDSCAPE_LEFT_PANE_MAX_WIDTH_RATIO = 0.34;
export const LANDSCAPE_ACTIVE_LINE_TOP_OFFSET = 32;
export const LANDSCAPE_TOP_LIST_PADDING = 168;

export type LandscapeLayoutMetrics = {
  artworkSize: number;
  leftPaneWidth: number;
};

export function getLandscapeLayoutMetrics({
  viewportWidth,
  viewportHeight,
  safeTop,
  safeBottom,
  safeLeft = 0,
  safeRight = 0,
}: {
  viewportWidth: number;
  viewportHeight: number;
  safeTop: number;
  safeBottom: number;
  safeLeft?: number;
  safeRight?: number;
}): LandscapeLayoutMetrics {
  const availableWidth = Math.max(
    0,
    viewportWidth - safeLeft - safeRight - LANDSCAPE_LYRICS_PADDING,
  );
  const leftPaneMaxWidth = Math.floor(
    availableWidth * LANDSCAPE_LEFT_PANE_MAX_WIDTH_RATIO,
  );
  const innerPaneWidth = Math.max(
    0,
    leftPaneMaxWidth - LANDSCAPE_LEFT_PANE_PADDING * 2,
  );
  const maxArtFromHeight = Math.max(
    0,
    viewportHeight -
      safeTop -
      safeBottom -
      LANDSCAPE_VERTICAL_PADDING * 2 -
      LANDSCAPE_META_BELOW_RESERVE,
  );
  const artworkSize = Math.floor(
    Math.min(
      maxArtFromHeight,
      innerPaneWidth,
      LANDSCAPE_MAX_ARTWORK_SIZE,
    ),
  );
  const leftPaneWidth =
    safeLeft + LANDSCAPE_LEFT_PANE_PADDING * 2 + artworkSize;

  return { artworkSize, leftPaneWidth };
}

/** Shift centered lyrics notices up so they align with the physical screen center. */
export function getLyricsViewportCenterUpwardOffset(insetsTop: number) {
  return (insetsTop + TOP_BAR_CONTENT_HEIGHT + LYRICS_WRAP_MARGIN_TOP) / 2;
}

/** Landscape lyrics pane uses no top bar; center empty-state notices vertically. */
export function getLandscapeLyricsCenterUpwardOffset(insetsTop: number) {
  return insetsTop / 2;
}

export function isLandscapeLayout(width: number, height: number) {
  return width > height;
}
