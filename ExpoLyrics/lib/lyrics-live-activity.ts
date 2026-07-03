import * as LiveActivity from "expo-live-activity";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import {
  getActiveLyricLineKey,
  resolveActiveLyricLine,
} from "@/lib/active-lyric-line";
import {
  getCachedArtworkAccent,
  prefetchArtworkAccent,
} from "@/lib/artwork-accent";
import { normalizeBridgeArtworkUri } from "@/lib/artwork";
import { formatLyricsSourceLabel } from "@/lib/format-lyrics-source";
import { detectLyricsTimingMode } from "@/lib/lyrics-timing";
import type { LyricsTimingMode } from "@/lib/lyrics-timing";
import type { LyricLine, Track } from "@/types/bridge";

export type LyricsLiveActivitySnapshot = {
  track: Track | null;
  lyricsSource: string;
  lyrics: LyricLine[];
  isPlaying: boolean;
  playbackPosition: number;
  anchorPositionMs: number;
  anchorMonotonicMs: number;
  connectionStatus: string;
};

type LyricsLiveActivityState = {
  activityId: string | null;
  accentKey: string;
  accentHex: string;
  lyricLineKey: string;
};

const activityState: LyricsLiveActivityState = {
  activityId: null,
  accentKey: "",
  accentHex: "",
  lyricLineKey: "",
};

let manualKeepAlive = false;
let lastStartError: string | null = null;

const DEFAULT_ACCENT_HEX = "8B5CF6";

const LIVE_ACTIVITY_COLORS = {
  background: "000000",
  title: "FFFFFF",
  subtitle: "FFFFFF",
  source: "FFFFFF",
} as const;

const liveActivityNative = requireOptionalNativeModule("ExpoLiveActivity");

type LiveActivityLyricsMode = "karaoke" | "interpolated" | "static" | "unknown";
type NativeActivityDebugInfo = {
  available?: boolean;
  activitiesEnabled?: boolean;
  hostBundleIdentifier?: string;
  extensionBundleIdentifier?: string;
  expectedExtensionBundleIdentifier?: string;
  extensionMatchesHost?: boolean;
  extensionPath?: string;
  extensionPointIdentifier?: string;
  hostProvisioning?: NativeProvisioningDebugInfo;
  extensionProvisioning?: NativeProvisioningDebugInfo;
  activityCount?: number;
  activities?: Array<{
    id?: string;
    state?: string;
    title?: string;
  }>;
  error?: string;
};

type NativeProvisioningDebugInfo = {
  present?: boolean;
  bundleIdentifier?: string;
  applicationIdentifier?: string;
  teamIdentifier?: string;
  profileName?: string;
  profileAppIdName?: string;
};

function logLiveActivityWarning(message: string, error?: unknown) {
  if (!__DEV__) {
    return;
  }
  if (error !== undefined) {
    console.warn(`[live-activity] ${message}`, error);
    return;
  }
  console.warn(`[live-activity] ${message}`);
}

function timingModeForLiveActivity(mode: LyricsTimingMode): LiveActivityLyricsMode {
  if (mode === "karaoke" || mode === "interpolated" || mode === "static") {
    return mode;
  }
  return "unknown";
}

