import React, { createContext, forwardRef, useCallback, useContext, useEffect } from 'react';
import { type ScrollView, type ScrollViewProps } from 'react-native';
import Animated, { cancelAnimation, scrollTo, useAnimatedReaction, useAnimatedRef, useAnimatedStyle,
  useFrameCallback, useScrollOffset, useSharedValue, withTiming, runOnUI, type SharedValue } from 'react-native-reanimated';
import { advanceBatchedMotion, prepareBatchedRow, removeBatchedMotion, type BatchedMotion } from './batched-amll-motion';
import { amllScrollSpring, spicyScrollDuration, spicyScrollEasing, stepAmllSpring } from './reference-motion';

export type ScrollCommand = { serial: number; offset: number; delta: number; index: number; firstVisible: number;
  interval: number; instant: boolean; interlude: boolean; snap: boolean; geometry?: boolean };
export const initialScrollCommand: ScrollCommand = { serial: 0, offset: 0, delta: 0, index: 0, firstVisible: 0,
  interval: 800, instant: true, interlude: false, snap: false };
export type RowMotionEntry = { row: number; cell: number; vLead?: number; rowVLead?: number; cellVLead?: number; settled: boolean; owner?: SharedValue<number> };
export type ReferenceScroll = { command: SharedValue<ScrollCommand>; residual: SharedValue<number>; renderedResidual: SharedValue<number>; actualOffset: SharedValue<number>; spicy: boolean; motions?: SharedValue<Record<number, RowMotionEntry>>; batch?: SharedValue<BatchedMotion>; batchRows?: SharedValue<Record<number, RowMotionEntry>> };
export const ReferenceScrollContext = createContext<ReferenceScroll | null>(null);

function applyScrollCommand(host: ReferenceScroll, spring: SharedValue<{ p: number; v: number; stiffness: number; damping: number }>,
  nativeRef: ReturnType<typeof useAnimatedRef<ScrollView>>, command: ScrollCommand, previous: ScrollCommand | null) {
  'worklet';
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
}

