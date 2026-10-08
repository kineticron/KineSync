import { BlurView } from "expo-blur";
import { Asset } from "expo-asset";
import { LyricsTypeIcon } from "@/components/lyrics/lyrics-type-icon";
import { LinearGradient } from "expo-linear-gradient";
import * as FileSystem from "expo-file-system/legacy";
import { useKeepAwake } from "expo-keep-awake";
import { useFocusEffect, useRouter } from "expo-router";
import * as Sharing from "expo-sharing";
import Ionicons from "@react-native-vector-icons/ionicons";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  AppState,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Reanimated, {
  useSharedValue,
  withTiming,
  useAnimatedStyle,
  Easing as ReanimatedEasing,
  interpolate,
  interpolateColor,
  Extrapolation,
  FadeIn,
  FadeInUp,
  FadeOut,
  FadeOutUp,
  runOnJS,
  type SharedValue,
} from "react-native-reanimated";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import {
  getLandscapeLayoutMetrics,
  isLandscapeLayout,
  LANDSCAPE_FONT_SCALE,
  LANDSCAPE_LEFT_PANE_PADDING,
  LANDSCAPE_LYRICS_PADDING,
  LYRICS_WRAP_MARGIN_TOP,
  TOP_BAR_ARTWORK_SIZE,
  TOP_BAR_ARTWORK_TOP,
  TOP_BAR_CONTENT_HEIGHT,
} from "@/constants/player-layout";
import { AnimatedBridgedArtwork } from "@/components/lyrics/animated-bridged-artwork";
import { BridgedArtworkImage } from "@/components/lyrics/bridged-artwork-image";
import { resolveAnimatedArtworkForTrack } from "@/lib/animated-artwork";
import { normalizeBridgeArtworkUri, resolveTrackArtworkUrl } from "@/lib/artwork";
import { MAX_GIF_BYTES } from "@/lib/bridge-validation";
import { HorizontalPlayerPanel } from "@/components/lyrics/horizontal-player-panel";
import { SpicyLyricsView } from "@/components/lyrics/spicy-lyrics-view";
import { AmllLyricsView } from "@/components/lyrics/amll-lyrics-view";
import {
  PlaybackControls,
  type PlaybackControlsLayout,
} from "@/components/lyrics/playback-controls";
import { SettingsMenu } from "@/components/lyrics/settings-menu";
import {
  SpotifyBrowserFallback,
  type SpotifyBrowserFallbackHandle,
} from "@/components/lyrics/spotify-browser-fallback";
import { TopBar } from "@/components/lyrics/top-bar";
import { SpotifyNativeDetector } from "@/components/lyrics/spotify-native-detector";
import { PromotionalBackdrop } from "@/components/ui/promotional-backdrop";
import { useSpotifySessionStore } from "@/store/spotify-session-store";
import { ListeningEmptyState } from "@/components/lyrics/listening-empty-state";
import { MarqueeText } from "@/components/ui/marquee-text";
import { bridgeClient } from "@/lib/bridge-client";
import {
  refreshLyricsForCurrentTrack,
  requestImmediateTranslationForCurrentSource,
} from "@/lib/lyrics-sync";
import { detectLyricsTimingMode } from "@/lib/lyrics-timing";
import type { PlaybackMode } from "@/lib/playback-source";
import {
  animateIconButtonPressIn,
  animateIconButtonPressOut,
  ICON_BUTTON_PRESS_SCALE,
} from "@/lib/icon-button-press-animation";
import { usePlaybackStore } from "@/store/playback-store";
import type { LyricLine } from "@/types/bridge";
import { usePlayerTour } from "@/hooks/use-player-tour";
import { TOUR_TRACK, usePlayerTourStore, type PlayerTourStep } from "@/store/player-tour-store";
import { DEMO_LYRICS } from "@/components/onboarding/renderer-preview";
import { PlayerTourOverlay } from "@/components/onboarding/player-tour-overlay";
import type { PreviewPlaybackAnchor } from "@/components/lyrics/use-playback-timeline-clock";
const LYRICS_PLAYBACK_WAKE_LOCK_TAG = "kinesync-lyrics-playback";
const CONTROLS_IDLE_TIMEOUT_MS = 2500;
const PLAYER_MODE_TRANSITION_MS = 420;
const PLAYER_MODE_EASE = ReanimatedEasing.out(ReanimatedEasing.cubic);
const TOP_BAR_ARTWORK_LEFT = 24;
const TOP_BAR_ARTWORK_RADIUS = 11;
const FULLSCREEN_ARTWORK_WIDTH_RATIO = 0.94;
const FULLSCREEN_ARTWORK_MAX_SIZE = 520;
const FULLSCREEN_ARTWORK_RADIUS = 22;
const FULLSCREEN_ALBUM_LABEL_GAP = 28;
const FULLSCREEN_ALBUM_LABEL_HEIGHT = 21;
const FULLSCREEN_ALBUM_LABEL_OFFSET = -8;
const FULLSCREEN_META_OFFSET = 30;
const FULLSCREEN_META_ESTIMATED_HEIGHT = 50;
const FULLSCREEN_ACTION_BUTTON_SIZE = 36;

function getLineKey(line: LyricLine) {
  return `${line.lineStartTime}-${line.lineEndTime}`;
}

function LyricsPlaybackWakeLock() {
  useKeepAwake(LYRICS_PLAYBACK_WAKE_LOCK_TAG);
  return null;
}

function isCensorshipBoundary(leftText: string, rightText: string) {
  const left = String(leftText || "").trim();
  const right = String(rightText || "").trim();
  if (!left || !right) {
    return false;
  }
  const censorRun = /^[*＊•·]+$/;
  return (
    (censorRun.test(left) && /^[A-Za-z0-9]/.test(right)) ||
    (/[A-Za-z0-9]$/.test(left) && censorRun.test(right))
  );
}

function getPrimaryLineText(line: LyricLine) {
  const syllables = line.syllables || [];
  if (!syllables.length) {
    return "";
  }

  let text = String(syllables[0]?.text || "");
  for (let index = 1; index < syllables.length; index += 1) {
    const prev = syllables[index - 1];
    const current = syllables[index];
    const currentText = String(current?.text || "");
    if (!currentText) {
      continue;
    }
    const hasWhitespaceBoundary = /\s$/.test(text) || /^\s/.test(currentText);
    const boundaryFromWordFlag = prev?.isPartOfWord === false;
    const prevTrim = String(prev?.text || "").trim();
    const currentTrim = currentText.trim();
    const boundaryFromCensorship = isCensorshipBoundary(prevTrim, currentTrim);
    const boundaryFromHeuristic =
      typeof prev?.isPartOfWord !== "boolean" &&
      /[A-Za-z0-9]$/.test(text) &&
      /^[A-Za-z0-9]/.test(currentText);
    if (
      !hasWhitespaceBoundary &&
      (boundaryFromWordFlag || boundaryFromCensorship || boundaryFromHeuristic)
    ) {
      text += " ";
    }
    text += currentText;
  }
  return text.trim();
}

