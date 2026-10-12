import React, { memo } from 'react';
import { NativeLyricsView, type NativeLyricsViewProps } from './native/native-lyrics-view';

/** Native Spicy candidate; opt in while visual parity and release performance are being validated. */
export const NativeSpicyLyricsView = memo(function NativeSpicyLyricsView(props: NativeLyricsViewProps) {
  return <NativeLyricsView {...props} style="spicy" reveal="canvas" />;
});
