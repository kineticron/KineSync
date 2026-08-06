import Ionicons from "@react-native-vector-icons/ionicons";
import { memo, useCallback, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

import {
  forceStartLyricsLiveActivity,
  getLyricsLiveActivityDebugInfo,
  hasActiveLyricsLiveActivity,
  isLyricsLiveActivitySupported,
  stopLyricsLiveActivity,
} from "@/lib/lyrics-live-activity";
import { usePlaybackStore } from "@/store/playback-store";

function readSnapshot() {
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

export const LiveActivityDebugPanel = memo(function LiveActivityDebugPanel() {
  const [statusMessage, setStatusMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const trackTitle = usePlaybackStore((s) => s.currentTrack?.title);
  const connectionStatus = usePlaybackStore((s) => s.connectionStatus);

  const refreshStatus = useCallback(() => {
    const info = getLyricsLiveActivityDebugInfo();
    const nativeCount = info.nativeActivityDebug.activityCount;
    const implementation = info.nativeActivityDebug.implementation;
    const nativeError = info.nativeActivityDebug.error;
    const details = [
      `Runtime: ${implementation}`,
      `Native: ${nativeCount}`,
      info.payloadBytes
        ? `Payload: ${info.payloadBytes}/${info.payloadLimitBytes} B${
            info.payloadTrimmed ? " (trimmed)" : ""
          }`
        : null,
      nativeError ? `Error: ${nativeError}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    setStatusMessage(
      `${
        info.supported
          ? info.active
            ? `Active${info.manualKeepAlive ? ", keep-alive" : ""}`
            : info.lastStartError
              ? `Idle — ${info.lastStartError}`
              : "Idle"
          : "iOS only"
      }${details ? ` · ${details}` : ""}`,
    );
  }, []);

  const handleStart = useCallback(async () => {
    if (Platform.OS !== "ios") {
      setStatusMessage("iOS only");
      return;
    }
    setBusy(true);
    try {
      const snapshot = readSnapshot();
      const started = await forceStartLyricsLiveActivity(snapshot);
      setStatusMessage(
        started
          ? "Started — lock the device or inspect the Dynamic Island"
          : getLyricsLiveActivityDebugInfo().lastStartError ??
              "Start failed (check track + dev build)",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      await stopLyricsLiveActivity(readSnapshot());
      refreshStatus();
      setStatusMessage("Stopped");
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  if (Platform.OS !== "ios") {
    return null;
  }

  const supported = isLyricsLiveActivitySupported();

  return (
    <View style={styles.container}>
      <View style={styles.metaRow}>
        <Ionicons
          name={supported ? "checkmark-circle" : "alert-circle"}
          size={14}
          color={supported ? "#8FF0C4" : "#FCA5A5"}
        />
        <Text style={styles.metaText}>
          {supported ? "Live Activity module loaded" : "Rebuild with iOS dev client"}
        </Text>
      </View>
      <Text style={styles.metaText}>
        Track: {trackTitle?.trim() || "none"} · Bridge: {connectionStatus}
      </Text>
      <Text style={styles.metaText}>
        Active: {hasActiveLyricsLiveActivity() ? "yes" : "no"}
        {statusMessage ? ` · ${statusMessage}` : ""}
      </Text>
      <View style={styles.buttonRow}>
        <Pressable
          style={({ pressed }) => [
            styles.button,
            pressed && styles.buttonPressed,
            busy && styles.buttonDisabled,
          ]}
          disabled={busy}
          onPress={() => {
            void handleStart();
          }}>
          <Text style={styles.buttonText}>Start now</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.buttonSecondary,
            pressed && styles.buttonPressed,
            busy && styles.buttonDisabled,
          ]}
          disabled={busy}
          onPress={() => {
            void handleStop();
          }}>
          <Text style={styles.buttonText}>Stop</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.buttonSecondary, pressed && styles.buttonPressed]}
          onPress={refreshStatus}>
          <Text style={styles.buttonText}>Refresh</Text>
        </Pressable>
      </View>
      <Text style={styles.helperText}>
        Live Activity starts automatically when playback metadata arrives. Use Start
        now to replace it for diagnostics, then lock the device or inspect the Dynamic
        Island. Native widget changes require a fresh iOS development build.
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  metaText: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 12,
    lineHeight: 17,
  },
  buttonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  button: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(143,240,196,0.18)",
    borderWidth: 1,
    borderColor: "rgba(143,240,196,0.35)",
  },
  buttonSecondary: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  buttonPressed: {
    opacity: 0.86,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: "#F8FAFF",
    fontSize: 12,
    fontWeight: "600",
  },
  helperText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 11,
    lineHeight: 15,
  },
});
