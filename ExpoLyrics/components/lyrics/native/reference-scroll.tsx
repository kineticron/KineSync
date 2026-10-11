import React, { createContext, forwardRef, useCallback, useContext, useEffect } from 'react';
import { type ScrollView, type ScrollViewProps } from 'react-native';
import Animated, { cancelAnimation, scrollTo, useAnimatedReaction, useAnimatedRef, useAnimatedStyle,
  useFrameCallback, useScrollOffset, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { amllScrollSpring, spicyScrollDuration, spicyScrollEasing, stepAmllSpring } from './reference-motion';

export type ScrollCommand = { serial: number; offset: number; delta: number; index: number; firstVisible: number;
  interval: number; instant: boolean; interlude: boolean; snap: boolean };
export const initialScrollCommand: ScrollCommand = { serial: 0, offset: 0, delta: 0, index: 0, firstVisible: 0,
  interval: 800, instant: true, interlude: false, snap: false };
export type ReferenceScroll = { command: SharedValue<ScrollCommand>; residual: SharedValue<number>; actualOffset: SharedValue<number>; spicy: boolean };
export const ReferenceScrollContext = createContext<ReferenceScroll | null>(null);

/** Move the recycled list once, then animate its visual displacement entirely on the UI thread. */
export const ReferenceScrollView = forwardRef<ScrollView, ScrollViewProps>(function ReferenceScrollView(props, ref) {
  const host = useContext(ReferenceScrollContext)!;
  const nativeRef = useAnimatedRef<ScrollView>();
  useScrollOffset(nativeRef, host.actualOffset);
  useAnimatedReaction(() => host.command.value, (command, previous) => {
    if (command.serial === previous?.serial || !command.serial) return;
    if (host.spicy) {
      cancelAnimation(host.residual);
      host.residual.value = command.instant ? 0 : host.residual.value + command.delta;
      if (!command.instant) host.residual.value = withTiming(0, {
        duration: spicyScrollDuration(command.interval, false, command.interlude, Math.abs(command.delta)),
        easing: spicyScrollEasing,
      });
    }
    if (command.snap) scrollTo(nativeRef, 0, command.offset, false);
  });
  return <Animated.ScrollView {...props} ref={instance => {
    nativeRef(instance);
    if (typeof ref === 'function') ref(instance);
    else if (ref) ref.current = instance;
  }} />;
});

/** AMLL staggers the individual row springs; a single animated scroll cannot reproduce this. */
export function useReferenceRowScroll(host: ReferenceScroll, index: number, enabled: boolean) {
  const state = useSharedValue({ p: 0, v: 0, delay: 0, stiffness: 90, damping: 15 });
  useAnimatedReaction(() => host.command.value, (command, previous) => {
    if (command.serial === previous?.serial || host.spicy) return;
    if (command.instant) { state.value = { ...state.value, p: 0, v: 0, delay: 0 }; return; }
    state.value = { p: state.value.p + command.delta, v: state.value.v, ...amllScrollSpring(command, index) };
  });
  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    const s = state.value;
    if (s.p === 0 && s.v === 0) return;
    const dt = Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000);
    if (s.delay > 0) { state.value = { ...s, delay: Math.max(0, s.delay - dt) }; return; }
    const next = stepAmllSpring(s, 0, 0.9, s.damping, s.stiffness, dt);
    const settled = Math.abs(next.p) < 0.01 && Math.abs(next.v) < 0.01;
    state.value = { ...s, p: settled ? 0 : next.p, v: settled ? 0 : next.v };
  }, [state]), false);
  useEffect(() => { frame.setActive(enabled && !host.spicy); return () => frame.setActive(false); }, [enabled, frame, host.spicy]);
  return useAnimatedStyle(() => ({ transform: [{ translateY:
    (host.command.value.snap ? host.actualOffset.value - host.command.value.offset : 0) +
    (host.spicy ? host.residual.value : state.value.p) }] }));
}
