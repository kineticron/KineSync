import React, { createContext } from 'react';
import { StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import type { PlaybackWindowState } from '@/lib/lyrics-layout';
import type { NativeLyricsStyle } from './native-lyrics-model';
import type { RowMotionEntry } from './reference-scroll';
import { measuredProtection, type Protection } from './native-progressive-blur';
export { measuredProtection, type Protection };

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
export type AttributionGeometry = { y: number; height: number };

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

export function hasBlurGeometry(
  rows: BlurGeometry,
  window?: PlaybackWindowState,
  time?: number,
  attribution?: AttributionGeometry | null,
  hasAttribution?: boolean,
): boolean {
  if (hasAttribution && (!attribution || !Number.isFinite(attribution.y) || attribution.y <= 0 || !Number.isFinite(attribution.height) || attribution.height <= 0)) {
    return false;
  }
  if (rows.length === 0) return false;
  if (!window) {
    return rows.every(row => Number.isFinite(row.y) && Number.isFinite(row.height) && row.height > 0);
  }
  const activeStart = window.visualActiveLineStartIndex >= 0 ? window.visualActiveLineStartIndex : window.focusLineIndex;
  const first = Math.max(0, Math.min(rows.length - 1, activeStart));
  let last = first;
  let dots = -1;
  const t = typeof time === 'number' ? time : (rows[first]?.start ?? 0);
  rows.forEach((row, index) => {
    if (row.voices ? row.voices.some((v: { start: number; end: number }) => t >= v.start && t < v.end) : t >= row.start && t < row.end) {
      last = Math.max(last, index);
    }
    if (row.interlude && t >= row.interlude.start && t < row.interlude.end) dots = Math.max(dots, index);
  });
  const nextTarget = Math.min(rows.length - 1, Math.max(last + 1, dots, first, 0));
  const checkStart = Math.min(first, last);
  for (let i = checkStart; i <= nextTarget; i++) {
    const r = rows[i];
    if (!r || !Number.isFinite(r.y) || !Number.isFinite(r.height) || r.height <= 0) return false;
  }
  return true;
}

export function sameBlurGeometry(a: BlurGeometry, b: BlurGeometry) {
  'worklet';
  return a.length === b.length && a.every((row, i) =>
    row.y === b[i].y && row.height === b[i].height && row.start === b[i].start && row.end === b[i].end);
}

/**
 * Standard GPU Source-Over composite of two independent transparent passes:
 * alpha_out = alpha_near + alpha_far * (1 - alpha_near).
 */
export function compositeAlpha(near: number, far: number) {
  'worklet';
  return near + far * (1 - near);
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

/**
 * Computes exact measured protection envelope tracking the actual animated
 * row positions each UI frame for AMLL. Combines staggered row springs,
 * cell layout animations, wraps, translations, dots, and overlapping voices.
 * Unknown or missing geometry immediately fails safe to [-Infinity, Infinity].
 */
export function amllAnimatedProtection(
  rows: BlurGeometry,
  protection: Protection,
  motions?: Record<number, RowMotionEntry>,
  residual = 0,
  dt = 1 / 60,
): { top: number; bottom: number } {
  'worklet';
  if (!Number.isFinite(protection.top) || !Number.isFinite(protection.bottom) || protection.first < 0 || protection.index < protection.first) {
    return { top: -Infinity, bottom: Infinity };
  }
  let minTop = Infinity;
  let maxBottom = -Infinity;
  for (let i = protection.first; i <= protection.index; i++) {
    const r = rows[i];
    if (!r || !Number.isFinite(r.y) || !Number.isFinite(r.height) || r.height <= 0) {
      return { top: -Infinity, bottom: Infinity };
    }
    const entry = motions ? motions[i] : undefined;
    const dy = (entry?.row ?? residual) + (entry?.cell ?? 0);
    // Measured maximum per-frame velocity lead: guarantees that if the mask uniform
    // is scheduled one frame before the row transform, the rendered row cannot breach the blur mask.
    const lead = entry?.vLead ?? 0;
    const rowTop = r.y + dy - lead;
    const rowBottom = r.y + r.height + dy + lead;
    if (rowTop < minTop) minTop = rowTop;
    if (rowBottom > maxBottom) maxBottom = rowBottom;
  }
  return {
    top: Number.isFinite(minTop) ? minTop : -Infinity,
    bottom: Number.isFinite(maxBottom) ? maxBottom : Infinity,
  };
}

export function NativeSharedBlur({ target, rows, window, position, offset, height, deadlines, seekVersion, style, residual, motions, attribution, hasAttribution }: {
  target: React.RefObject<View | null>; rows: SharedValue<BlurGeometry>; window: SharedValue<PlaybackWindowState>;
  deadlines: number[]; position: SharedValue<number>; offset: SharedValue<number>; height: number; seekVersion: SharedValue<number>;
  style?: NativeLyricsStyle; residual?: SharedValue<number>; motions?: SharedValue<Record<number, RowMotionEntry>>;
  attribution?: SharedValue<AttributionGeometry | null>;
  hasAttribution?: boolean;
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
  // In AMLL, effective boundaries track the actual animated protected row positions EACH UI FRAME (staggered row springs + layout cell motion).
  // Attribution text at the bottom is strictly excluded: lower blur terminates before attribution top, upper blur remains above attribution top.
  const upper = useAnimatedStyle(() => {
    let rawTop = -Infinity;
    if (style === 'amll') {
      const animated = amllAnimatedProtection(rows.value, protection.value, motions?.value, residual?.value ?? 0);
      rawTop = animated.top;
    } else {
      rawTop = Number.isFinite(protection.value.top)
        ? (Number.isFinite(animatedTop.value) ? Math.min(animatedTop.value, protection.value.top) : protection.value.top)
        : -Infinity;
    }
    const r = sharedBlurViewport({ top: rawTop, bottom: Infinity }, offset.value, height);
    const attr = attribution?.value;
    let upperTranslateY = r.top;
    if (attr && Number.isFinite(attr.y) && Number.isFinite(attr.height) && attr.y > 0) {
      const attrScreenTop = attr.y - offset.value;
      if (attrScreenTop < r.top) {
        upperTranslateY = Math.min(r.top, attrScreenTop);
      }
    }
    return {
      transform: [{ translateY: upperTranslateY }],
      height: spanHeight,
      overflow: 'hidden',
    };
  });

  const lower = useAnimatedStyle(() => {
    let rawBottom = Infinity;
    if (style === 'amll') {
      const animated = amllAnimatedProtection(rows.value, protection.value, motions?.value, residual?.value ?? 0);
      rawBottom = animated.bottom;
    } else {
      rawBottom = Number.isFinite(protection.value.bottom)
        ? (Number.isFinite(animatedBottom.value) ? Math.max(animatedBottom.value, protection.value.bottom) : protection.value.bottom)
        : Infinity;
    }
    const r = sharedBlurViewport({ top: -Infinity, bottom: rawBottom }, offset.value, height);
    const attr = attribution?.value;
    let lowerHeight = spanHeight;
    if (hasAttribution) {
      if (!attr || !Number.isFinite(attr.y) || attr.y <= 0 || !Number.isFinite(attr.height) || attr.height <= 0) {
        lowerHeight = 0;
      } else {
        const attrScreenTop = attr.y - offset.value;
        lowerHeight = Math.max(0, Math.min(spanHeight, attrScreenTop - r.bottom));
      }
    } else if (attr && Number.isFinite(attr.y) && Number.isFinite(attr.height) && attr.y > 0) {
      const attrScreenTop = attr.y - offset.value;
      lowerHeight = Math.max(0, Math.min(spanHeight, attrScreenTop - r.bottom));
    }
    return {
      transform: [{ translateY: r.bottom }],
      height: lowerHeight,
      overflow: 'hidden',
    };
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
          <LinearGradient colors={upperNearColors} locations={upperNearLocs} style={{ height: spanHeight, width: '100%' }} />
        </Animated.View>
        <Animated.View style={[{ position: 'absolute', height: spanHeight, width: '100%' }, lower]}>
          <LinearGradient colors={lowerNearColors} locations={lowerNearLocs} style={{ height: spanHeight, width: '100%' }} />
        </Animated.View>
      </View>}>
      <BlurView style={StyleSheet.absoluteFill} blurTarget={target} blurMethod="dimezisBlurViewSdk31Plus" tint={tint} intensity={nearIntensity} />
    </MaskedView>
    {/* Pass 2: Far Tier */}
    <MaskedView pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill} androidRenderingMode="software" maskElement={<View style={StyleSheet.absoluteFill}>
        <Animated.View style={[{ position: 'absolute', top: -spanHeight, height: spanHeight, width: '100%' }, upper]}>
          <LinearGradient colors={upperFarColors} locations={upperFarLocs} style={{ height: spanHeight, width: '100%' }} />
        </Animated.View>
        <Animated.View style={[{ position: 'absolute', height: spanHeight, width: '100%' }, lower]}>
          <LinearGradient colors={lowerFarColors} locations={lowerFarLocs} style={{ height: spanHeight, width: '100%' }} />
        </Animated.View>
      </View>}>
      <BlurView style={StyleSheet.absoluteFill} blurTarget={target} blurMethod="dimezisBlurViewSdk31Plus" tint={tint} intensity={farIntensity} />
    </MaskedView>
  </View>;
}
