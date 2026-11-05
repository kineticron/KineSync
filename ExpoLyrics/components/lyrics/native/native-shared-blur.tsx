import React, { createContext } from 'react';
import { StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import type { PlaybackWindowState } from '@/lib/lyrics-layout';
import type { NativeLyricsStyle } from './native-lyrics-model';
import { measuredProtection, type Protection } from './native-progressive-blur';

export const NativeSharedBlurContext = createContext(false);
export const NativeBlurGeometryContext = createContext<(() => void) | undefined>(undefined);
export type BlurRow = {
  y: number;
  height: number;
  start: number;
  end: number;
  interlude?: { start: number; end: number };
  voices?: { start: number; end: number }[];
};
export type BlurGeometry = BlurRow[];

export type SharedBlurProfile = {
  nearIntensity: number;
  farIntensity: number;
  d1: number;
  dNear: number;
  dCross: number;
  tint: 'systemUltraThinMaterial' | 'default';
};

export const SHARED_BLUR_PROFILES: Record<NativeLyricsStyle, SharedBlurProfile> = {
  spicy: {
    nearIntensity: 10,
    farIntensity: 24,
    d1: 60,
    dNear: 100,
    dCross: 60,
    tint: 'systemUltraThinMaterial',
  },
  amll: {
    nearIntensity: 6,
    farIntensity: 16,
    d1: 70,
    dNear: 110,
    dCross: 70,
    tint: 'systemUltraThinMaterial',
  },
};

export const SHARED_BLUR_NEAR_INTENSITY = SHARED_BLUR_PROFILES.spicy.nearIntensity;
export const SHARED_BLUR_FAR_INTENSITY = SHARED_BLUR_PROFILES.spicy.farIntensity;

export function getSharedBlurProfile(style?: NativeLyricsStyle): SharedBlurProfile {
  return (style && SHARED_BLUR_PROFILES[style]) || SHARED_BLUR_PROFILES.spicy;
}

export function hasBlurGeometry(rows: BlurGeometry) {
  // Conservative prototype gate: partial snapshots can leave both protected
  // edges unbounded. Keep original per-voice blur until every cell is valid.
  return rows.length > 0 && rows.every(row => Number.isFinite(row.y) && Number.isFinite(row.height) && row.height > 0);
}

export function sameBlurGeometry(a: BlurGeometry, b: BlurGeometry) {
  'worklet';
  return a.length === b.length && a.every((row, i) =>
    row.y === b[i].y && row.height === b[i].height && row.start === b[i].start && row.end === b[i].end);
}

/**
 * Exact numerical weights for complementary multi-tier shared blur masks.
 * Inside protected region (distance <= 0): near=0, far=0, sum=0.
 * In transition: near + far = 1.0 (continuous, no seam).
 * Everywhere: near + far <= 1.0.
 */
export function sharedBlurMaskWeights(distance: number, _spanHeight = 1000, d1 = 60, dNear = 100, dCross = 60) {
  'worklet';
  if (distance <= 0) return { near: 0, far: 0, sum: 0 };
  let near = 0, far = 0;
  if (distance < d1) {
    near = distance / d1;
    far = 0;
  } else if (distance <= d1 + dNear) {
    near = 1;
    far = 0;
  } else if (distance < d1 + dNear + dCross) {
    const t = (distance - (d1 + dNear)) / dCross;
    near = 1 - t;
    far = t;
  } else {
    near = 0;
    far = 1;
  }
  return { near, far, sum: near + far };
}

/**
 * Computes measured protection boundaries for active voices and the complete next
 * semantic row (wraps, translations, interludes/dots). Strictly zero constant offset.
 * Missing/unmeasured geometry opens the safe zone to infinity.
 */
export function sharedBlurRegion(rows: BlurGeometry, window: PlaybackWindowState, time: number, offset = 0) {
  'worklet';
  const protection = measuredProtection(rows, window, time);
  return {
    top: Number.isFinite(protection.top) ? protection.top - offset : -Infinity,
    bottom: Number.isFinite(protection.bottom) ? protection.bottom - offset : Infinity,
  };
}

export function sharedBlurViewport(region: { top: number; bottom: number }, offset: number, height: number) {
  'worklet';
  const limit = height + 160;
  if (region.top === -Infinity && region.bottom === Infinity) return { top: -limit, bottom: limit };
  return {
    top: region.top === -Infinity ? -limit : Math.max(-limit, Math.min(limit, region.top - offset)),
    bottom: region.bottom === Infinity ? limit : Math.max(-limit, Math.min(limit, region.bottom - offset)),
  };
}

export function NativeSharedBlur({ target, rows, window, position, offset, height, deadlines, seekVersion, style }: {
  target: React.RefObject<View | null>; rows: SharedValue<BlurGeometry>; window: SharedValue<PlaybackWindowState>;
  deadlines: number[]; position: SharedValue<number>; offset: SharedValue<number>; height: number; seekVersion: SharedValue<number>;
  style?: NativeLyricsStyle;
}) {
  const profile = getSharedBlurProfile(style);
  const protection = useSharedValue<Protection>({ first: 0, index: -1, top: -Infinity, bottom: Infinity });
  const animatedTop = useSharedValue(-Infinity);
  const animatedBottom = useSharedValue(Infinity);

  useAnimatedReaction(() => {
    let low = 0, high = deadlines.length;
    while (low < high) { const mid = (low + high) >>> 1; if (deadlines[mid] <= position.value) low = mid + 1; else high = mid; }
    return { bucket: low, geometry: rows.value, window: window.value, seek: seekVersion.value };
  }, (next, previous) => {
    if (!previous || next.bucket !== previous.bucket || next.geometry !== previous.geometry || next.window !== previous.window || next.seek !== previous.seek) {
      const targetProtection = measuredProtection(next.geometry, next.window, position.value);
      const old = protection.value;
      const reset = !previous || (next.geometry !== previous.geometry && !sameBlurGeometry(next.geometry, previous.geometry)) || next.seek !== previous.seek || !Number.isFinite(old.bottom) || !Number.isFinite(targetProtection.bottom);
      protection.value = targetProtection;
      if (reset || targetProtection.top !== old.top) {
        animatedTop.value = reset || !Number.isFinite(old.top) || !Number.isFinite(targetProtection.top) ? targetProtection.top : withTiming(targetProtection.top, { duration: 240 });
      }
      if (reset || targetProtection.bottom !== old.bottom) {
        animatedBottom.value = reset || !Number.isFinite(old.bottom) || !Number.isFinite(targetProtection.bottom) ? targetProtection.bottom : withTiming(targetProtection.bottom, { duration: 240 });
      }
    }
  });

  // Critical Asymmetry:
  // Forward cue: animatedBottom lags behind target.bottom -> max(animatedBottom, protection.bottom) guarantees next row is NEVER blurred.
  // Reverse cue: animatedBottom smoothly moves up -> max(animatedBottom, protection.bottom) follows animatedBottom smoothly.
  // Converse for top: min(animatedTop, protection.top) guarantees newly active row above is NEVER blurred while smoothly releasing downward.
  const upper = useAnimatedStyle(() => {
    const rawTop = Number.isFinite(protection.value.top)
      ? (Number.isFinite(animatedTop.value) ? Math.min(animatedTop.value, protection.value.top) : protection.value.top)
      : -Infinity;
    const r = sharedBlurViewport({ top: rawTop, bottom: Infinity }, offset.value, height);
    return { transform: [{ translateY: r.top }] };
  });

  const lower = useAnimatedStyle(() => {
    const rawBottom = Number.isFinite(protection.value.bottom)
      ? (Number.isFinite(animatedBottom.value) ? Math.max(animatedBottom.value, protection.value.bottom) : protection.value.bottom)
      : Infinity;
    const r = sharedBlurViewport({ top: -Infinity, bottom: rawBottom }, offset.value, height);
    return { transform: [{ translateY: r.bottom }] };
  });

  const spanHeight = 2 * height + 320;
  const { d1, dNear, dCross, nearIntensity, farIntensity, tint } = profile;
  const l1 = d1 / spanHeight;
  const l2 = (d1 + dNear) / spanHeight;
  const l3 = (d1 + dNear + dCross) / spanHeight;

  // Lower Near: 0 at anchor -> 1 at l1..l2 -> 0 at l3
  const lowerNearColors: readonly [string, string, ...string[]] = ['transparent', 'rgba(0,0,0,0.5)', 'black', 'black', 'rgba(0,0,0,0.5)', 'transparent', 'transparent'];
  const lowerNearLocs: readonly [number, number, ...number[]] = [0, l1 * 0.5, l1, l2, l2 + (l3 - l2) * 0.5, l3, 1];

  // Lower Far: 0 at anchor..l2 -> 1 at l3..1
  const lowerFarColors: readonly [string, string, ...string[]] = ['transparent', 'transparent', 'rgba(0,0,0,0.5)', 'black', 'black'];
  const lowerFarLocs: readonly [number, number, ...number[]] = [0, l2, l2 + (l3 - l2) * 0.5, l3, 1];

  // Upper Near: 0 at anchor (1) -> 1 at 1-l1..1-l2 -> 0 at 1-l3
  const upperNearColors: readonly [string, string, ...string[]] = ['transparent', 'transparent', 'rgba(0,0,0,0.5)', 'black', 'black', 'rgba(0,0,0,0.5)', 'transparent'];
  const upperNearLocs: readonly [number, number, ...number[]] = [0, 1 - l3, 1 - l3 + (l3 - l2) * 0.5, 1 - l2, 1 - l1, 1 - l1 * 0.5, 1];

  // Upper Far: 0 at anchor (1)..1-l2 -> 1 at 1-l3..0
  const upperFarColors: readonly [string, string, ...string[]] = ['black', 'black', 'rgba(0,0,0,0.5)', 'transparent', 'transparent'];
  const upperFarLocs: readonly [number, number, ...number[]] = [0, 1 - l3, 1 - l3 + (l3 - l2) * 0.5, 1 - l2, 1];

  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
    {/* Pass 1: Near Tier */}
    <MaskedView pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill} androidRenderingMode="software" maskElement={<View style={StyleSheet.absoluteFill}>
        <Animated.View style={[{ position: 'absolute', top: -spanHeight, height: spanHeight, width: '100%' }, upper]}>
          <LinearGradient colors={upperNearColors} locations={upperNearLocs} style={{ flex: 1 }} />
        </Animated.View>
        <Animated.View style={[{ position: 'absolute', height: spanHeight, width: '100%' }, lower]}>
          <LinearGradient colors={lowerNearColors} locations={lowerNearLocs} style={{ flex: 1 }} />
        </Animated.View>
      </View>}>
      <BlurView style={StyleSheet.absoluteFill} blurTarget={target} blurMethod="dimezisBlurViewSdk31Plus" tint={tint} intensity={nearIntensity} />
    </MaskedView>
    {/* Pass 2: Far Tier */}
    <MaskedView pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill} androidRenderingMode="software" maskElement={<View style={StyleSheet.absoluteFill}>
        <Animated.View style={[{ position: 'absolute', top: -spanHeight, height: spanHeight, width: '100%' }, upper]}>
          <LinearGradient colors={upperFarColors} locations={upperFarLocs} style={{ flex: 1 }} />
        </Animated.View>
        <Animated.View style={[{ position: 'absolute', height: spanHeight, width: '100%' }, lower]}>
          <LinearGradient colors={lowerFarColors} locations={lowerFarLocs} style={{ flex: 1 }} />
        </Animated.View>
      </View>}>
      <BlurView style={StyleSheet.absoluteFill} blurTarget={target} blurMethod="dimezisBlurViewSdk31Plus" tint={tint} intensity={farIntensity} />
    </MaskedView>
  </View>;
}
