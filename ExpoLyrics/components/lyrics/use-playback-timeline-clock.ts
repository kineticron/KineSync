import { useCallback } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { cancelAnimation, Easing, useSharedValue, withTiming } from "react-native-reanimated";
import { usePlaybackStore } from "@/store/playback-store";

/** One UI-thread clock per anchor, instead of restarting a tween every store tick. */
export function usePlaybackTimelineClock(durationMs: number) {
  const position = useSharedValue(usePlaybackStore.getState().playbackPosition);
  useFocusEffect(useCallback(() => {
    const sync = () => {
      cancelAnimation(position);
      if (AppState.currentState !== "active") return;
      const state = usePlaybackStore.getState();
      const elapsed = state.isPlaying ? Math.max(0, performance.now() - state.anchorMonotonicMs) : 0;
      const current = Math.max(0, Math.min(durationMs, state.anchorPositionMs + elapsed));
      position.value = current;
      if (state.isPlaying && current < durationMs) {
        position.value = withTiming(durationMs, {
          duration: durationMs - current,
          easing: Easing.linear,
        });
      }
    };
    sync();
    const unsubscribe = usePlaybackStore.subscribe((state, previous) => {
      if (state.anchorPositionMs !== previous.anchorPositionMs ||
          state.anchorMonotonicMs !== previous.anchorMonotonicMs ||
          state.isPlaying !== previous.isPlaying) sync();
    });
    const subscription = AppState.addEventListener("change", sync);
    return () => {
      unsubscribe();
      subscription.remove();
      cancelAnimation(position);
    };
  }, [durationMs, position]));
  return position;
}
