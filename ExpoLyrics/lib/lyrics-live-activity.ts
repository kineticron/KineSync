import type { LiveActivity } from "expo-widgets";
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
import KineSyncLyricsActivity, {
  type LyricsLiveActivityProps,
} from "@/widgets/lyrics-live-activity";

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
  activity: LiveActivity<LyricsLiveActivityProps> | null;
  accentKey: string;
  accentHex: string;
  lyricLineKey: string;
};

const activityState: LyricsLiveActivityState = {
  activity: null,
  accentKey: "",
  accentHex: "",
  lyricLineKey: "",
};

let manualKeepAlive = false;
let lastStartError: string | null = null;
let lastPayloadBytes = 0;
let lastPayloadTrimmed = false;

// ActivityKit limits the encoded attributes and content state to 4 KB. Expo
// Widgets stores these props as JSON, so leave enough headroom for its wrapper.
export const ACTIVITYKIT_PAYLOAD_LIMIT_BYTES = 4096;
export const LIVE_ACTIVITY_SAFE_PAYLOAD_BYTES = 3200;
const MAX_TITLE_BYTES = 192;
const MAX_SUBTITLE_BYTES = 192;
const MAX_SOURCE_BYTES = 96;
const MAX_LYRIC_BYTES = 768;
const DEFAULT_ACCENT_HEX = "8B5CF6";

