import { useEffect, type ReactNode } from "react";
import Animated, { cancelAnimation, useAnimatedReaction, useAnimatedStyle, useSharedValue,
  withDelay, withSpring, type SharedValue } from "react-native-reanimated";
import { type amlPositionSpring } from "@/lib/amll-native";

export type NativeLyricScroll = { from: number; target: number; revision: number; firstVisible: number; focus: number;
  spring: ReturnType<typeof amlPositionSpring> };

// Capped stagger window: distant rows snap instead of queueing delayed
// springs that outlive the list scroll.
const MAX_STAGGER_DELAY_MS = 280;
const STAGGER_SNAP_DISTANCE = 10;

/** The list owns gestures/virtualization; each painted row owns its AMLL spring. */
export function NativeLyricMotion({ children, index, command, offset, enabled, active }: {
  children: ReactNode; index: number; command: SharedValue<NativeLyricScroll>;
  offset: SharedValue<number>; enabled: SharedValue<boolean>; active: boolean;
}) {
  // Never read another shared value during React render. The reaction seeds the
  // exact command.from value before enabling the row spring, so zero is a safe
  // cold initial value and avoids per-row strict-mode warnings / JS noise.
  const rowOffset = useSharedValue(0);
  useAnimatedReaction(() => ({ command: command.value, enabled: enabled.value && active }), (next, previous) => {
    if (!next.enabled) { cancelAnimation(rowOffset); return; }
    if (previous?.enabled && previous.command.revision === next.command.revision) return;
    if (!previous?.enabled) rowOffset.value = next.command.from;
    // Far rows snap: unbounded delays keep springs queued on the UI thread
    // long after the list settles, overlapping the next scroll.
    if (Math.abs(index - next.command.focus) > STAGGER_SNAP_DISTANCE) {
      cancelAnimation(rowOffset);
      rowOffset.value = next.command.target;
      return;
    }
    let delay = 0;
    let step = 50;
    for (let i = next.command.firstVisible; i < index; i++) {
      delay += step;
      if (delay >= MAX_STAGGER_DELAY_MS) { delay = MAX_STAGGER_DELAY_MS; break; }
      if (i >= next.command.focus) step /= 1.05;
    }
    rowOffset.value = withDelay(delay, withSpring(next.command.target, next.command.spring));
  });
  useEffect(() => () => cancelAnimation(rowOffset), [rowOffset]);
  const motion = useAnimatedStyle(() => ({ transform: [{ translateY:
    enabled.value && active ? Math.max(0, offset.value) - rowOffset.value : 0 }] }));
  return <Animated.View style={motion}>{children}</Animated.View>;
}
