import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useState, type PropsWithChildren } from 'react';
import { Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  cancelAnimation, Easing, Extrapolation, interpolate, runOnJS,
  useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, withSpring, withDelay, withSequence,
} from 'react-native-reanimated';

import { Design, Motion } from '@/constants/design';
import { LaunchVisibilityContext } from './launch-visibility';

// Runs before the root mounts, so the OS splash hands off to a painted wordmark.
void SplashScreen.preventAutoHideAsync().catch(() => {});

const REVEAL_MS = 1000;
const COMPRESS_MS = 260;
const ZOOM_MS = 780;
const ZOOM_START_MS = REVEAL_MS + COMPRESS_MS;
const CONTENT_REVEAL_MS = ZOOM_START_MS + ZOOM_MS * 0.08;
const FADE_END_MS = ZOOM_START_MS + ZOOM_MS * 0.82;
const DURATION_MS = ZOOM_START_MS + ZOOM_MS + 160;

export const launchTiming = {
  zoomStart: ZOOM_START_MS, zoomDuration: ZOOM_MS,
  fadeStart: CONTENT_REVEAL_MS, fadeEnd: FADE_END_MS, duration: DURATION_MS,
};
// A small point inside the native e's crossbar continues the white surface at
// extreme magnification, without replacing or redrawing any of the letters.
const WHITE_POINT_SIZE = 1;
type WordmarkMetrics = { width: number; prefix: number; throughE: number; crossbarY: number };

export function getLaunchCameraFocus(scale: number, travel: number) {
  'worklet';
  // Compensate for magnification immediately, then move the target to center.
  // A linear camera offset would fling the white stroke offscreen mid-zoom.
  return scale > 1 ? 1 - (1 - travel) / scale : travel;
}

