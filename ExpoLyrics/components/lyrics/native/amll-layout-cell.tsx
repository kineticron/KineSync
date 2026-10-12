import React, { forwardRef, useContext, useMemo } from 'react';
import { type View, type ViewProps } from 'react-native';
import Animated, { defineAnimation, useSharedValue, type Animation, type LayoutAnimationFunction, type SharedValue } from 'react-native-reanimated';
import { amllScrollSpring, stepAmllSpring } from './reference-motion';
import { ReferenceScrollContext } from './reference-scroll';

type CellMotion = { p: number; v: number; index: number };
interface CellSpring extends Animation<CellSpring> { current: number; velocity: number; timestamp: number }

/** Same solver as viewport/row motion, with retained position and velocity on interruption. */
function withLayoutSpring(motion: SharedValue<CellMotion>, stiffness: number, damping: number): number {
  'worklet';
  return defineAnimation<CellSpring>(0, () => {
    'worklet';
    return {
      current: 0, velocity: 0, timestamp: 0,
      onStart(animation, value, now) {
        animation.current = Number(value);
        animation.velocity = motion.value.v;
        animation.timestamp = now;
      },
      onFrame(animation, now) {
        const next = stepAmllSpring({ p: animation.current, v: animation.velocity }, 0, 0.9, damping, stiffness,
          Math.min(0.064, Math.max(0, (now - animation.timestamp) / 1000)));
        const settled = Math.abs(next.p) < 0.01 && Math.abs(next.v) < 0.01;
        animation.current = settled ? 0 : next.p;
        animation.velocity = settled ? 0 : next.v;
        animation.timestamp = now;
        motion.value = { ...motion.value, p: animation.current, v: animation.velocity };
        return settled;
      },
    };
  }) as unknown as number;
}

/** Animate changed cell positions, never their measured Yoga height. */
export const AmllLayoutCell = forwardRef<View, ViewProps & { index: number }>(function AmllLayoutCell({ index, ...props }, ref) {
  const host = useContext(ReferenceScrollContext)!;
  const motion = useSharedValue<CellMotion>({ p: 0, v: 0, index });
  const layout = useMemo<LayoutAnimationFunction>(() => values => {
    'worklet';
    const { stiffness, damping } = amllScrollSpring(host.command.value, index);
    const current = motion.value;
    // A recycled cell is a new row, not a layout transition of the previous row.
    const p = current.index === index ? current.p + values.currentOriginY - values.targetOriginY : 0;
    motion.value = { p, v: current.index === index ? current.v : 0, index };
    return {
      initialValues: { transform: [{ translateY: p }] },
      animations: { transform: [{ translateY: withLayoutSpring(motion, stiffness, damping) }] },
    };
  }, [host, index, motion]);
  return <Animated.View {...props} ref={ref} layout={layout} collapsable={false} />;
});
