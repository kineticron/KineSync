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

export function hasBlurGeometry(rows: BlurGeometry) {
  // Conservative prototype gate: partial snapshots can leave both protected
  // edges unbounded. Keep original per-voice blur until every cell is valid.
  return rows.length > 0 && rows.every(row => Number.isFinite(row.y) && Number.isFinite(row.height) && row.height > 0);
}

/** FlashList cells are ordered/nonoverlapping. Unknown cells are protected
 * between real neighboring cell edges, never extrapolated from guessed heights.
 * Missing lookahead can extend one edge without discarding the other safe edge. */
export function sharedBlurRegion(rows: BlurGeometry, window: PlaybackWindowState, time: number, offset: number) {
  'worklet';
  let top = Infinity, bottom = -Infinity;
  const first = window.visualActiveLineStartIndex;
  const last = window.visualActiveLineEndIndex;
  const focus = Math.max(0, window.focusLineIndex);
  const known = rows.map(row => Number.isFinite(row.y) && Number.isFinite(row.height) && row.height > 0);
  const nextEdges: number[] = [];
  let next = Infinity;
  for (let i = rows.length - 1; i >= 0; i--) {
    nextEdges[i] = next;
    if (known[i]) next = rows[i].y;
  }
  let previous = -Infinity;
  rows.forEach((row, index) => {
    if (first >= 0 && index >= first && index <= last ||
      index >= (last >= 0 ? last + 1 : focus) && index <= (last >= 0 ? last + 2 : focus + 1) ||
      time >= row.start - 1500 && time <= row.end) {
      top = Math.min(top, (known[index] ? row.y : previous) - offset - 96);
      bottom = Math.max(bottom, (known[index] ? row.y + row.height : nextEdges[index]) - offset + 96);
    }
    if (known[index]) previous = row.y + row.height;
  });
  return top !== Infinity ? { top, bottom } : { top: -Infinity, bottom: Infinity };
}

export function sharedBlurViewport(region: { top: number; bottom: number }, offset: number, height: number) {
  'worklet';
  const limit = height + 160;
  if (region.top === -Infinity && region.bottom === Infinity) return { top: -limit, bottom: limit };
  return { top: Math.max(-limit, Math.min(limit, region.top - offset)), bottom: Math.max(-limit, Math.min(limit, region.bottom - offset)) };
}

export function NativeSharedBlur({ target, rows, window, position, offset, height, deadlines }: {
  target: React.RefObject<View | null>; rows: SharedValue<BlurGeometry>; window: SharedValue<PlaybackWindowState>;
  deadlines: number[]; position: SharedValue<number>; offset: SharedValue<number>; height: number;
}) {
  const region = useSharedValue({ top: -Infinity, bottom: Infinity });
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
