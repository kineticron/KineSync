import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { cancelAnimation, Easing, useSharedValue, withTiming } from 'react-native-reanimated';
import { usePlaybackStore } from '@/store/playback-store';
import type { PreviewPlaybackAnchor } from '../use-playback-timeline-clock';

/** No playback-position React subscription and no JS frame/tick loop. */
export type NativeClockAnchor = { positionMs: number; monotonicMs: number; playing: boolean };

export function useNativeLyricsClock({ active, duration, preview, demo, playing, demoPlayback, anchor }: {
  active: boolean; duration: number; preview?: number | null; demo: boolean; playing?: boolean; demoPlayback?: PreviewPlaybackAnchor;
  /** Follow this clock instead of KineSync's playback (Sync Studio's local audio). */
  anchor?: NativeClockAnchor | null;
}) {
  const position = useSharedValue(0);
  const running = useSharedValue(false);
  const seekVersion = useSharedValue(0);
  const lastSync = useRef({ position: 0, monotonic: 0, playing: false, serial: 0 });
  const sync = useCallback(() => {
    cancelAnimation(position);
    const visible = active && AppState.currentState === 'active';
    running.value = visible;
    if (!visible) return;
    const state = usePlaybackStore.getState();
    const clock = anchor ? { isPlaying: anchor.playing, anchorPositionMs: anchor.positionMs, anchorMonotonicMs: anchor.monotonicMs }
      : demoPlayback ?? state;
    const isPlaying = demo && !anchor ? demoPlayback ? demoPlayback.isPlaying && preview == null : (playing ?? true) : clock.isPlaying && preview == null;
    const current = Math.max(0, Math.min(duration, preview ?? (demo && !demoPlayback && !anchor ? 0 : clock.anchorPositionMs +
      (clock.isPlaying ? Math.max(0, performance.now() - clock.anchorMonotonicMs) : 0))));
    const now = performance.now();
    const previous = lastSync.current;
    const expected = previous.position + (previous.playing ? Math.max(0, now - previous.monotonic) : 0);
    const serial = previous.serial + Number(previous.monotonic > 0 && Math.abs(current - expected) > 1000);
    lastSync.current = { position: current, monotonic: now, playing: isPlaying, serial };
    seekVersion.value = serial;
    position.value = current;
    if (isPlaying && current < duration) position.value = withTiming(duration, { duration: duration - current, easing: Easing.linear });
  }, [active, anchor, demo, demoPlayback, duration, playing, position, preview, running, seekVersion]);
  useFocusEffect(useCallback(() => {
    sync();
    const unsubscribe = demo ? () => {} : usePlaybackStore.subscribe((state, previous) => {
      if (state.anchorPositionMs !== previous.anchorPositionMs || state.anchorMonotonicMs !== previous.anchorMonotonicMs || state.isPlaying !== previous.isPlaying) sync();
    });
    const subscription = AppState.addEventListener('change', sync);
    return () => { unsubscribe(); subscription.remove(); running.value = false; cancelAnimation(position); };
  }, [demo, position, running, sync]));
  useEffect(() => () => cancelAnimation(position), [position]);
  return { position, running, seekVersion };
}
