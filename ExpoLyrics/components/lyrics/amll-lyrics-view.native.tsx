/* eslint-disable @typescript-eslint/no-require-imports */
import type { ComponentType } from 'react';
import type { NativeLyricsViewProps } from './native/native-lyrics-view';

// Keep the reference available while the native port's parity checklist is open.
export const AmllLyricsView: ComponentType<NativeLyricsViewProps> = process.env.EXPO_PUBLIC_NATIVE_LYRICS === '1'
  ? require('./native-amll-lyrics-view').NativeAmllLyricsView
  : require('./amll-lyrics-view.tsx').AmllLyricsView;
