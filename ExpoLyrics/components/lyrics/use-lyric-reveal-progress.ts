import { useEffect, useRef } from "react";
import {
  cancelAnimation,
  Easing,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

function clamp01(value: number) {
  "worklet";
  return Math.max(0, Math.min(1, value));
}

function getMonotonicNow() {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}

export function getLyricRevealProgress(
  currentTime: number,
  startTime: number,
  endTime: number,
) {
  "worklet";
  return clamp01(
    (currentTime - startTime) / Math.max(1, endTime - startTime),
  );
}

export function useLyricRevealProgress({
  currentTime,
  startTime,
  endTime,
  isPlaying,
  enabled,
}: {
  currentTime: number;
  startTime: number;
  endTime: number;
  isPlaying: boolean;
  enabled: boolean;
}) {
  const progress = useSharedValue(
    enabled ? getLyricRevealProgress(currentTime, startTime, endTime) : 0,
  );
  const synchronizationRef = useRef({
    currentTime,
    monotonicMs: getMonotonicNow(),
  });

  useEffect(() => {
    const now = getMonotonicNow();
    const previous = synchronizationRef.current;
    const expectedTime =
      previous.currentTime + (isPlaying ? now - previous.monotonicMs : 0);
    const isDiscontinuity = Math.abs(currentTime - expectedTime) >= 220;
    synchronizationRef.current = { currentTime, monotonicMs: now };

    if (!enabled) {
      cancelAnimation(progress);
      progress.value = 0;
      return;
    }

    const synchronizedProgress = getLyricRevealProgress(
      currentTime,
      startTime,
      endTime,
    );
    if (!isPlaying || synchronizedProgress >= 1) {
      cancelAnimation(progress);
      progress.value = synchronizedProgress;
      return;
    }

    // Ordinary bridge clock updates retime the existing UI-thread animation
    // without resetting its presentation value. Only seeks snap to the newly
    // synchronized position.
    if (isDiscontinuity) {
      cancelAnimation(progress);
      progress.value = synchronizedProgress;
    }

    if (currentTime < startTime) {
      progress.value = withDelay(
        Math.max(0, startTime - currentTime),
        withTiming(1, {
          duration: Math.max(1, endTime - startTime),
          easing: Easing.linear,
        }),
      );
      return;
    }

    progress.value = withTiming(1, {
      duration: Math.max(1, endTime - currentTime),
      easing: Easing.linear,
    });
  }, [
    currentTime,
    enabled,
    endTime,
    isPlaying,
    progress,
    startTime,
  ]);

  return progress;
}
