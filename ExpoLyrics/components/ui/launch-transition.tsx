import { reloadAppAsync } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  cancelAnimation, Easing, Extrapolation, interpolate, runOnJS,
  useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, withSpring, withDelay, withSequence,
} from 'react-native-reanimated';

import { Design, Motion } from '@/constants/design';
import { LaunchVisibilityContext } from './launch-visibility';

// Runs before the root mounts. Android hands over once the launch shell has layout.
void SplashScreen.preventAutoHideAsync().catch(() => {
  console.warn('[LaunchTransition] Native splash hold failed');
});

const REVEAL_MS = 1000;
const COMPRESS_MS = 260;
const ZOOM_MS = 780;
const ZOOM_START_MS = REVEAL_MS + COMPRESS_MS;
const CONTENT_REVEAL_MS = ZOOM_START_MS + ZOOM_MS * 0.08;
const FADE_END_MS = ZOOM_START_MS + ZOOM_MS * 0.82;
const DURATION_MS = ZOOM_START_MS + ZOOM_MS + 160;
const ANDROID_MEASUREMENT_MS = 400;
const STARTUP_TIMEOUT_MS = 5000;
const ANIMATION_GRACE_MS = 400;
const FALLBACK_CROSSBAR_Y = 24;
const SPLASH_RETRY_MS = 150;

export const launchTiming = {
  zoomStart: ZOOM_START_MS, zoomDuration: ZOOM_MS,
  fadeStart: CONTENT_REVEAL_MS, fadeEnd: FADE_END_MS, duration: DURATION_MS,
};
// A small point inside the native e's crossbar continues the white surface at
// extreme magnification, without replacing or redrawing any of the letters.
const WHITE_POINT_SIZE = 1;
type LineMetrics = { y: number; ascender: number; xHeight: number };
type WordmarkMetrics = { width?: number; prefix?: number; throughE?: number; line?: LineMetrics | null };
type LaunchRun = {
  started: boolean;
  finished: boolean;
  deadline: ReturnType<typeof setTimeout>;
  measurement?: ReturnType<typeof setTimeout>;
  reveal?: ReturnType<typeof setTimeout>;
  finish: (reason: string) => void;
  releaseSplash: (reason: string) => void;
};

function trace(event: string, data: Record<string, unknown> = {}) {
  if (Platform.OS === 'android') {
    console.info('[LaunchTransition]', Date.now(), event, JSON.stringify(data, (_, value) =>
      typeof value === 'number' && !Number.isFinite(value) ? String(value) : value));
  }
}

