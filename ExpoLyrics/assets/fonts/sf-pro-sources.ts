import type { DataModule } from "@shopify/react-native-skia";

// Registers the bundled San Francisco Pro faces for BOTH renderers:
//   - the Skia TypefaceFontProvider (see lib/lyrics-skia-fonts.ts)
//   - expo-font on the RN side (see app/_layout.tsx)
// so the family name maps to the same glyphs/metrics everywhere.
//
// This starts EMPTY on purpose: Metro fails the build if `require()` points at
// a file that isn't there, so we only add the requires once the .otf files
// exist. See README.md in this folder, then:
//   1. Drop the .otf files here.
//   2. Uncomment the block below.
//   3. Set SF_PRO_ENABLED = true in constants/lyrics-typography.ts.
export const SF_PRO_SOURCES: Record<string, DataModule[]> = {
  // "SF Pro Display": [
  //   require("./SF-Pro-Display-Regular.otf"),
  //   require("./SF-Pro-Display-Bold.otf"),
  // ],
};
