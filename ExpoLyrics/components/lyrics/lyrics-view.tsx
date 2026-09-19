import {
  type LyricLineRange,
  type BackgroundActiveLine,
  type LyricTimingIndex,
  type CreditsLayout,
  EMPTY_WINDOW_STATE,
  LYRICS_LAYOUT,
  arePlaybackWindowStatesEqual,
  getBackgroundActiveLines,
  getLyricTimingIndex,
  getPlaybackWindowState,
  getCreditsAwareScrollOffset,
  getBottomListPadding,
  getFocusIndexAtPosition,
  getAutoScrollTargetRange,
  areLyricLineRangesEqual,
  isIndexWithinRange,
  isIndexWithinUpdateWindow,
  TOP_LIST_PADDING,
  BOTTOM_LIST_PADDING,
  ACTIVE_RANGE_BOTTOM_PADDING,
  STARTUP_DOTS_WARMUP_MS,
} from "@/lib/lyrics-layout";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  AppState,
  type AppStateStatus,
  Image,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
  Text,
  type LayoutChangeEvent,
  Pressable,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  cancelAnimation,
  Easing as ReanimatedEasing,
  scrollTo,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import {
  getLandscapeLyricsCenterUpwardOffset,
  getLyricsViewportCenterUpwardOffset,
  LANDSCAPE_LYRICS_EDGE_BLEED,
  LANDSCAPE_LYRICS_HORIZONTAL_INSET,
  LANDSCAPE_TOP_LIST_PADDING,
} from "@/constants/player-layout";
import { getPrimaryLineText } from "@/lib/active-lyric-line";
import { detectLyricsTimingMode } from "@/lib/lyrics-timing";
import { usePlaybackStore } from "@/store/playback-store";
import type {
  LyricLine as LyricLineType,
  LyricsAttributionMetadata,
  LyricsAttributionProfile,
} from "@/types/bridge";

import { AMLL_POSITION_SPRING, amlPositionSpring, amlBlur } from "@/lib/amll-native";
import { NativeLyricMotion, type NativeLyricScroll } from "./native-lyric-motion";
import { LyricLine } from "./lyric-line";
import { useLyricScrollInterruption } from "./use-lyric-scroll-interruption";

const SOURCE_CHANGE_AUTOSCROLL_DELAY_MS = 500;

const STATIC_LYRIC_FONT_SIZE = 26;
const STATIC_LYRIC_LINE_HEIGHT = 38;
const STATIC_LYRIC_HORIZONTAL_INSET = 28;
const STATIC_LYRIC_MAX_WIDTH = 300;
const STATIC_TRANSLATED_FONT_SIZE = 18;
const STATIC_TRANSLATED_LINE_HEIGHT = 26;

const ACTIVE_LINE_ALIGNMENT_EPSILON = 3;
const LYRIC_SCROLL_ANIMATION_MS = 1600;
const PROGRAMMATIC_SCROLL_GUARD_MS = LYRIC_SCROLL_ANIMATION_MS + 40;
const SCROLL_OFFSET_EPSILON = 2;
// Drifts at/below this size snap without a visible jump; larger drifts re-ease.
const SETTLE_SMOOTH_THRESHOLD_PX = 12;
const SCROLL_SETTLE_VERIFY_MS = LYRIC_SCROLL_ANIMATION_MS + 100;
const PENDING_ANCHOR_RETRY_MS = 96;
const MAX_PENDING_ANCHOR_RETRIES = 18;

const AUTO_FOLLOW_DISABLE_GRACE_MS = 2000;
const AUTO_FOLLOW_DISABLE_DISTANCE_PX = 120;
const AUTO_FOLLOW_RESUME_DISTANCE_PX = 64;
const USER_SCROLL_IDLE_RESET_MS = 700;
// ponytail: always true on native (web support removed)
const SHOULD_USE_UI_THREAD_SCROLL = true;
// ponytail: only the active line ±1 needs JS-driven syllable updates;
// farther cells use static colors and don't need per-frame re-render

const ReanimatedFlashList = Animated.createAnimatedComponent(FlashList<LyricLineType>);

function getFlashListLeadingInset(
  list: FlashListRef<LyricLineType> | null | undefined,
) {
  const inset = list?.getFirstItemOffset?.();
  if (typeof inset === "number" && Number.isFinite(inset) && inset >= 0) {
    return inset;
  }
  return TOP_LIST_PADDING;
}

function flashListLayoutUsesContentCoordinates(
  list: FlashListRef<LyricLineType> | null | undefined,
  leadingInset: number,
) {
  const firstLayout = list?.getLayout(0);
  if (!firstLayout || !Number.isFinite(firstLayout.y)) {
    return false;
  }
  return firstLayout.y >= leadingInset * 0.25;
}

function normalizeFlashListItemTop(
  list: FlashListRef<LyricLineType> | null | undefined,
  layoutY: number,
  leadingInset: number,
) {
  if (flashListLayoutUsesContentCoordinates(list, leadingInset)) {
    return layoutY;
  }
  return layoutY + leadingInset;
}

type LyricsViewProps = {
  active?: boolean;
  tapToSeekEnabled: boolean;
  showTranslatedText?: boolean;
  previewPositionMs?: number | null;
  autoFollowEnabled?: boolean;
  resumeAutoFollowSignal?: number;
  selectedLineKeys?: Set<string>;
  onLinePress?: (line: LyricLineType) => void;
  onLineLongPress?: (line: LyricLineType) => void;
  onCreditsTimestampPress?: (positionMs: number) => void;
  onActiveLineChange?: (lineIndex: number) => void;
  onAutoFollowChange?: (enabled: boolean) => void;
  onUserInteraction?: () => void;
  suppressInitialAutoScrollAnimation?: boolean;
  layoutSettleSignal?: number;
  suspendViewportScrollAdjustments?: boolean;
  onInitialAutoScrollSettled?: () => void;
  fontScale?: number;
  landscapeMode?: boolean;
};

type ScrollAnimationStyle = "native" | "lyric";

const CreditsProfileLine = memo(function CreditsProfileLine({
  label,
  profile,
  active,
  alignRight,
}: {
  label: string;
  profile: LyricsAttributionProfile;
  active: boolean;
  alignRight: boolean;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  return (
    <View
      style={[
        styles.creditsProfileRow,
        alignRight && styles.creditsProfileRowOpposite,
      ]}
    >
      <Text
        style={[
          styles.creditsText,
          alignRight && styles.creditsTextOpposite,
          active && styles.creditsTextActive,
        ]}
      >
        <Text style={styles.creditsTextStrong}>{label}</Text>@
        {profile.username}
      </Text>
      {profile.avatar && !avatarFailed ? (
        <Image
          source={{ uri: profile.avatar }}
          style={styles.creditsProfileAvatar}
          accessibilityLabel={`${profile.username || "Community member"}'s avatar`}
          onError={() => setAvatarFailed(true)}
        />
      ) : null}
    </View>
  );
});

const CreditsFooter = memo(function CreditsFooter({
  rendererActive = true,
  songwriters,
  attribution,
  lastLyricEndTime,
  onPress,
  style,
  alignRight = false,
}: {
  rendererActive?: boolean;
  songwriters: string[];
  attribution?: LyricsAttributionMetadata;
  lastLyricEndTime: number;
  onPress?: (positionMs: number) => void;
  style?: StyleProp<ViewStyle>;
  alignRight?: boolean;
}) {
  const isActive = usePlaybackStore(
    useCallback(
      (state) =>
        lastLyricEndTime > 0 && state.playbackPosition >= lastLyricEndTime,
      [lastLyricEndTime],
    ),
  );
  const activeProgress = useSharedValue(isActive ? 1 : 0);

  useEffect(() => {
    cancelAnimation(activeProgress);
    if (!rendererActive) {
      return;
    }
    activeProgress.value = withTiming(isActive ? 1 : 0, {
      duration: 260,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
    return () => cancelAnimation(activeProgress);
  }, [activeProgress, isActive, rendererActive]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.52 + activeProgress.value * 0.48,
    transform: [{ scale: 0.98 + activeProgress.value * 0.04 }],
  }));

  return (
    <Animated.View style={[styles.creditsFooterMotion, animatedStyle]}>
      <Pressable
        style={[styles.creditsFooter, style]}
        onPress={() => onPress?.(lastLyricEndTime)}
      >
        {songwriters.length ? (
          <Text
            style={[
              styles.creditsText,
              alignRight && styles.creditsTextOpposite,
              isActive && styles.creditsTextActive,
            ]}
          >
            <Text style={styles.creditsTextStrong}>Written By: </Text>
            {songwriters.join(", ")}
          </Text>
        ) : null}
        {attribution ? (
          <Text
            style={[
              styles.creditsText,
              alignRight && styles.creditsTextOpposite,
              isActive && styles.creditsTextActive,
            ]}
          >
            <Text style={styles.creditsTextStrong}>Provided By: </Text>
            {attribution.provider}
          </Text>
        ) : null}
        {attribution?.community ? (
          <Text
            style={[
              styles.creditsText,
              alignRight && styles.creditsTextOpposite,
              isActive && styles.creditsTextActive,
            ]}
          >
            These lyrics have been provided by the Spicy Lyrics community
          </Text>
        ) : null}
        {attribution?.maker?.username ? (
          <CreditsProfileLine
            label="Made By: "
            profile={attribution.maker}
            active={isActive}
            alignRight={alignRight}
          />
        ) : null}
        {attribution?.uploader?.username ? (
          <CreditsProfileLine
            label={attribution.maker?.username ? "Uploaded By: " : "Made By: "}
            profile={attribution.uploader}
            active={isActive}
            alignRight={alignRight}
          />
        ) : null}
      </Pressable>
    </Animated.View>
  );
});

function getProjectedStorePosition(state: {
  anchorPositionMs: number;
  anchorMonotonicMs: number;
  isPlaying: boolean;
  playbackPosition: number;
}) {
  if (!state.isPlaying) {
    return Math.max(0, state.anchorPositionMs);
  }
  const now =
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  return Math.max(0, state.anchorPositionMs + Math.max(0, now - state.anchorMonotonicMs));
}

function usePlaybackWindowState(
  lyrics: LyricLineType[],
  backgroundActiveLines: BackgroundActiveLine[],
  timingIndex: LyricTimingIndex,
  active = true,
) {
  const [windowState, setWindowState] = useState(() =>
    getPlaybackWindowState(
      getProjectedStorePosition(usePlaybackStore.getState()),
      lyrics,
      backgroundActiveLines,
      timingIndex,
    ),
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    const computeWindowState = () =>
      getPlaybackWindowState(
        getProjectedStorePosition(usePlaybackStore.getState()),
        lyrics,
        backgroundActiveLines,
        timingIndex,
      );

    setWindowState((prev) => {
      const next = computeWindowState();
      return arePlaybackWindowStatesEqual(prev, next) ? prev : next;
    });

    const refresh = () => {
      const next = computeWindowState();
      setWindowState((prev) =>
        arePlaybackWindowStatesEqual(prev, next) ? prev : next,
      );
    };

    let previousPosition = usePlaybackStore.getState().playbackPosition;
    let previousAnchor = usePlaybackStore.getState().anchorPositionMs;
    let previousAnchorMono = usePlaybackStore.getState().anchorMonotonicMs;
    let previousPlaying = usePlaybackStore.getState().isPlaying;
    const unsubscribe = usePlaybackStore.subscribe((state) => {
      // Anchor packets retarget the projected clock immediately; don't wait
      // for the next 100ms playbackPosition tick or highlights lag behind the
      // word masks (and short overlaps can be missed entirely).
      if (
        state.playbackPosition === previousPosition &&
        state.anchorPositionMs === previousAnchor &&
        state.anchorMonotonicMs === previousAnchorMono &&
        state.isPlaying === previousPlaying
      ) {
        return;
      }
      previousPosition = state.playbackPosition;
      previousAnchor = state.anchorPositionMs;
      previousAnchorMono = state.anchorMonotonicMs;
      previousPlaying = state.isPlaying;
      refresh();
    });
    // Between store ticks the projected clock keeps advancing. Poll while
    // playing so active boundaries flip on time, like main's per-frame
    // projection, instead of lagging up to a full tick behind.
    const poller = setInterval(() => {
      if (usePlaybackStore.getState().isPlaying) {
        refresh();
      }
    }, 50);
    return () => {
      unsubscribe();
      clearInterval(poller);
    };
  }, [active, backgroundActiveLines, lyrics, timingIndex]);

  if (lyrics.length === 0) {
    return EMPTY_WINDOW_STATE;
  }

  return windowState;
}

