import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { cancelAnimation, defineAnimation, useSharedValue, type AnimationObject } from 'react-native-reanimated';
import { usePlaybackStore } from '@/store/playback-store';
import type { PreviewPlaybackAnchor } from '../use-playback-timeline-clock';
import { beginNativeClockCapture, emitNativeClockDiagnostic, nextNativeClockInstance, reportNativeUiClock,
  setNativeClockStoreReader, type NativeClockCapture } from '@/lib/native-clock-diagnostics';
import { scheduleOnRN } from 'react-native-worklets';

// Keep the raw RN NativePerformance.now HostFunction. Worklets transports native
// HostFunctions directly; wrapping/binding this would lose that property. UI's
// global performance.now and display-link timestamps have different domains.
const nativeMonotonicNow = performance.now;

function projectAnchor(anchor: PreviewPlaybackAnchor, duration: number, now: number) {
  'worklet';
  return Math.max(0, Math.min(duration, anchor.anchorPositionMs +
    (anchor.isPlaying ? Math.max(0, now - anchor.anchorMonotonicMs) : 0)));
}

/** A media clock, independent of dispatch latency, frame cadence and Reduce Motion. */
function withNativePlaybackClock(anchor: PreviewPlaybackAnchor, duration: number, sampledAt: number, capture: NativeClockCapture | null) {
  'worklet';
  return defineAnimation<AnimationObject<number>>(0, () => {
    'worklet';
    return {
      current: 0,
      // Even a zero-position start must run; valueSetter otherwise skips an
      // animation whose initial current equals the shared value.
      isHigherOrder: true,
      reduceMotion: false,
      nativeClock: true,
      fallbackPosition: 0,
      fallbackTime: 0,
      traceFrames: 0,
      traceStarted: 0,
      onStart(animation: AnimationObject<number>) {
        try {
          const now = nativeMonotonicNow();
          if (!Number.isFinite(now)) throw new Error('Native monotonic clock unavailable');
          animation.current = projectAnchor(anchor, duration, now);
          if (capture) scheduleOnRN(reportNativeUiClock, capture, 'ui-clock-start', { nativeNow: now,
            uiNow: performance.now(), position: animation.current, playing: anchor.isPlaying, fallback: false,
            anchorPosition: anchor.anchorPositionMs, anchorMono: anchor.anchorMonotonicMs, sampledAt });
        } catch {
          // Defensive compatibility path for runtimes that wrap RN's native
          // clock in a remote JS function. Stay in one UI-local time domain;
          // this path retains the old handoff lag rather than mixing epochs.
          animation.nativeClock = false;
          animation.fallbackPosition = projectAnchor(anchor, duration, sampledAt);
          animation.fallbackTime = performance.now();
          animation.current = animation.fallbackPosition;
          if (__DEV__) console.warn('[NativeLyricsClock] Native uptime unavailable on UI; using receipt-relative fallback.');
          if (capture) scheduleOnRN(reportNativeUiClock, capture, 'ui-clock-start', { nativeNow: null,
            uiNow: performance.now(), position: animation.current, playing: anchor.isPlaying, fallback: true,
            anchorPosition: anchor.anchorPositionMs, anchorMono: anchor.anchorMonotonicMs, sampledAt });
        }
        if (capture) animation.traceStarted = performance.now();
      },
      onFrame(animation: AnimationObject<number>, frameTimestamp: number) {
        const nativeNow = animation.nativeClock ? nativeMonotonicNow() : null;
        animation.current = animation.nativeClock
          ? projectAnchor(anchor, duration, nativeNow!)
          : Math.max(0, Math.min(duration, animation.fallbackPosition +
            (anchor.isPlaying ? Math.max(0, performance.now() - animation.fallbackTime) : 0)));
        if (capture && animation.traceFrames < 3 && performance.now() - animation.traceStarted >= animation.traceFrames * 1000) {
          animation.traceFrames++;
          scheduleOnRN(reportNativeUiClock, capture, 'ui-clock-frame', { nativeNow, uiNow: performance.now(), frameTimestamp,
            position: animation.current, playing: anchor.isPlaying, fallback: !animation.nativeClock,
            anchorPosition: anchor.anchorPositionMs, anchorMono: anchor.anchorMonotonicMs });
        }
        return !anchor.isPlaying || animation.current >= duration;
      },
    };
  }) as unknown as number;
}

