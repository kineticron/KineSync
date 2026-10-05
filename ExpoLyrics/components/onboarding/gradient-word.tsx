import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, type TextStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useAmbientMotion } from './setup-motion';

export function GradientWord({ text, colors, active, style }: { text: string; colors: readonly [string, string]; active: boolean; style: TextStyle }) {
  const phase = useAmbientMotion(active, text.startsWith('modern') ? 4200 : 5700);
  const drift = useAnimatedStyle(() => ({ transform: [{ translateX: `${-25 + phase.value * 25}%` }] }));
  return <MaskedView androidRenderingMode="software" maskElement={<Text style={[style, { color: '#000' }]}>{text}</Text>}>
    <Text style={[style, { opacity: 0 }]}>{text}</Text>
    <Animated.View style={[styles.field, drift]}>
      <LinearGradient colors={[colors[0], colors[1], colors[0]]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
    </Animated.View>
  </MaskedView>;
}
const styles = StyleSheet.create({ field: { position: 'absolute', top: 0, bottom: 0, left: 0, width: '200%' } });
