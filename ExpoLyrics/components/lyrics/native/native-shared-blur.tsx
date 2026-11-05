import React, { createContext } from 'react';
import { StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import type { PlaybackWindowState } from '@/lib/lyrics-layout';

export const NativeSharedBlurContext = createContext(false);
export const NativeBlurGeometryContext = createContext<(() => void) | undefined>(undefined);
export type BlurGeometry = { y: number; height: number; start: number; end: number }[];

/** Content coordinates remain independent of the viewport during manual drags. */
export function sharedBlurRegion(rows: BlurGeometry, window: PlaybackWindowState, time: number, offset: number) {
  'worklet';
  let top = Infinity, bottom = -Infinity, missing = false;
  const first = window.visualActiveLineStartIndex;
  const last = window.visualActiveLineEndIndex;
  const focus = Math.max(0, window.focusLineIndex);
  rows.forEach((row, index) => {
    if (first >= 0 && index >= first && index <= last ||
      index >= (last >= 0 ? last + 1 : focus) && index <= (last >= 0 ? last + 2 : focus + 1) ||
      time >= row.start - 1500 && time <= row.end) {
      if (!Number.isFinite(row.y) || !Number.isFinite(row.height) || row.height <= 0) missing = true;
      top = Math.min(top, row.y - offset - 96);
      bottom = Math.max(bottom, row.y + row.height - offset + 96);
    }
  });
  // Unknown layout: fail open, with no tinted blur across live lyrics.
  return !missing && Number.isFinite(top) ? { top, bottom } : { top: -100000, bottom: 100000 };
}

export function sharedBlurViewport(region: { top: number; bottom: number }, offset: number, height: number) {
  'worklet';
  const limit = height + 160;
  if (region.top === -100000 && region.bottom === 100000) return { top: -limit, bottom: limit };
  return { top: Math.max(-limit, Math.min(limit, region.top - offset)), bottom: Math.max(-limit, Math.min(limit, region.bottom - offset)) };
}

export function NativeSharedBlur({ target, rows, window, position, offset, height, deadlines }: {
  target: React.RefObject<View | null>; rows: SharedValue<BlurGeometry>; window: SharedValue<PlaybackWindowState>;
  deadlines: number[]; position: SharedValue<number>; offset: SharedValue<number>; height: number;
}) {
  const region = useSharedValue({ top: -100000, bottom: 100000 });
  useAnimatedReaction(() => {
    // Discrete timing bucket: scanning occurs only at an approach/end deadline,
    // a presentation cue, or a new geometry snapshot, never on scroll frames.
    let low = 0, high = deadlines.length;
    while (low < high) { const mid = (low + high) >>> 1; if (deadlines[mid] <= position.value) low = mid + 1; else high = mid; }
    return { bucket: low, geometry: rows.value, window: window.value };
  }, (next, previous) => {
    if (!previous || next.bucket !== previous.bucket || next.geometry !== previous.geometry || next.window !== previous.window)
      region.value = sharedBlurRegion(next.geometry, next.window, position.value, 0);
  });
  const upper = useAnimatedStyle(() => {
    const r = sharedBlurViewport(region.value, offset.value, height);
    return { transform: [{ translateY: r.top }] };
  });
  const lower = useAnimatedStyle(() => {
    const r = sharedBlurViewport(region.value, offset.value, height);
    return { transform: [{ translateY: r.bottom }] };
  });
  return <MaskedView pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={StyleSheet.absoluteFill} androidRenderingMode="software" maskElement={<View style={StyleSheet.absoluteFill}>
      <Animated.View style={[{ position: 'absolute', top: -height - 160, height: height + 160, width: '100%' }, upper]}>
        <LinearGradient colors={['black', 'black', 'transparent']} locations={[0, height / (height + 160), 1]} style={{ flex: 1 }} />
      </Animated.View>
      <Animated.View style={[{ position: 'absolute', height: height + 160, width: '100%' }, lower]}>
        <LinearGradient colors={['transparent', 'black', 'black']} locations={[0, 160 / (height + 160), 1]} style={{ flex: 1 }} />
      </Animated.View>
    </View>}>
    <BlurView style={StyleSheet.absoluteFill} blurTarget={target} blurMethod="dimezisBlurViewSdk31Plus" tint="default" intensity={18} />
  </MaskedView>;
}