export function LyricsView({
  active = true,
  tapToSeekEnabled,
  selectedLineKeys,
  showTranslatedText = true,
  previewPositionMs = null,
  autoFollowEnabled = true,
  resumeAutoFollowSignal = 0,
  onLinePress,
  onLineLongPress,
  onCreditsTimestampPress,
  onActiveLineChange,
  onAutoFollowChange,
  onUserInteraction,
  suppressInitialAutoScrollAnimation = false,
  layoutSettleSignal = 0,
  suspendViewportScrollAdjustments = false,
  onInitialAutoScrollSettled,
  fontScale = 1,
  landscapeMode = false,
}: LyricsViewProps) {
  const topListPadding = landscapeMode
    ? LANDSCAPE_TOP_LIST_PADDING
    : TOP_LIST_PADDING;
  const lyrics = usePlaybackStore((s) => s.lyrics);
  const hasDuetLines = useMemo(() => lyrics.some(line => line.oppositeAligned), [lyrics]);
  const lyricsSource = usePlaybackStore((s) => s.lyricsSource);
  const lyricsStatusMessage = usePlaybackStore((s) => s.lyricsStatusMessage);
  const lyricsMetadata = usePlaybackStore((s) => s.lyricsMetadata);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === "active");
  const rendererActive = active && appIsActive;
  const lyricsTimingMode = useMemo(
    () => detectLyricsTimingMode(lyrics, lyricsSource),
    [lyrics, lyricsSource],
  );
  const insets = useSafeAreaInsets();
  const centeredNoticeUpwardOffset = useMemo(
    () =>
      landscapeMode
        ? getLandscapeLyricsCenterUpwardOffset(insets.top)
        : getLyricsViewportCenterUpwardOffset(insets.top),
    [insets.top, landscapeMode],
  );
  const [showEmptyDebug, setShowEmptyDebug] = useState(false);
  const backgroundActiveLines = useMemo(
    () => getBackgroundActiveLines(lyrics),
    [lyrics],
  );
  const lyricTimingIndex = useMemo(() => getLyricTimingIndex(lyrics), [lyrics]);
  const liveWindowState = usePlaybackWindowState(
    lyrics,
    backgroundActiveLines,
    lyricTimingIndex,
    rendererActive,
  );
  const [listReady, setListReady] = useState(false);
  const [isUserTouchScrolling, setIsUserTouchScrolling] = useState(false);
  const listRef = useAnimatedRef<FlashListRef<LyricLineType>>();
  const lyricScrollOffset = useSharedValue(0);
  const lyricScrollActive = useSharedValue(false);
  const staggerEnabled = useSharedValue(false);
  const scrollCommand = useSharedValue<NativeLyricScroll>({ from: 0, target: 0, revision: 0, firstVisible: 0, focus: 0, spring: AMLL_POSITION_SPRING });
  const activeLineRef = useRef(-1);
  const onAutoFollowChangeRef = useRef(onAutoFollowChange);
  const listHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  const rowHeightsRef = useRef(new Map<number, number>());
  const rowOffsetsRef = useRef(new Map<number, number>());
  const pendingScrollFrameRef = useRef<number | null>(null);
  const programmaticScrollTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const userScrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastUserScrollAtRef = useRef(0);
  const scrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const programmaticScrollInProgressRef = useRef(false);
  const userScrollInProgressRef = useRef(false);
  const userDragInProgressRef = useRef(false);
  const userScrollSessionRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const rendererActiveRef = useRef(rendererActive);
  rendererActiveRef.current = rendererActive;
  const autoFollowDisableGraceUntilRef = useRef(
    Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS,
  );
  const lastScrollRequestRef = useRef("");
  const lastResumeAutoFollowSignalRef = useRef(0);
  const pendingAnchorRangeRef = useRef<LyricLineRange | null>(null);
  const pendingAnchorAnimatedRef = useRef(true);
  const sourceAutoScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const startupDotsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasShownStartupDotsRef = useRef(false);
  const pendingAnchorRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingAnchorRetryCountRef = useRef(0);
  const hasMountedLyricsChangeEffectRef = useRef(false);
  const lastLyricsSourceRef = useRef<string | null>(null);
  const initialAutoScrollPendingRef = useRef(suppressInitialAutoScrollAnimation);
  const initialAutoScrollSettledRef = useRef(false);
  const lastLayoutSettleSignalRef = useRef(layoutSettleSignal);
  const [startupDotsWarmupActive, setStartupDotsWarmupActive] = useState(false);
  const [isSourceAutoScrollCooldown, setIsSourceAutoScrollCooldown] =
    useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  // main's AMLL WebView uses LayoutAlignAnchor.Top at 8% of the viewport.
  const activeLineTopOffset = viewportHeight * 0.08;
  const [contentLayoutVersion, setContentLayoutVersion] = useState(0);
  // ponytail: batch cell layout bumps — fast scroll fires onLayout per cell,
  // debounce so we only re-render once per frame instead of per-cell
  const layoutBumpPendingRef = useRef(false);
  const layoutBumpFrameRef = useRef<number | null>(null);
  const bumpContentLayoutVersion = useCallback(() => {
    if (layoutBumpPendingRef.current) return;
    layoutBumpPendingRef.current = true;
    if (layoutBumpFrameRef.current !== null) return;
    layoutBumpFrameRef.current = requestAnimationFrame(() => {
      layoutBumpFrameRef.current = null;
      layoutBumpPendingRef.current = false;
      setContentLayoutVersion((v) => v + 1);
    });
  }, []);
  const creditsLayoutRef = useRef<CreditsLayout | null>(null);

  const autoFollowActive = autoFollowEnabled && !isSourceAutoScrollCooldown;

  const markInitialAutoScrollSettled = useCallback(() => {
    if (initialAutoScrollSettledRef.current) {
      return;
    }
    initialAutoScrollSettledRef.current = true;
    initialAutoScrollPendingRef.current = false;
    onInitialAutoScrollSettled?.();
  }, [onInitialAutoScrollSettled]);

  useDerivedValue(() => {
    if (lyricScrollActive.value) {
      scrollTo(listRef, 0, Math.max(0, lyricScrollOffset.value), false);
    }
  });

  // FlashList's scroll events already report the native offset. A second
  // runOnJS callback for every animation frame only duplicates that traffic.

  const previewPlaybackPosition =
    Number.isFinite(previewPositionMs) && previewPositionMs !== null
      ? previewPositionMs
      : null;
  const previewFocusIndex = useMemo(
    () =>
      previewPlaybackPosition !== null
        ? getFocusIndexAtPosition(previewPlaybackPosition, lyrics)
        : -1,
    [lyrics, previewPlaybackPosition],
  );
  const displayPlaybackPosition =
    previewPlaybackPosition !== null ? previewPlaybackPosition : null;
  const displayWindowState = useMemo(
    () =>
      displayPlaybackPosition !== null
        ? getPlaybackWindowState(
            displayPlaybackPosition,
            lyrics,
            backgroundActiveLines,
            lyricTimingIndex,
          )
        : liveWindowState,
    [
      backgroundActiveLines,
      displayPlaybackPosition,
      liveWindowState,
      lyrics,
      lyricTimingIndex,
    ],
  );
  const effectiveWindowState = useMemo(() => {
    if (!startupDotsWarmupActive) {
      return displayWindowState;
    }
    const focusIndex =
      displayWindowState.focusLineIndex >= 0 ? displayWindowState.focusLineIndex : 0;
    const pauseAfterIndex = focusIndex > 0 ? focusIndex - 1 : -1;
    return {
      ...displayWindowState,
      activeLineStartIndex: -1,
      activeLineEndIndex: -1,
      visualActiveLineStartIndex: -1,
      visualActiveLineEndIndex: -1,
      isLongPause: true,
      pauseProgress: 0,
      pauseAfterIndex,
      pauseBeforeIndex: focusIndex,
    };
  }, [displayWindowState, startupDotsWarmupActive]);
  // ponytail: coarse fingerprint for extraData — only changes when cell rendering
  // actually differs (index boundaries + pause on/off), NOT on every pauseProgress tick
  const extraDataFingerprint = useMemo(
    () =>
      `${effectiveWindowState.activeLineStartIndex}:${effectiveWindowState.activeLineEndIndex}:${effectiveWindowState.visualActiveLineStartIndex}:${effectiveWindowState.visualActiveLineEndIndex}:${effectiveWindowState.focusLineIndex}:${effectiveWindowState.pauseAfterIndex}:${effectiveWindowState.pauseBeforeIndex}:${effectiveWindowState.isLongPause ? 1 : 0}:${isUserTouchScrolling ? 1 : 0}:${rendererActive ? 1 : 0}`,
    [
      effectiveWindowState.activeLineStartIndex,
      effectiveWindowState.activeLineEndIndex,
      effectiveWindowState.visualActiveLineStartIndex,
      effectiveWindowState.visualActiveLineEndIndex,
      effectiveWindowState.focusLineIndex,
      effectiveWindowState.pauseAfterIndex,
      effectiveWindowState.pauseBeforeIndex,
      effectiveWindowState.isLongPause,
      isUserTouchScrolling,
      rendererActive,
    ],
  );
  const activeLineIndex = effectiveWindowState.activeLineStartIndex;
  const songwriters = useMemo(
    () => lyricsMetadata.credits?.songwriters || [],
    [lyricsMetadata.credits?.songwriters],
  );
  const attribution = lyricsMetadata.attribution;
  const hasCredits = songwriters.length > 0 || Boolean(attribution);
  const instrumental = Boolean(lyricsMetadata.instrumental);
  const lastLyricEndTime = lyrics.length
    ? Number(lyrics[lyrics.length - 1]?.lineEndTime || 0)
    : 0;
  const playbackPositionRef = useRef(
    usePlaybackStore.getState().playbackPosition,
  );
  const [scrollPlannerTick, bumpScrollPlanner] = useReducer(
    (tick: number) => tick + 1,
    0,
  );
  const effectiveWindowStateRef = useRef(effectiveWindowState);
  effectiveWindowStateRef.current = effectiveWindowState;
  const scrollTargetRangeRef = useRef<LyricLineRange | null>(null);
  const scheduleScrollToRangeRef = useRef<typeof scheduleScrollToRange>(null as any);
  // ponytail: subscribe instead of reactive selector — avoids LyricsView re-render on every 64ms tick
  const [liveCreditsActive, setLiveCreditsActive] = useState(
    () => lastLyricEndTime > 0 && usePlaybackStore.getState().playbackPosition >= lastLyricEndTime,
  );
  useEffect(() => {
    if (!rendererActive) {
      return;
    }
    const check = (pos: number) => lastLyricEndTime > 0 && pos >= lastLyricEndTime;
    setLiveCreditsActive(check(usePlaybackStore.getState().playbackPosition));
    let prev = liveCreditsActive;
    return usePlaybackStore.subscribe((state) => {
      const next = check(state.playbackPosition);
      if (next !== prev) {
        prev = next;
        setLiveCreditsActive(next);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLyricEndTime, rendererActive]);
  const creditsActive =
    previewPlaybackPosition !== null
      ? lastLyricEndTime > 0 && previewPlaybackPosition >= lastLyricEndTime
      : liveCreditsActive;
  const scrollTargetRange = useMemo(() => {
    void scrollPlannerTick;
    if (!lyrics.length) {
      return null;
    }

    // Preview scrubbing: follow a single focused line for precision.
    if (previewPlaybackPosition !== null) {
      const focusIndex =
        previewFocusIndex >= 0 ? previewFocusIndex : effectiveWindowState.focusLineIndex;
      if (focusIndex >= 0) {
        return { startIndex: focusIndex, endIndex: focusIndex };
      }
      return null;
    }

    return getAutoScrollTargetRange(
      effectiveWindowState,
      playbackPositionRef.current,
      lyrics,
    );
  }, [
    effectiveWindowState,
    lyrics,
    previewFocusIndex,
    previewPlaybackPosition,
    scrollPlannerTick,
  ]);
  scrollTargetRangeRef.current = scrollTargetRange;
  useEffect(() => {
    if (!rendererActive) {
      return;
    }
    const projected = () => getProjectedStorePosition(usePlaybackStore.getState());
    let previousPosition = projected();
    playbackPositionRef.current = previousPosition;
    const checkRangeChange = (nextPosition: number) => {
      playbackPositionRef.current = nextPosition;
      if (previewPlaybackPosition !== null) {
        return;
      }
      const prevRange = getAutoScrollTargetRange(
        effectiveWindowStateRef.current,
        previousPosition,
        lyrics,
      );
      const nextRange = getAutoScrollTargetRange(
        effectiveWindowStateRef.current,
        nextPosition,
        lyrics,
      );
      previousPosition = nextPosition;
      if (!areLyricLineRangesEqual(prevRange, nextRange)) {
        bumpScrollPlanner();
      }
    };
    const unsubscribe = usePlaybackStore.subscribe((state) => {
      const nextPosition = getProjectedStorePosition(state);
      if (nextPosition === previousPosition) {
        return;
      }
      checkRangeChange(nextPosition);
    });
    const poller = setInterval(() => {
      if (usePlaybackStore.getState().isPlaying) {
        const nextPosition = projected();
        if (nextPosition !== previousPosition) {
          checkRangeChange(nextPosition);
        }
      }
    }, 50);
    return () => {
      unsubscribe();
      clearInterval(poller);
    };
  }, [lyrics, previewPlaybackPosition, rendererActive]);
  useEffect(() => {
    onAutoFollowChangeRef.current = onAutoFollowChange;
  }, [onAutoFollowChange]);

  useEffect(() => {
    if (
      layoutSettleSignal <= 0 ||
      layoutSettleSignal === lastLayoutSettleSignalRef.current
    ) {
      return;
    }
    lastLayoutSettleSignalRef.current = layoutSettleSignal;
    initialAutoScrollPendingRef.current = true;
    initialAutoScrollSettledRef.current = false;
    lastScrollRequestRef.current = "";
    pendingAnchorRangeRef.current = null;
  }, [layoutSettleSignal]);

  useEffect(() => {
    if (hasShownStartupDotsRef.current || lyrics.length === 0) {
      return;
    }
    hasShownStartupDotsRef.current = true;
    setStartupDotsWarmupActive(true);
    if (startupDotsTimerRef.current) {
      clearTimeout(startupDotsTimerRef.current);
    }
    startupDotsTimerRef.current = setTimeout(() => {
      setStartupDotsWarmupActive(false);
      startupDotsTimerRef.current = null;
    }, STARTUP_DOTS_WARMUP_MS);
  }, [lyrics.length]);

  useEffect(() => {
    if (!autoFollowEnabled) {
      return;
    }
    userScrollInProgressRef.current = false;
    userScrollSessionRef.current = false;
    lastScrollRequestRef.current = "";
  }, [autoFollowEnabled]);

  const getAbsoluteLineTop = useCallback(
    (index: number) => {
      const safeIndex = Math.max(0, Math.min(index, lyrics.length - 1));
      if (listReady && listRef.current) {
        const layout = listRef.current.getLayout(safeIndex);
        if (layout && Number.isFinite(layout.y)) {
          const leadingInset = getFlashListLeadingInset(listRef.current);
          const absoluteTop = normalizeFlashListItemTop(
            listRef.current,
            layout.y,
            leadingInset,
          );
          rowOffsetsRef.current.set(safeIndex, absoluteTop);
          return absoluteTop;
        }
      }
      const measuredTop = rowOffsetsRef.current.get(safeIndex);
      return measuredTop ?? null;
    },
    [listReady, listRef, lyrics.length],
  );

  const getLineHeight = useCallback(
    (index: number) => {
      const safeIndex = Math.max(0, Math.min(index, lyrics.length - 1));
      if (listReady) {
        const layout = listRef.current?.getLayout(safeIndex);
        if (layout && Number.isFinite(layout.height) && layout.height > 0) {
          rowHeightsRef.current.set(safeIndex, layout.height);
          return layout.height;
        }
      }
      return rowHeightsRef.current.get(safeIndex);
    },
    [listReady, listRef, lyrics.length],
  );

  const getScrollOffsetForLineIndex = useCallback(
    (index: number) => {
      const absoluteTop = getAbsoluteLineTop(index);
      if (absoluteTop === null) {
        return null;
      }
      return Math.max(0, absoluteTop - activeLineTopOffset);
    },
    [activeLineTopOffset, getAbsoluteLineTop],
  );

  const markProgrammaticScroll = useCallback((animated: boolean) => {
    programmaticScrollInProgressRef.current = true;
    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = setTimeout(
      () => {
        programmaticScrollInProgressRef.current = false;
        programmaticScrollTimerRef.current = null;
      },
      animated ? PROGRAMMATIC_SCROLL_GUARD_MS : 120,
    );
  }, []);

  const clearUserScrollIdleTimer = useCallback(() => {
    if (userScrollIdleTimerRef.current) {
      clearTimeout(userScrollIdleTimerRef.current);
      userScrollIdleTimerRef.current = null;
    }
  }, []);

  const scheduleUserScrollIdleReset = useCallback(() => {
    lastUserScrollAtRef.current = Date.now();
    if (userScrollIdleTimerRef.current !== null) return;
    const checkIdle = () => {
      if (userDragInProgressRef.current) {
        userScrollIdleTimerRef.current = setTimeout(checkIdle, USER_SCROLL_IDLE_RESET_MS);
        return;
      }
      const remaining = USER_SCROLL_IDLE_RESET_MS - (Date.now() - lastUserScrollAtRef.current);
      if (remaining > 0) {
        userScrollIdleTimerRef.current = setTimeout(checkIdle, remaining);
        return;
      }
      userScrollInProgressRef.current = false;
      userScrollSessionRef.current = false;
      setIsUserTouchScrolling(false);
      userScrollIdleTimerRef.current = null;
    };
    userScrollIdleTimerRef.current = setTimeout(checkIdle, USER_SCROLL_IDLE_RESET_MS);
  }, []);

  const scrollToOffset = useCallback(
    (
      offset: number,
      animated: boolean,
      animationStyle: ScrollAnimationStyle,
      startOffset: number,
    ) => {
      if (
        animated &&
        animationStyle === "lyric" &&
        SHOULD_USE_UI_THREAD_SCROLL
      ) {
        cancelAnimation(lyricScrollOffset);
        lyricScrollActive.value = true;
        lyricScrollOffset.value = startOffset;
        const focus = effectiveWindowStateRef.current.focusLineIndex;
        const previous = lyrics[focus - 1];
        const interval = previous && lyrics[focus] ? lyrics[focus].lineStartTime - previous.lineStartTime : undefined;
        const spring = amlPositionSpring(interval, previewPlaybackPosition !== null || Math.abs(focus - scrollCommand.value.focus) > 1,
          effectiveWindowStateRef.current.isLongPause);
        scrollCommand.value = { from: startOffset, target: offset, revision: scrollCommand.value.revision + 1,
          firstVisible: 0, focus, spring };
        // Single unified motion: rows ride the list together, no per-row stagger.
        staggerEnabled.value = false;
        lyricScrollOffset.value = withSpring(
          offset,
          spring,
          (finished) => {
            if (finished) {
              lyricScrollActive.value = false;
            }
          },
        );
        return;
      }

      cancelAnimation(lyricScrollOffset);
      staggerEnabled.value = false;
      lyricScrollActive.value = false;
      staggerEnabled.value = false;
      lyricScrollOffset.value = offset;
      listRef.current?.scrollToOffset({
        offset,
        animated,
        skipFirstItemOffset: false,
      });
    },
    [listRef, lyricScrollActive, lyricScrollOffset, lyrics, previewPlaybackPosition, scrollCommand, staggerEnabled],
  );

  const syncMeasuredRowLayoutsFromIndex = useCallback(
    (fromIndex: number) => {
      const rowHeights = rowHeightsRef.current;
      const rowOffsets = rowOffsetsRef.current;
      let offset = topListPadding;
      if (fromIndex > 0) {
        const previousTop = rowOffsets.get(fromIndex - 1);
        const previousHeight = rowHeights.get(fromIndex - 1);
        if (previousTop === undefined || previousHeight === undefined) {
          return;
        }
        offset = previousTop + previousHeight;
      }
      for (let index = fromIndex; index < lyrics.length; index += 1) {
        const height = rowHeights.get(index);
        if (height === undefined) {
          break;
        }
        rowOffsets.set(index, offset);
        offset += height;
      }
    },
    [lyrics.length, topListPadding],
  );

  const getRangeMetrics = useCallback(
    (range: LyricLineRange) => {
      const startIndex = Math.max(0, Math.min(range.startIndex, lyrics.length - 1));
      const endIndex = Math.max(startIndex, Math.min(range.endIndex, lyrics.length - 1));
      const top = getAbsoluteLineTop(startIndex);
      const endTop = getAbsoluteLineTop(endIndex);
      const endHeight = getLineHeight(endIndex);
      if (top === null || endTop === null || endHeight === undefined) {
        return null;
      }
      return {
        top,
        bottom: endTop + endHeight,
      };
    },
    [getAbsoluteLineTop, getLineHeight, lyrics.length],
  );

  const getScrollOffsetForRange = useCallback(
    (range: LyricLineRange) => {
      const listHeight = listHeightRef.current;
      if (!listHeight || lyrics.length === 0) {
        return null;
      }
      const isLastLineRange =
        range.endIndex >= lyrics.length - 1 &&
        range.startIndex >= lyrics.length - 1;
      if (creditsActive && hasCredits && isLastLineRange) {
        return getCreditsAwareScrollOffset({
          range,
          lyricsLength: lyrics.length,
          listHeight,
          creditsLayout: creditsLayoutRef.current,
          getAbsoluteLineTop,
          creditsActive,
          hasCredits: true,
          activeLineTopOffset,
        });
      }

      const anchorOffset = getScrollOffsetForLineIndex(range.startIndex);
      if (anchorOffset === null) {
        return null;
      }

      const metrics = getRangeMetrics(range);
      if (!metrics) {
        return anchorOffset;
      }
      const { top, bottom } = metrics;
      const activeRangeHeight = bottom - top;
      const activeRangeFits =
        activeRangeHeight <=
        listHeight - activeLineTopOffset - ACTIVE_RANGE_BOTTOM_PADDING;
      if (activeRangeFits) {
        return anchorOffset;
      }
      return Math.max(
        0,
        bottom - listHeight + ACTIVE_RANGE_BOTTOM_PADDING,
      );
    },
    [
      activeLineTopOffset,
      creditsActive,
      getAbsoluteLineTop,
      getRangeMetrics,
      getScrollOffsetForLineIndex,
      lyrics.length,
      hasCredits,
    ],
  );

  const isRangeAnchoredAndVisible = useCallback(
    (range: LyricLineRange) => {
      const listHeight = listHeightRef.current;
      if (!listHeight || lyrics.length === 0) {
        return true;
      }
      const targetOffset = getScrollOffsetForRange(range);
      if (targetOffset === null) {
        return false;
      }
      const isLastLineRange =
        range.endIndex >= lyrics.length - 1 &&
        range.startIndex >= lyrics.length - 1;
      if (creditsActive && hasCredits && isLastLineRange) {
        const creditsLayout = creditsLayoutRef.current;
        const scrollOffset = scrollOffsetRef.current;
        if (
          Math.abs(scrollOffset - targetOffset) > ACTIVE_LINE_ALIGNMENT_EPSILON
        ) {
          return false;
        }
        if (!creditsLayout) {
          return true;
        }
        return (
          creditsLayout.bottom <=
          scrollOffset + listHeight - ACTIVE_RANGE_BOTTOM_PADDING + ACTIVE_LINE_ALIGNMENT_EPSILON
        );
      }
      const metrics = getRangeMetrics(range);
      if (!metrics) {
        return false;
      }
      const { top, bottom } = metrics;
      const activeLineViewportTop = top - scrollOffsetRef.current;
      const activeRangeHeight = bottom - top;
      const activeRangeFits =
        activeRangeHeight <=
        listHeight - activeLineTopOffset - ACTIVE_RANGE_BOTTOM_PADDING;
      const topIsAnchored =
        Math.abs(activeLineViewportTop - activeLineTopOffset) <=
        ACTIVE_LINE_ALIGNMENT_EPSILON;
      const bottomIsVisible =
        bottom <=
        scrollOffsetRef.current +
          listHeight -
          ACTIVE_RANGE_BOTTOM_PADDING +
          ACTIVE_LINE_ALIGNMENT_EPSILON;
      if (activeRangeFits) {
        return topIsAnchored && bottomIsVisible;
      }
      return bottomIsVisible;
    },
    [
      activeLineTopOffset,
      creditsActive,
      getRangeMetrics,
      getScrollOffsetForRange,
      lyrics.length,
      hasCredits,
    ],
  );

  const getDistanceFromRangeAnchor = useCallback(
    (range: LyricLineRange) => {
      const targetOffset = getScrollOffsetForRange(range);
      if (targetOffset === null) {
        return null;
      }
      return Math.abs(targetOffset - scrollOffsetRef.current);
    },
    [getScrollOffsetForRange],
  );

  const autoFollowEnabledRef = useRef(autoFollowEnabled);
  autoFollowEnabledRef.current = autoFollowEnabled;
  const previewPlaybackPositionRef = useRef(previewPlaybackPosition);
  previewPlaybackPositionRef.current = previewPlaybackPosition;
  const startupDotsWarmupActiveRef = useRef(startupDotsWarmupActive);
  startupDotsWarmupActiveRef.current = startupDotsWarmupActive;
  const isSourceAutoScrollCooldownRef = useRef(isSourceAutoScrollCooldown);
  isSourceAutoScrollCooldownRef.current = isSourceAutoScrollCooldown;
  const getDistanceFromRangeAnchorRef = useRef(getDistanceFromRangeAnchor);
  getDistanceFromRangeAnchorRef.current = getDistanceFromRangeAnchor;

  // ponytail: stable identity — reads volatile deps from refs to avoid cascading
  // callback invalidation that re-renders the entire FlashList on every line change
  const updateAutoFollowForUserScroll = useCallback(() => {
    const currentScrollTarget = scrollTargetRangeRef.current;
    if (
      !currentScrollTarget ||
      previewPlaybackPositionRef.current !== null ||
      startupDotsWarmupActiveRef.current ||
      isSourceAutoScrollCooldownRef.current ||
      programmaticScrollInProgressRef.current ||
      (!userScrollSessionRef.current && !userScrollInProgressRef.current)
    ) {
      return;
    }

    const distanceFromAnchor = getDistanceFromRangeAnchorRef.current(currentScrollTarget);
    if (distanceFromAnchor === null) {
      return;
    }

    if (autoFollowEnabledRef.current) {
      if (Date.now() < autoFollowDisableGraceUntilRef.current) {
        return;
      }
      if (distanceFromAnchor > AUTO_FOLLOW_DISABLE_DISTANCE_PX) {
        lastScrollRequestRef.current = "";
        onAutoFollowChangeRef.current?.(false);
      }
      return;
    }

    if (distanceFromAnchor <= AUTO_FOLLOW_RESUME_DISTANCE_PX) {
      lastScrollRequestRef.current = "";
      onAutoFollowChangeRef.current?.(true);
    }
  }, []);

  const scheduleScrollToRange = useCallback(
    (
      range: LyricLineRange,
      {
        animated = true,
        animationStyle = "lyric",
        force = false,
      }: {
        animated?: boolean;
        animationStyle?: ScrollAnimationStyle;
        force?: boolean;
      } = {},
    ) => {
      if (!rendererActiveRef.current || !listReady || lyrics.length === 0) {
        return;
      }
      const shouldSettleInitialAutoScroll =
        initialAutoScrollPendingRef.current && autoFollowEnabled;
      const shouldAnimate =
        animated && !shouldSettleInitialAutoScroll;
      const effectiveAnimationStyle: ScrollAnimationStyle = animated
        ? animationStyle
        : "native";
      const resolvedOffset = getScrollOffsetForRange(range);
      if (resolvedOffset === null) {
        pendingAnchorRangeRef.current = range;
        pendingAnchorAnimatedRef.current = animated;
        const layoutIndex = Math.max(
          0,
          Math.min(range.startIndex, lyrics.length - 1),
        );
        void listRef.current
          ?.scrollToIndex({
            index: layoutIndex,
            animated: false,
            viewOffset: activeLineTopOffset,
          })
          .then(() => {
            if (!rendererActiveRef.current) {
              return;
            }
            if (getScrollOffsetForRange(range) === null) {
              if (
                pendingAnchorRetryCountRef.current < MAX_PENDING_ANCHOR_RETRIES &&
                !pendingAnchorRetryTimerRef.current
              ) {
                pendingAnchorRetryTimerRef.current = setTimeout(() => {
                  pendingAnchorRetryTimerRef.current = null;
                  const pendingRange = pendingAnchorRangeRef.current;
                  if (!pendingRange) {
                    pendingAnchorRetryCountRef.current = 0;
                    return;
                  }
                  pendingAnchorRetryCountRef.current += 1;
                  scheduleScrollToRange(pendingRange, {
                    animated: pendingAnchorAnimatedRef.current,
                    animationStyle: "lyric",
                    force: true,
                  });
                }, PENDING_ANCHOR_RETRY_MS);
              }
              return;
            }
            pendingAnchorRetryCountRef.current = 0;
            scheduleScrollToRange(range, {
              animated,
              animationStyle,
              force: true,
            });
          });
        return;
      }
      pendingAnchorRetryCountRef.current = 0;
      if (pendingAnchorRetryTimerRef.current) {
        clearTimeout(pendingAnchorRetryTimerRef.current);
        pendingAnchorRetryTimerRef.current = null;
      }
      if (!force && isRangeAnchoredAndVisible(range)) {
        pendingAnchorRangeRef.current = null;
        return;
      }
      const requestKey = `${range.startIndex}:${range.endIndex}:${Math.round(
        resolvedOffset,
      )}:${Math.round(scrollOffsetRef.current)}:${shouldAnimate ? effectiveAnimationStyle : "i"}`;
      if (!force && lastScrollRequestRef.current === requestKey) {
        return;
      }
      lastScrollRequestRef.current = requestKey;
      if (
        pendingScrollFrameRef.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(pendingScrollFrameRef.current);
      }
      const performScroll = () => {
        pendingScrollFrameRef.current = null;
        if (!rendererActiveRef.current) {
          return;
        }
        pendingAnchorRangeRef.current = range;
        markProgrammaticScroll(shouldAnimate);
        const startOffset = scrollOffsetRef.current;
        scrollToOffset(
          resolvedOffset,
          shouldAnimate,
          effectiveAnimationStyle,
          startOffset,
        );
        if (!shouldAnimate) {
          scrollOffsetRef.current = resolvedOffset;
        }
        if (scrollSettleTimerRef.current) {
          clearTimeout(scrollSettleTimerRef.current);
        }
        scrollSettleTimerRef.current = setTimeout(
          () => {
            scrollSettleTimerRef.current = null;
            if (
              !rendererActiveRef.current ||
              !listReady ||
              lyrics.length === 0
            ) {
              return;
            }
            const settledOffset = getScrollOffsetForRange(range);
            if (settledOffset === null) {
              pendingAnchorRangeRef.current = range;
              return;
            }
            const settleDrift = Math.abs(
              settledOffset - scrollOffsetRef.current,
            );
            if (settleDrift <= SCROLL_OFFSET_EPSILON) {
              return;
            }
            // Small drifts snap invisibly; larger ones (e.g. a row remeasured
            // mid-scroll) re-ease instead of jumping.
            if (settleDrift <= SETTLE_SMOOTH_THRESHOLD_PX) {
              markProgrammaticScroll(false);
              const startOffset = scrollOffsetRef.current;
              scrollToOffset(settledOffset, false, "native", startOffset);
              scrollOffsetRef.current = settledOffset;
              return;
            }
            markProgrammaticScroll(true);
            scrollToOffset(
              settledOffset,
              true,
              "lyric",
              scrollOffsetRef.current,
            );
          },
          shouldAnimate ? SCROLL_SETTLE_VERIFY_MS : 80,
        );
        if (shouldSettleInitialAutoScroll) {
          markInitialAutoScrollSettled();
        }
      };
      if (typeof requestAnimationFrame === "function") {
        pendingScrollFrameRef.current = requestAnimationFrame(performScroll);
        return;
      }
      performScroll();
    },
    [
      autoFollowEnabled,
      activeLineTopOffset,
      getScrollOffsetForRange,
      isRangeAnchoredAndVisible,
      listReady,
      listRef,
      lyrics.length,
      markInitialAutoScrollSettled,
      markProgrammaticScroll,
      scrollToOffset,
    ],
  );
  scheduleScrollToRangeRef.current = scheduleScrollToRange;

  // ponytail: track whether all cells are measured so we can skip onLayout entirely
  const [allCellsMeasured, setAllCellsMeasured] = useState(false);
  const handleCellLayout = useCallback(
    (index: number, event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (!Number.isFinite(height) || height <= 0) {
        return;
      }
      const rowHeights = rowHeightsRef.current;
      const previousHeight = rowHeights.get(index);
      if (previousHeight !== undefined && Math.abs(previousHeight - height) < 0.5) {
        return;
      }
      rowHeights.set(index, height);
      if (getAbsoluteLineTop(index) === null) {
        syncMeasuredRowLayoutsFromIndex(index);
      }
      // ponytail: only bump when the last line height changes — that's the only thing that
      // affects listInsets.paddingBottom. Mid-song cell layouts during scroll don't change padding.
      if (index === lyrics.length - 1) {
        bumpContentLayoutVersion();
      }
      // Once every line has been measured, disable onLayout to stop bridge chatter
      if (rowHeights.size >= lyrics.length && !allCellsMeasured) {
        setAllCellsMeasured(true);
      }
      const pendingRange = pendingAnchorRangeRef.current;
      const currentScrollTarget = scrollTargetRangeRef.current;
      const rangeToRescroll =
        pendingRange ??
        (currentScrollTarget &&
        index >= currentScrollTarget.startIndex &&
        index <= currentScrollTarget.endIndex
          ? currentScrollTarget
          : null);
      if (
        rangeToRescroll &&
        rowOffsetsRef.current.has(rangeToRescroll.startIndex)
      ) {
        // Non-forced: the anchor/visibility guard inside scheduleScrollToRange
        // decides. Forcing here restarted the position spring on every cell
        // remeasure mid-scroll, which read as staggered shifting.
        scheduleScrollToRangeRef.current(rangeToRescroll, {
          animated: pendingRange
            ? pendingAnchorAnimatedRef.current
            : true,
          animationStyle: "lyric",
          force: false,
        });
      }
    },
    [
      allCellsMeasured,
      bumpContentLayoutVersion,
      getAbsoluteLineTop,
      lyrics.length,
      syncMeasuredRowLayoutsFromIndex,
    ],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollOffsetRef.current = Math.max(0, event.nativeEvent.contentOffset.y);
      if (
        programmaticScrollInProgressRef.current ||
        (!userScrollSessionRef.current && !userScrollInProgressRef.current)
      ) {
        return;
      }
      scheduleUserScrollIdleReset();
      updateAutoFollowForUserScroll();
    },
    [scheduleUserScrollIdleReset, updateAutoFollowForUserScroll],
  );

  const handleUserDragBegin = useCallback((offset: number) => {
    // A real drag always wins over a pending auto-scroll, including its guard
    // and delayed settle/retry jobs. The UI worklet has already stopped motion.
    scrollOffsetRef.current = offset;
    programmaticScrollInProgressRef.current = false;
    for (const timer of [programmaticScrollTimerRef, scrollSettleTimerRef, pendingAnchorRetryTimerRef]) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    }
    onUserInteraction?.();
    setIsUserTouchScrolling(true);
    userScrollInProgressRef.current = true;
    userDragInProgressRef.current = true;
    userScrollSessionRef.current = true;
    scheduleUserScrollIdleReset();
    lastScrollRequestRef.current = "";
    pendingAnchorRangeRef.current = null;
    if (pendingScrollFrameRef.current !== null) {
      cancelAnimationFrame(pendingScrollFrameRef.current);
      pendingScrollFrameRef.current = null;
    }
  }, [onUserInteraction, scheduleUserScrollIdleReset]);
  const handleScrollBeginDrag = useLyricScrollInterruption(
    lyricScrollOffset, lyricScrollActive, handleUserDragBegin, staggerEnabled,
  );

  useLayoutEffect(() => {
    activeLineRef.current = -1;
    scrollOffsetRef.current = 0;
    userScrollInProgressRef.current = false;
    userDragInProgressRef.current = false;
    userScrollSessionRef.current = false;
    autoFollowDisableGraceUntilRef.current =
      Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS;
    lastScrollRequestRef.current = "";
    pendingAnchorRangeRef.current = null;
    pendingAnchorAnimatedRef.current = true;
    pendingAnchorRetryCountRef.current = 0;
    if (pendingAnchorRetryTimerRef.current) {
      clearTimeout(pendingAnchorRetryTimerRef.current);
      pendingAnchorRetryTimerRef.current = null;
    }
    onAutoFollowChangeRef.current?.(true);
    setAllCellsMeasured(false);
    rowHeightsRef.current.clear();
    rowOffsetsRef.current.clear();
    creditsLayoutRef.current = null;
    setContentLayoutVersion(0);
  }, [lyrics]);

  // Reset measurement state when layout-affecting props change
  useEffect(() => {
    setAllCellsMeasured(false);
    rowHeightsRef.current.clear();
  }, [fontScale, landscapeMode]);

  useEffect(
    () => () => {
      if (startupDotsTimerRef.current) {
        clearTimeout(startupDotsTimerRef.current);
        startupDotsTimerRef.current = null;
      }
      if (
        pendingScrollFrameRef.current !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(pendingScrollFrameRef.current);
      }
      pendingScrollFrameRef.current = null;
      if (programmaticScrollTimerRef.current) {
        clearTimeout(programmaticScrollTimerRef.current);
        programmaticScrollTimerRef.current = null;
      }
      clearUserScrollIdleTimer();
      if (scrollSettleTimerRef.current) {
        clearTimeout(scrollSettleTimerRef.current);
        scrollSettleTimerRef.current = null;
      }
      cancelAnimation(lyricScrollOffset);
      staggerEnabled.value = false;
      lyricScrollActive.value = false;
      pendingAnchorRangeRef.current = null;
      pendingAnchorAnimatedRef.current = true;
      pendingAnchorRetryCountRef.current = 0;
      if (pendingAnchorRetryTimerRef.current) {
        clearTimeout(pendingAnchorRetryTimerRef.current);
        pendingAnchorRetryTimerRef.current = null;
      }
      if (layoutBumpFrameRef.current !== null) {
        cancelAnimationFrame(layoutBumpFrameRef.current);
        layoutBumpFrameRef.current = null;
      }
      programmaticScrollInProgressRef.current = false;
    },
    [clearUserScrollIdleTimer, lyricScrollActive, lyricScrollOffset, staggerEnabled],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;
      setAppIsActive(nextState === "active");
      if (nextState !== "active" || previousState === "active") {
        return;
      }

      cancelAnimation(lyricScrollOffset);
      staggerEnabled.value = false;
      lyricScrollActive.value = false;
      programmaticScrollInProgressRef.current = false;
      userScrollInProgressRef.current = false;
      userDragInProgressRef.current = false;
      userScrollSessionRef.current = false;
      autoFollowDisableGraceUntilRef.current =
        Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS;
      lastScrollRequestRef.current = "";
    });

    return () => subscription.remove();
  }, [
    lyricScrollActive,
    lyricScrollOffset,
    staggerEnabled,
  ]);

  useEffect(() => {
    if (rendererActive) {
      autoFollowDisableGraceUntilRef.current =
        Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS;
      lastScrollRequestRef.current = "";
      return;
    }

    // Keep the native list exactly where it was while the lyrics screen is not
    // visible. In particular, cancel the UI-thread scroll timing rather than
    // letting it finish behind another tab/screen.
    cancelAnimation(lyricScrollOffset);
    staggerEnabled.value = false;
    lyricScrollActive.value = false;
    programmaticScrollInProgressRef.current = false;
    userScrollInProgressRef.current = false;
    userDragInProgressRef.current = false;
    userScrollSessionRef.current = false;
    clearUserScrollIdleTimer();
    setIsUserTouchScrolling(false);
    if (
      pendingScrollFrameRef.current !== null &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(pendingScrollFrameRef.current);
      pendingScrollFrameRef.current = null;
    }
    if (programmaticScrollTimerRef.current) {
      clearTimeout(programmaticScrollTimerRef.current);
      programmaticScrollTimerRef.current = null;
    }
    if (scrollSettleTimerRef.current) {
      clearTimeout(scrollSettleTimerRef.current);
      scrollSettleTimerRef.current = null;
    }
    if (pendingAnchorRetryTimerRef.current) {
      clearTimeout(pendingAnchorRetryTimerRef.current);
      pendingAnchorRetryTimerRef.current = null;
    }
  }, [rendererActive, lyricScrollActive, lyricScrollOffset, clearUserScrollIdleTimer, staggerEnabled]);

  useEffect(() => {
    if (!hasMountedLyricsChangeEffectRef.current) {
      hasMountedLyricsChangeEffectRef.current = true;
      lastLyricsSourceRef.current = lyricsSource || null;
      return;
    }
    const currentSource = lyricsSource || null;
    if (lastLyricsSourceRef.current === currentSource) {
      return;
    }
    lastLyricsSourceRef.current = currentSource;

    setIsSourceAutoScrollCooldown(true);
    if (sourceAutoScrollTimerRef.current) {
      clearTimeout(sourceAutoScrollTimerRef.current);
    }
    sourceAutoScrollTimerRef.current = setTimeout(() => {
      setIsSourceAutoScrollCooldown(false);
      sourceAutoScrollTimerRef.current = null;
    }, SOURCE_CHANGE_AUTOSCROLL_DELAY_MS);
  }, [lyricsSource]);

  useEffect(
    () => () => {
      if (sourceAutoScrollTimerRef.current) {
        clearTimeout(sourceAutoScrollTimerRef.current);
        sourceAutoScrollTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (
      !rendererActive ||
      !listReady ||
      resumeAutoFollowSignal <= 0 ||
      resumeAutoFollowSignal === lastResumeAutoFollowSignalRef.current
    ) {
      return;
    }
    lastResumeAutoFollowSignalRef.current = resumeAutoFollowSignal;
    userScrollInProgressRef.current = false;
    userScrollSessionRef.current = false;
    lastScrollRequestRef.current = "";
    onAutoFollowChange?.(true);
    if (isSourceAutoScrollCooldown || !scrollTargetRange) {
      return;
    }
    scheduleScrollToRange(scrollTargetRange, {
      animated: true,
      animationStyle: "lyric",
      force: true,
    });
  }, [
    isSourceAutoScrollCooldown,
    listReady,
    onAutoFollowChange,
    rendererActive,
    resumeAutoFollowSignal,
    scheduleScrollToRange,
    scrollTargetRange,
  ]);

  useEffect(() => {
    if (initialAutoScrollPendingRef.current && lyrics.length === 0) {
      markInitialAutoScrollSettled();
      return;
    }
    if (
      initialAutoScrollPendingRef.current &&
      listReady &&
      !scrollTargetRange
    ) {
      markInitialAutoScrollSettled();
    }
  }, [lyrics.length, listReady, markInitialAutoScrollSettled, scrollTargetRange]);

  useEffect(() => {
    if (
      !rendererActive ||
      !listReady ||
      !scrollTargetRange ||
      isSourceAutoScrollCooldown ||
      startupDotsWarmupActive ||
      suspendViewportScrollAdjustments ||
      userScrollInProgressRef.current
    ) {
      return;
    }
    if (previewPlaybackPosition !== null) {
      if (!isRangeAnchoredAndVisible(scrollTargetRange)) {
        scheduleScrollToRange(scrollTargetRange, {
          animated: true,
          animationStyle: "lyric",
        });
      } else if (initialAutoScrollPendingRef.current) {
        markInitialAutoScrollSettled();
      }
      return;
    }
    if (autoFollowActive && !isRangeAnchoredAndVisible(scrollTargetRange)) {
      scheduleScrollToRange(scrollTargetRange, {
        animated: true,
        animationStyle: "lyric",
      });
    } else if (autoFollowActive && initialAutoScrollPendingRef.current) {
      markInitialAutoScrollSettled();
    }
  }, [
    autoFollowActive,
    creditsActive,
    isRangeAnchoredAndVisible,
    isSourceAutoScrollCooldown,
    markInitialAutoScrollSettled,
    listReady,
    previewPlaybackPosition,
    rendererActive,
    scheduleScrollToRange,
    scrollTargetRange,
    startupDotsWarmupActive,
    suspendViewportScrollAdjustments,
    viewportHeight,
    layoutSettleSignal,
  ]);

  useEffect(() => {
    if (activeLineIndex < 0) {
      activeLineRef.current = -1;
      return;
    }
    if (activeLineIndex === activeLineRef.current) {
      return;
    }
    activeLineRef.current = activeLineIndex;
    onActiveLineChange?.(activeLineIndex);
  }, [activeLineIndex, onActiveLineChange]);

  // ponytail: read window state from ref so renderItem is stable across line transitions.
  // FlashList still diffs via extraData, but the callback identity doesn't change,
  // avoiding full invalidation of the internal render tree.
  const renderItem = useCallback(
    ({ item, index }: { item: LyricLineType; index: number }) => {
      const ws = effectiveWindowStateRef.current;
      const hasActiveLines = ws.activeLineStartIndex >= 0;
      const isActive =
        hasActiveLines &&
        isIndexWithinRange(
          index,
          ws.activeLineStartIndex,
          ws.activeLineEndIndex,
        );
      const shouldDrivePlaybackUpdates = isIndexWithinUpdateWindow(
        index,
        ws,
      );
      const isPast =
        ws.focusLineIndex >= 0
          ? hasActiveLines
            ? index < ws.focusLineIndex
            : index <= ws.focusLineIndex
          : false;
      const inactiveOpacityDistance = Math.abs(
        ws.focusLineIndex - index,
      );
      const showPauseDotsAfter =
        ws.isLongPause && index === ws.pauseAfterIndex;
      const showPauseDotsBefore =
        ws.isLongPause && index === ws.pauseBeforeIndex;

      return (
        <NativeLyricMotion index={index} command={scrollCommand} offset={lyricScrollOffset}
          enabled={staggerEnabled} active={rendererActive}>
        <LyricLine
          rendererActive={rendererActive}
          line={item}
          isActive={isActive}
          isPast={isPast}
          isSelected={Boolean(selectedLineKeys?.has(`${item.lineStartTime}-${item.lineEndTime}`))}
          blurAmount={amlBlur(index, ws.focusLineIndex, ws.visualActiveLineEndIndex,
            isActive || isIndexWithinRange(index, ws.visualActiveLineStartIndex, ws.visualActiveLineEndIndex), isUserTouchScrolling)}
          inactiveOpacityDistance={inactiveOpacityDistance}
          showPauseDotsAfter={showPauseDotsAfter}
          showPauseDotsBefore={showPauseDotsBefore}
          pauseStartMs={ws.pauseStartMs}
          pauseVisualDurationMs={ws.pauseVisualDurationMs}
          playbackPositionOverrideMs={previewPlaybackPosition}
          pauseTone={
            ws.isLongPause
              ? index <= ws.pauseAfterIndex
                ? "past"
                : "future"
              : "none"
          }
          onPress={onLinePress}
          onLongPress={onLineLongPress}
          tapEnabled={tapToSeekEnabled}
          showTranslatedText={showTranslatedText}
          shouldDrivePlaybackUpdates={shouldDrivePlaybackUpdates}
          fontScale={fontScale}
          landscapeMode={landscapeMode}
          hasDuetLines={hasDuetLines}
        />
        </NativeLyricMotion>
      );
    },
    [
      fontScale,
      landscapeMode,
      hasDuetLines,
      scrollCommand,
      staggerEnabled,
      lyricScrollOffset,
      onLineLongPress,
      onLinePress,
      selectedLineKeys,
      isUserTouchScrolling,
      showTranslatedText,
      tapToSeekEnabled,
      previewPlaybackPosition,
      rendererActive,
    ],
  );

  // ponytail: skip onLayout once all cells measured — eliminates JS bridge chatter during scroll
  const flashListRenderItem = useCallback(
    ({ item, index }: { item: LyricLineType; index: number }) => (
      <View
        style={landscapeMode ? styles.flashListCellLandscape : undefined}
        onLayout={
          allCellsMeasured
            ? undefined
            : (event) => handleCellLayout(index, event)
        }
      >
        {renderItem({ item, index })}
      </View>
    ),
    [allCellsMeasured, handleCellLayout, landscapeMode, renderItem],
  );

  const keyExtractor = useCallback(
    (item: LyricLineType, index: number) =>
      `${index}-${item.lineStartTime}-${item.lineEndTime}`,
    [],
  );

  const listInsets = useMemo(() => {
    void contentLayoutVersion;
    const lastLineIndex = Math.max(0, lyrics.length - 1);
    const lastLineTop = getAbsoluteLineTop(lastLineIndex);
    const lastLineHeight = getLineHeight(lastLineIndex) ?? 0;
    return {
      // Extra top inset supports Apple-like upper-focus active line anchoring.
      paddingTop: topListPadding,
      // Bottom inset is sized so max scroll stops once the last line (and credits)
      // reach their anchor positions, without extra empty scroll room.
      paddingBottom: getBottomListPadding({
        viewportHeight,
        lyricsLength: lyrics.length,
        lastLineTop,
        lastLineHeight,
        creditsLayout: creditsLayoutRef.current,
        hasCredits,
        activeLineTopOffset,
      }),
    };
  }, [
    activeLineTopOffset,
    contentLayoutVersion,
    getAbsoluteLineTop,
    getLineHeight,
    lyrics.length,
    hasCredits,
    topListPadding,
    viewportHeight,
  ]);

  const handleCreditsLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      if (!Number.isFinite(height) || height <= 0 || lyrics.length === 0) {
        return;
      }
      const lastLineIndex = lyrics.length - 1;
      const lastLineTop = getAbsoluteLineTop(lastLineIndex);
      const lastLineHeight = getLineHeight(lastLineIndex);
      if (lastLineTop === null || lastLineHeight === undefined) {
        return;
      }
      const absoluteTop = lastLineTop + lastLineHeight;
      const nextLayout: CreditsLayout = {
        top: absoluteTop,
        bottom: absoluteTop + height,
      };
      const previousLayout = creditsLayoutRef.current;
      if (
        previousLayout &&
        Math.abs(previousLayout.top - nextLayout.top) < 0.5 &&
        Math.abs(previousLayout.bottom - nextLayout.bottom) < 0.5
      ) {
        return;
      }
      creditsLayoutRef.current = nextLayout;
      bumpContentLayoutVersion();
      const pendingRange = pendingAnchorRangeRef.current;
      if (pendingRange) {
        scheduleScrollToRange(pendingRange, {
          animated: pendingAnchorAnimatedRef.current,
          animationStyle: "lyric",
          force: true,
        });
        return;
      }
      if (!listReady || !scrollTargetRange) {
        return;
      }
      if (!isRangeAnchoredAndVisible(scrollTargetRange)) {
        scheduleScrollToRange(scrollTargetRange, {
          animated: true,
          animationStyle: "lyric",
          force: true,
        });
      }
    },
    [
      bumpContentLayoutVersion,
      getAbsoluteLineTop,
      getLineHeight,
      isRangeAnchoredAndVisible,
      listReady,
      lyrics.length,
      scheduleScrollToRange,
      scrollTargetRange,
    ],
  );

  const listFooter = useMemo(() => {
    if (!hasCredits) {
      return null;
    }
    return (
      <View onLayout={handleCreditsLayout}>
        <CreditsFooter
          rendererActive={rendererActive}
          songwriters={songwriters}
          attribution={attribution}
          lastLyricEndTime={lastLyricEndTime}
          onPress={onCreditsTimestampPress}
        />
      </View>
    );
  }, [
    handleCreditsLayout,
    lastLyricEndTime,
    onCreditsTimestampPress,
    attribution,
    hasCredits,
    rendererActive,
    songwriters,
  ]);

  if (!lyrics.length) {
    const title = instrumental ? "This song is an instrumental" : "No synced lyrics yet";
    const iconName = instrumental ? "musical-notes" : "document-text";
    return (
      <View style={styles.container}>
        <View
          style={[
            styles.emptyWrap,
            {
              transform: [{ translateY: -centeredNoticeUpwardOffset }],
            },
          ]}
        >
          <View style={styles.emptyIconWrap}>
            <Ionicons name={iconName} size={34} color="#FFFFFF" />
          </View>
          <Text style={styles.emptyTitle}>{title}</Text>
          <Pressable
            style={styles.emptyDebugButton}
            onPress={() => setShowEmptyDebug((value) => !value)}
          >
            <Ionicons
              name={showEmptyDebug ? "chevron-up" : "information-circle"}
              size={15}
              color="rgba(255,255,255,0.76)"
            />
            <Text style={styles.emptyDebugText}>
              {showEmptyDebug ? "Hide details" : "Details"}
            </Text>
          </Pressable>
          {showEmptyDebug && (
            <Text style={styles.emptySub}>
              {lyricsStatusMessage || `Source: ${lyricsSource || "unavailable"}`}
            </Text>
          )}
        </View>
      </View>
    );
  }

  if (lyricsTimingMode === "static") {
    // ponytail: FlashList instead of ScrollView+.map() — virtualizes long static lyrics
    const staticRenderItem = ({ item: line }: { item: LyricLineType }) => {
      const text = getPrimaryLineText(line);
      if (!text) return null;
      const translatedText = String(line.translatedText || "").trim();
      const backgroundText = line.backgroundSyllables?.length
        ? getPrimaryLineText({ ...line, syllables: line.backgroundSyllables })
        : "";
      const backgroundTranslatedText = String(
        line.backgroundTranslatedText || "",
      ).trim();
      const alignRight = landscapeMode ? !line.oppositeAligned : false;
      return (
        <View
          style={[
            styles.staticLyricLineWrap,
            alignRight && styles.staticLyricLineWrapOpposite,
          ]}
        >
          <Text
            style={[
              styles.staticLyricLineText,
              alignRight && styles.staticLyricLineTextOpposite,
              {
                fontSize: STATIC_LYRIC_FONT_SIZE * fontScale,
                lineHeight: STATIC_LYRIC_LINE_HEIGHT * fontScale,
              },
            ]}
          >
            {text}
          </Text>
          {showTranslatedText && translatedText ? (
            <Text
              style={[
                styles.staticTranslatedText,
                alignRight && styles.staticLyricLineTextOpposite,
                {
                  fontSize: STATIC_TRANSLATED_FONT_SIZE * fontScale,
                  lineHeight: STATIC_TRANSLATED_LINE_HEIGHT * fontScale,
                },
              ]}
            >
              {translatedText}
            </Text>
          ) : null}
          {backgroundText ? (
            <View
              style={[
                styles.staticBackgroundGroup,
                alignRight && styles.staticLyricLineWrapOpposite,
              ]}
            >
              <Text
                style={[
                  styles.staticBackgroundText,
                  alignRight && styles.staticLyricLineTextOpposite,
                  {
                    fontSize: STATIC_TRANSLATED_FONT_SIZE * fontScale,
                    lineHeight: STATIC_TRANSLATED_LINE_HEIGHT * fontScale,
                  },
                ]}
              >
                {backgroundText}
              </Text>
              {showTranslatedText && backgroundTranslatedText ? (
                <Text
                  style={[
                    styles.staticBackgroundTranslatedText,
                    alignRight && styles.staticLyricLineTextOpposite,
                    {
                      fontSize: 15 * fontScale,
                      lineHeight: 21 * fontScale,
                    },
                  ]}
                >
                  {backgroundTranslatedText}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      );
    };
    const staticFooter = hasCredits ? (
      <View
        style={[
          styles.staticCreditsFooter,
          landscapeMode && styles.staticCreditsFooterLandscape,
        ]}
      >
        <CreditsFooter
          songwriters={songwriters}
          attribution={attribution}
          lastLyricEndTime={0}
          onPress={onCreditsTimestampPress}
          alignRight={landscapeMode}
          style={[
            styles.staticCreditsFooterPressable,
            landscapeMode && styles.staticCreditsFooterPressableLandscape,
          ]}
        />
      </View>
    ) : null;
    return (
      <View style={[styles.container, landscapeMode && styles.containerLandscape]}>
        <FlashList
          data={lyrics}
          renderItem={staticRenderItem}
          keyExtractor={keyExtractor}
          drawDistance={400}
          ListFooterComponent={staticFooter}
          contentContainerStyle={[
            styles.staticLyricsContent,
            landscapeMode && styles.listContentLandscape,
            {
              paddingTop: topListPadding,
              paddingBottom: BOTTOM_LIST_PADDING,
            },
          ]}
          showsVerticalScrollIndicator={false}
          onScrollBeginDrag={() => onUserInteraction?.()}
          onMomentumScrollBegin={() => onUserInteraction?.()}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, landscapeMode && styles.containerLandscape]}>
      <ReanimatedFlashList
        ref={listRef}
        data={lyrics}
        renderItem={flashListRenderItem}
        keyExtractor={keyExtractor}
        extraData={extraDataFingerprint}
        drawDistance={320}
        ListFooterComponent={listFooter}
        onLoad={() => {
          const pendingRange = pendingAnchorRangeRef.current ?? scrollTargetRangeRef.current;
          if (pendingRange) {
            scheduleScrollToRangeRef.current(pendingRange, {
              animated: true,
              animationStyle: "lyric",
              force: true,
            });
          }
        }}
        onLayout={(event) => {
          const height = event.nativeEvent.layout.height;
          listHeightRef.current = height;
          setViewportHeight((previous) =>
            Math.abs(previous - height) < 0.5 ? previous : height,
          );
          setListReady(true);
        }}
        contentContainerStyle={[
          styles.listContent,
          landscapeMode && styles.listContentLandscape,
          listInsets,
        ]}
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={10}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={() => {
          userDragInProgressRef.current = false;
          userScrollInProgressRef.current = false;
          scheduleUserScrollIdleReset();
        }}
        onMomentumScrollBegin={() => {
          if (
            programmaticScrollInProgressRef.current ||
            !userScrollSessionRef.current
          ) {
            return;
          }
          onUserInteraction?.();
          setIsUserTouchScrolling(true);
          cancelAnimation(lyricScrollOffset);
          staggerEnabled.value = false;
          lyricScrollActive.value = false;
          userScrollInProgressRef.current = true;
          scheduleUserScrollIdleReset();
          lastScrollRequestRef.current = "";
          pendingAnchorRangeRef.current = null;
          if (
            pendingScrollFrameRef.current !== null &&
            typeof cancelAnimationFrame === "function"
          ) {
            cancelAnimationFrame(pendingScrollFrameRef.current);
            pendingScrollFrameRef.current = null;
          }
        }}
        onMomentumScrollEnd={() => {
          userDragInProgressRef.current = false;
          setIsUserTouchScrolling(false);
          clearUserScrollIdleTimer();
          programmaticScrollInProgressRef.current = false;
          if (programmaticScrollTimerRef.current) {
            clearTimeout(programmaticScrollTimerRef.current);
            programmaticScrollTimerRef.current = null;
          }
          userScrollInProgressRef.current = false;
          userScrollSessionRef.current = false;
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  containerLandscape: {
    overflow: "visible",
  },
  listContent: {
    paddingHorizontal: LYRICS_LAYOUT.listInset,
  },
  listContentLandscape: {
    paddingLeft:
      LANDSCAPE_LYRICS_HORIZONTAL_INSET + LANDSCAPE_LYRICS_EDGE_BLEED,
    paddingRight:
      LANDSCAPE_LYRICS_HORIZONTAL_INSET + LANDSCAPE_LYRICS_EDGE_BLEED,
  },
  flashListCellLandscape: {
    overflow: "visible",
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 28,
  },
  emptyIconWrap: {
    width: 70,
    height: 70,
    borderRadius: 35,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  emptyTitle: {
    color: "#F8F8FB",
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "800",
    textAlign: "center",
  },
  emptyDebugButton: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.09)",
  },
  emptyDebugText: {
    color: "rgba(255,255,255,0.76)",
    fontSize: 12,
    fontWeight: "600",
  },
  emptySub: {
    color: "rgba(248,248,251,0.72)",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    maxWidth: 320,
  },
  staticLyricsContent: {
    paddingHorizontal: STATIC_LYRIC_HORIZONTAL_INSET,
  },
  staticLyricsColumn: {
    width: "100%",
    maxWidth: STATIC_LYRIC_MAX_WIDTH,
    alignSelf: "flex-start",
  },
  staticLyricsColumnLandscape: {
    alignSelf: "flex-end",
  },
  staticLyricLineWrap: {
    marginBottom: 14,
    alignSelf: "flex-start",
    width: "100%",
    maxWidth: STATIC_LYRIC_MAX_WIDTH,
    paddingVertical: 1,
  },
  staticLyricLineWrapOpposite: {
    alignSelf: "flex-end",
    alignItems: "flex-end",
  },
  staticLyricLineText: {
    color: "#FFFFFF",
    fontSize: STATIC_LYRIC_FONT_SIZE,
    lineHeight: STATIC_LYRIC_LINE_HEIGHT,
    fontWeight: "600",
    letterSpacing: 0.15,
    textAlign: "left",
    alignSelf: "flex-start",
  },
  staticLyricLineTextOpposite: {
    textAlign: "right",
    alignSelf: "flex-end",
  },
  staticTranslatedText: {
    marginTop: 6,
    color: "rgba(255,255,255,0.68)",
    fontSize: STATIC_TRANSLATED_FONT_SIZE,
    lineHeight: STATIC_TRANSLATED_LINE_HEIGHT,
    fontWeight: "500",
    letterSpacing: 0.1,
    textAlign: "left",
    alignSelf: "flex-start",
  },
  staticBackgroundGroup: {
    marginTop: 5,
    alignSelf: "flex-start",
  },
  staticBackgroundText: {
    color: "rgba(255,255,255,0.78)",
    fontWeight: "500",
    letterSpacing: 0.1,
    textAlign: "left",
    alignSelf: "flex-start",
  },
  staticBackgroundTranslatedText: {
    marginTop: 2,
    color: "rgba(255,255,255,0.58)",
    fontWeight: "500",
    letterSpacing: 0.08,
    textAlign: "left",
    alignSelf: "flex-start",
  },
  staticCreditsFooter: {
    marginTop: 18,
    paddingTop: 4,
    alignSelf: "stretch",
  },
  staticCreditsFooterLandscape: {
    alignItems: "flex-end",
  },
  staticCreditsFooterPressable: {
    paddingHorizontal: 0,
    paddingTop: 12,
  },
  staticCreditsFooterPressableLandscape: {
    alignItems: "flex-end",
  },
  creditsFooter: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 6,
  },
  creditsFooterMotion: {
    alignSelf: "stretch",
  },
  creditsText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 13,
    lineHeight: 18,
  },
  creditsTextOpposite: {
    textAlign: "right",
  },
  creditsTextStrong: {
    fontWeight: "800",
  },
  creditsProfileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  creditsProfileRowOpposite: {
    justifyContent: "flex-end",
  },
  creditsProfileAvatar: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  creditsTextActive: {
    color: "#FFFFFF",
  },
});