/** Scroll the real viewport continuously so recycled cells never teleport. */
export const ReferenceScrollView = forwardRef<ScrollView, ScrollViewProps>(function ReferenceScrollView(props, ref) {
  const host = useContext(ReferenceScrollContext)!;
  const nativeRef = useAnimatedRef<ScrollView>();
  const spring = useSharedValue({ p: 0, v: 0, stiffness: 90, damping: 15 });
  useScrollOffset(nativeRef, host.actualOffset);
  useAnimatedReaction(() => host.command.value, (command, previous) => {
    if (!host.batch) applyScrollCommand(host, spring, nativeRef, command, previous);
  });
  useFrameCallback(useCallback(info => {
    'worklet';
    if (host.batch) {
      const command = host.command.value, previous = host.batch.value.command;
      if (command.serial !== previous?.serial) {
        applyScrollCommand(host, spring, nativeRef, command, previous ?? null);
        // Commands, viewport and row springs share one callback. No mapper can
        // observe a new viewport paired with an old row command state.
        const rows = host.batch.value.rows;
        for (const key in rows) {
          const index = Number(key), slot = rows[index];
          prepareBatchedRow(host, index, true, slot.state, slot.output, command,
            { command: slot.command, index });
        }
        host.batch.modify(value => { value.command = command; return value; }, false);
      }
    }
    if (!host.command.value.snap || host.residual.value === 0) {
      if (host.batch) advanceBatchedMotion(host, info.timeSincePreviousFrame);
      return;
    }
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
    if (host.batch) advanceBatchedMotion(host, info.timeSincePreviousFrame);
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
  const state = useSharedValue({ p: 0, v: 0, renderedP: 0, delay: 0, prevResidual: 0, stiffness: 90, damping: 15 });
  const output = useSharedValue(0);
  useAnimatedReaction(host.batch ? () => {
    'worklet';
    return { command: initialScrollCommand, index };
  } : () => {
    'worklet';
    return { command: host.command.value, index };
  }, ({ command, index: rowIndex }, previous) => {
    if (host.spicy) return;
    if (host.batch) return;
    if (!previous || rowIndex !== previous.index) {
      if (previous && host.motions) {
        const cur = host.motions.value;
        if (cur[previous.index]) {
          const next = { ...cur };
          delete next[previous.index];
          host.motions.value = next;
        }
      }
      state.value = { ...state.value, p: host.residual.value, v: 0, renderedP: host.renderedResidual.value, delay: 0, prevResidual: host.renderedResidual.value };
      if (host.motions) {
        const cur = host.motions.value[rowIndex];
        const curCell = cur?.cell ?? 0;
        const cellVLead = cur?.cellVLead ?? 0;
        host.motions.value = { ...host.motions.value, [rowIndex]: { row: 0, cell: curCell, vLead: cellVLead, cellVLead, settled: curCell === 0 } };
      }
      return;
    }
    if (command.serial === previous.command.serial) return;
    if (command.instant) {
      state.value = { ...state.value, p: 0, v: 0, renderedP: 0, delay: 0, prevResidual: host.renderedResidual.value };
      if (host.motions) {
        const cur = host.motions.value[rowIndex];
        const curCell = cur?.cell ?? 0;
        const cellVLead = cur?.cellVLead ?? 0;
        host.motions.value = { ...host.motions.value, [rowIndex]: { row: 0, cell: curCell, vLead: cellVLead, rowVLead: 0, cellVLead, settled: curCell === 0 } };
      }
      return;
    }
    if (command.geometry) {
      state.value = { ...state.value, p: state.value.p + command.delta,
        ...amllScrollSpring(command, index), delay: 0, prevResidual: host.renderedResidual.value };
      if (host.motions) {
        const rowDy = state.value.renderedP - host.renderedResidual.value;
        const cur = host.motions.value[rowIndex];
        const curCell = cur?.cell ?? 0;
        const cellVLead = cur?.cellVLead ?? 0;
        const worstHost = stepAmllSpring({ p: host.residual.value, v: 0 }, 0, 0.9, 15, 90, 0.064);
        const hostLead = Math.max(Math.abs(worstHost.p - host.residual.value), Math.abs(host.residual.value) * 0.45);
        const worstRow = stepAmllSpring({ p: state.value.p, v: 0 }, 0, 0.9, state.value.damping, state.value.stiffness, 0.064);
        const rowVLead = Math.abs(worstRow.p - state.value.p) + hostLead;
        host.motions.value = { ...host.motions.value, [rowIndex]: { row: rowDy, cell: curCell, vLead: rowVLead + cellVLead, rowVLead, cellVLead, settled: false } };
      }
      return;
    }
    state.value = { ...state.value, p: state.value.p + (previous.command.snap ? command.delta : command.offset - host.actualOffset.value), ...amllScrollSpring(previous.command.snap ? command : { ...command, firstVisible: command.index }, index), prevResidual: host.renderedResidual.value };
    if (host.motions) {
      const rowDy = state.value.renderedP - host.renderedResidual.value;
      const cur = host.motions.value[rowIndex];
      const curCell = cur?.cell ?? 0;
      const cellVLead = cur?.cellVLead ?? 0;
      const worstHost = stepAmllSpring({ p: host.residual.value, v: 0 }, 0, 0.9, 15, 90, 0.064);
      const hostLead = Math.max(Math.abs(worstHost.p - host.residual.value), Math.abs(host.residual.value) * 0.45);
      const worstRow = stepAmllSpring({ p: state.value.p, v: 0 }, 0, 0.9, state.value.damping, state.value.stiffness, 0.064);
      const rowVLead = Math.abs(worstRow.p - state.value.p) + hostLead;
      host.motions.value = { ...host.motions.value, [rowIndex]: { row: rowDy, cell: curCell, vLead: rowVLead + cellVLead, rowVLead, cellVLead, settled: false } };
    }
  });
  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    const s = state.value;
    if (s.p === 0 && s.v === 0 && s.renderedP === 0 && host.residual.value === 0) {
      if (host.motions) {
        const cur = host.motions.value[index];
        if (cur && (cur.row !== 0 || !cur.settled || (cur.vLead ?? 0) !== 0)) {
          host.motions.value = { ...host.motions.value, [index]: { row: 0, cell: cur.cell ?? 0, vLead: cur.cellVLead ?? 0, rowVLead: 0, cellVLead: cur.cellVLead ?? 0, settled: (cur.cell ?? 0) === 0 } };
        }
      }
      return;
    }
    const dt = Math.min(0.064, Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000)) || (1 / 60);
    const worstHost = stepAmllSpring({ p: host.residual.value, v: 0 }, 0, 0.9, 15, 90, 0.064);
    const measuredHostLead = Math.abs(host.renderedResidual.value - s.prevResidual);
    const hostLead = host.residual.value !== 0 ? Math.max(measuredHostLead, Math.abs(worstHost.p - host.residual.value), Math.abs(host.residual.value) * 0.45) : 0;
    if (s.delay > 0) {
      state.value = { ...s, renderedP: s.p, delay: Math.max(0, s.delay - dt), prevResidual: host.renderedResidual.value };
      if (host.motions) {
        const rowDy = s.p - host.renderedResidual.value;
        const cur = host.motions.value[index];
        const curCell = cur?.cell ?? 0;
        const cellVLead = cur?.cellVLead ?? 0;
        const worstRow = stepAmllSpring({ p: s.p, v: 0 }, 0, 0.9, s.damping, s.stiffness, 0.064);
        const rowVLead = Math.abs(worstRow.p - s.p) + hostLead;
        host.motions.value = { ...host.motions.value, [index]: { row: rowDy, cell: curCell, vLead: rowVLead + cellVLead, rowVLead, cellVLead, settled: false } };
      }
      return;
    }
    const next = stepAmllSpring(s, 0, 0.9, s.damping, s.stiffness, dt);
    const settled = Math.abs(next.p) < 0.01 && Math.abs(next.v) < 0.01;
    state.value = { ...s, p: settled ? 0 : next.p, v: settled ? 0 : next.v,
      renderedP: settled ? 0 : next.p, prevResidual: host.renderedResidual.value };
    if (host.motions) {
      const rowDy = settled ? 0 : next.p - host.renderedResidual.value;
      const cur = host.motions.value[index];
      const curCell = cur?.cell ?? 0;
      const cellVLead = cur?.cellVLead ?? 0;
      const worstRow = stepAmllSpring({ p: next.p, v: next.v }, 0, 0.9, s.damping, s.stiffness, 0.064);
      const rowLead = settled ? 0 : Math.max(Math.abs(worstRow.p - next.p), Math.abs(next.v) * 0.064, 0.01);
      const rowVLead = settled && host.residual.value === 0 ? 0 : rowLead + hostLead;
      host.motions.value = { ...host.motions.value, [index]: { row: rowDy, cell: curCell, vLead: rowVLead + cellVLead, rowVLead, cellVLead, settled: settled && curCell === 0 } };
    }
  }, [host, state, index]), false);
  useEffect(() => {
    frame.setActive(enabled && !host.spicy && !host.batch);
    if (host.batch && enabled && !host.spicy) runOnUI(() => {
      'worklet';
      // Register outside the mapper pass. Commands are consumed by the single
      // viewport callback, so the publisher never depends on reaction ordering.
      prepareBatchedRow(host, index, true, state, output, host.command.value, null);
    })();
    return () => {
      frame.setActive(false);
      if (host.batch) {
        runOnUI(removeBatchedMotion)(host.batch, index, output, false);
      } else if (host.motions) {
        const cur = host.motions.value;
        if (cur[index]) {
          const next = { ...cur };
          delete next[index];
          host.motions.value = next;
        }
      }
    };
  }, [enabled, frame, host, index, output, state]);
  // Command reactions run independently. Subtracting the host residual here
  // exposes its full cue delta before the row reaction catches up, briefly
  // moving the outgoing line above the top bar. Use only frame-published values
  // for BOTH springs, so their callback order cannot introduce a one-frame lag.
  const spicy = host.spicy;
  const command = host.command;
  const renderedResidual = host.renderedResidual;
  const batched = !!host.batch;
  return useAnimatedStyle(batched ? () => {
    'worklet';
    return { transform: [{ translateY: output.value }] };
  } : () => {
    'worklet';
    return { transform: [{ translateY: spicy || !command.value.snap ? 0 : state.value.renderedP - renderedResidual.value }] };
  });
}