function Wordmark({ onMetrics }: { onMetrics?: (metrics: Partial<WordmarkMetrics>) => void }) {
  return <View style={styles.wordmark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Text allowFontScaling={false} style={styles.name}
      onLayout={event => onMetrics?.({ width: event.nativeEvent.layout.width })}
      onTextLayout={event => {
        const line = event.nativeEvent.lines[0];
        if (line) onMetrics?.({ crossbarY: line.y + line.ascender - line.xHeight / 2 });
      }}>KineSync</Text>
    {onMetrics && <View style={styles.measurements}>
      <Text allowFontScaling={false} style={styles.name} onLayout={event => onMetrics({ prefix: event.nativeEvent.layout.width })}>Kin</Text>
      <Text allowFontScaling={false} style={styles.name} onLayout={event => onMetrics({ throughE: event.nativeEvent.layout.width })}>Kine</Text>
    </View>}
  </View>;
}

export function LaunchTransition({ ready, children }: PropsWithChildren<{ ready: boolean }>) {
  const reduceMotion = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const zoomScale = Math.max(width, height) / WHITE_POINT_SIZE * 1.2;
  // React Native Web does not emit onTextLayout; native builds use the actual
  // font's baseline and x-height rather than this browser fallback.
  const [metrics, setMetrics] = useState<WordmarkMetrics>({ width: 0, prefix: 0, throughE: 0, crossbarY: Platform.OS === 'web' ? 24 : 0 });
  const measureWordmark = useCallback((update: Partial<WordmarkMetrics>) => {
    setMetrics(previous => Object.entries(update).every(([key, value]) => previous[key as keyof WordmarkMetrics] === value)
      ? previous : { ...previous, ...update });
  }, []);
  const focusX = -metrics.width / 2 + (metrics.prefix + metrics.throughE) / 2;
  const focusY = metrics.crossbarY - 21;
  const [laidOut, setLaidOut] = useState(false);
  const [finished, setFinished] = useState(false);
  const [contentVisible, setContentVisible] = useState(false);
  const progress = useSharedValue(0);
  const brandScale = useSharedValue(1);
  const focus = useSharedValue(0);
  const contentOffset = useSharedValue(28);
  const finish = useCallback(() => setFinished(true), []);

  useEffect(() => {
    if (!laidOut || !metrics.width || !metrics.prefix || !metrics.throughE || !metrics.crossbarY || !ready || finished) return;
    void SplashScreen.hideAsync().catch(() => {});
    if (reduceMotion) {
      progress.value = 1;
      contentOffset.value = 0;
      finish();
      return;
    }
    progress.value = withTiming(1, {
      duration: DURATION_MS,
      easing: Easing.linear,
    }, (complete) => {
      if (complete) runOnJS(finish)();
    });
    contentOffset.value = withDelay(CONTENT_REVEAL_MS, withSpring(0, Motion.settle));
    brandScale.value = withDelay(REVEAL_MS, withSequence(
      withTiming(0.88, { duration: COMPRESS_MS, easing: Easing.out(Easing.back(1.4)) }),
      withTiming(zoomScale, { duration: ZOOM_MS, easing: Easing.in(Easing.cubic) }),
    ));
    focus.value = withDelay(REVEAL_MS + COMPRESS_MS, withTiming(1, { duration: ZOOM_MS, easing: Easing.in(Easing.cubic) }));
    const revealContent = setTimeout(() => setContentVisible(true), CONTENT_REVEAL_MS);
    return () => { clearTimeout(revealContent); cancelAnimation(progress); cancelAnimation(contentOffset); cancelAnimation(brandScale); cancelAnimation(focus); };
  }, [brandScale, contentOffset, finish, finished, focus, laidOut, metrics, progress, ready, reduceMotion, zoomScale]);

  const wordmarkStyle = useAnimatedStyle(() => {
    const cameraFocus = getLaunchCameraFocus(brandScale.value, focus.value);
    return {
      // Fade the complete wordmark with its overlay during the forward zoom,
      // rather than hiding individual letters based on their magnification.
      opacity: 1,
      transform: [
        { translateX: -focusX * brandScale.value * cameraFocus },
        { translateY: -focusY * brandScale.value * cameraFocus },
        { scale: brandScale.value },
      ],
    };
  });
  const stemStyle = useAnimatedStyle(() => {
    const cameraFocus = getLaunchCameraFocus(brandScale.value, focus.value);
    return {
      // Animate the actual rectangle bounds instead of a transformed texture.
      left: width / 2 + focusX * brandScale.value * (1 - cameraFocus) - WHITE_POINT_SIZE * brandScale.value / 2,
      top: height / 2 + focusY * brandScale.value * (1 - cameraFocus) - WHITE_POINT_SIZE * brandScale.value / 2,
      width: WHITE_POINT_SIZE * brandScale.value,
      height: WHITE_POINT_SIZE * brandScale.value,
      // Let the real glyph render unmodified during reveal and pullback.
      opacity: interpolate(brandScale.value, [8, 16], [0, 1], Extrapolation.CLAMP),
    };
  });
  const revealStyle = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, REVEAL_MS / DURATION_MS], [0, 240], Extrapolation.CLAMP),
  }));
  const overlayStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [
      0, CONTENT_REVEAL_MS / DURATION_MS,
      (ZOOM_START_MS + ZOOM_MS * 0.3) / DURATION_MS,
      (ZOOM_START_MS + ZOOM_MS * 0.5) / DURATION_MS,
      FADE_END_MS / DURATION_MS,
    ], [1, 1, 0.82, 0.18, 0], Extrapolation.CLAMP),
  }));
  const contentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [
      0, CONTENT_REVEAL_MS / DURATION_MS,
      (ZOOM_START_MS + ZOOM_MS * 0.4) / DURATION_MS, 1,
    ], [0, 0, 1, 1], Extrapolation.CLAMP),
    transform: [{ translateY: contentOffset.value }],
  }));

  return (
    <View style={styles.root} onLayout={() => setLaidOut(true)}>
      <Animated.View
        style={[styles.root, !finished && contentStyle]}
        pointerEvents={finished ? 'auto' : 'none'}
        aria-hidden={!finished}
        accessibilityElementsHidden={!finished}
        importantForAccessibility={finished ? 'auto' : 'no-hide-descendants'}>
        <LaunchVisibilityContext.Provider value={finished || contentVisible}>
          {children}
        </LaunchVisibilityContext.Provider>
      </Animated.View>
      {!finished && (
        <Animated.View style={[styles.overlay, overlayStyle]} accessibilityLabel="KineSync is opening" accessibilityRole="progressbar">
          <View style={[StyleSheet.absoluteFill, styles.veil]} />
          <Animated.View style={[styles.brand, wordmarkStyle]}>
            <View style={styles.dimBrand}>
              <Wordmark onMetrics={measureWordmark} />
            </View>
            <Animated.View style={[styles.reveal, revealStyle]}>
              <Wordmark />
            </Animated.View>
          </Animated.View>
          <Animated.View pointerEvents="none" style={[styles.whiteStem, stemStyle]} />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, overflow: 'hidden', backgroundColor: Design.background },
  overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  veil: { backgroundColor: '#000000' },
  brand: { width: 240, height: 42 },
  dimBrand: { ...StyleSheet.absoluteFill, opacity: 0.18 },
  reveal: { position: 'absolute', left: 0, top: 0, height: 42, overflow: 'hidden' },
  wordmark: { position: 'absolute', top: 0, left: 0, width: 240, alignItems: 'center' },
  measurements: { position: 'absolute', opacity: 0, alignItems: 'flex-start' },
  name: { color: '#FFFFFF', fontSize: 32, lineHeight: 42, fontWeight: '800', letterSpacing: -1 },
  whiteStem: { position: 'absolute', backgroundColor: '#FFFFFF' },
});
