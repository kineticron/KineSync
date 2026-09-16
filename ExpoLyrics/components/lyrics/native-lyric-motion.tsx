import { useEffect, type ReactNode } from "react";
import Animated, { cancelAnimation, useAnimatedReaction, useAnimatedStyle, useSharedValue,
  withDelay, withSpring, type SharedValue } from "react-native-reanimated";
import { type amlPositionSpring } from "@/lib/amll-native";

export type NativeLyricScroll = { from: number; target: number; revision: number; firstVisible: number; focus: number;
  spring: ReturnType<typeof amlPositionSpring> };

/** The list owns gestures/virtualization; each painted row owns its AMLL spring. */
export function NativeLyricMotion({ children, index, command, offset, enabled, active }: {
  children: ReactNode; index: number; command: SharedValue<NativeLyricScroll>;
  offset: SharedValue<number>; enabled: SharedValue<boolean>; active: boolean;
}) {
  const rowOffset = useSharedValue(command.value.target);
  useAnimatedReaction(() => ({ command: command.value, enabled: enabled.value && active }), (next, previous) => {
    if (!next.enabled) { cancelAnimation(rowOffset); return; }
    if (previous?.enabled && previous.command.revision === next.command.revision) return;
    if (!previous?.enabled) rowOffset.value = next.command.from;
    let delay = 0;
    let step = 50;
    for (let i = next.command.firstVisible; i < index; i++) {
      delay += step;
      if (i >= next.command.focus) step /= 1.05;
    }
    rowOffset.value = withDelay(delay, withSpring(next.command.target, next.command.spring));
  });
  useEffect(() => () => cancelAnimation(rowOffset), [rowOffset]);
  const motion = useAnimatedStyle(() => ({ transform: [{ translateY:
    enabled.value && active ? Math.max(0, offset.value) - rowOffset.value : 0 }] }));
  return <Animated.View style={motion}>{children}</Animated.View>;
}