type LiveActivityLyricsMode = "karaoke" | "interpolated" | "static" | "unknown";
type NativeActivityDebugInfo = {
  available: boolean;
  implementation: "expo-widgets";
  activityCount: number;
  activities: { state: "active" }[];
  error?: string;
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

export function measureLiveActivityPayloadBytes(state: object) {
  return utf8ByteLength(JSON.stringify(state));
}

function fitLiveActivityStateToBudget(
  state: LyricsLiveActivityProps,
): LyricsLiveActivityProps {
  const next = { ...state };
  const measure = () => measureLiveActivityPayloadBytes(next);

  lastPayloadTrimmed = false;
  if (measure() > LIVE_ACTIVITY_SAFE_PAYLOAD_BYTES && next.currentLineText) {
    next.currentLineText = truncateUtf8(next.currentLineText, 256);
    lastPayloadTrimmed = true;
  }
  if (measure() > LIVE_ACTIVITY_SAFE_PAYLOAD_BYTES && next.subtitle) {
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

export function buildLyricsLiveActivityState(
  snapshot: LyricsLiveActivitySnapshot,
): LyricsLiveActivityProps {
  const track = snapshot.track;
  const timingMode = detectLyricsTimingMode(snapshot.lyrics, snapshot.lyricsSource);
  const isStatic = timingMode === "static";
  const lyricsMode = timingModeForLiveActivity(timingMode);
  const projectedPositionMs = projectPlaybackPosition(snapshot);
  const activeLine = isStatic
    ? null
    : resolveActiveLyricLine(snapshot.lyrics, projectedPositionMs);
  const artworkUrl = normalizeBridgeArtworkUri(trackArtworkUrl(track));

  return fitLiveActivityStateToBudget({
    title: truncateUtf8(track?.title?.trim() || "KineSync", MAX_TITLE_BYTES),
    subtitle: truncateUtf8(
      track?.artist?.trim() || "Unknown artist",
      MAX_SUBTITLE_BYTES,
    ),
    source: truncateUtf8(
      formatLyricsSourceLabel(snapshot.lyricsSource) || "KineSync",
      MAX_SOURCE_BYTES,
    ),
    lyricsMode,
    currentLineText:
      isStatic || !activeLine?.text
        ? ""
        : truncateUtf8(activeLine.text, MAX_LYRIC_BYTES),
    isPlaying: snapshot.isPlaying,
    progress: getPlaybackProgress(snapshot, projectedPositionMs),
    accentHex: sanitizeAccentHex(getCachedArtworkAccent(artworkUrl)),
  });
}

function trackArtworkUrl(track: Track | null | undefined) {
  return track?.artworkUrl ?? "";
}

function safeStartActivity(state: LyricsLiveActivityProps) {
  const payloadBytes = measureLiveActivityPayloadBytes(state);
  if (payloadBytes > LIVE_ACTIVITY_SAFE_PAYLOAD_BYTES) {
    lastStartError = `Live Activity payload is ${payloadBytes} bytes; safe limit is ${LIVE_ACTIVITY_SAFE_PAYLOAD_BYTES}.`;
    logLiveActivityWarning(lastStartError);
    return undefined;
  }

  try {
    lastStartError = null;
    return KineSyncLyricsActivity.start(state, "expolyrics:///");
  } catch (error) {
    lastStartError =
      error instanceof Error ? error.message : "Failed to start Live Activity.";
    logLiveActivityWarning("Failed to start activity.", error);
    return undefined;
  }
}

async function safeUpdateActivity(
  activity: LiveActivity<LyricsLiveActivityProps>,
  state: LyricsLiveActivityProps,
) {
  try {
    await activity.update(state);
    return true;
  } catch (error) {
    logLiveActivityWarning("Failed to update activity.", error);
    return false;
  }
}

async function safeStopActivity(
  activity: LiveActivity<LyricsLiveActivityProps>,
  state: LyricsLiveActivityProps,
) {
  try {
    await activity.end("immediate", state, new Date());
    return true;
  } catch (error) {
    logLiveActivityWarning("Failed to stop activity.", error);
    return false;
  }
}

function resetActivityState() {
  activityState.activity = null;
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

function recoverNativeActivity() {
  if (activityState.activity || !isLyricsLiveActivitySupported()) {
    return activityState.activity;
  }

  try {
    activityState.activity = KineSyncLyricsActivity.getInstances()[0] ?? null;
  } catch (error) {
    logLiveActivityWarning("Failed to recover an existing activity.", error);
  }
  return activityState.activity;
}

export function hasActiveLyricsLiveActivity() {
  return Boolean(recoverNativeActivity());
}

export function getLyricsLiveActivityDebugInfo() {
  let nativeActivityDebug: NativeActivityDebugInfo;
  try {
    const activityCount = isLyricsLiveActivitySupported()
      ? KineSyncLyricsActivity.getInstances().length
      : 0;
    nativeActivityDebug = {
      available: isLyricsLiveActivitySupported(),
      implementation: "expo-widgets",
      activityCount,
      activities: Array.from({ length: activityCount }, () => ({ state: "active" })),
    };
  } catch (error) {
    nativeActivityDebug = {
      available: false,
      implementation: "expo-widgets",
      activityCount: 0,
      activities: [],
      error:
        error instanceof Error
          ? error.message
          : "Failed to read native activity state.",
    };
  }

  return {
    supported: isLyricsLiveActivitySupported(),
    active: hasActiveLyricsLiveActivity(),
    activityId: null,
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
    lastStartError ??= "Live Activity start returned no instance.";
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
  const activity = safeStartActivity(state);

  if (!activity) {
    resetActivityState();
    return false;
  }

  const artworkUrl = normalizeBridgeArtworkUri(trackArtworkUrl(snapshot.track));
  activityState.activity = activity;
  activityState.accentKey = artworkUrl || "default";
  activityState.accentHex = state.accentHex;
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
  const accentChanged =
    accentKey !== activityState.accentKey ||
    state.accentHex !== activityState.accentHex;
  const nextLineKey = getActiveLyricLineKey(
    resolveActiveLyricLine(snapshot.lyrics, projectPlaybackPosition(snapshot)),
  );
  const activity = recoverNativeActivity();

  if (!activity || accentChanged) {
    if (activity) {
      await stopLyricsLiveActivity(snapshot);
    }
    return startLyricsLiveActivity(snapshot);
  }

  const updated = await safeUpdateActivity(activity, state);
  if (!updated) {
    resetActivityState();
    return startLyricsLiveActivity(snapshot);
  }

  activityState.accentKey = accentKey;
  activityState.accentHex = state.accentHex;
  activityState.lyricLineKey = nextLineKey;
  return true;
}

export async function stopLyricsLiveActivity(
  snapshot: LyricsLiveActivitySnapshot,
): Promise<void> {
  const activity = recoverNativeActivity();
  if (!activity) {
    return;
  }

  const state = buildLyricsLiveActivityState(snapshot);
  await safeStopActivity(activity, state);
  manualKeepAlive = false;
  resetActivityState();
}

export function isLyricsLiveActivitySupported() {
  return Platform.OS === "ios";
}
