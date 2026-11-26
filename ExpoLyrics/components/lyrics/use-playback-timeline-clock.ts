import { useCallback } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { cancelAnimation, Easing, useSharedValue, withTiming } from "react-native-reanimated";
import { usePlaybackStore } from "@/store/playback-store";

/** One UI-thread clock per anchor, instead of restarting a tween every store tick. */
export type PreviewPlaybackAnchor = { anchorPositionMs: number; anchorMonotonicMs: number; isPlaying: boolean };
export type PreviewPlaybackSource = {
  getSnapshot: () => PreviewPlaybackAnchor | undefined;
  subscribe: (listener: () => void) => () => void;
};

export function usePlaybackTimelineClock(durationMs: number, preview?: PreviewPlaybackSource) {
  const position = useSharedValue(usePlaybackStore.getState().playbackPosition);
  const sync = useCallback(() => {
    cancelAnimation(position);
    if (AppState.currentState !== "active") return;
    const state = preview?.getSnapshot() ?? usePlaybackStore.getState();
    const elapsed = state.isPlaying ? Math.max(0, performance.now() - state.anchorMonotonicMs) : 0;
    const current = Math.max(0, Math.min(durationMs, state.anchorPositionMs + elapsed));
    position.value = current;
    if (state.isPlaying && current < durationMs) {
      position.value = withTiming(durationMs, {
        duration: durationMs - current,
        easing: Easing.linear,
      });
    }
  }, [durationMs, position, preview]);
  useFocusEffect(useCallback(() => {
    sync();
    let lastPreview = preview?.getSnapshot();
    const unsubscribePreview = preview?.subscribe(() => {
      const next = preview?.getSnapshot();
      if (next === lastPreview || (next && lastPreview && next.anchorPositionMs === lastPreview.anchorPositionMs &&
          next.anchorMonotonicMs === lastPreview.anchorMonotonicMs && next.isPlaying === lastPreview.isPlaying)) return;
      lastPreview = next;
      sync();
    });
    const unsubscribe = usePlaybackStore.subscribe((state, previous) => {
      if (preview?.getSnapshot()) return;
      if (state.anchorPositionMs !== previous.anchorPositionMs ||
          state.anchorMonotonicMs !== previous.anchorMonotonicMs ||
          state.isPlaying !== previous.isPlaying) sync();
    });
    const subscription = AppState.addEventListener("change", sync);
    return () => {
      unsubscribePreview?.();
      unsubscribe();
      subscription.remove();
      cancelAnimation(position);
    };
  }, [position, preview, sync]));
  return { position, sync };
}
