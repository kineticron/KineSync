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

export function LyricsLiveActivityProvider({ children }: PropsWithChildren) {
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const syncInFlightRef = useRef(false);
  const pendingSyncRef = useRef(false);
  const lastAnchorSyncAtRef = useRef(0);
  const lastTrackIdRef = useRef<string | null>(null);
  const lastLyricsSourceRef = useRef("");
  const lastLyricsModeKeyRef = useRef("");
  const lastLyricLineKeyRef = useRef("");
  const lastIsPlayingRef = useRef<boolean | null>(null);
  const lastConnectionStatusRef = useRef("");
  const lastPrefetchedArtworkKeyRef = useRef("");

  useEffect(() => {
    if (!isLyricsLiveActivitySupported()) {
      return;
    }

    const prefetchAccent = () => {
      if (appStateRef.current !== "active") {
        return;
      }
      const snapshot = readSnapshot();
      const artworkKey = [
        snapshot.track?.id || "",
        snapshot.track?.artworkUrl || "",
      ].join("\u0000");
      if (!snapshot.track || artworkKey === lastPrefetchedArtworkKeyRef.current) {
        return;
      }
      lastPrefetchedArtworkKeyRef.current = artworkKey;
      void prefetchLiveActivityAccent(snapshot);
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
        const shouldBeActive =
          Boolean(snapshot.track?.title?.trim()) &&
          (snapshot.connectionStatus === "connected" ||
            snapshot.isPlaying ||
            hasActiveLyricsLiveActivity());

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

    const handleAppStateChange = (nextState: AppStateStatus) => {
      appStateRef.current = nextState;
      if (nextState === "active") {
        prefetchAccent();
      }
      // The activity is normally created by the foreground store subscription.
      // This forced sync refreshes the final state during lifecycle transitions.
      void syncLiveActivity(true);
    };

    const unsubscribe = usePlaybackStore.subscribe((state) => {
      if (appStateRef.current === "active") {
        prefetchAccent();
      }
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
      const playbackStateChanged =
        state.isPlaying !== lastIsPlayingRef.current ||
        state.connectionStatus !== lastConnectionStatusRef.current;

      if (metadataChanged || lineChanged || playbackStateChanged) {
        lastTrackIdRef.current = trackId;
        lastLyricsSourceRef.current = state.lyricsSource;
        lastLyricsModeKeyRef.current = lyricsMode;
        lastLyricLineKeyRef.current = lyricLineKey;
        lastIsPlayingRef.current = state.isPlaying;
        lastConnectionStatusRef.current = state.connectionStatus;
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
      unsubscribe();
      appStateSubscription.remove();
      if (Platform.OS === "ios") {
        void stopLyricsLiveActivity(readSnapshot());
      }
    };
  }, []);

  return children;
}
