import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useState, type PropsWithChildren } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation, Easing, Extrapolation, interpolate, runOnJS,
  useAnimatedStyle, useReducedMotion, useSharedValue, withTiming,
} from 'react-native-reanimated';

import { Design } from '@/constants/design';

// Runs before the root mounts, so the OS splash hands off to a painted logo.
void SplashScreen.preventAutoHideAsync().catch(() => {});

export function LaunchTransition({ ready, children }: PropsWithChildren<{ ready: boolean }>) {
  const reduceMotion = useReducedMotion();
  const [laidOut, setLaidOut] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [finished, setFinished] = useState(false);
  const progress = useSharedValue(0);
  const finish = useCallback(() => setFinished(true), []);

  useEffect(() => {
    // A failed image decode must never strand someone on the native splash.
    const fallback = setTimeout(() => setImageReady(true), 1200);
    return () => clearTimeout(fallback);
  }, []);

  useEffect(() => {
    if (!laidOut || !imageReady || !ready || finished) return;
    void SplashScreen.hideAsync().catch(() => {});
    if (reduceMotion) {
      progress.value = 1;
      finish();
      return;
    }
    progress.value = withTiming(1, {
      duration: 1050,
      easing: Easing.linear,
    }, (complete) => {
      if (complete) runOnJS(finish)();
    });
    return () => cancelAnimation(progress);
  }, [finish, finished, imageReady, laidOut, progress, ready, reduceMotion]);

  const logoStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.64, 0.9], [1, 1, 0], Extrapolation.CLAMP),
    transform: [
      { translateY: interpolate(progress.value, [0, 0.32, 1], [0, -12, -62]) },
      { scale: interpolate(progress.value, [0, 0.22, 0.4, 1], [1, 1.08, 1, 0.68]) },
      { rotate: `${interpolate(progress.value, [0, 0.22, 0.4, 1], [0, -5, 0, 6])}deg` },
    ],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.18, 0.65], [0, 0.5, 0], Extrapolation.CLAMP),
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.7, 2.3]) }],
  }));
  const labelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.18, 0.52, 0.76], [0, 1, 1, 0], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(progress.value, [0, 1], [8, -12]) }],
  }));
  const veilStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.6, 1], [1, 1, 0], Extrapolation.CLAMP),
  }));
  const contentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.56, 1], [0, 0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(progress.value, [0, 0.56, 1], [16, 16, 0], Extrapolation.CLAMP) }],
  }));

  return (
    <View style={styles.root} onLayout={() => setLaidOut(true)}>
      <Animated.View
        style={[styles.root, !finished && contentStyle]}
        pointerEvents={finished ? 'auto' : 'none'}
        aria-hidden={!finished}
        accessibilityElementsHidden={!finished}
        importantForAccessibility={finished ? 'auto' : 'no-hide-descendants'}>
        {children}
      </Animated.View>
      {!finished && (
        <View style={styles.overlay} accessibilityLabel="KineSync is opening" accessibilityRole="progressbar">
          <Animated.View style={[StyleSheet.absoluteFill, styles.veil, veilStyle]} />
          <Animated.View style={[styles.ring, ringStyle]} />
          <Animated.View style={[styles.logo, logoStyle]}>
            <Image source={require('@/assets/images/R.png')} style={styles.image} contentFit="contain" onLoad={() => setImageReady(true)} onError={() => setImageReady(true)} />
          </Animated.View>
          <Animated.View style={[styles.wordmark, labelStyle]}>
            <Text style={styles.name}>KineSync</Text>
            <Text style={styles.tagline}>Feel every word.</Text>
          </Animated.View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, overflow: 'hidden', backgroundColor: Design.background },
  overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  veil: { backgroundColor: Design.background },
  logo: { width: 112, height: 112 },
  image: { width: '100%', height: '100%', borderRadius: 28 },
  ring: { position: 'absolute', width: 164, height: 164, borderRadius: 82, borderWidth: 1, borderColor: Design.accent },
  wordmark: { position: 'absolute', top: '50%', marginTop: 90, alignItems: 'center', gap: 8 },
  name: { color: Design.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.9 },
  tagline: { color: Design.muted, fontSize: 14, letterSpacing: 0.3 },
});
