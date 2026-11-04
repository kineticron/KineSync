import { createContext, useEffect, useSyncExternalStore } from 'react';
import { useFonts, type SkTypefaceFontProvider } from '@shopify/react-native-skia';
import { useFonts as useNativeFonts } from 'expo-font';

const regular = require('../../../assets/fonts/SF-Pro-Display-Regular.otf');
const bold = require('../../../assets/fonts/SF-Pro-Display-Bold.otf');
const sources = { 'SF Pro Display': [regular, bold] };
const nativeSources = { 'KineSync-SF-Regular': regular, 'KineSync-SF-Bold': bold };

export const NativeLyricsFontContext = createContext<SkTypefaceFontProvider | null>(null);

// This module owns one immutable provider for this fixed bundled asset set.
// Skia's useFonts creates a new provider per mount and does not dispose it on
// unmount. Retain the first completed provider so exact geometry can survive
// concurrent packet layers and renderer remounts. A module/asset revision gets
// a new owner; custom context providers still have separate geometry keys.
let bundledProvider: SkTypefaceFontProvider | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => bundledProvider;

// Load once per renderer, rather than creating a font provider for every row.
export function useNativeLyricsFonts() {
  useNativeFonts(nativeSources);
  const loaded = useFonts(sources);
  useEffect(() => {
    if (!bundledProvider && loaded) {
      bundledProvider = loaded;
      listeners.forEach(listener => listener());
    }
  }, [loaded]);
  return useSyncExternalStore(subscribe, snapshot, snapshot) ?? loaded;
}
