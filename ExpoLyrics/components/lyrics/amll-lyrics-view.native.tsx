/* eslint-disable @typescript-eslint/no-require-imports */
import type { ComponentType } from 'react';
import type { NativeLyricsViewProps } from './native/native-lyrics-view';

// Native is the default; explicitly set 0 to use the WebView reference.
export const AmllLyricsView: ComponentType<NativeLyricsViewProps> = process.env.EXPO_PUBLIC_NATIVE_LYRICS !== '0'
  ? require('./native-amll-lyrics-view').NativeAmllLyricsView
  : require('./amll-lyrics-view.tsx').AmllLyricsView;
