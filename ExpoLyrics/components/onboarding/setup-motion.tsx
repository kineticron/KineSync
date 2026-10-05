import { useContext, useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View, type TextStyle, type StyleProp } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { LaunchVisibilityContext } from '@/components/ui/launch-visibility';

// Existing palettes, reproduced with their original stops. WebGradients by itmeo:
// https://github.com/itmeo/webgradients/blob/master/webgradients.css
export const SETUP_GRADIENT = ['#a7a6cb', '#8989ba', '#8989ba'] as const; // 060 Polite Rumors
export const MODERN_GRADIENT = ['#a1c4fd', '#c2e9fb'] as const; // 010 Winter Neva
export const BEAUTIFUL_GRADIENT = ['#a8edea', '#fed6e3'] as const; // 023 Rare Wind

export function useAmbientMotion(active: boolean, duration = 10000) {
  const reduceMotion = useReducedMotion();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const phase = useSharedValue(0);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (active && foreground && !reduceMotion) {
      phase.value = 0;
      phase.value = withRepeat(withTiming(1, { duration, easing: Easing.bezier(0.45, 0, 0.55, 1) }), -1, true);
    }
    return () => cancelAnimation(phase);
  }, [active, duration, foreground, phase, reduceMotion]);
  return phase;
}

export function SetupBackground() {
  const phase = useAmbientMotion(true, 14000);
  const drift = useAnimatedStyle(() => ({ transform: [
    { translateX: (phase.value - 0.5) * 100 },
    { translateY: (phase.value - 0.5) * 140 },
    { rotate: `${-14 + phase.value * 28}deg` },
  ] }));
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <Animated.View style={[styles.gradientField, drift]}>
      <LinearGradient colors={SETUP_GRADIENT} locations={[0, 0.52, 1]} start={{ x: 0, y: 1 }} end={{ x: 0, y: 0 }} style={StyleSheet.absoluteFill} />
    </Animated.View>
    <View style={[StyleSheet.absoluteFill, styles.shade]} />
  </View>;
}

/** One emphasized syllable: a slow left-to-right fill without scaling the panel. */
export function LyricReveal({ text, active, style }: { text: string; active: boolean; style: StyleProp<TextStyle> }) {
  const launchVisible = useContext(LaunchVisibilityContext);
  const reduceMotion = useReducedMotion();
  const fill = useSharedValue(0);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    fill.value = active && launchVisible ? (reduceMotion ? 1 : withTiming(1, { duration: 1500, easing: Easing.linear })) : 0;
    return () => cancelAnimation(fill);
  }, [active, fill, launchVisible, reduceMotion]);
  const clipping = useAnimatedStyle(() => ({ width: width * fill.value }));
  return <View accessible accessibilityRole="header" accessibilityLabel={text}>
    <Text aria-hidden onLayout={event => setWidth(Math.ceil(event.nativeEvent.layout.width) + 1)} style={[style, { opacity: 0.32 }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{text}</Text>
    <Animated.View aria-hidden pointerEvents="none" style={[styles.reveal, clipping]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text style={[style, { width, color: '#FFFFFF', textShadowColor: 'rgba(255,255,255,0.28)', textShadowRadius: 10 }]}>{text}</Text>
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  gradientField: { position: 'absolute', top: '-30%', bottom: '-30%', left: '-50%', right: '-50%' },
  shade: { backgroundColor: 'rgba(9,12,19,0.82)' },
  reveal: { position: 'absolute', top: 0, bottom: 0, left: 0, overflow: 'hidden' },
});
