import { useState } from 'react';
import { Pressable, type PressableProps } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';

import { Motion } from '@/constants/design';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** A small, interruptible spring. Preserves native press/long-press semantics. */
export function MotionPressable({ style, onPressIn, onPressOut, onHoverIn, onHoverOut, disabled, accessibilityRole = 'button', ...props }: PressableProps) {
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <AnimatedPressable
      {...props}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      style={[typeof style === 'function' ? style({ pressed, hovered }) : style, animatedStyle]}
      onHoverIn={(event) => { setHovered(true); onHoverIn?.(event); }}
      onHoverOut={(event) => { setHovered(false); onHoverOut?.(event); }}
      onPressIn={(event) => {
        setPressed(true);
        scale.value = reduceMotion ? 1 : withSpring(0.97, Motion.press);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        scale.value = withSpring(1, Motion.settle);
        onPressOut?.(event);
      }}
    />
  );
}
