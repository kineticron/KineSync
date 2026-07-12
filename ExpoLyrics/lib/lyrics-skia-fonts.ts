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
 * SF_PRO_ENABLED is a build-time setting. When it is off, no native provider
 * is created; when it is on, the app reloads with the configured hook path.
 */
export function useLyricsFontProvider(): SkTypefaceFontProvider | null {
  // Do not instantiate a native typeface provider for every lyric line when
  // custom fonts are off. The system FontMgr is the intended default path.
  if (!SF_PRO_ENABLED) {
    return null;
  }
  return useFonts(SF_PRO_SOURCES);
}
