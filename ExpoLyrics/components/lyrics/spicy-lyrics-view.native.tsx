/* eslint-disable @typescript-eslint/no-require-imports */
import type { ComponentType } from 'react';
import type { NativeLyricsViewProps } from './native/native-lyrics-view';

// Keep the reference available while the native port's parity checklist is open.
export const SpicyLyricsView: ComponentType<NativeLyricsViewProps> = process.env.EXPO_PUBLIC_NATIVE_LYRICS === '1'
  ? require('./native-spicy-lyrics-view').NativeSpicyLyricsView
  : require('./spicy-lyrics-view.tsx').SpicyLyricsView;
