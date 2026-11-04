import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { PlaybackWindowState } from '@/lib/lyrics-layout';
import { NativeSkiaVoice } from './native-skia-voice';
import { NativeLazySkiaVoice } from './native-lazy-skia-voice';
import { useFastLyricLoading } from '@/lib/fast-lyric-loading';

/** All visual active rows plus two subsequent rows, and early voice deadlines.
 * Backgrounds participate independently; overlaps never consume lookahead slots. */
export function needsExactGlyphs(index: number, start: number, end: number, time: number, window: PlaybackWindowState) {
  'worklet';
  const first = window.visualActiveLineStartIndex;
  const last = window.visualActiveLineEndIndex;
  const focus = Math.max(0, window.focusLineIndex);
  return first >= 0 && index >= first && index <= last ||
    index >= (last >= 0 ? last + 1 : focus) && index <= (last >= 0 ? last + 2 : focus + 1) ||
    time >= start - 1500 && time <= end;
}

/** Development experiment only. Once promoted, retain the exact animation owner
 * until cell retirement: this includes arbitrarily long spring release and
 * outgoing layers. Never guess a settling timeout or reset a live spring. */
export function NativeFastVoice(props: React.ComponentProps<typeof NativeSkiaVoice> & {
  rowIndex: number; presentationWindow: SharedValue<PlaybackWindowState>;
}) {
  const { rowIndex, presentationWindow, ...voiceProps } = props;
  const { voice, position } = props;
  const identity = useMemo(() => ({ paintWords: voice.paintWords, words: voice.words, start: voice.start, end: voice.end }), [voice.paintWords, voice.words, voice.start, voice.end]);
  const current = useRef(identity);
  current.current = identity;
  const required = () => needsExactGlyphs(rowIndex, voice.start, voice.end, position.value, presentationWindow.value);
  const [prepared, setPrepared] = useState(() => required() ? identity : null);
  const promote = useCallback(() => {
    // A seek can supersede an approaching cue while its RN callback is queued.
    if (current.current === identity && needsExactGlyphs(rowIndex, voice.start, voice.end, position.value, presentationWindow.value))
      setPrepared(identity);
  }, [identity, rowIndex, voice.start, voice.end, position, presentationWindow]);
  useAnimatedReaction(() => needsExactGlyphs(rowIndex, voice.start, voice.end, position.value, presentationWindow.value),
    (needed, previous) => { if (needed && needed !== previous) scheduleOnRN(promote); },
    [identity, rowIndex, voice.start, voice.end, position, presentationWindow, promote]);
  return <NativeLazySkiaVoice {...voiceProps} prepareGlyphs={prepared === identity || required()} />;
}

/** The subscription exists only in development. Static and tree renderers keep
 * the original implementation; the experimental paragraph path is canvas-only. */
export function NativeDevelopmentVoice(props: React.ComponentProps<typeof NativeSkiaVoice> & {
  rowIndex?: number; presentationWindow?: SharedValue<PlaybackWindowState>;
}) {
  const enabled = useFastLyricLoading();
  const { rowIndex = 0, presentationWindow, ...voiceProps } = props;
  return __DEV__ && enabled && !props.staticLyrics && props.batched !== false && presentationWindow
    ? <NativeFastVoice {...voiceProps} rowIndex={rowIndex} presentationWindow={presentationWindow} />
    : <NativeSkiaVoice {...voiceProps} />;
}