function base64ToUint8Array(base64: string) {
  if (typeof atob !== "function") {
    throw new Error("Base64 decoding is not available in this browser.");
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function safeGifPayload(base64: unknown) {
  const value = typeof base64 === 'string' ? base64 : '';
  if (!value || value.length % 4 === 1 || value.length > Math.ceil(MAX_GIF_BYTES * 4 / 3) + 16 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Math.floor(value.replace(/=+$/, '').length * 3 / 4);
  return bytes > 0 && bytes <= MAX_GIF_BYTES ? value : null;
}

function makeSafeGifFileName() {
  const bytes = new Uint8Array(12);
  const cryptoApi = globalThis.crypto as { getRandomValues?: (array: Uint8Array) => Uint8Array } | undefined;
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else bytes.set(Array.from({ length: bytes.length }, () => Math.floor(Math.random() * 256)));
  return `kinesync-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}.gif`;
}

async function shareGifOnWeb({
  base64,
  fileName,
  mimeType,
  title,
  artist,
}: {
  base64: string;
  fileName: string;
  mimeType: string;
  title: string;
  artist: string;
}) {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new Error("Web download is not available in this environment.");
  }

  const blob = new Blob([base64ToUint8Array(base64)], { type: mimeType });
  const file =
    typeof File !== "undefined"
      ? new File([blob], fileName, { type: mimeType })
      : null;
  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean;
    share?: (data: {
      files?: File[];
      title?: string;
      text?: string;
    }) => Promise<void>;
  };

  if (file && nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({
      files: [file],
      title: "Share synced lyric GIF",
      text: `${title} - ${artist}`,
    });
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

type PlaybackControlsDockProps = {
  isPlaying: boolean;
  durationMs: number;
  shareSelectionCount?: number;
  shareSelectionMode?: boolean;
  shareBusy?: boolean;
  onScrubPreview?: (positionMs: number | null) => void;
  showResumeAutoFollow?: boolean;
  onResumeAutoFollow?: () => void;
  onOpenShareMenu?: () => void;
  onPlayPause: () => void;
  onPlayPauseResync?: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (positionMs: number) => void;
  onRequestTranslate?: () => void;
  translationLoading?: boolean;
  autoHidePlaybackControls?: boolean;
  onToggleAutoHidePlaybackControls?: () => void;
  playbackMode?: PlaybackMode;
  latencyMs?: number;
  onUserInteraction?: () => void;
  fullscreenAlbumMode?: boolean;
  fullscreenActions?: ReactNode;
  controlsModeTransitioning?: boolean;
  fullscreenAlbumProgress: SharedValue<number>;
  layout?: PlaybackControlsLayout;
  previewPlayback?: PreviewPlaybackAnchor;
  tourStep?: PlayerTourStep;
  previewTranslated?: boolean;
};

const PlaybackControlsDock = memo(function PlaybackControlsDock({
  isPlaying,
  durationMs,
  shareSelectionCount,
  shareSelectionMode,
  shareBusy,
  onScrubPreview,
  showResumeAutoFollow,
  onResumeAutoFollow,
  onOpenShareMenu,
  onPlayPause,
  onPlayPauseResync,
  onNext,
  onPrevious,
  onSeek,
  onRequestTranslate,
  translationLoading,
  autoHidePlaybackControls,
  onToggleAutoHidePlaybackControls,
  playbackMode = "desktop",
  latencyMs = 0,
  onUserInteraction,
  fullscreenAlbumMode,
  fullscreenActions,
  controlsModeTransitioning,
  fullscreenAlbumProgress,
  layout,
  previewPlayback,
  tourStep,
  previewTranslated,
}: PlaybackControlsDockProps) {
  return (
    <PlaybackControls
      previewPlayback={previewPlayback}
      tourStep={tourStep}
      previewTranslated={previewTranslated}
      isPlaying={isPlaying}
      durationMs={durationMs}
      shareSelectionCount={shareSelectionCount}
      shareSelectionMode={shareSelectionMode}
      shareBusy={shareBusy}
      onScrubPreview={onScrubPreview}
      showResumeAutoFollow={showResumeAutoFollow}
      onResumeAutoFollow={onResumeAutoFollow}
      onOpenShareMenu={onOpenShareMenu}
      onPlayPause={onPlayPause}
      onPlayPauseResync={onPlayPauseResync}
      onPrevious={onPrevious}
      onNext={onNext}
      onSeek={onSeek}
      onRequestTranslate={onRequestTranslate}
      translationLoading={translationLoading}
      autoHidePlaybackControls={autoHidePlaybackControls}
      onToggleAutoHidePlaybackControls={onToggleAutoHidePlaybackControls}
      playbackMode={playbackMode}
      latencyMs={latencyMs}
      onUserInteraction={onUserInteraction}
      fullscreenAlbumMode={fullscreenAlbumMode}
      fullscreenActions={fullscreenActions}
      controlsModeTransitioning={controlsModeTransitioning}
      fullscreenAlbumProgress={fullscreenAlbumProgress}
      layout={layout}
    />
  );
});

export default function HomeScreen() {
  const router = useRouter();
  const [isScreenFocused, setIsScreenFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setIsScreenFocused(true);
      return () => {
        setIsScreenFocused(false);
        if (usePlayerTourStore.getState().active) usePlayerTourStore.getState().finish();
      };
    }, []),
  );
  const spotifyBrowserRef = useRef<SpotifyBrowserFallbackHandle>(null);
  const insets = useSafeAreaInsets();
  const windowDimensions = useWindowDimensions();
  const tour = usePlayerTour(isScreenFocused);
  const liveTrack = usePlaybackStore((s) => s.currentTrack);
  const currentTrack = tour.active ? TOUR_TRACK : liveTrack;
  const connectionStatus = usePlaybackStore((s) => s.connectionStatus);
  const playbackMode = usePlaybackStore((s) => s.playbackMode);
  const spotifySignedIn = useSpotifySessionStore((s) => s.signedIn);
  const showEmptyState = !tour.active && (!currentTrack || (playbackMode === 'mobile' && !spotifySignedIn) || (playbackMode === 'desktop' && connectionStatus !== 'connected'));
  const driftOffset = usePlaybackStore((s) => s.driftOffset);
  const errorMessage = usePlaybackStore((s) => s.errorMessage);
  const liveIsPlaying = usePlaybackStore((s) => s.isPlaying);
  const isPlaying = tour.active ? tour.isPlaying : liveIsPlaying;
  const liveLyricsSource = usePlaybackStore((s) => s.lyricsSource);
  const lyricsSource = tour.active ? 'demo-syllable' : liveLyricsSource;
  const liveLyrics = usePlaybackStore((s) => s.lyrics);
  const lyrics = tour.active ? DEMO_LYRICS : liveLyrics;
  const lyricsMetadata = usePlaybackStore((s) => s.lyricsMetadata);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fullscreenAlbumMode, setFullscreenAlbumMode] = useState(false);
  const [lyricsMounted, setLyricsMounted] = useState(true);
  const [topBarMounted, setTopBarMounted] = useState(true);
  const [albumArtworkMorphing, setAlbumArtworkMorphing] = useState(false);
  const hasHandledFullscreenTransitionRef = useRef(false);
  const tapToSeekEnabled = true;
  const liveAutoHidePlaybackControls = usePlaybackStore((s) => s.autoHidePlaybackControls);
  const tourAutoHideDemo = tour.active && tour.step === 'autoHide';
  const autoHidePlaybackControls = tour.active ? tourAutoHideDemo && tour.autoHideControls : liveAutoHidePlaybackControls;
  const setAutoHidePlaybackControls = usePlaybackStore((s) => s.setAutoHidePlaybackControls);
  const liveShowTranslatedText = usePlaybackStore((s) => s.showTranslatedText);
  const showTranslatedText = tour.active ? tour.translated : liveShowTranslatedText;
  const previewPlayback = useMemo(() => tour.active ? {
    anchorPositionMs: tour.anchorPositionMs,
    anchorMonotonicMs: tour.anchorMonotonicMs,
    isPlaying: tour.isPlaying && tour.foreground && isScreenFocused,
  } : undefined, [tour.active, tour.anchorPositionMs, tour.anchorMonotonicMs, tour.isPlaying, tour.foreground, isScreenFocused]);
  const lyricsStyle = usePlaybackStore((s) => s.lyricsStyle);
  const setLyricsStyle = usePlaybackStore((s) => s.setLyricsStyle);
  const [autoFollowEnabled, setAutoFollowEnabled] = useState(true);
  const [resumeAutoFollowSignal, setResumeAutoFollowSignal] = useState(0);
  const [controlsDockHeight, setControlsDockHeight] = useState(0);
  const [scrubPreviewPositionMs, setScrubPreviewPositionMs] = useState<
    number | null
  >(null);
  // ponytail: throttle scrub state updates to ~32ms so every gesture frame doesn't re-render the 2150-line HomeScreen
  const scrubThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScrubValueRef = useRef<number | null>(null);
  const handleScrubPreview = useCallback((positionMs: number | null) => {
    if (positionMs === null) {
      if (scrubThrottleRef.current) {
        clearTimeout(scrubThrottleRef.current);
        scrubThrottleRef.current = null;
      }
      pendingScrubValueRef.current = null;
      setScrubPreviewPositionMs(null);
      return;
    }
    pendingScrubValueRef.current = positionMs;
    if (!scrubThrottleRef.current) {
      setScrubPreviewPositionMs(positionMs);
      scrubThrottleRef.current = setTimeout(() => {
        scrubThrottleRef.current = null;
        if (pendingScrubValueRef.current !== null) {
          setScrubPreviewPositionMs(pendingScrubValueRef.current);
        }
      }, 32);
    }
  }, []);
  const [activeLineIndex, setActiveLineIndex] = useState(-1);
  const [selectedLineKeys, setSelectedLineKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [shareBusy, setShareBusy] = useState(false);
  useEffect(() => {
    setFullscreenAlbumMode(false);
    setAlbumArtworkMorphing(false);
    setLyricsMounted(true);
    setTopBarMounted(true);
    setScrubPreviewPositionMs(null);
    setAutoFollowEnabled(true);
    setSelectedLineKeys(new Set());
  }, [tour.active]);
  const fullscreenAlbumProgress = useSharedValue(0);
  const topBarTrackPress = useSharedValue(0);
  const fullscreenMenuButtonScale = useSharedValue(1);
  const lyricsRestoreOpacity = useSharedValue(1);
  const controlsOpacity = useSharedValue(1);
  const controlsTranslateY = useSharedValue(0);
  const controlsIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const autoHidePlaybackControlsRef = useRef(autoHidePlaybackControls);
  const fullscreenAlbumModeRef = useRef(fullscreenAlbumMode);
  const albumArtworkMorphingRef = useRef(albumArtworkMorphing);
  const trackArtworkUrl = currentTrack?.artworkUrl ?? "";
  const trackAlbumTitle = String(currentTrack?.album || "").trim();
  const [resolvedAnimatedSquareUrl, setResolvedAnimatedSquareUrl] = useState("");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [landscapeArtControlsVisible, setLandscapeArtControlsVisible] =
    useState(false);
  const landscapeArtControlsVisibleRef = useRef(landscapeArtControlsVisible);
  const isLandscape = isLandscapeLayout(
    windowDimensions.width,
    windowDimensions.height,
  );
  const isLandscapeRef = useRef(isLandscape);
  useEffect(() => {
    if (tour.active && isLandscape && tour.step === 'lyrics') usePlayerTourStore.getState().advance('lyrics');
  }, [tour.active, tour.step, isLandscape]);
  const landscapeLayout = useMemo(
    () =>
      getLandscapeLayoutMetrics({
        viewportWidth: windowDimensions.width,
        viewportHeight: windowDimensions.height,
        safeTop: insets.top,
        safeBottom: insets.bottom,
        safeLeft: insets.left,
        safeRight: insets.right,
      }),
    [
      insets.bottom,
      insets.left,
      insets.right,
      insets.top,
      windowDimensions.height,
      windowDimensions.width,
    ],
  );
  const landscapeArtworkSize = landscapeLayout.artworkSize;
  const landscapeLeftPaneWidth = landscapeLayout.leftPaneWidth;

  const resolvedArtworkUrl = useMemo(
    () => tour.active ? Asset.fromModule(require('@/assets/images/R.png')).uri : normalizeBridgeArtworkUri(trackArtworkUrl),
    [trackArtworkUrl, tour.active],
  );
  const hasResolvedArtwork = resolvedArtworkUrl.length > 0;

  useEffect(() => {
    setResolvedAnimatedSquareUrl("");
    if (!currentTrack || tour.active) {
      return;
    }
    let cancelled = false;
    void resolveAnimatedArtworkForTrack(currentTrack).then((urls) => {
      if (cancelled) {
        return;
      }
      setResolvedAnimatedSquareUrl(urls?.squareUrl ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [currentTrack, tour.active]);

  useEffect(() => {
    if (
      tour.active || playbackMode !== "mobile" ||
      connectionStatus === "connected" ||
      !currentTrack ||
      Boolean(normalizeBridgeArtworkUri(currentTrack.artworkUrl))
    ) {
      return;
    }
    let cancelled = false;
    const trackId = currentTrack.id;
    void resolveTrackArtworkUrl(currentTrack).then((artworkUrl) => {
      if (cancelled || !artworkUrl) {
        return;
      }
      const state = usePlaybackStore.getState();
      if (
        state.playbackMode === "mobile" &&
        state.connectionStatus !== "connected"
      ) {
        state.setCurrentTrackArtwork(trackId, artworkUrl);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    currentTrack,
    tour.active,
    connectionStatus,
    playbackMode,
    currentTrack?.id,
    currentTrack?.title,
    currentTrack?.artist,
    currentTrack?.album,
    currentTrack?.durationMs,
    currentTrack?.artworkUrl,
  ]);

  const fullscreenControlsReserve = Math.max(controlsDockHeight + 26, 210);
  const fullscreenArtworkSize = Math.min(
    windowDimensions.width * FULLSCREEN_ARTWORK_WIDTH_RATIO,
    FULLSCREEN_ARTWORK_MAX_SIZE,
  );
  const fullscreenArtworkLeft =
    (windowDimensions.width - fullscreenArtworkSize) / 2;
  const fullscreenArtworkAvailableHeight = Math.max(
    fullscreenArtworkSize,
    windowDimensions.height - insets.top - fullscreenControlsReserve,
  );
  const fullscreenAlbumLabelBlockHeight = trackAlbumTitle
    ? FULLSCREEN_ALBUM_LABEL_HEIGHT +
      FULLSCREEN_ALBUM_LABEL_GAP +
      FULLSCREEN_ALBUM_LABEL_OFFSET
    : 0;
  const fullscreenArtworkBlockHeight =
    fullscreenAlbumLabelBlockHeight +
    fullscreenArtworkSize +
    FULLSCREEN_META_OFFSET +
    FULLSCREEN_META_ESTIMATED_HEIGHT;
  const fullscreenArtworkTop =
    insets.top +
    TOP_BAR_ARTWORK_TOP +
    Math.max(
      0,
      (fullscreenArtworkAvailableHeight - fullscreenArtworkBlockHeight) / 2,
    );
  const fullscreenArtworkImageTop =
    fullscreenArtworkTop + fullscreenAlbumLabelBlockHeight;
  const bridgeConnected = connectionStatus === "connected";
  const translationLoading = !tour.active && Boolean(lyricsMetadata.translation?.isLoading);
  const lyricsTimingMode = useMemo(
    () => detectLyricsTimingMode(lyrics, lyricsSource),
    [lyrics, lyricsSource],
  );

  const finishLyricsModeTransition = useCallback(() => {
    albumArtworkMorphingRef.current = false;
    setAlbumArtworkMorphing(false);
  }, []);

  useEffect(() => {
    if (!hasHandledFullscreenTransitionRef.current) {
      hasHandledFullscreenTransitionRef.current = true;
      fullscreenAlbumProgress.value = fullscreenAlbumMode ? 1 : 0;
      setLyricsMounted(true);
      setTopBarMounted(!fullscreenAlbumMode);
      lyricsRestoreOpacity.value = fullscreenAlbumMode ? 0 : 1;
      return;
    }

    const targetProgress = fullscreenAlbumMode ? 1 : 0;
    if (fullscreenAlbumMode) {
      setTopBarMounted(true);
      setLyricsMounted(true);
    } else {
      setTopBarMounted(true);
      setLyricsMounted(true);
    }

    fullscreenAlbumProgress.value = withTiming(
      targetProgress,
      {
        duration: PLAYER_MODE_TRANSITION_MS,
        easing: PLAYER_MODE_EASE,
      },
      (finished) => {
        if (!finished) {
          return;
        }
        if (targetProgress === 0) {
          runOnJS(setLyricsMounted)(true);
          runOnJS(finishLyricsModeTransition)();
          return;
        }
        runOnJS(setAlbumArtworkMorphing)(false);
        runOnJS(setTopBarMounted)(false);
      },
    );
  }, [
    finishLyricsModeTransition,
    fullscreenAlbumMode,
    fullscreenAlbumProgress,
    lyricsRestoreOpacity,
  ]);

  useEffect(() => {
    setSelectedLineKeys(new Set());
  }, [currentTrack?.id]);

  useEffect(() => {
    autoHidePlaybackControlsRef.current = autoHidePlaybackControls;
  }, [autoHidePlaybackControls]);

  useEffect(() => {
    fullscreenAlbumModeRef.current = fullscreenAlbumMode;
  }, [fullscreenAlbumMode]);

  useEffect(() => {
    albumArtworkMorphingRef.current = albumArtworkMorphing;
  }, [albumArtworkMorphing]);

  useEffect(() => {
    isLandscapeRef.current = isLandscape;
  }, [isLandscape]);

  useEffect(() => {
    landscapeArtControlsVisibleRef.current = landscapeArtControlsVisible;
  }, [landscapeArtControlsVisible]);

  useEffect(() => {
    if (!isLandscape) {
      return;
    }
    if (fullscreenAlbumMode) {
      fullscreenAlbumModeRef.current = false;
      setFullscreenAlbumMode(false);
      setTopBarMounted(true);
      albumArtworkMorphingRef.current = false;
      setAlbumArtworkMorphing(false);
      fullscreenAlbumProgress.value = 0;
    }
    setLandscapeArtControlsVisible(false);
  }, [fullscreenAlbumMode, fullscreenAlbumProgress, isLandscape]);

  const clearControlsIdleTimer = useCallback(() => {
    if (controlsIdleTimerRef.current) {
      clearTimeout(controlsIdleTimerRef.current);
      controlsIdleTimerRef.current = null;
    }
  }, []);

  const hideControls = useCallback(() => {
    setControlsVisible(false);
    controlsOpacity.value = withTiming(0, {
      duration: 240,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
    controlsTranslateY.value = withTiming(44, {
      duration: 260,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [controlsOpacity, controlsTranslateY]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    controlsOpacity.value = withTiming(1, {
      duration: 220,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
    controlsTranslateY.value = withTiming(0, {
      duration: 240,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [controlsOpacity, controlsTranslateY]);

  const scheduleControlsHide = useCallback(() => {
    clearControlsIdleTimer();

    if (isLandscapeRef.current && !tourAutoHideDemo) {
      if (!landscapeArtControlsVisibleRef.current) {
        return;
      }
      controlsIdleTimerRef.current = setTimeout(() => {
        controlsIdleTimerRef.current = null;
        if (isLandscapeRef.current) {
          setLandscapeArtControlsVisible(false);
        }
      }, CONTROLS_IDLE_TIMEOUT_MS);
      return;
    }

    if (
      fullscreenAlbumModeRef.current ||
      !autoHidePlaybackControlsRef.current
    ) {
      showControls();
      return;
    }

    controlsIdleTimerRef.current = setTimeout(() => {
      controlsIdleTimerRef.current = null;
      if (
        fullscreenAlbumModeRef.current ||
        !autoHidePlaybackControlsRef.current
      ) {
        showControls();
        return;
      }
      hideControls();
    }, CONTROLS_IDLE_TIMEOUT_MS);
  }, [clearControlsIdleTimer, hideControls, showControls, tourAutoHideDemo]);

  const handleControlsInteraction = useCallback(() => {
    if (isLandscapeRef.current && !tourAutoHideDemo) {
      scheduleControlsHide();
      return;
    }
    if (!controlsVisible) {
      showControls();
    }
    scheduleControlsHide();
  }, [controlsVisible, scheduleControlsHide, showControls, tourAutoHideDemo]);

  useEffect(() => {
    clearControlsIdleTimer();

    if (isLandscape && !tourAutoHideDemo) {
      if (landscapeArtControlsVisible) {
        scheduleControlsHide();
      }
      return clearControlsIdleTimer;
    }

    if (fullscreenAlbumMode || !autoHidePlaybackControls) {
      showControls();
      return clearControlsIdleTimer;
    }

    scheduleControlsHide();
    return clearControlsIdleTimer;
  }, [
    autoHidePlaybackControls,
    clearControlsIdleTimer,
    fullscreenAlbumMode,
    isLandscape,
    landscapeArtControlsVisible,
    scheduleControlsHide,
    showControls,
    tourAutoHideDemo,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', () => setScrubPreviewPositionMs(null));
    return () => subscription.remove();
  }, []);

  const sendSeekToPlaybackSource = useCallback((positionMs: number) => {
    if (usePlaybackStore.getState().connectionStatus === "connected") {
      bridgeClient.seekTo(positionMs);
      return;
    }
    spotifyBrowserRef.current?.seekTo(positionMs);
  }, []);

  const handlePlaybackPlayPause = useCallback(() => {
    if (usePlayerTourStore.getState().active) { usePlayerTourStore.getState().togglePlayback(); return; }
    if (usePlaybackStore.getState().connectionStatus === "connected") {
      bridgeClient.togglePlayPause();
      return;
    }
    spotifyBrowserRef.current?.togglePlayPause();
  }, []);

  const handlePlaybackResync = useCallback(() => {
    if (usePlayerTourStore.getState().active) return;
    if (usePlaybackStore.getState().connectionStatus === "connected") {
      bridgeClient.resyncPlayback();
      return;
    }
    spotifyBrowserRef.current?.resyncPlayback();
  }, []);

  const handlePlaybackPrevious = useCallback(() => {
    if (usePlayerTourStore.getState().active) { usePlayerTourStore.getState().seek(0); return; }
    if (usePlaybackStore.getState().connectionStatus === "connected") {
      bridgeClient.skipPrevious();
      return;
    }
    spotifyBrowserRef.current?.skipPrevious();
  }, []);

  const handlePlaybackNext = useCallback(() => {
    if (usePlayerTourStore.getState().active) { usePlayerTourStore.getState().seek(0); return; }
    if (usePlaybackStore.getState().connectionStatus === "connected") {
      bridgeClient.skipNext();
      return;
    }
    spotifyBrowserRef.current?.skipNext();
  }, []);
  const handleLyricLinePress = useCallback((line: LyricLine) => {
    if (usePlayerTourStore.getState().active) {
      usePlayerTourStore.getState().seek(line.lineStartTime);
      usePlayerTourStore.getState().advance('seek');
      setScrubPreviewPositionMs(null);
      setAutoFollowEnabled(true);
      setResumeAutoFollowSignal(value => value + 1);
      return;
    }
    const nowWall = Date.now();
    const nowMono =
      typeof performance !== "undefined" &&
      typeof performance.now === "function"
        ? performance.now()
        : nowWall;
    usePlaybackStore.setState({
      anchorPositionMs: line.lineStartTime,
      anchorTimestampMs: nowWall,
      anchorMonotonicMs: nowMono,
      playbackPosition: line.lineStartTime,
    });
    sendSeekToPlaybackSource(line.lineStartTime);
    setScrubPreviewPositionMs(null);
    setAutoFollowEnabled(true);
    setResumeAutoFollowSignal((value) => value + 1);
  }, [sendSeekToPlaybackSource]);

  const handleSeek = useCallback(
    (positionMs: number) => {
      if (usePlayerTourStore.getState().active) {
        usePlayerTourStore.getState().seek(positionMs);
        usePlayerTourStore.getState().advance('seek');
        setScrubPreviewPositionMs(null);
        setAutoFollowEnabled(true);
        setResumeAutoFollowSignal(value => value + 1);
        return;
      }
      const clamped = Math.max(
        0,
        Math.min(positionMs, currentTrack?.durationMs ?? positionMs),
      );
      const nowWall = Date.now();
      const nowMono =
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
          ? performance.now()
          : nowWall;
      usePlaybackStore.setState({
        anchorPositionMs: clamped,
        anchorTimestampMs: nowWall,
        anchorMonotonicMs: nowMono,
        playbackPosition: clamped,
      });
      if (isPlaying && autoFollowEnabled) {
        setAutoFollowEnabled(false);
      }
      sendSeekToPlaybackSource(clamped);
      setScrubPreviewPositionMs(null);
      setAutoFollowEnabled(true);
      setResumeAutoFollowSignal((value) => value + 1);
    },
    [autoFollowEnabled, currentTrack?.durationMs, isPlaying, sendSeekToPlaybackSource],
  );

  const handleActiveLineChange = useCallback((nextActiveLine: number) => {
    setActiveLineIndex(nextActiveLine);
  }, []);

  const handleLineLongPress = useCallback((line: LyricLine) => {
    if (usePlayerTourStore.getState().active) return;
    const key = getLineKey(line);
    setSelectedLineKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const ensureSelectionForShare = useCallback(() => {
    const { lyrics } = usePlaybackStore.getState();
    const selected = lyrics.filter((line) =>
      selectedLineKeys.has(getLineKey(line)),
    );
    if (selected.length > 0) {
      return selected;
    }
    if (!lyrics.length) {
      return [];
    }
    const anchorIndex = Math.max(0, activeLineIndex);
    const start = Math.max(0, Math.min(anchorIndex, lyrics.length - 1));
    const end = Math.min(lyrics.length, start + 6);
    return lyrics.slice(start, end);
  }, [activeLineIndex, selectedLineKeys]);

  const exportShareGif = useCallback(async () => {
    if (shareBusy) {
      return;
    }
    const linesToShare = ensureSelectionForShare();
    if (!currentTrack?.id || !linesToShare.length) {
      Alert.alert("Nothing to share", "Select at least one lyric line first.");
      return;
    }

    setShareBusy(true);
    try {
      const response = await bridgeClient.requestShareGif({
        trackId: currentTrack.id,
        title: currentTrack.title,
        artist: currentTrack.artist,
        artworkUrl: resolvedArtworkUrl,
        includeTranslations: showTranslatedText,
        lines: linesToShare
          .map((line) => {
            const text = getPrimaryLineText(line);
            if (!text) {
              return null;
            }
            return {
              lineStartTime: line.lineStartTime,
              lineEndTime: line.lineEndTime,
              text,
              translatedText: showTranslatedText
                ? String(line.translatedText || "").trim() || undefined
                : undefined,
              syllables: (line.syllables || []).map((syl) => ({
                text: String(syl.text || ""),
                startTime: Number(syl.startTime || line.lineStartTime),
                endTime: Number(syl.endTime || line.lineEndTime),
              })),
            };
          })
          .filter((line): line is NonNullable<typeof line> => Boolean(line)),
      });

      const safeBase64 = safeGifPayload(response.base64);
      if (!response.ok || !safeBase64 || response.mimeType && response.mimeType !== 'image/gif') {
        throw new Error(
          response.error || "Desktop bridge did not return GIF data.",
        );
      }

      const fileName = makeSafeGifFileName();
      if (Platform.OS === "web") {
        await shareGifOnWeb({
          base64: safeBase64,
          fileName,
          mimeType: response.mimeType || "image/gif",
          title: currentTrack.title,
          artist: currentTrack.artist,
        });
        return;
      }

      const uri = `${FileSystem.cacheDirectory || ""}${fileName}`;
      await FileSystem.writeAsStringAsync(uri, safeBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          dialogTitle: "Share synced lyric GIF",
          mimeType: "image/gif",
          UTI: "com.compuserve.gif",
        });
      } else {
        await Share.share({
          message: `Lyric GIF ready: ${currentTrack.title} - ${currentTrack.artist}`,
          url: uri,
        });
      }
    } catch (error) {
      Alert.alert(
        "GIF export failed",
        error instanceof Error ? error.message : "Unable to create GIF.",
      );
    } finally {
      setShareBusy(false);
    }
  }, [
    currentTrack,
    ensureSelectionForShare,
    resolvedArtworkUrl,
    shareBusy,
    showTranslatedText,
  ]);

  const clearSelection = useCallback(() => {
    setSelectedLineKeys(new Set());
  }, []);

  const openShareMenu = useCallback(() => {
    const selectedCount = selectedLineKeys.size;
    const fallbackCount = ensureSelectionForShare().length;
    Alert.alert(
      "Share Lyric GIF",
      selectedCount > 0
        ? `${selectedCount} selected line${selectedCount === 1 ? "" : "s"} will be animated.`
        : `No lines selected. Sharing ${fallbackCount} lines from current playback window.`,
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Clear selection",
          style: "destructive",
          onPress: clearSelection,
        },
        {
          text: "Create GIF",
          onPress: () => {
            void exportShareGif();
          },
        },
      ],
    );
  }, [
    clearSelection,
    ensureSelectionForShare,
    exportShareGif,
    selectedLineKeys.size,
  ]);

  const handleResumeAutoFollow = useCallback(() => {
    setScrubPreviewPositionMs(null);
    setAutoFollowEnabled(true);
    setResumeAutoFollowSignal((value) => value + 1);
    usePlayerTourStore.getState().advance('autoScroll');
  }, []);

  const handleToggleAutoHidePlaybackControls = useCallback(() => {
    if (usePlayerTourStore.getState().active) { usePlayerTourStore.getState().toggleAutoHide(); return; }
    const next = !autoHidePlaybackControlsRef.current;
    autoHidePlaybackControlsRef.current = next;
    setAutoHidePlaybackControls(next);
  }, [setAutoHidePlaybackControls]);

  const handleShowFullscreenAlbum = useCallback(() => {
    usePlayerTourStore.getState().advance('artwork');
    albumArtworkMorphingRef.current = true;
    setAlbumArtworkMorphing(true);
    fullscreenAlbumModeRef.current = true;
    setFullscreenAlbumMode(true);
    showControls();
    setScrubPreviewPositionMs(null);
  }, [showControls]);

  const handleLandscapeArtworkPress = useCallback(() => {
    usePlayerTourStore.getState().advance('artwork');
    usePlayerTourStore.getState().advance('lyrics');
    setLandscapeArtControlsVisible((visible) => {
      const next = !visible;
      landscapeArtControlsVisibleRef.current = next;
      if (next) {
        scheduleControlsHide();
      } else {
        clearControlsIdleTimer();
      }
      return next;
    });
    handleControlsInteraction();
  }, [clearControlsIdleTimer, handleControlsInteraction, scheduleControlsHide]);

  const handleShowLyrics = useCallback(() => {
    usePlayerTourStore.getState().advance('lyrics');
    albumArtworkMorphingRef.current = true;
    setAlbumArtworkMorphing(true);
    fullscreenAlbumModeRef.current = false;
    setFullscreenAlbumMode(false);
    setTopBarMounted(true);
  }, []);

  const handleAutoFollowChange = useCallback(
    (enabled: boolean) => {
      setAutoFollowEnabled(enabled);
      if (enabled) {
        setScrubPreviewPositionMs(null);
      }
      if (!enabled) {
        handleControlsInteraction();
      }
    },
    [handleControlsInteraction],
  );

  const controlsStyle = useAnimatedStyle(() => {
    return {
      opacity: controlsOpacity.value,
      transform: [{ translateY: controlsTranslateY.value }],
    };
  });

  const lyricsBottomBlurOpacityStyle = useAnimatedStyle(() => {
    const modeOpacity = interpolate(
      fullscreenAlbumProgress.value,
      [0, 0.32],
      [1, 0],
      Extrapolation.CLAMP,
    );
    return {
      opacity:
        controlsOpacity.value *
        modeOpacity *
        lyricsRestoreOpacity.value,
    };
  });


  const fullscreenMenuButtonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: fullscreenMenuButtonScale.value }],
    opacity: interpolate(
      fullscreenMenuButtonScale.value,
      [1, ICON_BUTTON_PRESS_SCALE],
      [1, 0.86],
    ),
  }));

  const animatedAlbumArtworkStyle = useAnimatedStyle(() => {
    const progress = fullscreenAlbumProgress.value;
    const startTop = insets.top + TOP_BAR_ARTWORK_TOP;
    const startSize = TOP_BAR_ARTWORK_SIZE;
    const endSize = fullscreenArtworkSize;
    const endLeft = fullscreenArtworkLeft;
    const endTop = fullscreenArtworkImageTop;
    const morphScale = interpolate(progress, [0, 1], [startSize / endSize, 1]);
    const startCenterX = TOP_BAR_ARTWORK_LEFT + startSize / 2;
    const startCenterY = startTop + startSize / 2;
    const endCenterX = endLeft + endSize / 2;
    const endCenterY = endTop + endSize / 2;
    const translateX = interpolate(
      progress,
      [0, 1],
      [startCenterX - endCenterX, 0],
    );
    const translateY = interpolate(
      progress,
      [0, 1],
      [startCenterY - endCenterY, 0],
    );
    const borderRadius = interpolate(
      progress,
      [0, 1],
      [
        (TOP_BAR_ARTWORK_RADIUS * endSize) / startSize,
        FULLSCREEN_ARTWORK_RADIUS,
      ],
    );
    const shadowOpacity = interpolate(progress, [0, 0.88, 1], [0, 0, 0.28]);
    const backgroundColor = interpolateColor(
      progress,
      [0, 1],
      ["rgba(255,255,255,0.12)", "rgba(255,255,255,0)"],
    );

    let pressScale = 1;
    let opacity = 1;
    if (progress <= 0.02) {
      const pressed = topBarTrackPress.value;
      pressScale = interpolate(pressed, [0, 1], [1, 0.99]);
      opacity = interpolate(pressed, [0, 1], [1, 0.82]);
    }

    return {
      left: endLeft,
      top: endTop,
      width: endSize,
      height: endSize,
      borderRadius,
      backgroundColor,
      opacity,
      shadowOpacity,
      transform: [
        { translateX },
        { translateY },
        { scale: morphScale * pressScale },
      ],
    };
  }, [
    fullscreenAlbumProgress,
    fullscreenArtworkImageTop,
    fullscreenArtworkLeft,
    fullscreenArtworkSize,
    fullscreenArtworkTop,
    insets.top,
    topBarTrackPress,
  ]);

  const lyricsViewportStyle = useMemo(
    () => ({
      position: "absolute" as const,
      left: 0,
      right: 0,
      top: insets.top + TOP_BAR_CONTENT_HEIGHT + LYRICS_WRAP_MARGIN_TOP,
      bottom: 0,
      overflow: "hidden" as const,
    }),
    [insets.top],
  );

  const lyricsChromeOpacityStyle = useAnimatedStyle(() => {
    const modeOpacity = interpolate(
      fullscreenAlbumProgress.value,
      [0, 0.32],
      [1, 0],
      Extrapolation.CLAMP,
    );
    return {
      opacity: modeOpacity * lyricsRestoreOpacity.value,
    };
  });

  const fullscreenChromeOpacityStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      fullscreenAlbumProgress.value,
      [0, 0.68, 1],
      [0, 0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  const handleControlsDockLayout = useCallback((height: number) => {
    if (fullscreenAlbumModeRef.current || albumArtworkMorphingRef.current) {
      return;
    }
    setControlsDockHeight(height);
  }, []);

  const handleTranslate = useCallback(() => {
    if (usePlayerTourStore.getState().active) { usePlayerTourStore.getState().translate(); return; }
    void requestImmediateTranslationForCurrentSource();
  }, []);
  const handleOpenMenu = useCallback(() => {
    if (usePlayerTourStore.getState().active) {
      Alert.alert('Player menu', 'When you’re listening, this menu lets you change lyrics style, refresh lyrics, and open more player options.');
      return;
    }
    setMenuOpen(true);
  }, []);

  return (
    <View style={styles.screen}>
      {isScreenFocused && isPlaying && lyrics.length > 0 ? (
        <LyricsPlaybackWakeLock />
      ) : null}
      {hasResolvedArtwork ? (
        // ponytail: single blurred image; sharp layer was fully occluded by tint anyway
        <BridgedArtworkImage
          uri={resolvedArtworkUrl}
          style={styles.backgroundBlur}
          contentFit="cover"
          blurRadius={40}
          recyclingKey={`background-blur-${resolvedArtworkUrl}`}
        />
      ) : null}
      {!hasResolvedArtwork && <PromotionalBackdrop />}
      <View
        style={[
          hasResolvedArtwork && styles.backgroundTint,
          hasResolvedArtwork && styles.backgroundTintWithArtwork,
        ]}
      />

      {isLandscape ? (
        <View style={styles.landscapeRoot}>
          <View style={styles.landscapeLeftPane}>
            <SafeAreaView
              edges={["top", "left", "bottom"]}
              style={[
                styles.landscapeLeftSafe,
                { paddingHorizontal: LANDSCAPE_LEFT_PANE_PADDING },
              ]}
            >
              <HorizontalPlayerPanel
                title={currentTrack?.title || "KineSync"}
                artist={
                  currentTrack?.artist || ""
                }
                artworkUrl={resolvedArtworkUrl}
                animatedArtworkUrl={resolvedAnimatedSquareUrl}
                artworkActive={isScreenFocused}
                artworkSize={landscapeArtworkSize}
                lyricsTimingMode={lyricsTimingMode}
                lyricsSource={lyricsSource}
                onMenuPress={handleOpenMenu}
                onArtworkPress={handleLandscapeArtworkPress}
                controlsOverlayVisible={landscapeArtControlsVisible}
                controlsOverlay={
                  <PlaybackControlsDock
                    previewPlayback={previewPlayback}
                    tourStep={tour.active ? tour.step : undefined}
                    previewTranslated={tour.active ? tour.translated : undefined}
                    layout="overlay"
                    isPlaying={isPlaying}
                    durationMs={currentTrack?.durationMs ?? 0}
                    onScrubPreview={handleScrubPreview}
                    onPlayPause={handlePlaybackPlayPause}
                    onPlayPauseResync={handlePlaybackResync}
                    onPrevious={handlePlaybackPrevious}
                    onNext={handlePlaybackNext}
                    onSeek={handleSeek}
                    onUserInteraction={handleControlsInteraction}
                    fullscreenAlbumProgress={fullscreenAlbumProgress}
                  />
                }
                utilityRow={
                  <PlaybackControlsDock
                    previewPlayback={previewPlayback}
                    tourStep={tour.active ? tour.step : undefined}
                    previewTranslated={tour.active ? tour.translated : undefined}
                    layout="landscape-utilities"
                    isPlaying={isPlaying}
                    durationMs={currentTrack?.durationMs ?? 0}
                    onScrubPreview={handleScrubPreview}
                    showResumeAutoFollow={
                      !autoFollowEnabled && scrubPreviewPositionMs === null
                    }
                    onResumeAutoFollow={handleResumeAutoFollow}
                    onPlayPause={handlePlaybackPlayPause}
                    onPlayPauseResync={handlePlaybackResync}
                    onPrevious={handlePlaybackPrevious}
                    onNext={handlePlaybackNext}
                    onSeek={handleSeek}
                    onRequestTranslate={handleTranslate}
                    translationLoading={translationLoading}
                    onUserInteraction={handleControlsInteraction}
                    fullscreenAlbumProgress={fullscreenAlbumProgress}
                  />
                }
              />
            </SafeAreaView>
          </View>

          {lyricsMounted ? (
            <SafeAreaView
              edges={["top", "right", "bottom"]}
              style={[
                styles.landscapeRightPane,
                { paddingLeft: LANDSCAPE_LYRICS_PADDING },
              ]}
            >
              {showEmptyState ? (
                <ListeningEmptyState mobile={playbackMode === 'mobile'} connected={connectionStatus === 'connected'} signedIn={spotifySignedIn} onConnect={() => router.push({ pathname: '/explore', params: { action: 'scan' } })} onSignIn={() => router.push({ pathname: '/explore', params: { action: 'login' } })} />
              ) : lyricsStyle === "amll" ? (
                <AmllLyricsView
                  active={isScreenFocused && (!tour.active || tour.foreground)}
                  demoLyrics={tour.active ? DEMO_LYRICS : undefined}
                  demoLayout="player"
                  demoIsPlaying={tour.active ? tour.isPlaying : undefined}
                  tapToSeekEnabled={tapToSeekEnabled}
                  showTranslatedText={showTranslatedText}
                        selectedLineKeys={selectedLineKeys}
                  previewPositionMs={tour.active ? (scrubPreviewPositionMs ?? tour.position) : scrubPreviewPositionMs}
                  autoFollowEnabled={autoFollowEnabled}
                  resumeAutoFollowSignal={resumeAutoFollowSignal}
                  onLinePress={handleLyricLinePress}
                  onLineLongPress={handleLineLongPress}
                  onActiveLineChange={handleActiveLineChange}
                  onAutoFollowChange={handleAutoFollowChange}
                  onCreditsTimestampPress={handleSeek}
                  onUserInteraction={handleControlsInteraction}
                  fontScale={LANDSCAPE_FONT_SCALE}
                  landscapeMode
                />
              ) : (
                <SpicyLyricsView
                  active={isScreenFocused && (!tour.active || tour.foreground)}
                  demoLyrics={tour.active ? DEMO_LYRICS : undefined}
                  demoLayout="player"
                  demoIsPlaying={tour.active ? tour.isPlaying : undefined}
                  tapToSeekEnabled={tapToSeekEnabled}
                  showTranslatedText={showTranslatedText}
                        selectedLineKeys={selectedLineKeys}
                  previewPositionMs={tour.active ? (scrubPreviewPositionMs ?? tour.position) : scrubPreviewPositionMs}
                  autoFollowEnabled={autoFollowEnabled}
                  resumeAutoFollowSignal={resumeAutoFollowSignal}
                  onLinePress={handleLyricLinePress}
                  onLineLongPress={handleLineLongPress}
                  onActiveLineChange={handleActiveLineChange}
                  onAutoFollowChange={handleAutoFollowChange}
                  onCreditsTimestampPress={handleSeek}
                  onUserInteraction={handleControlsInteraction}
                  fontScale={LANDSCAPE_FONT_SCALE}
                  landscapeMode
                />
              )}
            </SafeAreaView>
          ) : null}
        </View>
      ) : null}

      {!isLandscape ? (
      <>
      <Reanimated.View
        collapsable={false}
        pointerEvents="none"
        style={[styles.animatedAlbumArtworkShell, animatedAlbumArtworkStyle]}
      >
        {hasResolvedArtwork ? (
          <AnimatedBridgedArtwork
            staticUri={resolvedArtworkUrl}
            animatedUri={resolvedAnimatedSquareUrl}
            active={isScreenFocused && !albumArtworkMorphing}
            style={styles.animatedAlbumArtwork}
          />
        ) : null}
      </Reanimated.View>

      {fullscreenAlbumMode && !albumArtworkMorphing ? (
        <Reanimated.View>
          <Reanimated.View
            entering={FadeIn.duration(PLAYER_MODE_TRANSITION_MS).easing(
              PLAYER_MODE_EASE,
            )}
            exiting={FadeOut.duration(220).easing(PLAYER_MODE_EASE)}
          >
            <SafeAreaView
              edges={["top", "left", "right"]}
              style={styles.fullscreenTopSafeArea}
            />
          </Reanimated.View>
        </Reanimated.View>
      ) : topBarMounted ? (
        <Reanimated.View>
          <Reanimated.View
            exiting={FadeOutUp.duration(260).easing(PLAYER_MODE_EASE)}
          >
            <SafeAreaView
              edges={["top", "left", "right"]}
              style={styles.topSafeArea}
            >
              <Reanimated.View style={lyricsChromeOpacityStyle}>
                  <TopBar
                  tourHighlight={tour.active && tour.step === 'artwork'}
                  fitTitle={tour.active}
                  title={currentTrack?.title || "KineSync"}
                  artist={
                    currentTrack?.artist || ""
                  }
                  artworkUrl={resolvedArtworkUrl}
                  onTrackPress={currentTrack ? handleShowFullscreenAlbum : undefined}
                  onTrackPressIn={() => {
                    topBarTrackPress.value = 1;
                  }}
                  onTrackPressOut={() => {
                    topBarTrackPress.value = 0;
                  }}
                  hideArtwork={Boolean(currentTrack)}
                  lyricsTimingMode={lyricsTimingMode}
                  lyricsSource={lyricsSource}
                  onMenuPress={handleOpenMenu}
                />
              </Reanimated.View>
            </SafeAreaView>
          </Reanimated.View>
        </Reanimated.View>
      ) : null}

      {(fullscreenAlbumMode || albumArtworkMorphing) && (
        <Reanimated.View
          pointerEvents={
            fullscreenAlbumMode && !albumArtworkMorphing ? "box-none" : "none"
          }
          style={[
            styles.fullscreenAlbumWrap,
            {
              paddingTop: fullscreenArtworkTop,
              paddingBottom: fullscreenControlsReserve,
            },
            fullscreenChromeOpacityStyle,
          ]}
        >
          <Reanimated.View style={styles.fullscreenAlbumContent}>
            {trackAlbumTitle ? (
              <View
                style={[
                  styles.fullscreenAlbumLabelWrap,
                  {
                    width: fullscreenArtworkSize,
                    marginTop: FULLSCREEN_ALBUM_LABEL_OFFSET,
                    marginBottom: FULLSCREEN_ALBUM_LABEL_GAP,
                  },
                ]}
              >
                <MarqueeText style={styles.fullscreenAlbumLabel}>
                  {trackAlbumTitle}
                </MarqueeText>
              </View>
            ) : null}
            <View
              style={[
                styles.fullscreenAlbumArtSpacer,
                {
                  width: fullscreenArtworkSize,
                  height: fullscreenArtworkSize,
                },
              ]}
            />
            <Reanimated.View style={styles.fullscreenAlbumMetaOuter}>
              <Reanimated.View style={styles.fullscreenAlbumMetaRow}>
                <View style={styles.fullscreenAlbumTitleWrap}>
                  <MarqueeText style={styles.fullscreenAlbumTitle}>
                    {currentTrack?.title || "Waiting for Spotify"}
                  </MarqueeText>
                  <MarqueeText style={styles.fullscreenAlbumArtist}>
                    {currentTrack?.artist || "Desktop bridge not detected yet"}
                  </MarqueeText>
                </View>

                <View style={styles.fullscreenAlbumActionRow}>

                  <Reanimated.View style={fullscreenMenuButtonAnimatedStyle}>
                    <BlurView
                      intensity={34}
                      tint="light"
                      style={styles.fullscreenAlbumIconCapsule}
                    >
                      <Pressable
                        accessibilityLabel="Open player menu"
                        style={({ pressed }) => [
                          styles.fullscreenAlbumIconButton,
                          pressed && styles.fullscreenAlbumIconButtonPressed,
                        ]}
                        onPressIn={() => {
                          animateIconButtonPressIn(fullscreenMenuButtonScale);
                        }}
                        onPressOut={() => {
                          animateIconButtonPressOut(fullscreenMenuButtonScale);
                        }}
                        onPress={handleOpenMenu}
                      >
                        <Ionicons
                          name="ellipsis-horizontal"
                          size={18}
                          color="#F9FAFC"
                        />
                      </Pressable>
                    </BlurView>
                  </Reanimated.View>
                </View>
              </Reanimated.View>
            </Reanimated.View>
          </Reanimated.View>
        </Reanimated.View>
      )}

      {lyricsMounted && (
        <Reanimated.View
          pointerEvents={
            fullscreenAlbumMode || albumArtworkMorphing ? "none" : "auto"
          }
          style={[styles.lyricsWrap, lyricsViewportStyle]}
        >
          <Reanimated.View
            entering={FadeInUp.duration(PLAYER_MODE_TRANSITION_MS).easing(
              PLAYER_MODE_EASE,
            )}
            exiting={FadeOut.duration(300).easing(PLAYER_MODE_EASE)}
            style={[
              styles.lyricsContentWrap,
              showEmptyState && {
                paddingBottom: Math.max(controlsDockHeight + 12, 210),
              },
            ]}
          >
            <Reanimated.View
              style={[styles.lyricsContentInner, lyricsChromeOpacityStyle]}
            >
              {showEmptyState ? (
                <ListeningEmptyState mobile={playbackMode === 'mobile'} connected={connectionStatus === 'connected'} signedIn={spotifySignedIn} onConnect={() => router.push({ pathname: '/explore', params: { action: 'scan' } })} onSignIn={() => router.push({ pathname: '/explore', params: { action: 'login' } })} />
              ) : lyricsStyle === "amll" ? (
                <AmllLyricsView
                  active={isScreenFocused && (!tour.active || tour.foreground)}
                  demoLyrics={tour.active ? DEMO_LYRICS : undefined}
                  demoLayout="player"
                  demoIsPlaying={tour.active ? tour.isPlaying : undefined}
                  tapToSeekEnabled={tapToSeekEnabled}
                  showTranslatedText={showTranslatedText}
                  selectedLineKeys={selectedLineKeys}
                  previewPositionMs={tour.active ? (scrubPreviewPositionMs ?? tour.position) : scrubPreviewPositionMs}
                  autoFollowEnabled={autoFollowEnabled}
                  resumeAutoFollowSignal={resumeAutoFollowSignal}
                  onLinePress={handleLyricLinePress}
                  onLineLongPress={handleLineLongPress}
                  onActiveLineChange={handleActiveLineChange}
                  onAutoFollowChange={handleAutoFollowChange}
                  onCreditsTimestampPress={handleSeek}
                  onUserInteraction={handleControlsInteraction}
                />
              ) : (
                <SpicyLyricsView
                  active={isScreenFocused && (!tour.active || tour.foreground)}
                  demoLyrics={tour.active ? DEMO_LYRICS : undefined}
                  demoLayout="player"
                  demoIsPlaying={tour.active ? tour.isPlaying : undefined}
                  tapToSeekEnabled={tapToSeekEnabled}
                  showTranslatedText={showTranslatedText}
                  selectedLineKeys={selectedLineKeys}
                  previewPositionMs={tour.active ? (scrubPreviewPositionMs ?? tour.position) : scrubPreviewPositionMs}
                  autoFollowEnabled={autoFollowEnabled}
                  resumeAutoFollowSignal={resumeAutoFollowSignal}
                  onLinePress={handleLyricLinePress}
                  onLineLongPress={handleLineLongPress}
                  onActiveLineChange={handleActiveLineChange}
                  onAutoFollowChange={handleAutoFollowChange}
                  onCreditsTimestampPress={handleSeek}
                  onUserInteraction={handleControlsInteraction}
                />
              )}
            </Reanimated.View>
          </Reanimated.View>
          {/* ponytail: LinearGradient replaces BlurView — same fade, no GPU blur cost */}
          <Reanimated.View
            pointerEvents="none"
            style={[
              styles.lyricsBottomBlurWrap,
              { height: Math.max(0, controlsDockHeight + 58) },
              lyricsBottomBlurOpacityStyle,
            ]}
          >
            <LinearGradient
              pointerEvents="none"
              colors={["transparent", "rgba(0,0,0,0.85)"]}
              style={styles.lyricsBottomBlur}
            />
          </Reanimated.View>
        </Reanimated.View>
      )}

      {!fullscreenAlbumMode && !controlsVisible && (
        <Pressable
          style={styles.controlsRevealZone}
          onPress={handleControlsInteraction}
          hitSlop={0}
        />
      )}

      <SafeAreaView
        edges={["bottom", "left", "right"]}
        style={styles.bottomArea}
        pointerEvents={
          controlsVisible || fullscreenAlbumMode ? "box-none" : "none"
        }
      >
        <Reanimated.View
          pointerEvents={
            controlsVisible || fullscreenAlbumMode ? "auto" : "none"
          }
          style={[styles.controlsWrap, controlsStyle]}
          onLayout={(event) => {
            handleControlsDockLayout(event.nativeEvent.layout.height);
          }}
        >
          <PlaybackControlsDock
                    previewPlayback={previewPlayback}
                    tourStep={tour.active ? tour.step : undefined}
                    previewTranslated={tour.active ? tour.translated : undefined}
            isPlaying={isPlaying}
            durationMs={currentTrack?.durationMs ?? 0}
            shareSelectionCount={selectedLineKeys.size}
            shareSelectionMode={selectedLineKeys.size > 0}
            shareBusy={shareBusy}
            onScrubPreview={handleScrubPreview}
            showResumeAutoFollow={
              !autoFollowEnabled && scrubPreviewPositionMs === null
            }
            onResumeAutoFollow={handleResumeAutoFollow}
            onOpenShareMenu={openShareMenu}
            onPlayPause={handlePlaybackPlayPause}
            onPlayPauseResync={handlePlaybackResync}
            onPrevious={handlePlaybackPrevious}
            onNext={handlePlaybackNext}
            onSeek={handleSeek}
            onRequestTranslate={handleTranslate}
            translationLoading={translationLoading}
            autoHidePlaybackControls={autoHidePlaybackControls}
            onToggleAutoHidePlaybackControls={
              handleToggleAutoHidePlaybackControls
            }
            playbackMode={playbackMode}
            latencyMs={bridgeConnected ? driftOffset : Math.max(0, driftOffset)}
            onUserInteraction={handleControlsInteraction}
            fullscreenActions={
              <>
                <Pressable accessibilityRole="button" accessibilityLabel="Open local vault" disabled={tour.active} hitSlop={8} style={({ pressed }) => [styles.fullscreenBottomButton, pressed && styles.fullscreenBottomButtonPressed]} onPress={() => router.push("/(tabs)/vault")}>
                  <Ionicons name="library-outline" size={20} color="#FFFFFF" />
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Show lyrics" hitSlop={8} style={({ pressed }) => [styles.fullscreenBottomButton, tour.active && tour.step === 'lyrics' && styles.tourHighlight, pressed && styles.fullscreenBottomButtonPressed]} onPress={handleShowLyrics}>
                  <LyricsTypeIcon mode={lyricsTimingMode === "unknown" ? "interpolated" : lyricsTimingMode} size={17} color="#FFFFFF" />
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Open settings" disabled={tour.active} hitSlop={8} style={({ pressed }) => [styles.fullscreenBottomButton, pressed && styles.fullscreenBottomButtonPressed]} onPress={() => router.push("/(tabs)/explore")}>
                  <Ionicons name="settings-outline" size={20} color="#FFFFFF" />
                </Pressable>
              </>
            }
            fullscreenAlbumMode={fullscreenAlbumMode}
            controlsModeTransitioning={
              albumArtworkMorphing
            }
            fullscreenAlbumProgress={fullscreenAlbumProgress}
          />
        </Reanimated.View>
      </SafeAreaView>
      </>
      ) : null}

      {!tour.active && !tour.pending && (Platform.OS === 'ios' || Platform.OS === 'android'
        ? <SpotifyNativeDetector ref={spotifyBrowserRef} />
        : <SpotifyBrowserFallback ref={spotifyBrowserRef} />)}

      <SettingsMenu
        open={menuOpen}
        landscapeAnchorWidth={isLandscape ? landscapeLeftPaneWidth : undefined}
        onClose={() => setMenuOpen(false)}
        onReconnectBridge={() => {
          setMenuOpen(false);
          bridgeClient.reconnectNow();
        }}
        onRefetchLyrics={() => {
          setMenuOpen(false);
          void refreshLyricsForCurrentTrack("auto");
        }}
        onRefetchLyricsFromSource={(source) => {
          setMenuOpen(false);
          void refreshLyricsForCurrentTrack(source);
        }}
        onOpenBridgeSettings={() => {
          setMenuOpen(false);
          router.push("/(tabs)/explore");
        }}
        onOpenButtonTutorial={() => {
          setMenuOpen(false);
          usePlayerTourStore.getState().start();
        }}
        lyricsStyle={lyricsStyle}
        onChangeLyricsStyle={setLyricsStyle}
        connectionStatus={connectionStatus}
        playbackMode={playbackMode}
        latencyMs={bridgeConnected ? driftOffset : Math.max(0, driftOffset)}
        errorMessage={errorMessage}
      />
      {tour.active && isScreenFocused && <PlayerTourOverlay controlsHeight={controlsDockHeight} transitioning={albumArtworkMorphing} landscape={isLandscape} fullscreen={fullscreenAlbumMode} />}
    </View>
  );
}

const styles = StyleSheet.create({
  tourHighlight: { borderWidth: 2, borderColor: '#A8F0CF', borderRadius: 22, backgroundColor: 'rgba(168,240,207,0.12)' },
  screen: {
    flex: 1,
    backgroundColor: "#0A0B11",
  },
  landscapeRoot: {
    flex: 1,
    flexDirection: "row",
    zIndex: 4,
  },
  landscapeLeftPane: {
    flexShrink: 0,
    flexGrow: 0,
    alignSelf: "stretch",
  },
  landscapeLeftSafe: {
    flex: 1,
    justifyContent: "center",
  },
  landscapeRightPane: {
    flex: 1,
    minWidth: 0,
    overflow: "visible",
  },
  backgroundBlur: {
    ...StyleSheet.absoluteFill,
    opacity: 0.96,
  },
  backgroundTint: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(8, 9, 14, 0.68)",
  },
  backgroundTintWithArtwork: {
    backgroundColor: "rgba(8, 9, 14, 0.5)",
  },
  topSafeArea: {
    zIndex: 5,
    backgroundColor: "transparent",
  },
  fullscreenBottomButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  fullscreenBottomButtonPressed: {
    opacity: 0.72,
    transform: [{ scale: 0.94 }],
  },
  fullscreenTopSafeArea: {
    zIndex: 5,
    backgroundColor: "transparent",
  },
  lyricsWrap: {
    zIndex: 4,
  },
  fullscreenAlbumContent: {
    flex: 1,
    width: "100%",
    alignSelf: "stretch",
    alignItems: "center",
  },
  fullscreenAlbumMetaOuter: {
    width: "100%",
    alignItems: "center",
  },
  lyricsContentWrap: {
    flex: 1,
  },
  lyricsContentInner: {
    flex: 1,
  },
  fullscreenAlbumWrap: {
    ...StyleSheet.absoluteFill,
    zIndex: 4,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingHorizontal: 14,
  },
  animatedAlbumArtworkShell: {
    position: "absolute",
    zIndex: 6,
    borderRadius: 22,
    overflow: "hidden",
    shadowColor: "#000000",
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 18 },
  },
  animatedAlbumArtwork: {
    width: "100%",
    height: "100%",
  },
  fullscreenAlbumArtSpacer: {
    backgroundColor: "transparent",
  },
  fullscreenAlbumLabelWrap: {
    alignItems: "center",
  },
  fullscreenAlbumLabel: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "800",
    textAlign: "center",
  },
  fullscreenAlbumMetaRow: {
    width: "94%",
    maxWidth: 520,
    marginTop: FULLSCREEN_META_OFFSET,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  fullscreenAlbumTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  fullscreenAlbumTitle: {
    color: "#FFFFFF",
    fontSize: 21,
    fontWeight: "700",
  },
  fullscreenAlbumArtist: {
    marginTop: 4,
    color: "rgba(255,255,255,0.68)",
    fontSize: 17,
    fontWeight: "500",
  },
  fullscreenAlbumActionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  fullscreenAlbumIconCapsule: {
    borderRadius: FULLSCREEN_ACTION_BUTTON_SIZE / 2,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  fullscreenAlbumIconButton: {
    width: FULLSCREEN_ACTION_BUTTON_SIZE,
    height: FULLSCREEN_ACTION_BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  fullscreenAlbumIconButtonPressed: {
    backgroundColor: "rgba(255,255,255,0.18)",
    opacity: 0.94,
  },
  lyricsBottomBlurWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: -48,
    height: 320,
    zIndex: 7,
    overflow: "hidden",
  },
  lyricsBottomBlur: {
    ...StyleSheet.absoluteFill,
  },
  controlsRevealZone: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    top: "75%",
    zIndex: 20,
  },
  bottomArea: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: -25,
    paddingHorizontal: 18,
    paddingBottom: 10,
    zIndex: 6,
  },
  controlsWrap: {
    width: "100%",
    position: "relative",
    backgroundColor: "transparent",
  },
});