function shouldShowLiveActivity(snapshot: LyricsLiveActivitySnapshot) {
  return (
    isLyricsLiveActivitySupported() &&
    snapshot.connectionStatus === "connected" &&
    Boolean(snapshot.track?.title?.trim())
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getMonotonicNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function sanitizeAccentHex(accent: string) {
  const stripped = accent.replace("#", "").trim();
  if (/^[0-9A-Fa-f]{6}$/.test(stripped)) {
    return stripped.toUpperCase();
  }
  return DEFAULT_ACCENT_HEX;
}

export function projectPlaybackPosition(snapshot: LyricsLiveActivitySnapshot) {
  if (!snapshot.isPlaying) {
    return Math.max(0, snapshot.anchorPositionMs);
  }
  const elapsed = Math.max(0, getMonotonicNow() - snapshot.anchorMonotonicMs);
  const durationMs = snapshot.track?.durationMs ?? 0;
  const projected = snapshot.anchorPositionMs + elapsed;
  if (durationMs > 0) {
    return clamp(projected, 0, durationMs);
  }
  return Math.max(0, projected);
}

function getPlaybackProgress(
  snapshot: LyricsLiveActivitySnapshot,
  positionMs = projectPlaybackPosition(snapshot),
) {
  const durationMs = snapshot.track?.durationMs ?? 0;
  if (durationMs <= 0) {
    return 0;
  }
  return clamp(positionMs / durationMs, 0, 1);
}

function getTimerEndMs(
  snapshot: LyricsLiveActivitySnapshot,
  positionMs = projectPlaybackPosition(snapshot),
) {
  const durationMs = snapshot.track?.durationMs ?? 0;
  if (durationMs <= 0) {
    return undefined;
  }
  const remainingMs = Math.max(0, durationMs - positionMs);
  return Date.now() + remainingMs;
}

export function buildLyricsLiveActivityState(snapshot: LyricsLiveActivitySnapshot) {
  const track = snapshot.track;
  const timingMode = detectLyricsTimingMode(snapshot.lyrics, snapshot.lyricsSource);
  const isStatic = timingMode === "static";
  const lyricsMode = timingModeForLiveActivity(timingMode);
  const projectedPositionMs = projectPlaybackPosition(snapshot);
  const activeLine = isStatic
    ? null
    : resolveActiveLyricLine(snapshot.lyrics, projectedPositionMs);
  const title = track?.title?.trim() || "ExpoLyrics";
  const subtitle = track?.artist?.trim() || "Unknown artist";

  const timerEndMs = getTimerEndMs(snapshot, projectedPositionMs);
  const progress = getPlaybackProgress(snapshot, projectedPositionMs);

  return {
    title,
    subtitle,
    source: formatLyricsSourceLabel(snapshot.lyricsSource),
    lyricsMode,
    currentLineText: isStatic ? undefined : activeLine?.text,
    lineStartMs: isStatic ? undefined : activeLine?.lineStartMs,
    lineEndMs: isStatic ? undefined : activeLine?.lineEndMs,
    playbackAnchorMs: isStatic ? undefined : projectedPositionMs,
    playbackAnchorEpochMs: isStatic ? undefined : Date.now(),
    isPlayingLive: snapshot.isPlaying,
    syllablePayload:
      lyricsMode === "karaoke" ? activeLine?.syllablePayload : undefined,
    progressBar: {
      progress,
      ...(timerEndMs !== undefined ? { date: timerEndMs } : {}),
    },
  };
}

function buildActivityConfig(snapshot: LyricsLiveActivitySnapshot) {
  const artworkUrl = normalizeBridgeArtworkUri(trackArtworkUrl(snapshot.track));
  const accent = sanitizeAccentHex(getCachedArtworkAccent(artworkUrl));
  activityState.accentKey = artworkUrl || "default";
  activityState.accentHex = accent;

  return {
    backgroundColor: LIVE_ACTIVITY_COLORS.background,
    titleColor: LIVE_ACTIVITY_COLORS.title,
    subtitleColor: LIVE_ACTIVITY_COLORS.subtitle,
    progressViewTint: accent,
    progressViewLabelColor: LIVE_ACTIVITY_COLORS.source,
    deepLinkUrl: "/",
    timerType: "circular" as const,
    padding: { horizontal: 18, vertical: 16 },
  };
}

function trackArtworkUrl(track: Track | null | undefined) {
  return track?.artworkUrl ?? "";
}

function safeStartActivity(
  state: ReturnType<typeof buildLyricsLiveActivityState>,
  config: ReturnType<typeof buildActivityConfig>,
) {
  if (!liveActivityNative) {
    logLiveActivityWarning("Native module unavailable — rebuild with a dev client.");
    return undefined;
  }

  try {
    lastStartError = null;
    return LiveActivity.startActivity(state, config);
  } catch (error) {
    lastStartError =
      error instanceof Error ? error.message : "Failed to start Live Activity.";
    logLiveActivityWarning("Failed to start activity.", error);
    return undefined;
  }
}

function safeUpdateActivity(
  activityId: string,
  state: ReturnType<typeof buildLyricsLiveActivityState>,
) {
  if (!liveActivityNative) {
    return false;
  }

  try {
    LiveActivity.updateActivity(activityId, state);
    return true;
  } catch (error) {
    logLiveActivityWarning("Failed to update activity.", error);
    return false;
  }
}

function safeStopActivity(
  activityId: string,
  state: ReturnType<typeof buildLyricsLiveActivityState>,
) {
  if (!liveActivityNative) {
    return false;
  }

  try {
    LiveActivity.stopActivity(activityId, state);
    return true;
  } catch (error) {
    logLiveActivityWarning("Failed to stop activity.", error);
    return false;
  }
}

function resetActivityState() {
  activityState.activityId = null;
  activityState.accentKey = "";
  activityState.accentHex = "";
  activityState.lyricLineKey = "";
}

export function prefetchLiveActivityAccent(snapshot: LyricsLiveActivitySnapshot) {
  const artworkUrl = normalizeBridgeArtworkUri(trackArtworkUrl(snapshot.track));
  if (!artworkUrl) {
    return Promise.resolve(DEFAULT_ACCENT_HEX);
  }
  return prefetchArtworkAccent(artworkUrl).catch((error) => {
    logLiveActivityWarning("Accent prefetch failed.", error);
    return DEFAULT_ACCENT_HEX;
  });
}

export function hasActiveLyricsLiveActivity() {
  return Boolean(activityState.activityId);
}

export function getLyricsLiveActivityDebugInfo() {
  let nativeActivityDebug: NativeActivityDebugInfo | null = null;
  try {
    nativeActivityDebug =
      liveActivityNative?.getActivityDebugInfo?.() as NativeActivityDebugInfo;
  } catch (error) {
    nativeActivityDebug = {
      error:
        error instanceof Error
          ? error.message
          : "Failed to read native activity state.",
    };
  }

  return {
    supported: isLyricsLiveActivitySupported(),
    active: hasActiveLyricsLiveActivity(),
    activityId: activityState.activityId,
    manualKeepAlive,
    lastStartError,
    nativeActivityDebug,
  };
}

export function shouldKeepLyricsLiveActivityInForeground() {
  return manualKeepAlive;
}

export function setLyricsLiveActivityManualKeepAlive(enabled: boolean) {
  manualKeepAlive = enabled;
}

export async function forceStartLyricsLiveActivity(
  snapshot: LyricsLiveActivitySnapshot,
): Promise<boolean> {
  if (!isLyricsLiveActivitySupported() || !snapshot.track?.title?.trim()) {
    lastStartError = "Live Activity unavailable or no track title.";
    return false;
  }
  if (hasActiveLyricsLiveActivity()) {
    await stopLyricsLiveActivity(snapshot);
  }
  manualKeepAlive = true;
  const started = await startLyricsLiveActivity({
    ...snapshot,
    connectionStatus: "connected",
  });
  if (!started) {
    manualKeepAlive = false;
    lastStartError ??= "startActivity returned no id.";
  }
  return started;
}

export async function startLyricsLiveActivity(
  snapshot: LyricsLiveActivitySnapshot,
): Promise<boolean> {
  if (!shouldShowLiveActivity(snapshot)) {
    return false;
  }

  const state = buildLyricsLiveActivityState(snapshot);
  const config = buildActivityConfig(snapshot);
  const activityId = safeStartActivity(state, config);

  if (!activityId) {
    resetActivityState();
    return false;
  }

  activityState.activityId = activityId;
  activityState.lyricLineKey = getActiveLyricLineKey(
    resolveActiveLyricLine(snapshot.lyrics, projectPlaybackPosition(snapshot)),
  );
  return true;
}

export async function updateLyricsLiveActivity(
  snapshot: LyricsLiveActivitySnapshot,
): Promise<boolean> {
  if (!shouldShowLiveActivity(snapshot)) {
    await stopLyricsLiveActivity(snapshot);
    return false;
  }

  const state = buildLyricsLiveActivityState(snapshot);
  const artworkUrl = normalizeBridgeArtworkUri(trackArtworkUrl(snapshot.track));
  const accentKey = artworkUrl || "default";
  const nextAccentHex = sanitizeAccentHex(getCachedArtworkAccent(artworkUrl));
  const accentChanged =
    accentKey !== activityState.accentKey ||
    nextAccentHex !== activityState.accentHex;
  const nextLineKey = getActiveLyricLineKey(
    resolveActiveLyricLine(snapshot.lyrics, projectPlaybackPosition(snapshot)),
  );

  if (!activityState.activityId || accentChanged) {
    if (activityState.activityId) {
      await stopLyricsLiveActivity(snapshot);
    }
    return startLyricsLiveActivity(snapshot);
  }

  const updated = safeUpdateActivity(activityState.activityId, state);
  if (!updated) {
    resetActivityState();
    return startLyricsLiveActivity(snapshot);
  }

  if (nextLineKey !== activityState.lyricLineKey) {
    activityState.lyricLineKey = nextLineKey;
  }
  return true;
}

export async function stopLyricsLiveActivity(
  snapshot: LyricsLiveActivitySnapshot,
): Promise<void> {
  if (!activityState.activityId) {
    return;
  }

  const activityId = activityState.activityId;
  const state = buildLyricsLiveActivityState(snapshot);
  safeStopActivity(activityId, state);
  manualKeepAlive = false;
  resetActivityState();
}

export function isLyricsLiveActivitySupported() {
  return Platform.OS === "ios" && liveActivityNative != null;
}
