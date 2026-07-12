import { useFonts } from "@shopify/react-native-skia";
import type { SkTypefaceFontProvider } from "@shopify/react-native-skia";

import { SF_PRO_SOURCES } from "@/assets/fonts/sf-pro-sources";
import { SF_PRO_ENABLED } from "@/constants/lyrics-typography";

/**
 * Font manager for the Skia lyric paragraphs.
 *
 * - SF Pro disabled → returns null. The paragraph builder then falls back to
 *   Skia's system FontMgr, which resolves the platform-native family
 *   (LYRICS_FONT_FAMILY) and, crucially, keeps system fallback for non-Latin
 *   scripts. This is the correct default.
 * - SF Pro enabled → returns a TypefaceFontProvider carrying the bundled faces
 *   so every platform renders SF Pro identically.
 *
 * `useFonts` must be called unconditionally (hook rules); with an empty source
 * map it just yields an empty provider that we ignore.
 */
export function useLyricsFontProvider(): SkTypefaceFontProvider | null {
  const provider = useFonts(SF_PRO_SOURCES);
  return SF_PRO_ENABLED ? provider : null;
}
