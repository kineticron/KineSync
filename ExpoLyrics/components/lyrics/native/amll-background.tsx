import React, { memo, useCallback, useEffect, type ReactNode } from 'react';
import Animated, { Easing, useAnimatedReaction, useAnimatedStyle, useFrameCallback, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { amllScrollSpring, clamp01, stepAmllSpring } from './reference-motion';
import type { ReferenceScroll } from './reference-scroll';

/** AMLL's background occupies flow only while active (or paused), and slides from -80%. */
export const AmllBackground = memo(function AmllBackground({ children, active, playing, fontSize, referenceScroll, index, right }: {
  children: ReactNode; active: SharedValue<boolean>; playing: boolean; fontSize: number; referenceScroll: ReferenceScroll; index: number; right: boolean;
}) {
  const height = useSharedValue(0);
  const opacity = useSharedValue(playing ? 0 : 1);
  const spring = useSharedValue({ p: playing ? -80 : 0, v: 0, initialized: false });
  const parameters = useSharedValue({ delay: 0, stiffness: 90, damping: 15 });
  useAnimatedReaction(() => referenceScroll.command.value, (command, previous) => {
    if (command.serial === previous?.serial) return;
    const config = amllScrollSpring(command, index);
    parameters.value = { ...config, delay: command.instant ? 0 : config.delay };
    if (command.instant) spring.value = { p: active.value || !playing ? 0 : -80, v: 0, initialized: true };
  });
  useAnimatedReaction(() => active.value || !playing, (show, previous) => {
    if (show !== previous) opacity.value = previous === null ? Number(show) : withTiming(Number(show),
      { duration: 300, easing: Easing.bezier(0.25, 0.1, 0.25, 1) });
  });
  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    const target = active.value || !playing ? 0 : -80;
    const current = spring.value;
    if (current.p === target && current.v === 0 && current.initialized) return;
    const dt = Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000);
    const config = parameters.value;
    if (current.initialized && config.delay > 0) { parameters.value = { ...config, delay: Math.max(0, config.delay - dt) }; return; }
    const next = current.initialized ? stepAmllSpring(current, target, 0.9, config.damping, config.stiffness, dt) : { p: target, v: 0 };
    const settled = Math.abs(next.p - target) < 0.01 && Math.abs(next.v) < 0.01;
    spring.value = { p: settled ? target : next.p, v: settled ? 0 : next.v, initialized: true };
  }, [active, parameters, playing, spring]), false);
  useEffect(() => { frame.setActive(true); return () => frame.setActive(false); }, [frame]);
  const style = useAnimatedStyle(() => {
    const show = active.value || !playing;
    return { position: show ? 'relative' : 'absolute', top: show ? 0 : '100%', width: '100%',
      marginTop: show ? fontSize * 0.3 : 0, opacity: opacity.value * 0.4,
      transform: [{ translateY: height.value * spring.value.p / 100 }, { scale: 0.8 + 0.2 * clamp01(1 - Math.abs(spring.value.p) / 80) }],
      transformOrigin: right ? 'right top' : 'left top' };
  });
  return <Animated.View style={style} onLayout={event => { height.value = event.nativeEvent.layout.height; }}>{children}</Animated.View>;
});