/** No playback-position React subscription and no JS frame/tick loop. */
export function useNativeLyricsClock({ active, duration, preview, demo, playing, demoPlayback, diagnosticStyle = 'unknown' }: {
  active: boolean; duration: number; preview?: number | null; demo: boolean; playing?: boolean; demoPlayback?: PreviewPlaybackAnchor;
  diagnosticStyle?: string;
}) {
  const position = useSharedValue(0);
  const running = useSharedValue(false);
  const seekVersion = useSharedValue(0);
  const diagnosticInstance = useRef(0);
  if (__DEV__ && !diagnosticInstance.current) diagnosticInstance.current = nextNativeClockInstance();
  const lastSync = useRef({ position: 0, monotonic: 0, playing: false, serial: 0, trackId: null as string | null });
  const sync = useCallback(() => {
    cancelAnimation(position);
    const visible = active && AppState.currentState === 'active';
    running.value = visible;
    if (!visible) return;
    if (__DEV__) setNativeClockStoreReader(usePlaybackStore.getState);
    const capture = __DEV__ && !demo ? beginNativeClockCapture(diagnosticStyle, diagnosticInstance.current) : null;
    const state = usePlaybackStore.getState();
    const source = demoPlayback ?? state;
    const isPlaying = demo ? demoPlayback ? demoPlayback.isPlaying && preview == null : (playing ?? true) : state.isPlaying && preview == null;
    const now = performance.now();
    const anchor = { anchorPositionMs: preview ?? (demo && !demoPlayback ? 0 : source.anchorPositionMs),
      anchorMonotonicMs: preview != null || demo && !demoPlayback ? now : source.anchorMonotonicMs, isPlaying };
    const current = projectAnchor(anchor, duration, now);
    const trackId = demo ? null : state.currentTrack?.id ?? null;
    const previous = lastSync.current;
    const expected = previous.position + (previous.playing ? Math.max(0, now - previous.monotonic) : 0);
    const serial = previous.serial + Number(previous.monotonic > 0 &&
      (trackId !== previous.trackId || Math.abs(current - expected) > 1000));
    lastSync.current = { position: current, monotonic: now, playing: isPlaying, serial, trackId };
    seekVersion.value = serial;
    if (capture) emitNativeClockDiagnostic('js-clock-sync', { anchorPosition: anchor.anchorPositionMs,
      anchorMono: anchor.anchorMonotonicMs, sampledAt: now, projected: current, playing: isPlaying, preview: preview ?? null, seekSerial: serial }, capture);
    position.value = withNativePlaybackClock(anchor, duration, now, capture);
  }, [active, demo, demoPlayback, diagnosticStyle, duration, playing, position, preview, running, seekVersion]);
  useFocusEffect(useCallback(() => {
    sync();
    const unsubscribe = demo ? () => {} : usePlaybackStore.subscribe((state, previous) => {
      if (state.anchorPositionMs !== previous.anchorPositionMs || state.anchorMonotonicMs !== previous.anchorMonotonicMs ||
        state.isPlaying !== previous.isPlaying || state.currentTrack?.id !== previous.currentTrack?.id) sync();
    });
    const subscription = AppState.addEventListener('change', sync);
    return () => { unsubscribe(); subscription.remove(); running.value = false; cancelAnimation(position); };
  }, [demo, position, running, sync]));
  useEffect(() => () => cancelAnimation(position), [position]);
  return { position, running, seekVersion };
}
