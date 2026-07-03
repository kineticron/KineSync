import { type PropsWithChildren, useEffect, useRef } from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";

import {
  getActiveLyricLineKey,
  resolveActiveLyricLine,
} from "@/lib/active-lyric-line";
import {
  hasActiveLyricsLiveActivity,
  isLyricsLiveActivitySupported,
  prefetchLiveActivityAccent,
  projectPlaybackPosition,
  shouldKeepLyricsLiveActivityInForeground,
  setLyricsLiveActivityManualKeepAlive,
  startLyricsLiveActivity,
  stopLyricsLiveActivity,
  updateLyricsLiveActivity,
  type LyricsLiveActivitySnapshot,
} from "@/lib/lyrics-live-activity";
import { detectLyricsTimingMode } from "@/lib/lyrics-timing";
import { usePlaybackStore } from "@/store/playback-store";

function readSnapshot(): LyricsLiveActivitySnapshot {
  const state = usePlaybackStore.getState();
  return {
    track: state.currentTrack,
    lyricsSource: state.lyricsSource,
    lyrics: state.lyrics,
    isPlaying: state.isPlaying,
    playbackPosition: state.playbackPosition,
    anchorPositionMs: state.anchorPositionMs,
    anchorMonotonicMs: state.anchorMonotonicMs,
    connectionStatus: state.connectionStatus,
  };
}

const ANCHOR_SYNC_INTERVAL_MS = 2500;
const BACKGROUND_START_RETRY_MS = [250, 900, 2000] as const;

export function LyricsLiveActivityProvider({ children }: PropsWithChildren) {
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const syncInFlightRef = useRef(false);
  const pendingSyncRef = useRef(false);
  const lastAnchorSyncAtRef = useRef(0);
  const lastTrackIdRef = useRef<string | null>(null);
  const lastLyricsSourceRef = useRef("");
  const lastLyricsModeKeyRef = useRef("");
  const lastLyricLineKeyRef = useRef("");
  const backgroundRetryTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (!isLyricsLiveActivitySupported()) {
      return;
    }

    const prefetchAccent = () => {
      if (appStateRef.current !== "active") {
        return;
      }
      void prefetchLiveActivityAccent(readSnapshot());
    };

    prefetchAccent();

    const syncLiveActivity = async (force = false) => {
      if (syncInFlightRef.current) {
        if (force) {
          pendingSyncRef.current = true;
        }
        return;
      }

      syncInFlightRef.current = true;
      try {
        const snapshot = readSnapshot();
        const keepAliveInForeground = shouldKeepLyricsLiveActivityInForeground();
        const shouldBeActive =
          (appStateRef.current !== "active" || keepAliveInForeground) &&
          snapshot.connectionStatus === "connected" &&
          Boolean(snapshot.track?.title?.trim());

        if (!shouldBeActive) {
          if (hasActiveLyricsLiveActivity() || force) {
            setLyricsLiveActivityManualKeepAlive(false);
            await stopLyricsLiveActivity(snapshot);
          }
          return;
        }

        if (!hasActiveLyricsLiveActivity()) {
          const started = await startLyricsLiveActivity(snapshot);
          if (started) {
            lastLyricLineKeyRef.current = getActiveLyricLineKey(
              resolveActiveLyricLine(
                snapshot.lyrics,
                projectPlaybackPosition(snapshot),
              ),
            );
          }
          return;
        }

        await updateLyricsLiveActivity(snapshot);
      } finally {
        syncInFlightRef.current = false;
        if (pendingSyncRef.current) {
          pendingSyncRef.current = false;
          void syncLiveActivity(true);
        }
      }
    };

    const clearBackgroundRetries = () => {
      for (const timer of backgroundRetryTimersRef.current) {
        clearTimeout(timer);
      }
      backgroundRetryTimersRef.current = [];
    };

    const scheduleBackgroundRetries = () => {
      clearBackgroundRetries();
      for (const delayMs of BACKGROUND_START_RETRY_MS) {
        const timer = setTimeout(() => {
          void syncLiveActivity(true);
        }, delayMs);
        backgroundRetryTimersRef.current.push(timer);
      }
    };

    const handleAppStateChange = (nextState: AppStateStatus) => {
      appStateRef.current = nextState;
      if (nextState === "active") {
        clearBackgroundRetries();
      } else if (nextState === "background") {
        scheduleBackgroundRetries();
      }
      void syncLiveActivity(true);
    };

    const unsubscribe = usePlaybackStore.subscribe((state) => {
      if (appStateRef.current === "active") {
        prefetchAccent();
        return;
      }

      const snapshot = readSnapshot();
      const trackId = state.currentTrack?.id ?? null;
      const lyricsMode = detectLyricsTimingMode(state.lyrics, state.lyricsSource);
      const lyricLineKey = getActiveLyricLineKey(
        resolveActiveLyricLine(
          state.lyrics,
          projectPlaybackPosition({
            track: state.currentTrack,
            lyricsSource: state.lyricsSource,
            lyrics: state.lyrics,
            isPlaying: state.isPlaying,
            playbackPosition: state.playbackPosition,
            anchorPositionMs: state.anchorPositionMs,
            anchorMonotonicMs: state.anchorMonotonicMs,
            connectionStatus: state.connectionStatus,
          }),
        ),
      );
      const metadataChanged =
        trackId !== lastTrackIdRef.current ||
        state.lyricsSource !== lastLyricsSourceRef.current ||
        lyricsMode !== lastLyricsModeKeyRef.current;
      const lineChanged = lyricLineKey !== lastLyricLineKeyRef.current;

      if (metadataChanged || lineChanged) {
        lastTrackIdRef.current = trackId;
        lastLyricsSourceRef.current = state.lyricsSource;
        lastLyricsModeKeyRef.current = lyricsMode;
        lastLyricLineKeyRef.current = lyricLineKey;
        void syncLiveActivity(true);
        return;
      }

      if (!state.isPlaying) {
        return;
      }

      const now = Date.now();
      if (now - lastAnchorSyncAtRef.current < ANCHOR_SYNC_INTERVAL_MS) {
        return;
      }
      lastAnchorSyncAtRef.current = now;
      void syncLiveActivity();
    });

    const appStateSubscription = AppState.addEventListener(
      "change",
      handleAppStateChange,
    );

    void syncLiveActivity(true);

    return () => {
      clearBackgroundRetries();
      unsubscribe();
      appStateSubscription.remove();
      if (Platform.OS === "ios") {
        void stopLyricsLiveActivity(readSnapshot());
      }
    };
  }, []);

  return children;
}
