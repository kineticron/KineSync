import { forwardRef, useState, type ComponentRef, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Touchable, type TouchableProps } from 'react-native-gesture-handler';

export type NativeTouchableState = {
  pressed: boolean;
  hovered: boolean;
};

type NativeTouchableStyle =
  | StyleProp<ViewStyle>
  | ((state: NativeTouchableState) => StyleProp<ViewStyle>);

export type NativeTouchableProps = Omit<TouchableProps, 'children' | 'style'> & {
  children?: ReactNode | ((state: NativeTouchableState) => ReactNode);
  style?: NativeTouchableStyle;
};

/**
 * The app's native press target. RNGH's Touchable only reports press-in after
 * the platform recognizes the press, so a scroll or swipe that starts on a
 * control never flashes its pressed state. Holding the press-out until the
 * press-in transition finishes keeps very quick taps visibly acknowledged.
 */
export const NativeTouchable = forwardRef<
  ComponentRef<typeof Touchable>,
  NativeTouchableProps
>(function NativeTouchable(
  {
    style,
    children,
    disabled = false,
    accessible = true,
    accessibilityState,
    delayLongPress = 500,
    onPressIn,
    onPressOut,
    onHoverIn,
    onHoverOut,
    ...props
  },
  ref,
) {
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const tracksState =
    typeof style === 'function' || typeof children === 'function';
  const resolvedStyle =
    typeof style === 'function' ? style({ pressed, hovered }) : style;
  const resolvedChildren =
    typeof children === 'function' ? children({ pressed, hovered }) : children;

  return (
    <Touchable
      {...props}
      ref={ref}
      disabled={disabled}
      accessible={accessible}
      accessibilityState={
        disabled ? { ...accessibilityState, disabled: true } : accessibilityState
      }
      delayLongPress={delayLongPress}
      style={resolvedStyle}
      immediatePressOut={false}
      onPressIn={(event) => {
        if (tracksState) setPressed(true);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        if (tracksState) setPressed(false);
        onPressOut?.(event);
      }}
      onHoverIn={(event) => {
        if (tracksState) setHovered(true);
        onHoverIn?.(event);
      }}
      onHoverOut={(event) => {
        if (tracksState) setHovered(false);
        onHoverOut?.(event);
      }}>
      {resolvedChildren}
    </Touchable>
  );
});
