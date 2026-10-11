import React, { memo } from 'react';
import { NativeLyricsView, type NativeLyricsViewProps } from './native/native-lyrics-view';

/** Native AMLL candidate; opt in while visual parity and release performance are being validated. */
export const NativeAmllLyricsView = memo(function NativeAmllLyricsView(props: NativeLyricsViewProps) {
  return <NativeLyricsView {...props} style="amll" reveal="canvas" />;
});
