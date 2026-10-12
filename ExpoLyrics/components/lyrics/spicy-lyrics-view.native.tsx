/* eslint-disable @typescript-eslint/no-require-imports */
import type { ComponentType } from 'react';
import type { NativeLyricsViewProps } from './native/native-lyrics-view';

// Native is the default; explicitly set 0 to use the WebView reference.
export const SpicyLyricsView: ComponentType<NativeLyricsViewProps> = process.env.EXPO_PUBLIC_NATIVE_LYRICS !== '0'
  ? require('./native-spicy-lyrics-view').NativeSpicyLyricsView
  : require('./spicy-lyrics-view.tsx').SpicyLyricsView;
