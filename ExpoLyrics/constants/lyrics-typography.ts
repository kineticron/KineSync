import { Platform } from "react-native";

// Set to true AFTER bundling the San Francisco Pro fonts (see
// assets/fonts/README.md). When enabled, both the RN <Text> fallback and the
// Skia paragraphs render SF Pro on every platform, giving pixel-identical
// lyrics on iOS and Android. When false, we fall back to each platform's native
// San Francisco / Roboto.
export const SF_PRO_ENABLED = true;

// Family name registered with expo-font (RN side) AND the Skia
// TypefaceFontProvider (Skia side). Must match the family baked into the .otf.
export const SF_PRO_FAMILY = "SF Pro Display";

// Skia's default (system) FontMgr resolves "System" on Apple platforms but does
// NOT resolve "System" on Android — it returns a tofu/fallback typeface with
// different metrics, which is what made the Skia reveal look glitched. Android
// exposes its default (Roboto) under "sans-serif", which both Skia and RN Text
// resolve identically, so the Skia paragraph and the RN fallback stay
// metric-matched on each platform.
export const LYRICS_FONT_FAMILY = SF_PRO_ENABLED
  ? SF_PRO_FAMILY
  : Platform.select({ android: "sans-serif", default: "System" }) ?? "System";

