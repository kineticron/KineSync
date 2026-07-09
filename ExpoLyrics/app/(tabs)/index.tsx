import { BlurView } from "expo-blur";
import { Image as ExpoImage } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import * as FileSystem from "expo-file-system/legacy";
import { useRouter } from "expo-router";
import * as Sharing from "expo-sharing";
import { Ionicons } from "@expo/vector-icons";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  Alert,
  AppState,
  type AppStateStatus,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Reanimated, {
  useSharedValue,
  withTiming,
  withRepeat,
  withSequence,
  useAnimatedStyle,
  Easing as ReanimatedEasing,
  cancelAnimation,
  interpolate,
  interpolateColor,
  Extrapolation,
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  FadeOutDown,
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
import { HorizontalPlayerPanel } from "@/components/lyrics/horizontal-player-panel";
import { LyricsView } from "@/components/lyrics/lyrics-view";
import {
  PlaybackControls,
  type PlaybackControlsLayout,
} from "@/components/lyrics/playback-controls";
import { SettingsMenu } from "@/components/lyrics/settings-menu";
import { TopBar } from "@/components/lyrics/top-bar";
import { MarqueeText } from "@/components/ui/marquee-text";
import { bridgeClient } from "@/lib/bridge-client";
import {
  refreshLyricsForCurrentTrack,
  requestImmediateTranslationForCurrentSource,
} from "@/lib/lyrics-sync";
import { detectLyricsTimingMode } from "@/lib/lyrics-timing";
import {
  animateIconButtonPressIn,
  animateIconButtonPressOut,
  ICON_BUTTON_PRESS_SCALE,
} from "@/lib/icon-button-press-animation";
import { usePlaybackStore } from "@/store/playback-store";
import type { LyricLine } from "@/types/bridge";

function isBridgeArtworkUri(value: string | undefined) {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  // Accept remote and inline artwork payloads shipped by the desktop bridge.
  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    return true;
  }
  // Reject Windows-only filesystem paths that cannot be resolved from mobile.
  if (/^[a-z]:\\/i.test(trimmed) || /^\\\\/.test(trimmed)) {
    return false;
  }
  return false;
}

function looksLikeBase64Artwork(value: string) {
  const compact = value.replace(/\s+/g, "");
  if (!compact || compact.length < 256) {
    return false;
  }
  // Lightweight heuristic: base64 payloads are large and use this restricted charset.
  return /^[A-Za-z0-9+/=]+$/.test(compact);
}

function inferDataUriMime(base64Payload: string) {
  if (base64Payload.startsWith("/9j/")) {
    return "image/jpeg";
  }
  if (base64Payload.startsWith("iVBORw0KGgo")) {
    return "image/png";
  }
  if (base64Payload.startsWith("UklGR")) {
    return "image/webp";
  }
  return "image/jpeg";
}

function normalizeBridgeArtworkUri(value: string | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  if (isBridgeArtworkUri(trimmed)) {
    return trimmed;
  }
  if (looksLikeBase64Artwork(trimmed)) {
    const compact = trimmed.replace(/\s+/g, "");
    return `data:${inferDataUriMime(compact)};base64,${compact}`;
  }
  return "";
}

type TutorialIconName = ComponentProps<typeof Ionicons>["name"];
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
const BUTTON_TUTORIAL_ITEMS: {
  title: string;
  detail: string;
  icons: TutorialIconName[];
}[] = [
  {
    title: "Back, play, forward",
    detail: "Skip back, pause or resume, and skip to the next track.",
    icons: ["play-skip-back", "play", "play-skip-forward"],
  },
  {
    title: "Auto-scroll",
    detail: "Return lyrics to the current line when auto-scroll was paused.",
    icons: ["navigate-circle"],
  },
  {
    title: "Eye",
    detail:
      "Tap to toggle auto-hide controls. Hold to show or hide the status bar.",
    icons: ["eye"],
  },
  {
    title: "Translate",
    detail: "Tap to request translation. Hold to show or hide translated text.",
    icons: ["language"],
  },
  {
    title: "Status bar",
    detail: "Shows bridge status, lyrics source, and ping when visible.",
    icons: ["pulse"],
  },
];

