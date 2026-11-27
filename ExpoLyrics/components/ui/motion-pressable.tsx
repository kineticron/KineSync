import { forwardRef, useState, type ComponentRef, type ComponentProps, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Touchable } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';

import { Motion } from '@/constants/design';

const AnimatedTouchable = Animated.createAnimatedComponent(Touchable);

type TouchableProps = ComponentProps<typeof Touchable>;
type PressState = { pressed: boolean; hovered: boolean };

type MotionPressableProps = Omit<TouchableProps, 'children' | 'style'> & {
  children?: ReactNode | ((state: PressState) => ReactNode);
  style?: StyleProp<ViewStyle> | ((state: PressState) => StyleProp<ViewStyle>);
};

/** A small, interruptible spring over a platform-delayed native press target. */
export const MotionPressable = forwardRef<
  ComponentRef<typeof Touchable>,
  MotionPressableProps
>(function MotionPressable(
  {
    style,
    children,
    onPressIn,
    onPressOut,
    onHoverIn,
    onHoverOut,
    disabled,
    accessible = true,
    accessibilityRole = 'button',
    accessibilityState,
    delayLongPress = 500,
    ...props
  },
  ref,
) {
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const tracksState = typeof style === 'function' || typeof children === 'function';
  const resolvedChildren =
    typeof children === 'function' ? children({ pressed, hovered }) : children;

  return (
    <AnimatedTouchable
      {...props}
      ref={ref}
      disabled={disabled}
      accessible={accessible}
      accessibilityRole={accessibilityRole}
      accessibilityState={
        disabled ? { ...accessibilityState, disabled: true } : accessibilityState
      }
      delayLongPress={delayLongPress}
      immediatePressOut={false}
      style={[typeof style === 'function' ? style({ pressed, hovered }) : style, animatedStyle]}
      onHoverIn={(event) => { if (tracksState) setHovered(true); onHoverIn?.(event); }}
      onHoverOut={(event) => { if (tracksState) setHovered(false); onHoverOut?.(event); }}
      onPressIn={(event) => {
        if (tracksState) setPressed(true);
        scale.value = reduceMotion ? 1 : withSpring(0.97, Motion.press);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        if (tracksState) setPressed(false);
        scale.value = withSpring(1, Motion.settle);
        onPressOut?.(event);
      }}>
      {resolvedChildren}
    </AnimatedTouchable>
  );
});
