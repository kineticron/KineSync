import { createContext } from 'react';
import { useFonts, type SkTypefaceFontProvider } from '@shopify/react-native-skia';
import { useFonts as useNativeFonts } from 'expo-font';

const regular = require('../../../assets/fonts/SF-Pro-Display-Regular.otf');
const bold = require('../../../assets/fonts/SF-Pro-Display-Bold.otf');
const sources = { 'SF Pro Display': [regular, bold] };
const nativeSources = { 'KineSync-SF-Regular': regular, 'KineSync-SF-Bold': bold };

export const NativeLyricsFontContext = createContext<SkTypefaceFontProvider | null>(null);

// Load once per renderer, rather than creating a font provider for every row.
export function useNativeLyricsFonts() {
  useNativeFonts(nativeSources);
  return useFonts(sources);
}