function getLineKey(line: LyricLine) {
  return `${line.lineStartTime}-${line.lineEndTime}`;
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

function trimTrailingSourceFromAction(actionText: string, sourceText: string) {
  const action = String(actionText || "").trim();
  const source = String(sourceText || "").trim();
  if (!action || !source) {
    return action;
  }

  const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trailingSourcePatterns = [
    new RegExp(`\\s*\\(${escapedSource}\\)\\s*[.!…]*$`, "i"),
    new RegExp(
      `\\s+from\\s+${escapedSource}(?:\\s+on\\s+desktop)?\\s*[.!…]*$`,
      "i",
    ),
    new RegExp(`\\s+source\\s+${escapedSource}\\s*[.!…]*$`, "i"),
  ];

  for (const pattern of trailingSourcePatterns) {
    if (pattern.test(action)) {
      return action.replace(pattern, (match) =>
        match.toLowerCase().includes(" from ") ? " from" : "",
      );
    }
  }

  return action;
}

function extractSourceFromStatusMessage(statusMessage: string) {
  const message = String(statusMessage || "").trim();
  if (!message) {
    return "";
  }

  const parentheticalMatch = message.match(/\(([^()]+)\)\s*[.!…]*$/);
  if (parentheticalMatch) {
    return parentheticalMatch[1]?.trim() || "";
  }

  const fromMatch = message.match(
    /\bfrom\s+(.+?)(?:\s+on\s+desktop)?\s*[.!…]*$/i,
  );
  if (fromMatch) {
    return fromMatch[1]?.trim() || "";
  }

  const sourceMatch = message.match(/\bsource\s+(.+?)\s*[.!…]*$/i);
  if (sourceMatch) {
    return sourceMatch[1]?.trim() || "";
  }

  return "";
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
  showTranslatedText?: boolean;
  onToggleShowTranslatedText?: (value: boolean) => void;
  autoHidePlaybackControls?: boolean;
  onToggleAutoHidePlaybackControls?: () => void;
  connectionStatus?: "connected" | "disconnected" | "connecting";
  latencyMs?: number;
  statusActionText?: string;
  statusSourceText?: string;
  hideStatusBar?: boolean;
  onToggleHideStatusBar?: (value: boolean) => void;
  onUserInteraction?: () => void;
  fullscreenAlbumMode?: boolean;
  controlsModeTransitioning?: boolean;
  fullscreenAlbumProgress: SharedValue<number>;
  layout?: PlaybackControlsLayout;
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
  showTranslatedText,
  onToggleShowTranslatedText,
  autoHidePlaybackControls,
  onToggleAutoHidePlaybackControls,
  connectionStatus = "disconnected",
  latencyMs = 0,
  statusActionText = "",
  statusSourceText = "",
  hideStatusBar,
  onToggleHideStatusBar,
  onUserInteraction,
  fullscreenAlbumMode,
  controlsModeTransitioning,
  fullscreenAlbumProgress,
  layout,
}: PlaybackControlsDockProps) {
  return (
    <PlaybackControls
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
      showTranslatedText={showTranslatedText}
      onToggleShowTranslatedText={onToggleShowTranslatedText}
      autoHidePlaybackControls={autoHidePlaybackControls}
      onToggleAutoHidePlaybackControls={onToggleAutoHidePlaybackControls}
      hideStatusBar={hideStatusBar}
      onToggleHideStatusBar={onToggleHideStatusBar}
      connectionStatus={connectionStatus}
      latencyMs={latencyMs}
      statusActionText={statusActionText}
      statusSourceText={statusSourceText}
      onUserInteraction={onUserInteraction}
      fullscreenAlbumMode={fullscreenAlbumMode}
      controlsModeTransitioning={controlsModeTransitioning}
      fullscreenAlbumProgress={fullscreenAlbumProgress}
      layout={layout}
    />
  );
});

function ButtonTutorialModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.tutorialOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <BlurView intensity={38} tint="dark" style={styles.tutorialCard}>
          <View style={styles.tutorialHeader}>
            <Text style={styles.tutorialTitle}>Button tutorial</Text>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              style={({ pressed }) => [
                styles.tutorialCloseButton,
                pressed && styles.tutorialCloseButtonPressed,
              ]}
            >
              <Text style={styles.tutorialCloseText}>Done</Text>
            </Pressable>
          </View>
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.tutorialList}
          >
            {BUTTON_TUTORIAL_ITEMS.map((item) => (
              <View key={item.title} style={styles.tutorialRow}>
                <View style={styles.tutorialIconWrap}>
                  {item.icons.map((icon) => (
                    <Ionicons
                      key={`${item.title}-${icon}`}
                      name={icon}
                      size={17}
                      color="#FFFFFF"
                    />
                  ))}
                </View>
                <View style={styles.tutorialCopy}>
                  <Text style={styles.tutorialItemTitle}>{item.title}</Text>
                  <Text style={styles.tutorialItemDetail}>{item.detail}</Text>
                </View>
              </View>
            ))}
          </ScrollView>
        </BlurView>
      </View>
    </Modal>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const windowDimensions = useWindowDimensions();
  const currentTrack = usePlaybackStore((s) => s.currentTrack);
  const connectionStatus = usePlaybackStore((s) => s.connectionStatus);
  const driftOffset = usePlaybackStore((s) => s.driftOffset);
  const errorMessage = usePlaybackStore((s) => s.errorMessage);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const lyricsSource = usePlaybackStore((s) => s.lyricsSource);
  const lyrics = usePlaybackStore((s) => s.lyrics);
  const lyricsMetadata = usePlaybackStore((s) => s.lyricsMetadata);
  const lyricsStatusMessage = usePlaybackStore((s) => s.lyricsStatusMessage);
  const [menuOpen, setMenuOpen] = useState(false);
  const [buttonTutorialOpen, setButtonTutorialOpen] = useState(false);
  const [fullscreenAlbumMode, setFullscreenAlbumMode] = useState(false);
  const [lyricsMounted, setLyricsMounted] = useState(true);
  const [topBarMounted, setTopBarMounted] = useState(true);
  const [albumArtworkMorphing, setAlbumArtworkMorphing] = useState(false);
  const hasHandledFullscreenTransitionRef = useRef(false);
  const tapToSeekEnabled = usePlaybackStore((s) => s.playbackTapToSeek);
  const setTapToSeekEnabled = usePlaybackStore((s) => s.setPlaybackTapToSeek);
  const hidePlaybackStatusBar = usePlaybackStore((s) => s.hidePlaybackStatusBar);
  const setHidePlaybackStatusBar = usePlaybackStore((s) => s.setHidePlaybackStatusBar);
  const autoHidePlaybackControls = usePlaybackStore((s) => s.autoHidePlaybackControls);
  const setAutoHidePlaybackControls = usePlaybackStore((s) => s.setAutoHidePlaybackControls);
  const showTranslatedText = usePlaybackStore((s) => s.showTranslatedText);
  const setShowTranslatedText = usePlaybackStore((s) => s.setShowTranslatedText);
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
  const ambientPhaseA = useSharedValue(0);
  const ambientPhaseB = useSharedValue(0);
  const fullscreenAlbumProgress = useSharedValue(0);
  const topBarTrackPress = useSharedValue(0);
  const fullscreenLyricsButtonScale = useSharedValue(1);
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
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
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
    () => normalizeBridgeArtworkUri(trackArtworkUrl),
    [trackArtworkUrl],
  );
  const hasResolvedArtwork = resolvedArtworkUrl.length > 0;

  useEffect(() => {
    setResolvedAnimatedSquareUrl("");
    if (!currentTrack) {
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
  }, [
    currentTrack?.id,
    currentTrack?.artist,
    currentTrack?.album,
    currentTrack?.title,
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
  const derivedStatusSource = useMemo(
    () => extractSourceFromStatusMessage(lyricsStatusMessage),
    [lyricsStatusMessage],
  );
  const footerSourceText = useMemo(() => {
    if (derivedStatusSource) {
      return derivedStatusSource;
    }
    if (lyricsSource) {
      return lyricsSource;
    }
    return bridgeConnected ? "Waiting for source" : "Bridge offline";
  }, [bridgeConnected, derivedStatusSource, lyricsSource]);
  const footerActionText = useMemo(() => {
    const baseAction =
      lyricsStatusMessage ||
      (bridgeConnected ? "Waiting for lyrics" : "Connecting to bridge...");
    return trimTrailingSourceFromAction(baseAction, footerSourceText);
  }, [bridgeConnected, footerSourceText, lyricsStatusMessage]);
  const translationLoading = Boolean(lyricsMetadata.translation?.isLoading);
  const lyricsTimingMode = useMemo(
    () => detectLyricsTimingMode(lyrics, lyricsSource),
    [lyrics, lyricsSource],
  );
  const fadeLyricsBackIn = useCallback(() => {
    if (fullscreenAlbumMode || albumArtworkMorphingRef.current) {
      return;
    }
    lyricsRestoreOpacity.value = withTiming(1, {
      duration: 420,
      easing: PLAYER_MODE_EASE,
    });
  }, [fullscreenAlbumMode, lyricsRestoreOpacity]);

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

    if (isLandscapeRef.current) {
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
  }, [clearControlsIdleTimer, hideControls, showControls]);

  const handleControlsInteraction = useCallback(() => {
    if (isLandscapeRef.current) {
      scheduleControlsHide();
      return;
    }
    if (!controlsVisible) {
      showControls();
    }
    scheduleControlsHide();
  }, [controlsVisible, scheduleControlsHide, showControls]);

  useEffect(() => {
    clearControlsIdleTimer();

    if (isLandscape) {
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
  ]);

  useEffect(() => {
    const stopAmbientAnimations = () => {
      cancelAnimation(ambientPhaseA);
      cancelAnimation(ambientPhaseB);
    };

    const startAmbientAnimations = () => {
      ambientPhaseA.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 18000 }),
          withTiming(0, { duration: 18000 }),
        ),
        -1,
        false,
      );
      ambientPhaseB.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 22000 }),
          withTiming(0, { duration: 22000 }),
        ),
        -1,
        false,
      );
    };

    // ponytail: skip blobs when covered by fullscreen album art or backgrounded — saves CPU on older devices
    if (appStateRef.current === "active" && !fullscreenAlbumMode) {
      startAmbientAnimations();
    }

    const subscription = AppState.addEventListener("change", (nextState) => {
      appStateRef.current = nextState;
      if (nextState === "active") {
        setScrubPreviewPositionMs(null);
        if (!fullscreenAlbumMode) startAmbientAnimations();
        return;
      }
      setScrubPreviewPositionMs(null);
      stopAmbientAnimations();
    });

    return () => {
      subscription.remove();
      stopAmbientAnimations();
    };
  }, [ambientPhaseA, ambientPhaseB, fullscreenAlbumMode]);

  const handleLyricLinePress = useCallback((line: LyricLine) => {
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
    bridgeClient.seekTo(line.lineStartTime);
    setScrubPreviewPositionMs(null);
    setAutoFollowEnabled(true);
    setResumeAutoFollowSignal((value) => value + 1);
  }, []);

  const handleSeek = useCallback(
    (positionMs: number) => {
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
      bridgeClient.seekTo(clamped);
      setScrubPreviewPositionMs(null);
      setAutoFollowEnabled(true);
      setResumeAutoFollowSignal((value) => value + 1);
    },
    [autoFollowEnabled, currentTrack?.durationMs, isPlaying],
  );

  const handleActiveLineChange = useCallback((nextActiveLine: number) => {
    setActiveLineIndex(nextActiveLine);
  }, []);

  const handleLineLongPress = useCallback((line: LyricLine) => {
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

      if (!response.ok || !response.base64) {
        throw new Error(
          response.error || "Desktop bridge did not return GIF data.",
        );
      }

      const safeTitle = String(currentTrack.title || "lyrics")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 40);
      const fileName =
        response.fileName || `${safeTitle || "lyrics"}-share.gif`;
      if (Platform.OS === "web") {
        await shareGifOnWeb({
          base64: response.base64,
          fileName,
          mimeType: response.mimeType || "image/gif",
          title: currentTrack.title,
          artist: currentTrack.artist,
        });
        return;
      }

      const uri = `${FileSystem.cacheDirectory || ""}${fileName}`;
      await FileSystem.writeAsStringAsync(uri, response.base64, {
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
  }, []);

  const handleAutoHidePlaybackControlsChange = useCallback(
    (enabled: boolean) => {
      autoHidePlaybackControlsRef.current = enabled;
      setAutoHidePlaybackControls(enabled);
    },
    [setAutoHidePlaybackControls],
  );

  const handleToggleAutoHidePlaybackControls = useCallback(() => {
    const next = !autoHidePlaybackControlsRef.current;
    autoHidePlaybackControlsRef.current = next;
    setAutoHidePlaybackControls(next);
  }, [setAutoHidePlaybackControls]);

  const handleShowFullscreenAlbum = useCallback(() => {
    albumArtworkMorphingRef.current = true;
    setAlbumArtworkMorphing(true);
    fullscreenAlbumModeRef.current = true;
    setFullscreenAlbumMode(true);
    showControls();
    setScrubPreviewPositionMs(null);
  }, [showControls]);

  const handleLandscapeArtworkPress = useCallback(() => {
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

  const ambientBlobAStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { translateX: interpolate(ambientPhaseA.value, [0, 1], [-36, 36]) },
        { translateY: interpolate(ambientPhaseA.value, [0, 1], [-20, 30]) },
      ],
      opacity: interpolate(ambientPhaseA.value, [0, 1], [0.22, 0.32]),
    };
  });

  const ambientBlobBStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { translateX: interpolate(ambientPhaseB.value, [0, 1], [26, -28]) },
        { translateY: interpolate(ambientPhaseB.value, [0, 1], [26, -18]) },
      ],
      opacity: interpolate(ambientPhaseB.value, [0, 1], [0.2, 0.3]),
    };
  });

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

  const fullscreenLyricsButtonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: fullscreenLyricsButtonScale.value }],
    opacity: interpolate(
      fullscreenLyricsButtonScale.value,
      [1, ICON_BUTTON_PRESS_SCALE],
      [1, 0.86],
    ),
  }));

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

  return (
    <View style={styles.screen}>
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
      {!hasResolvedArtwork && (
        <>
          <Reanimated.View
            style={[styles.ambientBlob, styles.ambientBlobA, ambientBlobAStyle]}
          />
          <Reanimated.View
            style={[styles.ambientBlob, styles.ambientBlobB, ambientBlobBStyle]}
          />
        </>
      )}
      <View
        style={[
          styles.backgroundTint,
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
                title={currentTrack?.title || "Waiting for Spotify"}
                artist={
                  currentTrack?.artist || "Desktop bridge not detected yet"
                }
                artworkUrl={resolvedArtworkUrl}
                animatedArtworkUrl={resolvedAnimatedSquareUrl}
                artworkSize={landscapeArtworkSize}
                lyricsTimingMode={lyricsTimingMode}
                lyricsSource={lyricsSource}
                onMenuPress={() => setMenuOpen(true)}
                onArtworkPress={handleLandscapeArtworkPress}
                controlsOverlayVisible={landscapeArtControlsVisible}
                controlsOverlay={
                  <PlaybackControlsDock
                    layout="overlay"
                    isPlaying={isPlaying}
                    durationMs={currentTrack?.durationMs ?? 0}
                    onScrubPreview={handleScrubPreview}
                    onPlayPause={() => bridgeClient.togglePlayPause()}
                    onPlayPauseResync={() => bridgeClient.resyncPlayback()}
                    onPrevious={() => bridgeClient.skipPrevious()}
                    onNext={() => bridgeClient.skipNext()}
                    onSeek={handleSeek}
                    hideStatusBar
                    onUserInteraction={handleControlsInteraction}
                    fullscreenAlbumProgress={fullscreenAlbumProgress}
                  />
                }
                utilityRow={
                  <PlaybackControlsDock
                    layout="landscape-utilities"
                    isPlaying={isPlaying}
                    durationMs={currentTrack?.durationMs ?? 0}
                    onScrubPreview={handleScrubPreview}
                    showResumeAutoFollow={
                      !autoFollowEnabled && scrubPreviewPositionMs === null
                    }
                    onResumeAutoFollow={handleResumeAutoFollow}
                    onPlayPause={() => bridgeClient.togglePlayPause()}
                    onPlayPauseResync={() => bridgeClient.resyncPlayback()}
                    onPrevious={() => bridgeClient.skipPrevious()}
                    onNext={() => bridgeClient.skipNext()}
                    onSeek={handleSeek}
                    onRequestTranslate={() =>
                      requestImmediateTranslationForCurrentSource()
                    }
                    translationLoading={translationLoading}
                    showTranslatedText={showTranslatedText}
                    onToggleShowTranslatedText={setShowTranslatedText}
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
              <LyricsView
                tapToSeekEnabled={tapToSeekEnabled}
                showTranslatedText={showTranslatedText}
                selectedLineKeys={selectedLineKeys}
                previewPositionMs={scrubPreviewPositionMs}
                autoFollowEnabled={autoFollowEnabled}
                resumeAutoFollowSignal={resumeAutoFollowSignal}
                onLinePress={handleLyricLinePress}
                onLineLongPress={handleLineLongPress}
                onCreditsTimestampPress={handleSeek}
                onActiveLineChange={handleActiveLineChange}
                onAutoFollowChange={handleAutoFollowChange}
                onUserInteraction={handleControlsInteraction}
                fontScale={LANDSCAPE_FONT_SCALE}
                landscapeMode
              />
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
            active={!albumArtworkMorphing}
            style={styles.animatedAlbumArtwork}
            recyclingKey={`morph-artwork-${resolvedArtworkUrl}-${resolvedAnimatedSquareUrl}`}
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
                  title={currentTrack?.title || "Waiting for Spotify"}
                  artist={
                    currentTrack?.artist || "Desktop bridge not detected yet"
                  }
                  artworkUrl={resolvedArtworkUrl}
                  onTrackPress={handleShowFullscreenAlbum}
                  onTrackPressIn={() => {
                    topBarTrackPress.value = 1;
                  }}
                  onTrackPressOut={() => {
                    topBarTrackPress.value = 0;
                  }}
                  hideArtwork
                  lyricsTimingMode={lyricsTimingMode}
                  lyricsSource={lyricsSource}
                  onMenuPress={() => setMenuOpen(true)}
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
                  <Reanimated.View style={fullscreenLyricsButtonAnimatedStyle}>
                    <BlurView
                      intensity={34}
                      tint="light"
                      style={styles.fullscreenAlbumIconCapsule}
                    >
                      <Pressable
                        accessibilityLabel="Show lyrics"
                        style={({ pressed }) => [
                          styles.fullscreenAlbumIconButton,
                          pressed && styles.fullscreenAlbumIconButtonPressed,
                        ]}
                        onPressIn={() => {
                          animateIconButtonPressIn(fullscreenLyricsButtonScale);
                        }}
                        onPressOut={() => {
                          animateIconButtonPressOut(
                            fullscreenLyricsButtonScale,
                          );
                        }}
                        onPress={handleShowLyrics}
                      >
                        <Ionicons
                          name="chatbubble-ellipses-outline"
                          size={20}
                          color="#F9FAFC"
                        />
                      </Pressable>
                    </BlurView>
                  </Reanimated.View>

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
                        onPress={() => setMenuOpen(true)}
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
            style={styles.lyricsContentWrap}
          >
            <Reanimated.View
              style={[styles.lyricsContentInner, lyricsChromeOpacityStyle]}
            >
              <LyricsView
                tapToSeekEnabled={tapToSeekEnabled}
                showTranslatedText={showTranslatedText}
                selectedLineKeys={selectedLineKeys}
                previewPositionMs={scrubPreviewPositionMs}
                autoFollowEnabled={autoFollowEnabled}
                resumeAutoFollowSignal={resumeAutoFollowSignal}
                onLinePress={handleLyricLinePress}
                onLineLongPress={handleLineLongPress}
                onCreditsTimestampPress={handleSeek}
                onActiveLineChange={handleActiveLineChange}
                onAutoFollowChange={handleAutoFollowChange}
                onUserInteraction={handleControlsInteraction}
                suppressInitialAutoScrollAnimation
                suspendViewportScrollAdjustments={albumArtworkMorphing}
                onInitialAutoScrollSettled={fadeLyricsBackIn}
              />
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
            onPlayPause={() => bridgeClient.togglePlayPause()}
            onPlayPauseResync={() => bridgeClient.resyncPlayback()}
            onPrevious={() => bridgeClient.skipPrevious()}
            onNext={() => bridgeClient.skipNext()}
            onSeek={handleSeek}
            onRequestTranslate={() =>
              requestImmediateTranslationForCurrentSource()
            }
            translationLoading={translationLoading}
            showTranslatedText={showTranslatedText}
            onToggleShowTranslatedText={setShowTranslatedText}
            autoHidePlaybackControls={autoHidePlaybackControls}
            onToggleAutoHidePlaybackControls={
              handleToggleAutoHidePlaybackControls
            }
            onToggleHideStatusBar={setHidePlaybackStatusBar}
            connectionStatus={connectionStatus}
            latencyMs={bridgeConnected ? driftOffset : Math.max(0, driftOffset)}
            statusActionText={footerActionText}
            statusSourceText={footerSourceText}
            hideStatusBar={hidePlaybackStatusBar}
            onUserInteraction={handleControlsInteraction}
            fullscreenAlbumMode={fullscreenAlbumMode}
            controlsModeTransitioning={
              fullscreenAlbumMode || albumArtworkMorphing
            }
            fullscreenAlbumProgress={fullscreenAlbumProgress}
          />
        </Reanimated.View>
      </SafeAreaView>
      </>
      ) : null}

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
          setButtonTutorialOpen(true);
        }}
        playbackTapToSeek={tapToSeekEnabled}
        onTogglePlaybackTapToSeek={setTapToSeekEnabled}
        hidePlaybackStatusBar={hidePlaybackStatusBar}
        onToggleHidePlaybackStatusBar={setHidePlaybackStatusBar}
        autoHidePlaybackControls={autoHidePlaybackControls}
        onToggleAutoHidePlaybackControls={handleAutoHidePlaybackControlsChange}
        showTranslatedText={showTranslatedText}
        onToggleShowTranslatedText={setShowTranslatedText}
        connectionStatus={connectionStatus}
        latencyMs={bridgeConnected ? driftOffset : Math.max(0, driftOffset)}
        errorMessage={errorMessage}
      />

      <ButtonTutorialModal
        visible={buttonTutorialOpen}
        onClose={() => setButtonTutorialOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
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
    ...StyleSheet.absoluteFillObject,
    opacity: 0.96,
  },
  ambientBlob: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 160,
  },
  ambientBlobA: {
    top: 72,
    left: -40,
    backgroundColor: "#5A6DFF",
  },
  ambientBlobB: {
    right: -76,
    bottom: 160,
    backgroundColor: "#B668F2",
  },
  backgroundTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(8, 9, 14, 0.68)",
  },
  backgroundTintWithArtwork: {
    backgroundColor: "rgba(8, 9, 14, 0.5)",
  },
  topSafeArea: {
    zIndex: 5,
    backgroundColor: "transparent",
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
    ...StyleSheet.absoluteFillObject,
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
    ...StyleSheet.absoluteFillObject,
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
  tutorialOverlay: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    backgroundColor: "rgba(3,4,10,0.44)",
  },
  tutorialCard: {
    maxHeight: "72%",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 12,
    overflow: "hidden",
  },
  tutorialHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
  },
  tutorialTitle: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "700",
  },
  tutorialCloseButton: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  tutorialCloseButtonPressed: {
    opacity: 0.76,
    transform: [{ scale: 0.96 }],
  },
  tutorialCloseText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
  },
  tutorialList: {
    paddingBottom: 4,
    gap: 10,
  },
  tutorialRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
    gap: 12,
  },
  tutorialIconWrap: {
    minWidth: 44,
    minHeight: 34,
    paddingTop: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  tutorialCopy: {
    flex: 1,
    gap: 4,
  },
  tutorialItemTitle: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  tutorialItemDetail: {
    color: "rgba(255,255,255,0.68)",
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
  },
});
