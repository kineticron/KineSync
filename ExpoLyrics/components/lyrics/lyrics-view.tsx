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
  ScrollView,
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
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
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
import { LyricLine } from "./lyric-line";

const SOURCE_CHANGE_AUTOSCROLL_DELAY_MS = 500;

const STATIC_LYRIC_FONT_SIZE = 26;
const STATIC_LYRIC_LINE_HEIGHT = 38;
const STATIC_LYRIC_HORIZONTAL_INSET = 28;
const STATIC_LYRIC_MAX_WIDTH = 300;
const STATIC_TRANSLATED_FONT_SIZE = 18;
const STATIC_TRANSLATED_LINE_HEIGHT = 26;

const ACTIVE_LINE_ALIGNMENT_EPSILON = 3;
const SEEK_JUMP_MS = 1000;
// Overscan around the viewport for the AMLL-style windowed list. Rows outside
// this window unmount; rows inside keep stable identities (no recycling).
const ROW_OVERSCAN_PX = 1000;
// Fallback slot height for rows not yet measured, mirroring AMLL's
// LINE_HEIGHT_FALLBACK so windowing works before first measure.
const UNMEASURED_ROW_HEIGHT = 84;
const UNMEASURED_CREDITS_HEIGHT = 120;

const AUTO_FOLLOW_DISABLE_GRACE_MS = 2000;
const AUTO_FOLLOW_DISABLE_DISTANCE_PX = 120;
const AUTO_FOLLOW_RESUME_DISTANCE_PX = 64;
const USER_SCROLL_IDLE_RESET_MS = 700;

export type NativeLyricScroll = {
  shift: number;
  revision: number;
  snap: boolean;
  delays: number[];
  spring: ReturnType<typeof amlPositionSpring>;
};

/**
 * One AMLL-style row spring. Rows live in normal flow; auto-follow never
 * moves the scroll position itself. Instead every visible row glides with its
 * own delayed position spring toward the shared shift target, exactly like
 * AMLL core's per-line posY springs. All motion is transform-only, so
 * scrolling never triggers layout, recycling, or per-frame scroll events.
 */
