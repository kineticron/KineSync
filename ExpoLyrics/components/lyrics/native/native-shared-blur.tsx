import React, { createContext } from 'react';
import { StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
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
      first < 0 && index === focus ||
      time >= row.start && time <= row.end) {
      top = Math.min(top, (known[index] ? row.y : previous) - offset - 24);
      bottom = Math.max(bottom, (known[index] ? row.y + row.height : nextEdges[index]) - offset + 24);
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
  const animatedTop = useSharedValue(0);
  const animatedBottom = useSharedValue(0);
  useAnimatedReaction(() => {
    // Discrete timing bucket: scanning occurs only at an approach/end deadline,
    // a presentation cue, or a new geometry snapshot, never on scroll frames.
    let low = 0, high = deadlines.length;
    while (low < high) { const mid = (low + high) >>> 1; if (deadlines[mid] <= position.value) low = mid + 1; else high = mid; }
    return { bucket: low, geometry: rows.value, window: window.value };
  }, (next, previous) => {
    if (!previous || next.bucket !== previous.bucket || next.geometry !== previous.geometry || next.window !== previous.window)
      {
      const targetRegion = sharedBlurRegion(next.geometry, next.window, position.value, 0);
      const safe = Number.isFinite(targetRegion.top) && Number.isFinite(targetRegion.bottom);
      const initialize = !previous || next.geometry !== previous.geometry || !Number.isFinite(region.value.top) || !Number.isFinite(region.value.bottom);
      if (safe) {
        animatedTop.value = initialize ? targetRegion.top : withTiming(targetRegion.top, { duration: 240 });
        animatedBottom.value = initialize ? targetRegion.bottom : withTiming(targetRegion.bottom, { duration: 240 });
      }
      region.value = targetRegion;
    }
  });
  const upper = useAnimatedStyle(() => {
    const r = sharedBlurViewport({ top: Math.min(animatedTop.value, region.value.top), bottom: Math.max(animatedBottom.value, region.value.bottom) }, offset.value, height);
    return { transform: [{ translateY: r.top }] };
  });
  const lower = useAnimatedStyle(() => {
    const r = sharedBlurViewport({ top: Math.min(animatedTop.value, region.value.top), bottom: Math.max(animatedBottom.value, region.value.bottom) }, offset.value, height);
    return { transform: [{ translateY: r.bottom }] };
  });
  return <MaskedView pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={StyleSheet.absoluteFill} androidRenderingMode="software" maskElement={<View style={StyleSheet.absoluteFill}>
      <Animated.View style={[{ position: 'absolute', top: -2 * height - 320, height: 2 * height + 320, width: '100%' }, upper]}>
        <LinearGradient colors={['black', 'black', 'rgba(0,0,0,0.85)', 'rgba(0,0,0,0.5)', 'rgba(0,0,0,0.15)', 'transparent']} locations={[0, 1 - 160 / (2 * height + 320), 1 - 120 / (2 * height + 320), 1 - 80 / (2 * height + 320), 1 - 40 / (2 * height + 320), 1]} style={{ flex: 1 }} />
      </Animated.View>
      <Animated.View style={[{ position: 'absolute', height: 2 * height + 320, width: '100%' }, lower]}>
        <LinearGradient colors={['transparent', 'rgba(0,0,0,0.15)', 'rgba(0,0,0,0.5)', 'rgba(0,0,0,0.85)', 'black', 'black']} locations={[0, 40 / (2 * height + 320), 80 / (2 * height + 320), 120 / (2 * height + 320), 160 / (2 * height + 320), 1]} style={{ flex: 1 }} />
      </Animated.View>
    </View>}>
    <BlurView style={StyleSheet.absoluteFill} blurTarget={target} blurMethod="dimezisBlurViewSdk31Plus" tint="default" intensity={18} />
  </MaskedView>;
}
