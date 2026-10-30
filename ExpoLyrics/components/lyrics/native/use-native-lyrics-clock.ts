import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { cancelAnimation, Easing, useFrameCallback, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { usePlaybackStore } from '@/store/playback-store';
import type { PreviewPlaybackAnchor } from '../use-playback-timeline-clock';
import { projectUiFrameFromJsProjection, type NativeDiagnostics } from './native-render-diagnostics';

/** No playback-position React subscription and no JS frame/tick loop. */
export function useNativeLyricsClock({ active, duration, preview, demo, playing, demoPlayback, diagnostics }: {
  active: boolean; duration: number; preview?: number | null; demo: boolean; playing?: boolean; demoPlayback?: PreviewPlaybackAnchor;
  diagnostics?: NativeDiagnostics | null;
}) {
  const position = useSharedValue(0);
  const running = useSharedValue(false);
  const seekVersion = useSharedValue(0);
  const diagnosticProjection = useSharedValue({ serial: 0, reportedSerial: 0, jsTime: 0, position: 0, playing: false,
    source: '', generation: 0 });
  const projectionSerial = useRef(0);
  const diagnosticsRef = useRef(diagnostics);
  diagnosticsRef.current = diagnostics;
  const lastSync = useRef({ position: 0, monotonic: 0, playing: false, serial: 0 });
  const sync = useCallback(() => {
    cancelAnimation(position);
    const visible = active && AppState.currentState === 'active';
    running.value = visible;
    if (!visible) return;
    const state = usePlaybackStore.getState();
    const anchor = demoPlayback ?? state;
    const isPlaying = demo ? demoPlayback ? demoPlayback.isPlaying && preview == null : (playing ?? true) : state.isPlaying && preview == null;
    const current = Math.max(0, Math.min(duration, preview ?? (demo && !demoPlayback ? 0 : anchor.anchorPositionMs +
      (anchor.isPlaying ? Math.max(0, performance.now() - anchor.anchorMonotonicMs) : 0))));
    const now = performance.now();
    const previous = lastSync.current;
    const expected = previous.position + (previous.playing ? Math.max(0, now - previous.monotonic) : 0);
    const serial = previous.serial + Number(previous.monotonic > 0 && Math.abs(current - expected) > 1000);
    lastSync.current = { position: current, monotonic: now, playing: isPlaying, serial };
    seekVersion.value = serial;
    position.value = current;
    if (isPlaying && current < duration) position.value = withTiming(duration, { duration: duration - current, easing: Easing.linear });
    const diagnostic = diagnosticsRef.current;
    if (__DEV__ && diagnostic) {
      const nextProjectionSerial = ++projectionSerial.current;
      const source = demo ? demoPlayback ? 'demo_anchor' : 'demo_preview' : 'playback_store';
      diagnostic.recordProjection({ serial: nextProjectionSerial, jsTime: now, position: current, playing: isPlaying, source });
      if (diagnostic.isCaptureActive()) diagnosticProjection.value = { serial: nextProjectionSerial, reportedSerial: 0, jsTime: now,
        position: current, playing: isPlaying, source, generation: diagnostic.getGeneration() };
      const reason = previous.serial === 0 ? 'initial_focus' : 'anchor_update';
      if (diagnostic.isCaptureActive()) {
        const generation = diagnostic.getGeneration();
        setTimeout(() => diagnostic.report('anchor_projected', { source,
          anchorPositionMs: Math.round(anchor.anchorPositionMs), projectedPositionMs: Math.round(current), isPlaying,
          focusOrAnchorUpdate: reason }, generation), 0);
      }
    }
  }, [active, demo, demoPlayback, diagnosticProjection, duration, playing, position, preview, running, seekVersion]);
  useFocusEffect(useCallback(() => {
    sync();
    const unsubscribe = demo ? () => {} : usePlaybackStore.subscribe((state, previous) => {
      if (state.anchorPositionMs !== previous.anchorPositionMs || state.anchorMonotonicMs !== previous.anchorMonotonicMs || state.isPlaying !== previous.isPlaying) sync();
    });
    const subscription = AppState.addEventListener('change', sync);
    return () => { unsubscribe(); subscription.remove(); running.value = false; cancelAnimation(position); };
  }, [demo, position, running, sync]));
  const clockObserver = useFrameCallback(useCallback(info => {
    'worklet';
    const projection = diagnosticProjection.value;
    if (!diagnostics || projection.serial === 0 || projection.serial === projection.reportedSerial) return;
    if (!diagnostics.stats.value.captureEnabled) return;
    const stats = diagnostics.stats.value;
    if (projection.generation !== stats.generation) return;
    const uiNow = performance.now();
    const projected = stats.uiOffsetMs == null ? null : projectUiFrameFromJsProjection(projection.jsTime, projection.position,
      projection.playing, uiNow, stats.uiOffsetMs);
    scheduleOnRN(diagnostics.reportUi, stats.generation, 'clock_ui_first_frame', uiNow, {
      projectedPositionMs: Math.round(projection.position), observedPositionMs: Math.round(position.value),
      expectedPositionMs: projected?.expectedPositionMs ?? null,
      projectionToFrameMs: projected?.projectionToFrameMs ?? null,
      projectionJsTimeMs: projection.jsTime,
      isPlaying: projection.playing,
      calibrationReady: stats.uiOffsetMs != null,
    }, { offsetMs: stats.uiOffsetMs, errorMs: stats.offsetErrorMs });
    diagnosticProjection.modify(value => { value.reportedSerial = value.serial; return value; }, false);
  }, [diagnostics, diagnosticProjection, position]), false);
  useEffect(() => diagnostics ? diagnostics.registerClockObserver((activeObserver, projection) => {
    if (activeObserver && projection) diagnosticProjection.value = projection;
    clockObserver.setActive(activeObserver);
  }) : undefined,
    [clockObserver, diagnosticProjection, diagnostics]);
  useEffect(() => () => cancelAnimation(position), [position]);
  return { position, running, seekVersion };
}