function positiveMetric(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function getLaunchCameraFocus(scale: number, travel: number) {
  'worklet';
  // Compensate for magnification immediately, then move the target to center.
  // A linear camera offset would fling the white stroke offscreen mid-zoom.
  return scale > 1 ? 1 - (1 - travel) / scale : travel;
}

function Wordmark({ onMetrics }: { onMetrics?: (metrics: WordmarkMetrics) => void }) {
  const measure = (key: 'width' | 'prefix' | 'throughE', { width, height }: { width: number; height: number }) => {
    trace('text layout', { key, width, height });
    onMetrics?.({ [key]: width });
  };
  return <View style={styles.wordmark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Text allowFontScaling={false} style={styles.name}
      onLayout={onMetrics && (event => measure('width', event.nativeEvent.layout))}
      onTextLayout={onMetrics && (event => {
        const lines = event.nativeEvent.lines ?? [];
        const first = lines[0];
        const line = first ? { y: first.y, ascender: first.ascender, xHeight: first.xHeight } : null;
        trace('text lines', { count: lines.length, line, width: first?.width, height: first?.height });
        onMetrics({ line });
      })}>KineSync</Text>
    {onMetrics && <View style={styles.measurements}>
      <Text allowFontScaling={false} style={styles.name} onLayout={event => measure('prefix', event.nativeEvent.layout)}>Kin</Text>
      <Text allowFontScaling={false} style={styles.name} onLayout={event => measure('throughE', event.nativeEvent.layout)}>Kine</Text>
    </View>}
  </View>;
}

export function LaunchTransition({ ready, children }: PropsWithChildren<{ ready: boolean }>) {
  const reduceMotion = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const zoomScale = Math.max(width, height) / WHITE_POINT_SIZE * 1.2;
  const [metrics, setMetrics] = useState<WordmarkMetrics>({});
  const runRef = useRef<LaunchRun | null>(null);
  const motionStarted = useRef(false);
  const splashRelease = useRef({ attempts: 0, acknowledged: false });
  const measureWordmark = useCallback((update: WordmarkMetrics) => {
    // Native layout facts can arrive before the effects establish a run.
    setMetrics(previous => Object.entries(update).every(([key, value]) => Object.is(previous[key as keyof WordmarkMetrics], value))
      ? previous : { ...previous, ...update });
  }, []);
  const [{ focusX, focusY }, setCameraTarget] = useState({ focusX: 0, focusY: 0 });
  const [laidOut, setLaidOut] = useState(false);
  const [measurementExpired, setMeasurementExpired] = useState(false);
  const [finished, setFinished] = useState(false);
  const [contentVisible, setContentVisible] = useState(false);
  const progress = useSharedValue(0);
  const brandScale = useSharedValue(1);
  const focus = useSharedValue(0);
  const contentOffset = useSharedValue(28);
  const android = Platform.OS === 'android';
  const { width: wordWidth, prefix, throughE, line } = metrics;
  const rawCrossbarY = line ? line.y + line.ascender - line.xHeight / 2 : undefined;
  // Only Android needs the platform-specific glyph metric checks. Keep the
  // measured iOS target and the existing web target.
  const crossbarY = Platform.OS === 'web' ? FALLBACK_CROSSBAR_Y : rawCrossbarY;
  const validCrossbarY = positiveMetric(crossbarY) && (!android || (
    crossbarY < 42 && !!line && positiveMetric(line.ascender) &&
    positiveMetric(line.xHeight) && line.xHeight <= line.ascender
  )) ? crossbarY : undefined;
  const hasWidths = positiveMetric(wordWidth) && positiveMetric(prefix) && positiveMetric(throughE)
    && prefix < throughE && throughE < wordWidth;
  // Own the timers and animations for this mount. Gate changes must never
  // cancel a running animation or start it again.
  useEffect(() => {
    let splashRetry: ReturnType<typeof setTimeout> | undefined;
    const releaseSplash = (reason: string) => {
      const release = splashRelease.current;
      if (runRef.current !== run || release.acknowledged || splashRetry !== undefined || release.attempts >= 2) return;
      const attempt = ++release.attempts;
      trace('splash release requested', { reason, attempt });
      try {
        // Expo's native hideAsync wrapper calls this synchronous operation.
        SplashScreen.hide();
        release.acknowledged = true;
        trace('splash release acknowledged', { attempt });
      } catch {
        console.warn('[LaunchTransition]', Date.now(), 'splash release failed', attempt);
        if (attempt === 1) {
          splashRetry = setTimeout(() => {
            splashRetry = undefined;
            releaseSplash('retry');
          }, SPLASH_RETRY_MS);
        }
      }
    };
    const stopMotion = () => {
      cancelAnimation(progress);
      cancelAnimation(contentOffset);
      cancelAnimation(brandScale);
      cancelAnimation(focus);
    };
    const run: LaunchRun = {
      started: false,
      finished: false,
      deadline: setTimeout(() => run.finish('startup timeout'), STARTUP_TIMEOUT_MS),
      releaseSplash,
      finish: reason => {
        if (runRef.current !== run || run.finished) return;
        run.finished = true;
        clearTimeout(run.measurement);
        clearTimeout(run.deadline);
        clearTimeout(run.reveal);
        releaseSplash(reason);
        if (run.started) stopMotion();
        trace('transition finished', { reason });
        setFinished(true);
      },
    };
    runRef.current = run;
    return () => {
      runRef.current = null;
      clearTimeout(splashRetry);
      clearTimeout(run.measurement);
      clearTimeout(run.deadline);
      clearTimeout(run.reveal);
      if (run.started && !run.finished) stopMotion();
    };
  }, [brandScale, contentOffset, focus, progress]);

  useEffect(() => {
    const hasCrossbar = validCrossbarY !== undefined;
    trace('gates', {
      laidOut, ready, wordWidth, prefix, throughE, rawCrossbarY, hasWidths, hasCrossbar, measurementExpired, reduceMotion, finished,
      originalGate: !!(laidOut && ready && wordWidth && prefix && throughE && rawCrossbarY),
    });
    const run = runRef.current;
    if (!run || !laidOut) return;
    if (android) run.releaseSplash('root layout');
    if (finished || run.started || run.finished) return;
    if (motionStarted.current) {
      run.finish('animation interrupted');
      return;
    }
    if (android && !measurementExpired && run.measurement === undefined) {
      run.measurement = setTimeout(() => {
        if (runRef.current === run && !run.finished) setMeasurementExpired(true);
      }, ANDROID_MEASUREMENT_MS);
    }
    if (!ready) return;
    if (reduceMotion) {
      run.finish('reduced motion');
      return;
    }
    if (!hasWidths) {
      if (android && measurementExpired) run.finish('missing wordmark widths');
      return;
    }
    if (!hasCrossbar && (!android || (line === undefined && !measurementExpired))) return;

    run.started = true;
    motionStarted.current = true;
    clearTimeout(run.measurement);
    clearTimeout(run.deadline);
    run.deadline = setTimeout(() => run.finish('animation timeout'), DURATION_MS + ANIMATION_GRACE_MS);
    setCameraTarget({
      focusX: -wordWidth / 2 + (prefix + throughE) / 2,
      focusY: (validCrossbarY ?? FALLBACK_CROSSBAR_Y) - 21,
    });
    run.releaseSplash('animation start');
    trace('animation started', { fallbackCrossbar: !hasCrossbar });
    const complete = (completed: boolean) => {
      if (runRef.current !== run || run.finished) return;
      trace('animation callback', { completed });
      if (completed) run.finish('animation complete');
    };
    run.reveal = setTimeout(() => {
      if (runRef.current === run && !run.finished) setContentVisible(true);
    }, CONTENT_REVEAL_MS);
    progress.value = withTiming(1, {
      duration: DURATION_MS,
      easing: Easing.linear,
    }, (completed) => {
      runOnJS(complete)(completed === true);
    });
    contentOffset.value = withDelay(CONTENT_REVEAL_MS, withSpring(0, Motion.settle));
    brandScale.value = withDelay(REVEAL_MS, withSequence(
      withTiming(0.88, { duration: COMPRESS_MS, easing: Easing.out(Easing.back(1.4)) }),
      withTiming(zoomScale, { duration: ZOOM_MS, easing: Easing.in(Easing.cubic) }),
    ));
    focus.value = withDelay(REVEAL_MS + COMPRESS_MS, withTiming(1, { duration: ZOOM_MS, easing: Easing.in(Easing.cubic) }));
  }, [android, brandScale, contentOffset, finished, focus, hasWidths, laidOut, line, measurementExpired,
    prefix, progress, rawCrossbarY, ready, reduceMotion, throughE, validCrossbarY, wordWidth, zoomScale]);

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
    opacity: !ready ? 0 : finished ? 1 : interpolate(progress.value, [
      0, CONTENT_REVEAL_MS / DURATION_MS,
      (ZOOM_START_MS + ZOOM_MS * 0.4) / DURATION_MS, 1,
    ], [0, 0, 1, 1], Extrapolation.CLAMP),
    transform: [{ translateY: finished ? 0 : contentOffset.value }],
  }));

  const contentInteractive = ready && finished;
  const waitingForSetup = !ready && (android || finished);
  return (
    <View style={styles.root} onLayout={event => {
      const { width, height } = event.nativeEvent.layout;
      trace('root layout', { width, height });
      if (positiveMetric(width) && positiveMetric(height)) setLaidOut(true);
    }}>
      <Animated.View
        style={[styles.root, contentStyle]}
        pointerEvents={contentInteractive ? 'auto' : 'none'}
        aria-hidden={!contentInteractive}
        accessibilityElementsHidden={!contentInteractive}
        importantForAccessibility={contentInteractive ? 'auto' : 'no-hide-descendants'}>
        <LaunchVisibilityContext.Provider value={ready && (finished || contentVisible)}>
          {children}
        </LaunchVisibilityContext.Provider>
      </Animated.View>
      {!finished && (
        <Animated.View
          style={[styles.overlay, overlayStyle]}
          accessibilityLabel="KineSync is opening"
          accessibilityRole="progressbar"
          accessibilityElementsHidden={waitingForSetup}
          importantForAccessibility={waitingForSetup ? 'no-hide-descendants' : 'auto'}>
          <View style={_stableStyle1} />
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
      {waitingForSetup && (
        <View style={[styles.overlay, styles.setupStatus]}>
          <Text style={styles.pendingLabel} accessibilityLiveRegion="polite">
            {finished ? 'Setup is taking longer than expected.' : 'Restoring setup…'}
          </Text>
          {android && finished && (
            <Pressable accessibilityRole="button" style={styles.retryButton} onPress={() => {
              void reloadAppAsync('Retry setup restore').catch(() => {
                Alert.alert('Could not retry setup', 'Close and reopen KineSync to try again.');
              });
            }}>
              <Text style={styles.retryLabel}>Retry setup</Text>
            </Pressable>
          )}
        </View>
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
  setupStatus: { backgroundColor: Design.background },
  pendingLabel: { color: Design.muted },
  retryButton: { padding: 12 },
  retryLabel: { color: Design.accent },
  name: { color: '#FFFFFF', fontSize: 32, lineHeight: 42, fontWeight: '800', letterSpacing: -1 },
  whiteStem: { position: 'absolute', backgroundColor: '#FFFFFF' },
});

// Static native props retain their identity across renders.
const _stableStyle1 = [StyleSheet.absoluteFill, styles.veil];