function RowShift({
  index,
  command,
  frozen,
  children,
}: {
  index: number;
  command: SharedValue<NativeLyricScroll>;
  frozen: SharedValue<boolean>;
  children: React.ReactNode;
}) {
  const shift = useSharedValue(0);
  useAnimatedReaction(
    () => ({ cmd: command.value, held: frozen.value }),
    (next, previous) => {
      if (next.held) {
        cancelAnimation(shift);
        return;
      }
      if (
        previous &&
        previous.cmd.revision === next.cmd.revision &&
        previous.held === next.held
      ) {
        return;
      }
      cancelAnimation(shift);
      if (!previous || next.cmd.snap) {
        shift.value = next.cmd.shift;
        return;
      }
      const delay = next.cmd.delays?.[index] ?? 0;
      shift.value =
        delay > 0
          ? withDelay(delay, withSpring(next.cmd.shift, next.cmd.spring))
          : withSpring(next.cmd.shift, next.cmd.spring);
    },
  );
  useEffect(() => () => cancelAnimation(shift), [shift]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: shift.value }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
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
    return unsubscribe;
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
  const scrollRef = useRef<ScrollView | null>(null);
  // AMLL scroll model: the scroll position only moves via instant jumps and
  // the user's finger. Auto-follow glides rows with per-row UI-thread
  // springs (RowShift) toward a shared shift target, so scrolling is
  // transform-only and never drives layout, recycling, or scroll events.
  const shiftCommand = useSharedValue<NativeLyricScroll>({
    shift: 0,
    revision: 0,
    snap: true,
    delays: [],
    spring: AMLL_POSITION_SPRING,
  });
  const shiftFrozen = useSharedValue(false);
  const activeLineRef = useRef(-1);
  const onAutoFollowChangeRef = useRef(onAutoFollowChange);
  const listHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  const rowHeightsRef = useRef(new Map<number, number>());
  const userScrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastUserScrollAtRef = useRef(0);
  const userScrollInProgressRef = useRef(false);
  const userDragInProgressRef = useRef(false);
  const userScrollSessionRef = useRef(false);
  const dragStartOffsetRef = useRef(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const rendererActiveRef = useRef(rendererActive);
  rendererActiveRef.current = rendererActive;
  const autoFollowDisableGraceUntilRef = useRef(
    Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS,
  );
  const lastResumeAutoFollowSignalRef = useRef(0);
  const lastCommandedPositionRef = useRef<number | null>(null);
  const shiftMirrorRef = useRef(0);
  const sourceAutoScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const startupDotsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasShownStartupDotsRef = useRef(false);
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

  const autoFollowActive = autoFollowEnabled && !isSourceAutoScrollCooldown;

  const markInitialAutoScrollSettled = useCallback(() => {
    if (initialAutoScrollSettledRef.current) {
      return;
    }
    initialAutoScrollSettledRef.current = true;
    initialAutoScrollPendingRef.current = false;
    onInitialAutoScrollSettled?.();
  }, [onInitialAutoScrollSettled]);

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
    return unsubscribe;
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
  }, [autoFollowEnabled]);

  // ---- AMLL scroll model: arithmetic layout ---------------------------------
  // Like AMLL core's calcLayout, row geometry is prefix sums of measured
  // heights, never FlashList getLayout queries. Unmeasured rows use a
  // fallback slot so windowing and targets work before first measure.
  const rowCount = lyrics.length + (hasCredits ? 1 : 0);
  const estimatedRowHeight = useCallback(
    (index: number) =>
      rowHeightsRef.current.get(index) ??
      (hasCredits && index === lyrics.length
        ? UNMEASURED_CREDITS_HEIGHT
        : UNMEASURED_ROW_HEIGHT),
    [hasCredits, lyrics.length],
  );
  const getRowTop = useCallback(
    (index: number) => {
      const safeIndex = Math.max(0, Math.min(index, Math.max(0, rowCount - 1)));
      let top = topListPadding;
      for (let i = 0; i < safeIndex; i += 1) {
        top += estimatedRowHeight(i);
      }
      return top;
    },
    [estimatedRowHeight, rowCount, topListPadding],
  );
  const getContentHeight = useCallback(() => {
    let total = topListPadding;
    for (let i = 0; i < rowCount; i += 1) {
      total += estimatedRowHeight(i);
    }
    return total;
  }, [estimatedRowHeight, rowCount, topListPadding]);

  // True content offset that would anchor the range exactly, using the same
  // top/bottom policy as before (top-anchor when the range fits, bottom
  // pinning for tall ranges and the credits block).
  const getTrueOffsetForRange = useCallback(
    (range: LyricLineRange) => {
      const listHeight = listHeightRef.current;
      if (!listHeight || lyrics.length === 0) {
        return null;
      }
      const startIndex = Math.max(0, Math.min(range.startIndex, lyrics.length - 1));
      const endIndex = Math.max(startIndex, Math.min(range.endIndex, lyrics.length - 1));
      const top = getRowTop(startIndex);
      const rowBottom =
        getRowTop(endIndex) + estimatedRowHeight(endIndex);
      const isLastLineRange =
        range.endIndex >= lyrics.length - 1 &&
        range.startIndex >= lyrics.length - 1;
      if (creditsActive && hasCredits && isLastLineRange) {
        const creditsTop = getRowTop(lyrics.length);
        const creditsBottom = creditsTop + estimatedRowHeight(lyrics.length);
        const blockHeight = creditsBottom - getRowTop(lyrics.length - 1);
        const availableHeight =
          listHeight - activeLineTopOffset - ACTIVE_RANGE_BOTTOM_PADDING;
        if (blockHeight > availableHeight) {
          return Math.max(
            0,
            creditsBottom - listHeight + ACTIVE_RANGE_BOTTOM_PADDING,
          );
        }
        return Math.max(0, top - activeLineTopOffset);
      }
      const activeRangeHeight = rowBottom - top;
      if (
        activeRangeHeight <=
        listHeight - activeLineTopOffset - ACTIVE_RANGE_BOTTOM_PADDING
      ) {
        return Math.max(0, top - activeLineTopOffset);
      }
      return Math.max(0, rowBottom - listHeight + ACTIVE_RANGE_BOTTOM_PADDING);
    },
    [
      activeLineTopOffset,
      creditsActive,
      estimatedRowHeight,
      getRowTop,
      lyrics.length,
      hasCredits,
    ],
  );

  // Commanded anchor error: how far the focus row sits from its anchor given
  // the last commanded shift and the current scroll position.
  const getAnchorErrorForRange = useCallback(
    (range: LyricLineRange) => {
      const listHeight = listHeightRef.current;
      if (!listHeight || lyrics.length === 0) {
        return null;
      }
      const startIndex = Math.max(0, Math.min(range.startIndex, lyrics.length - 1));
      const endIndex = Math.max(startIndex, Math.min(range.endIndex, lyrics.length - 1));
      const top = getRowTop(startIndex);
      const rowBottom =
        getRowTop(endIndex) + estimatedRowHeight(endIndex);
      const shift = shiftMirrorRef.current;
      const scroll = scrollOffsetRef.current;
      const activeRangeHeight = rowBottom - top;
      if (
        activeRangeHeight <=
        listHeight - activeLineTopOffset - ACTIVE_RANGE_BOTTOM_PADDING
      ) {
        return Math.abs(top + shift - scroll - activeLineTopOffset);
      }
      return Math.abs(
        rowBottom + shift - scroll - (listHeight - ACTIVE_RANGE_BOTTOM_PADDING),
      );
    },
    [
      activeLineTopOffset,
      estimatedRowHeight,
      getRowTop,
      lyrics.length,
    ],
  );

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

  // AMLL's decaying per-row delay: rows at/after the first visible row accrue
  // 50ms each, decaying past the focus row. Rows above the viewport glide
  // with no delay. Only rendered (windowed) rows need entries.
  const buildStaggerDelays = useCallback(
    (firstVisible: number, focus: number, rendered: number[]) => {
      const delays = new Array<number>(rowCount).fill(0);
      let delay = 0;
      let step = 50;
      const ordered = [...rendered].sort((a, b) => a - b);
      for (const index of ordered) {
        if (index < firstVisible) {
          delays[index] = 0;
          continue;
        }
        delays[index] = delay;
        delay += step;
        if (index >= focus) {
          step /= 1.05;
        }
      }
      return delays;
    },
    [rowCount],
  );

  // ---- AMLL follow engine ---------------------------------------------------
  // Windowed rendering: only rows near the viewport (or the follow target)
  // mount. Unmounted rows release their native views, gradients and mask
  // bitmaps instead of sitting in a recycle pool.
  const [window, setWindow] = useState({ start: 0, end: 0 });
  const windowRef = useRef(window);
  const lastFocusRef = useRef(-1);

  const updateWindow = useCallback(
    (scrollY: number, targetIndex: number) => {
      const listHeight = listHeightRef.current;
      if (!listHeight || rowCount === 0) {
        return;
      }
      // AMLL's isInRenderRange tests the CURRENT (visual) position: layout
      // tops shifted by the commanded glide target, plus overscan and a 40%
      // motion buffer so rows gliding through stay mounted mid-motion.
      const shift = shiftMirrorRef.current;
      const motionBuffer = listHeight * 0.4;
      const lo = scrollY - shift - ROW_OVERSCAN_PX - motionBuffer;
      const hi = scrollY - shift + listHeight + ROW_OVERSCAN_PX + motionBuffer;
      let start = 0;
      while (
        start < rowCount - 1 &&
        getRowTop(start + 1) < lo
      ) {
        start += 1;
      }
      let end = start;
      while (end < rowCount && getRowTop(end) <= hi) {
        end += 1;
      }
      start = Math.max(0, Math.min(start, targetIndex - 4));
      end = Math.min(rowCount, Math.max(end, targetIndex + 5));
      if (end <= start) {
        end = Math.min(rowCount, start + 1);
      }
      const prev = windowRef.current;
      if (prev.start !== start || prev.end !== end) {
        windowRef.current = { start, end };
        setWindow({ start, end });
      }
    },
    [getRowTop, rowCount],
  );

  // Drive one follow update. Snaps move the native scroll position instantly
  // with zero shift; glides keep the scroll position fixed and animate the
  // shared shift target that every visible row springs toward on the UI
  // thread (AMLL core's per-line posY springs).
  const commandFollow = useCallback(
    (
      range: LyricLineRange,
      {
        snap = false,
        preview = false,
        seeking = false,
      }: { snap?: boolean; preview?: boolean; seeking?: boolean } = {},
    ) => {
      if (!rendererActiveRef.current || !listReady || lyrics.length === 0) {
        return;
      }
      const trueOffset = getTrueOffsetForRange(range);
      if (trueOffset === null) {
        return;
      }
      const focus =
        preview && previewFocusIndex >= 0
          ? previewFocusIndex
          : effectiveWindowStateRef.current.focusLineIndex;
      const safeFocus = focus >= 0 ? focus : range.startIndex;
      if (!snap && previewPlaybackPosition === null) {
        const anchorError = getAnchorErrorForRange(range);
        if (anchorError !== null && anchorError <= ACTIVE_LINE_ALIGNMENT_EPSILON) {
          if (initialAutoScrollPendingRef.current && autoFollowEnabled) {
            markInitialAutoScrollSettled();
          }
          return;
        }
      }
      const previous = safeFocus > 0 ? lyrics[safeFocus - 1] : undefined;
      const current = lyrics[safeFocus];
      const interval =
        previous && current
          ? current.lineStartTime - previous.lineStartTime
          : undefined;
      const jumpSeeking =
        seeking ||
        preview ||
        Math.abs(safeFocus - lastFocusRef.current) > 1;
      const spring = amlPositionSpring(
        interval,
        jumpSeeking,
        effectiveWindowStateRef.current.isLongPause,
      );
      lastFocusRef.current = safeFocus;
      if (snap) {
        scrollRef.current?.scrollTo({ y: trueOffset, animated: false });
        scrollOffsetRef.current = trueOffset;
        shiftMirrorRef.current = 0;
        shiftFrozen.value = false;
        shiftCommand.value = {
          shift: 0,
          revision: shiftCommand.value.revision + 1,
          snap: true,
          delays: [],
          spring,
        };
        updateWindow(trueOffset, safeFocus);
      } else {
        const shift = scrollOffsetRef.current - trueOffset;
        const win = windowRef.current;
        const rendered: number[] = [];
        for (
          let i = Math.max(0, win.start);
          i < Math.min(rowCount, win.end);
          i += 1
        ) {
          rendered.push(i);
        }
        if (safeFocus >= 0 && safeFocus < rowCount && !rendered.includes(safeFocus)) {
          rendered.push(safeFocus);
        }
        const firstVisible = (() => {
          const scroll = scrollOffsetRef.current;
          for (const index of [...rendered].sort((a, b) => a - b)) {
            if (getRowTop(index) + shift - scroll >= 0) {
              return index;
            }
          }
          return rendered.length ? Math.min(...rendered) : safeFocus;
        })();
        shiftMirrorRef.current = shift;
        shiftFrozen.value = false;
        shiftCommand.value = {
          shift,
          revision: shiftCommand.value.revision + 1,
          snap: false,
          delays: buildStaggerDelays(firstVisible, safeFocus, rendered),
          spring,
        };
        updateWindow(scrollOffsetRef.current, safeFocus);
      }
      lastCommandedPositionRef.current = playbackPositionRef.current;
      if (initialAutoScrollPendingRef.current && autoFollowEnabled) {
        markInitialAutoScrollSettled();
      }
    },
    [
      autoFollowEnabled,
      buildStaggerDelays,
      effectiveWindowStateRef,
      getAnchorErrorForRange,
      getRowTop,
      getTrueOffsetForRange,
      listReady,
      lyrics,
      markInitialAutoScrollSettled,
      previewFocusIndex,
      previewPlaybackPosition,
      rowCount,
      shiftCommand,
      shiftFrozen,
      updateWindow,
    ],
  );
  // During a user drag, follow ownership is decided from drag distance alone
  // (robust without reading live spring values): dragging farther than the
  // disable threshold from the grab point releases follow; scrolling back
  // within the resume threshold of the commanded anchor re-engages it.
  const getResumeAnchorOffset = useCallback(() => {
    const range = scrollTargetRangeRef.current;
    const listHeight = listHeightRef.current;
    if (!range || lyrics.length === 0 || !listHeight) {
      return null;
    }
    const startIndex = Math.max(0, Math.min(range.startIndex, lyrics.length - 1));
    const endIndex = Math.max(startIndex, Math.min(range.endIndex, lyrics.length - 1));
    const top = getRowTop(startIndex);
    const bottom = getRowTop(endIndex) + estimatedRowHeight(endIndex);
    const shift = shiftMirrorRef.current;
    if (
      bottom - top <=
      listHeight - activeLineTopOffset - ACTIVE_RANGE_BOTTOM_PADDING
    ) {
      return top + shift - activeLineTopOffset;
    }
    return bottom + shift - (listHeight - ACTIVE_RANGE_BOTTOM_PADDING);
  }, [activeLineTopOffset, estimatedRowHeight, getRowTop, lyrics.length]);

  const noteUserScrollDistance = useCallback(() => {
    const currentScrollTarget = scrollTargetRangeRef.current;
    if (
      !currentScrollTarget ||
      previewPlaybackPosition !== null ||
      startupDotsWarmupActive ||
      isSourceAutoScrollCooldown ||
      (!userScrollSessionRef.current && !userScrollInProgressRef.current)
    ) {
      return;
    }
    const dragged = Math.abs(scrollOffsetRef.current - dragStartOffsetRef.current);
    if (autoFollowEnabled) {
      if (Date.now() < autoFollowDisableGraceUntilRef.current) {
        return;
      }
      if (dragged > AUTO_FOLLOW_DISABLE_DISTANCE_PX) {
        onAutoFollowChangeRef.current?.(false);
      }
      return;
    }
    const resumeAnchor = getResumeAnchorOffset();
    if (resumeAnchor === null) {
      return;
    }
    if (Math.abs(scrollOffsetRef.current - resumeAnchor) <= AUTO_FOLLOW_RESUME_DISTANCE_PX) {
      onAutoFollowChangeRef.current?.(true);
    }
  }, [autoFollowEnabled, getResumeAnchorOffset, isSourceAutoScrollCooldown, previewPlaybackPosition, startupDotsWarmupActive]);

  // Follow driver: the single place that commands motion. Position jumps
  // (mount, seeks, source changes, resume) snap the native scroll position;
  // line advances glide the row springs. The commanded-position check keeps
  // snaps for real jumps only, so steady playback never restarts motion.
  const followRange = useCallback(
    (range: LyricLineRange, positionMs: number) => {
      if (!rendererActiveRef.current || !listReady || lyrics.length === 0) {
        return;
      }
      const lastCommanded = lastCommandedPositionRef.current;
      const seeking =
        lastCommanded === null ||
        Math.abs(positionMs - lastCommanded) > SEEK_JUMP_MS;
      commandFollow(range, {
        snap: seeking || initialAutoScrollPendingRef.current,
        preview: previewPlaybackPosition !== null,
        seeking,
      });
    },
    [
      commandFollow,
      listReady,
      lyrics.length,
      previewPlaybackPosition,
    ],
  );

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
      commandFollow(scrollTargetRange, { preview: true });
      return;
    }
    if (autoFollowActive) {
      followRange(scrollTargetRange, playbackPositionRef.current);
    } else if (initialAutoScrollPendingRef.current) {
      markInitialAutoScrollSettled();
    }
  }, [
    autoFollowActive,
    autoFollowEnabled,
    commandFollow,
    creditsActive,
    followRange,
    isSourceAutoScrollCooldown,
    listReady,
    markInitialAutoScrollSettled,
    previewPlaybackPosition,
    rendererActive,
    scrollTargetRange,
    startupDotsWarmupActive,
    suspendViewportScrollAdjustments,
    viewportHeight,
    layoutSettleSignal,
    contentLayoutVersion,
  ]);


  // ponytail: track whether all cells are measured so we can skip onLayout entirely
  const [allCellsMeasured, setAllCellsMeasured] = useState(false);
  // Background vocals collapse to zero height while inactive, so row heights
  // change whenever the visual range moves. Re-arm onLayout then so the new
  // heights refresh the caches; rows whose height didn't change no-op in the
  // handler, and the flag re-engages once everything is remeasured.
  const visualRangeKey = `${effectiveWindowState.visualActiveLineStartIndex}:${effectiveWindowState.visualActiveLineEndIndex}:${effectiveWindowState.focusLineIndex}`;
  useEffect(() => {
    setAllCellsMeasured(false);
  }, [visualRangeKey]);
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
      bumpContentLayoutVersion();
      // Once every line has been measured, disable onLayout to stop bridge chatter
      if (rowHeights.size >= rowCount && !allCellsMeasured) {
        setAllCellsMeasured(true);
      }
    },
    [allCellsMeasured, bumpContentLayoutVersion, rowCount],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = Math.max(0, event.nativeEvent.contentOffset.y);
      scrollOffsetRef.current = offset;
      updateWindow(offset, scrollTargetRangeRef.current?.startIndex ?? 0);
      if (
        !userScrollSessionRef.current &&
        !userScrollInProgressRef.current
      ) {
        return;
      }
      scheduleUserScrollIdleReset();
      noteUserScrollDistance();
    },
    [noteUserScrollDistance, scheduleUserScrollIdleReset, updateWindow],
  );

  const handleScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // A real drag freezes the row springs on the UI thread and hands the
      // scroll position to the finger. Distances are measured from the grab
      // point, so no live spring values are needed on the JS thread.
      const offset = Math.max(0, event.nativeEvent.contentOffset.y);
      scrollOffsetRef.current = offset;
      dragStartOffsetRef.current = offset;
      shiftFrozen.value = true;
      onUserInteraction?.();
      setIsUserTouchScrolling(true);
      userScrollInProgressRef.current = true;
      userDragInProgressRef.current = true;
      userScrollSessionRef.current = true;
      scheduleUserScrollIdleReset();
      updateWindow(offset, scrollTargetRangeRef.current?.startIndex ?? 0);
    },
    [
      onUserInteraction,
      scheduleUserScrollIdleReset,
      shiftFrozen,
      updateWindow,
    ],
  );

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = Math.max(0, event.nativeEvent.contentOffset.y);
      scrollOffsetRef.current = offset;
      userDragInProgressRef.current = false;
      userScrollInProgressRef.current = false;
      scheduleUserScrollIdleReset();
      updateWindow(offset, scrollTargetRangeRef.current?.startIndex ?? 0);
      noteUserScrollDistance();
      if (autoFollowEnabled) {
        // Still following: release was a nudge, so glide back to the anchor
        // instead of sitting frozen off-target until the next line change.
        const range = scrollTargetRangeRef.current;
        if (range) {
          commandFollow(range, {});
        }
        return;
      }
      // Released near the commanded anchor: resume gliding instead of
      // sitting frozen off-target.
      const resumeAnchor = getResumeAnchorOffset();
      if (
        resumeAnchor !== null &&
        Math.abs(offset - resumeAnchor) <= AUTO_FOLLOW_RESUME_DISTANCE_PX
      ) {
        onAutoFollowChangeRef.current?.(true);
      }
    },
    [
      autoFollowEnabled,
      commandFollow,
      getResumeAnchorOffset,
      noteUserScrollDistance,
      scheduleUserScrollIdleReset,
      updateWindow,
    ],
  );

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = Math.max(0, event.nativeEvent.contentOffset.y);
      scrollOffsetRef.current = offset;
      userDragInProgressRef.current = false;
      setIsUserTouchScrolling(false);
      clearUserScrollIdleTimer();
      userScrollInProgressRef.current = false;
      userScrollSessionRef.current = false;
      updateWindow(offset, scrollTargetRangeRef.current?.startIndex ?? 0);
      if (autoFollowEnabled) {
        const range = scrollTargetRangeRef.current;
        if (range) {
          commandFollow(range, {});
        }
        return;
      }
      const resumeAnchor = getResumeAnchorOffset();
      if (
        resumeAnchor !== null &&
        Math.abs(offset - resumeAnchor) <= AUTO_FOLLOW_RESUME_DISTANCE_PX
      ) {
        onAutoFollowChangeRef.current?.(true);
      }
    },
    [autoFollowEnabled, clearUserScrollIdleTimer, commandFollow, getResumeAnchorOffset, updateWindow],
  );


  useLayoutEffect(() => {
    activeLineRef.current = -1;
    scrollOffsetRef.current = 0;
    shiftMirrorRef.current = 0;
    lastCommandedPositionRef.current = null;
    lastFocusRef.current = -1;
    userScrollInProgressRef.current = false;
    userDragInProgressRef.current = false;
    userScrollSessionRef.current = false;
    autoFollowDisableGraceUntilRef.current =
      Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS;
    onAutoFollowChangeRef.current?.(true);
    setAllCellsMeasured(false);
    rowHeightsRef.current.clear();
    windowRef.current = { start: 0, end: 0 };
    setWindow({ start: 0, end: 0 });
    shiftFrozen.value = false;
    shiftCommand.value = {
      shift: 0,
      revision: shiftCommand.value.revision + 1,
      snap: true,
      delays: [],
      spring: AMLL_POSITION_SPRING,
    };
    setContentLayoutVersion(0);
  }, [lyrics, shiftCommand, shiftFrozen]);

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
      clearUserScrollIdleTimer();
      if (layoutBumpFrameRef.current !== null) {
        cancelAnimationFrame(layoutBumpFrameRef.current);
        layoutBumpFrameRef.current = null;
      }
    },
    [clearUserScrollIdleTimer],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;
      setAppIsActive(nextState === "active");
      if (nextState !== "active" || previousState === "active") {
        return;
      }

      userScrollInProgressRef.current = false;
      userDragInProgressRef.current = false;
      userScrollSessionRef.current = false;
      autoFollowDisableGraceUntilRef.current =
        Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS;
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (rendererActive) {
      autoFollowDisableGraceUntilRef.current =
        Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS;
      return;
    }

    // While the renderer is hidden, freeze row motion and touch state. The
    // rows stay mounted so reactivation is instant; springs simply stop
    // retargeting until the follow driver commands again.
    shiftFrozen.value = true;
    userScrollInProgressRef.current = false;
    userDragInProgressRef.current = false;
    userScrollSessionRef.current = false;
    clearUserScrollIdleTimer();
    setIsUserTouchScrolling(false);
  }, [rendererActive, clearUserScrollIdleTimer, shiftFrozen]);

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
    onAutoFollowChange?.(true);
    if (isSourceAutoScrollCooldown || !scrollTargetRange) {
      return;
    }
    commandFollow(scrollTargetRange, {});
  }, [
    autoFollowEnabled,
    commandFollow,
    isSourceAutoScrollCooldown,
    listReady,
    onAutoFollowChange,
    rendererActive,
    resumeAutoFollowSignal,
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

  // Rows read the live window state directly; LyricLine's memo props bail out
  // for unchanged rows, so boundary updates only re-render what changed.
  const renderLyricRow = (item: LyricLineType, index: number) => {
    const ws = effectiveWindowState;
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
      <View
        style={landscapeMode ? styles.flashListCellLandscape : undefined}
        onLayout={
          allCellsMeasured
            ? undefined
            : (event) => handleCellLayout(index, event)
        }
      >
        <RowShift index={index} command={shiftCommand} frozen={shiftFrozen}>
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
        </RowShift>
      </View>
    );
  };

  const listInsets = useMemo(() => {
    void contentLayoutVersion;
    const lastLineIndex = Math.max(0, lyrics.length - 1);
    const lastLineTop = getRowTop(lastLineIndex);
    const lastLineHeight = estimatedRowHeight(lastLineIndex);
    const creditsLayout: CreditsLayout | null = hasCredits
      ? {
          top: getRowTop(lyrics.length),
          bottom:
            getRowTop(lyrics.length) + estimatedRowHeight(lyrics.length),
        }
      : null;
    return {
      // The top inset lives in the top spacer (so windowing accounts for it);
      // only the bottom inset pads the container.
      paddingTop: 0,
      // Bottom inset is sized so max scroll stops once the last line (and credits)
      // reach their anchor positions, without extra empty scroll room.
      paddingBottom: getBottomListPadding({
        viewportHeight,
        lyricsLength: lyrics.length,
        lastLineTop,
        lastLineHeight,
        creditsLayout,
        hasCredits,
        activeLineTopOffset,
      }),
    };
  }, [
    activeLineTopOffset,
    contentLayoutVersion,
    estimatedRowHeight,
    getRowTop,
    lyrics.length,
    hasCredits,
    viewportHeight,
  ]);

  const renderCreditsRow = () => (
    <View
      onLayout={
        allCellsMeasured
          ? undefined
          : (event) => handleCellLayout(lyrics.length, event)
      }
    >
      <RowShift index={lyrics.length} command={shiftCommand} frozen={shiftFrozen}>
        <CreditsFooter
          rendererActive={rendererActive}
          songwriters={songwriters}
          attribution={attribution}
          lastLyricEndTime={lastLyricEndTime}
          onPress={onCreditsTimestampPress}
        />
      </RowShift>
    </View>
  );

  // Windowed rows: spacers preserve the scroll extent while unmounted rows
  // release their native views, gradients and mask bitmaps.
  const topSpacerHeight = Math.max(0, getRowTop(window.start));
  const bottomSpacerHeight = Math.max(
    0,
    getContentHeight() - getRowTop(Math.min(window.end, rowCount)),
  );
  const renderedRowIndices = useMemo(() => {
    const indices: number[] = [];
    for (
      let i = Math.max(0, window.start);
      i < Math.min(window.end, rowCount);
      i += 1
    ) {
      indices.push(i);
    }
    return indices;
  }, [rowCount, window.end, window.start]);

  // Memory gate: when the renderer is hidden (other tab, background), drop
  // the heavy row tree entirely instead of idling hundreds of masked views
  // and gradients. Remount snaps back to the live position on return.
  if (!rendererActive) {
    return <View style={styles.container} />;
  }

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
    // Static lyrics render every row in a plain ScrollView (no follow engine).
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
        <ScrollView
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
        >
          {lyrics.map((line) => (
            <View
              key={`${line.lineStartTime}-${line.lineEndTime}`}
            >
              {staticRenderItem({ item: line })}
            </View>
          ))}
          {staticFooter}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.container, landscapeMode && styles.containerLandscape]}>
      <ScrollView
        ref={scrollRef}
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
        scrollEventThrottle={100}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollBegin={() => {
          if (!userScrollSessionRef.current) {
            return;
          }
          onUserInteraction?.();
          setIsUserTouchScrolling(true);
          userScrollInProgressRef.current = true;
          scheduleUserScrollIdleReset();
        }}
        onMomentumScrollEnd={handleMomentumScrollEnd}
      >
        {topSpacerHeight > 0 ? (
          <View style={{ height: topSpacerHeight }} />
        ) : null}
        {renderedRowIndices.map((index) =>
          index < lyrics.length ? (
            <View
              key={`${index}-${lyrics[index].lineStartTime}-${lyrics[index].lineEndTime}`}
            >
              {renderLyricRow(lyrics[index], index)}
            </View>
          ) : hasCredits ? (
            <View key="credits">{renderCreditsRow()}</View>
          ) : null,
        )}
        {bottomSpacerHeight > 0 ? (
          <View style={{ height: bottomSpacerHeight }} />
        ) : null}
      </ScrollView>
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
