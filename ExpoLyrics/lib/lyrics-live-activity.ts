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
let lastPayloadBytes = 0;
let lastPayloadTrimmed = false;

// ActivityKit rejects the combined static attributes and dynamic content state
// above 4 KB. Keep headroom for Swift Codable's representation.
export const ACTIVITYKIT_PAYLOAD_LIMIT_BYTES = 4096;
export const LIVE_ACTIVITY_SAFE_PAYLOAD_BYTES = 3500;
const LIVE_ACTIVITY_STATE_BUDGET_BYTES = 2900;
const MAX_TITLE_BYTES = 192;
const MAX_SUBTITLE_BYTES = 192;
const MAX_SOURCE_BYTES = 96;
const MAX_LYRIC_BYTES = 768;
const MAX_SYLLABLE_PAYLOAD_BYTES = 1400;

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
  payloadLimitBytes?: number;
  activities?: {
    id?: string;
    state?: string;
    title?: string;
  }[];
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
    Boolean(snapshot.track?.title?.trim()) &&
    (snapshot.connectionStatus === "connected" ||
      snapshot.isPlaying ||
      hasActiveLyricsLiveActivity())
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

export function utf8ByteLength(value: string) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function truncateUtf8(value: string, maxBytes: number) {
  if (utf8ByteLength(value) <= maxBytes) {
    return value;
  }

  let result = "";
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (usedBytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    usedBytes += characterBytes;
  }
  return result.trimEnd();
}

export function measureLiveActivityPayloadBytes(
  state: object,
  config?: object,
) {
  return utf8ByteLength(
    JSON.stringify(
      config === undefined
        ? { contentState: state }
        : { attributes: config, contentState: state },
    ),
  );
}

function fitLiveActivityStateToBudget<T extends {
  subtitle?: string;
  currentLineText?: string;
  syllablePayload?: string;
}>(state: T, config?: object): T {
  const budget = config
    ? LIVE_ACTIVITY_SAFE_PAYLOAD_BYTES
    : LIVE_ACTIVITY_STATE_BUDGET_BYTES;
  const next = { ...state };
  const measure = () => measureLiveActivityPayloadBytes(next, config);

  lastPayloadTrimmed = false;
  if (measure() > budget && next.syllablePayload) {
    next.syllablePayload = undefined;
    lastPayloadTrimmed = true;
  }
  if (measure() > budget && next.currentLineText) {
    next.currentLineText = truncateUtf8(next.currentLineText, 256);
    lastPayloadTrimmed = true;
  }
  if (measure() > budget && next.subtitle) {
    next.subtitle = truncateUtf8(next.subtitle, 96);
    lastPayloadTrimmed = true;
  }

  lastPayloadBytes = measure();
  return next;
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

export function buildLyricsLiveActivityState(
  snapshot: LyricsLiveActivitySnapshot,
  config?: object,
) {
  const track = snapshot.track;
  const timingMode = detectLyricsTimingMode(snapshot.lyrics, snapshot.lyricsSource);
  const isStatic = timingMode === "static";
  const lyricsMode = timingModeForLiveActivity(timingMode);
  const projectedPositionMs = projectPlaybackPosition(snapshot);
  const activeLine = isStatic
    ? null
    : resolveActiveLyricLine(snapshot.lyrics, projectedPositionMs);
  const title = truncateUtf8(
    track?.title?.trim() || "KineSync",
    MAX_TITLE_BYTES,
  );
  const subtitle = truncateUtf8(
    track?.artist?.trim() || "Unknown artist",
    MAX_SUBTITLE_BYTES,
  );

  const timerEndMs = getTimerEndMs(snapshot, projectedPositionMs);
  const progress = getPlaybackProgress(snapshot, projectedPositionMs);

  const syllablePayload =
    lyricsMode === "karaoke" &&
    activeLine?.syllablePayload &&
    utf8ByteLength(activeLine.syllablePayload) <= MAX_SYLLABLE_PAYLOAD_BYTES
      ? activeLine.syllablePayload
      : undefined;

  return fitLiveActivityStateToBudget(
    {
      title,
      subtitle,
      source: truncateUtf8(
        formatLyricsSourceLabel(snapshot.lyricsSource),
        MAX_SOURCE_BYTES,
      ),
      lyricsMode,
      currentLineText:
        isStatic || !activeLine?.text
          ? undefined
          : truncateUtf8(activeLine.text, MAX_LYRIC_BYTES),
      lineStartMs: isStatic ? undefined : activeLine?.lineStartMs,
      lineEndMs: isStatic ? undefined : activeLine?.lineEndMs,
      playbackAnchorMs: isStatic ? undefined : projectedPositionMs,
      playbackAnchorEpochMs: isStatic ? undefined : Date.now(),
      isPlayingLive: snapshot.isPlaying,
      syllablePayload,
      progressBar: {
        progress,
        ...(timerEndMs !== undefined ? { date: timerEndMs } : {}),
      },
    },
    config,
  );
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

  const payloadBytes = measureLiveActivityPayloadBytes(state, config);
  if (payloadBytes > LIVE_ACTIVITY_SAFE_PAYLOAD_BYTES) {
    lastStartError = `Live Activity payload is ${payloadBytes} bytes; safe limit is ${LIVE_ACTIVITY_SAFE_PAYLOAD_BYTES}.`;
    logLiveActivityWarning(lastStartError);
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

function recoverNativeActivityId() {
  if (activityState.activityId || !liveActivityNative) {
    return activityState.activityId;
  }

  try {
    const debugInfo =
      liveActivityNative.getActivityDebugInfo?.() as NativeActivityDebugInfo | undefined;
    const activity = debugInfo?.activities?.find(
      (candidate) =>
        candidate.id &&
        candidate.state !== "ended" &&
        candidate.state !== "dismissed",
    );
    if (activity?.id) {
      activityState.activityId = activity.id;
    }
  } catch {
    // Recovery is best-effort; startActivity will surface a useful native error.
  }
  return activityState.activityId;
}

export function hasActiveLyricsLiveActivity() {
  return Boolean(recoverNativeActivityId());
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
    payloadBytes: lastPayloadBytes,
    payloadLimitBytes: ACTIVITYKIT_PAYLOAD_LIMIT_BYTES,
    payloadTrimmed: lastPayloadTrimmed,
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

  const config = buildActivityConfig(snapshot);
  const state = buildLyricsLiveActivityState(snapshot, config);
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
