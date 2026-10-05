import { useEffect, useState } from 'react';
import { Text, type TextStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useAmbientMotion } from './setup-motion';

const AnimatedText = Animated.createAnimatedComponent(Text);
export function GradientWord({ text, colors, active, style }: { text: string; colors: readonly [string, string]; active: boolean; style: TextStyle }) {
  const phase = useAmbientMotion(active, text.startsWith('modern') ? 4200 : 5700);
  const drift = useAnimatedStyle(() => ({ backgroundPosition: `${phase.value * 100}% 0%` } as TextStyle));
  // Keep SSR markup readable until CSS background clipping is available.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <AnimatedText style={[style, mounted && {
    color: 'transparent', backgroundImage: `linear-gradient(90deg, ${colors[0]}, ${colors[1]}, ${colors[0]})`,
    backgroundSize: '200% 100%', backgroundClip: 'text', WebkitBackgroundClip: 'text',
  } as TextStyle, drift]}>{text}</AnimatedText>;
}
