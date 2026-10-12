import React, { createContext, forwardRef, useCallback, useContext, useEffect } from 'react';
import { type ScrollView, type ScrollViewProps } from 'react-native';
import Animated, { cancelAnimation, scrollTo, useAnimatedReaction, useAnimatedRef, useAnimatedStyle,
  useFrameCallback, useScrollOffset, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { amllScrollSpring, spicyScrollDuration, spicyScrollEasing, stepAmllSpring } from './reference-motion';

export type ScrollCommand = { serial: number; offset: number; delta: number; index: number; firstVisible: number;
  interval: number; instant: boolean; interlude: boolean; snap: boolean; geometry?: boolean };
export const initialScrollCommand: ScrollCommand = { serial: 0, offset: 0, delta: 0, index: 0, firstVisible: 0,
  interval: 800, instant: true, interlude: false, snap: false };
export type ReferenceScroll = { command: SharedValue<ScrollCommand>; residual: SharedValue<number>; renderedResidual: SharedValue<number>; actualOffset: SharedValue<number>; spicy: boolean };
export const ReferenceScrollContext = createContext<ReferenceScroll | null>(null);

/** Scroll the real viewport continuously so recycled cells never teleport. */
export const ReferenceScrollView = forwardRef<ScrollView, ScrollViewProps>(function ReferenceScrollView(props, ref) {
  const host = useContext(ReferenceScrollContext)!;
  const nativeRef = useAnimatedRef<ScrollView>();
  const spring = useSharedValue({ p: 0, v: 0, stiffness: 90, damping: 15 });
  useScrollOffset(nativeRef, host.actualOffset);
  useAnimatedReaction(() => host.command.value, (command, previous) => {
    if (command.serial === previous?.serial || !command.serial) return;
    if (!command.snap || command.instant) {
      cancelAnimation(host.residual);
      host.residual.value = 0;
      host.renderedResidual.value = 0;
      spring.value = { ...spring.value, p: 0, v: 0 };
      if (command.snap) scrollTo(nativeRef, 0, command.offset, false);
      return;
    }
    if (command.geometry) {
      // Cells commit final geometry once and animate their old-to-new position
      // with a transform. Retarget the viewport on that same spring trajectory;
      // an instant scroll here would fight the cell animation on every resize.
      host.residual.value += command.delta;
      spring.value = { ...spring.value, p: spring.value.p + command.delta,
        ...amllScrollSpring(command, command.firstVisible) };
      return;
    }
    cancelAnimation(host.residual);
    // A manual drag can finish far from the offset at which it began.
    const delta = previous?.snap ? command.delta : command.offset - host.actualOffset.value;
    host.residual.value += delta;
    if (host.spicy) host.residual.value = withTiming(0, {
      duration: spicyScrollDuration(command.interval, false, command.interlude, Math.abs(delta)),
      easing: spicyScrollEasing,
    });
    else spring.value = { p: host.residual.value, v: spring.value.v,
      ...amllScrollSpring(command, command.firstVisible) };
  });
  useFrameCallback(useCallback(info => {
    'worklet';
    if (!host.command.value.snap || host.residual.value === 0) return;
    if (!host.spicy) {
      const s = spring.value;
      const next = stepAmllSpring(s, 0, 0.9, s.damping, s.stiffness,
        Math.min(0.064, Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000)));
      const settled = Math.abs(next.p) < 0.01 && Math.abs(next.v) < 0.01;
      spring.value = { ...s, p: settled ? 0 : next.p, v: settled ? 0 : next.v };
      host.residual.value = spring.value.p;
    }
    scrollTo(nativeRef, 0, Math.max(0, host.command.value.offset - host.residual.value), false);
    host.renderedResidual.value = host.residual.value;
  }, [host, nativeRef, spring]));
  // withTiming can reach zero between callbacks; apply its final endpoint too.
  useAnimatedReaction(() => host.residual.value, (value, previous) => {
    if (value === 0 && previous !== 0 && host.command.value.snap) {
      scrollTo(nativeRef, 0, host.command.value.offset, false);
      host.renderedResidual.value = 0;
    }
  });
  return <Animated.ScrollView {...props} ref={instance => {
    nativeRef(instance);
    if (typeof ref === 'function') ref(instance);
    else if (ref) ref.current = instance;
  }} />;
});

/** AMLL staggers the individual row springs; a single animated scroll cannot reproduce this. */
export function useReferenceRowScroll(host: ReferenceScroll, index: number, enabled: boolean) {
  const state = useSharedValue({ p: 0, v: 0, renderedP: 0, delay: 0, stiffness: 90, damping: 15 });
  useAnimatedReaction(() => ({ command: host.command.value, index }), ({ command, index: rowIndex }, previous) => {
    if (host.spicy) return;
    if (!previous || rowIndex !== previous.index) {
      state.value = { ...state.value, p: host.residual.value, v: 0, renderedP: host.renderedResidual.value, delay: 0 };
      return;
    }
    if (command.serial === previous.command.serial) return;
    if (command.instant) { state.value = { ...state.value, p: 0, v: 0, renderedP: 0, delay: 0 }; return; }
    if (command.geometry) {
      state.value = { ...state.value, p: state.value.p + command.delta,
        ...amllScrollSpring(command, index), delay: 0 };
      return;
    }
    state.value = { ...state.value, p: state.value.p + (previous.command.snap ? command.delta : command.offset - host.actualOffset.value), ...amllScrollSpring(previous.command.snap ? command : { ...command, firstVisible: command.index }, index) };
  });
  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    const s = state.value;
    if (s.p === 0 && s.v === 0 && s.renderedP === 0 && host.residual.value === 0) return;
    const dt = Math.min(0.064, Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000));
    if (s.delay > 0) { state.value = { ...s, renderedP: s.p, delay: Math.max(0, s.delay - dt) }; return; }
    const next = stepAmllSpring(s, 0, 0.9, s.damping, s.stiffness, dt);
    const settled = Math.abs(next.p) < 0.01 && Math.abs(next.v) < 0.01;
    state.value = { ...s, p: settled ? 0 : next.p, v: settled ? 0 : next.v,
      renderedP: settled ? 0 : next.p };
  }, [host, state]), false);
  useEffect(() => { frame.setActive(enabled && !host.spicy); return () => frame.setActive(false); }, [enabled, frame, host.spicy]);
  // Command reactions run independently. Subtracting the host residual here
  // exposes its full cue delta before the row reaction catches up, briefly
  // moving the outgoing line above the top bar. Use only frame-published values
  // for BOTH springs, so their callback order cannot introduce a one-frame lag.
  return useAnimatedStyle(() => ({ transform: [{ translateY:
    host.spicy || !host.command.value.snap ? 0 : state.value.renderedP - host.renderedResidual.value }] }));
}
