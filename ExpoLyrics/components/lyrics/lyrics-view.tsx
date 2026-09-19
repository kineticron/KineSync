import {
  type LyricLineRange,
  type BackgroundActiveLine,
  type LyricTimingIndex,
  EMPTY_WINDOW_STATE,
  LYRICS_LAYOUT,
  arePlaybackWindowStatesEqual,
  getBackgroundActiveLines,
  getLyricTimingIndex,
  getPlaybackWindowState,
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
  useAnimatedStyle,
  useSharedValue,
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

import { amlBlur } from "@/lib/amll-native";
import { LyricLine } from "./lyric-line";

const SOURCE_CHANGE_AUTOSCROLL_DELAY_MS = 500;

const STATIC_LYRIC_FONT_SIZE = 26;
const STATIC_LYRIC_LINE_HEIGHT = 38;
const STATIC_LYRIC_HORIZONTAL_INSET = 28;
const STATIC_LYRIC_MAX_WIDTH = 300;
const STATIC_TRANSLATED_FONT_SIZE = 18;
const STATIC_TRANSLATED_LINE_HEIGHT = 26;

const SEEK_JUMP_MS = 1000;
// Anchor expressed as a FlashList viewPosition (fraction of the viewport).
const ACTIVE_LINE_VIEW_POSITION = 0.08;
const ESTIMATED_ROW_HEIGHT = 90;

const AUTO_FOLLOW_DISABLE_GRACE_MS = 2000;
const AUTO_FOLLOW_DISABLE_DISTANCE_PX = 120;
const AUTO_FOLLOW_RESUME_DISTANCE_PX = 64;
const USER_SCROLL_IDLE_RESET_MS = 700;


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
  const listRef = useRef<FlashListRef<LyricLineType> | null>(null);
  // Standard virtualized-list scrolling: FlashList owns layout,
  // recycling and gestures. Auto-follow drives it with native animated
  // scrolls only, so the JS and UI threads do no per-frame scroll work.
  const activeLineRef = useRef(-1);
  const onAutoFollowChangeRef = useRef(onAutoFollowChange);
  const listHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  // Last resting offset of the list (programmatic glides excluded): the
  // reference point for follow disable/resume distances.
  const settledOffsetRef = useRef(0);
  const lastCommandAtRef = useRef(0);
  const rowHeightsRef = useRef(new Map<number, number>());
  const userScrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastUserScrollAtRef = useRef(0);
  const userScrollInProgressRef = useRef(false);
  const userDragInProgressRef = useRef(false);
  const userScrollSessionRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const rendererActiveRef = useRef(rendererActive);
  rendererActiveRef.current = rendererActive;
  const autoFollowDisableGraceUntilRef = useRef(
    Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS,
  );
  const lastResumeAutoFollowSignalRef = useRef(0);
  const lastCommandedPositionRef = useRef<number | null>(null);
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
  const activeLineTopOffset = viewportHeight * ACTIVE_LINE_VIEW_POSITION;
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
  // Row geometry is only ever an estimate here (real layout belongs to
  // FlashList): it feeds the bottom padding and the scrollToIndex fallback.
  // Positioning itself always goes through scrollToIndex, which uses the
  // list's own measured layout.
  const estimatedRowHeight = useCallback(
    (index: number) =>
      rowHeightsRef.current.get(index) ?? ESTIMATED_ROW_HEIGHT,
    [],
  );
  const getEstimatedOffset = useCallback(
    (index: number) => {
      const safeIndex = Math.max(0, Math.min(index, lyrics.length - 1));
      let top = topListPadding;
      for (let i = 0; i < safeIndex; i += 1) {
        top += estimatedRowHeight(i);
      }
      return Math.max(0, top - activeLineTopOffset);
    },
    [activeLineTopOffset, estimatedRowHeight, lyrics.length, topListPadding],
  );

  // The single place that commands motion. Everything runs natively inside
  // the list (Core Animation scroll); JS only picks the target row.
  const doAutoScroll = useCallback(
    (range: LyricLineRange, animated: boolean) => {
      const list = listRef.current;
      if (!rendererActiveRef.current || !listReady || lyrics.length === 0 || !list) {
        return;
      }
      const index = Math.max(
        0,
        Math.min(range.startIndex, lyrics.length - 1),
      );
      const commandedAt = Date.now();
      lastCommandAtRef.current = commandedAt;
      list
        .scrollToIndex({
          index,
          animated,
          viewPosition: ACTIVE_LINE_VIEW_POSITION,
        })
        .catch(() => {
          listRef.current?.scrollToOffset({
            offset: getEstimatedOffset(index),
            animated: false,
          });
        });
      // Native animated scrolls emit no completion callback; once the glide
      // has landed, adopt the resting offset (unless the user grabbed the
      // list meanwhile) so follow distances compare against reality.
      setTimeout(() => {
        if (
          lastCommandAtRef.current === commandedAt &&
          !userScrollSessionRef.current &&
          !userScrollInProgressRef.current
        ) {
          settledOffsetRef.current = scrollOffsetRef.current;
        }
      }, 800);
      if (initialAutoScrollPendingRef.current && autoFollowEnabled) {
        markInitialAutoScrollSettled();
      }
    },
    [
      autoFollowEnabled,
      getEstimatedOffset,
      listReady,
      lyrics.length,
      markInitialAutoScrollSettled,
    ],
  );

  // Position jumps (mount, seeks, source changes, resume) snap; line
  // advances glide natively. Steady playback never restarts motion because
  // the driver effect below only commands when the target range changes.
  const followRange = useCallback(
    (range: LyricLineRange, positionMs: number) => {
      const lastCommanded = lastCommandedPositionRef.current;
      const seeking =
        lastCommanded === null ||
        Math.abs(positionMs - lastCommanded) > SEEK_JUMP_MS;
      lastCommandedPositionRef.current = positionMs;
      doAutoScroll(range, !seeking && !initialAutoScrollPendingRef.current);
    },
    [doAutoScroll],
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
      doAutoScroll(scrollTargetRange, true);
      return;
    }
    if (autoFollowActive) {
      followRange(scrollTargetRange, playbackPositionRef.current);
    } else if (initialAutoScrollPendingRef.current) {
      markInitialAutoScrollSettled();
    }
  }, [
    autoFollowActive,
    creditsActive,
    doAutoScroll,
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


  // Row heights feed the bottom padding and the scrollToIndex fallback, so
  // onLayout stays attached: it only fires on real changes, and unchanged
  // rows no-op below. Measurement never commands motion.
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
    },
    [bumpContentLayoutVersion],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = Math.max(0, event.nativeEvent.contentOffset.y);
      scrollOffsetRef.current = offset;
      // Track the resting offset outside user sessions and recent commands so
      // follow distances compare against where the list actually sits.
      if (
        !userScrollSessionRef.current &&
        !userScrollInProgressRef.current &&
        Date.now() - lastCommandAtRef.current > 800
      ) {
        settledOffsetRef.current = offset;
      }
      if (
        !userScrollSessionRef.current &&
        !userScrollInProgressRef.current
      ) {
        return;
      }
      scheduleUserScrollIdleReset();
      const settled = settledOffsetRef.current;
      if (previewPlaybackPosition !== null || startupDotsWarmupActive || isSourceAutoScrollCooldown) {
        return;
      }
      const distance = Math.abs(offset - settled);
      if (autoFollowEnabled) {
        if (Date.now() < autoFollowDisableGraceUntilRef.current) {
          return;
        }
        if (distance > AUTO_FOLLOW_DISABLE_DISTANCE_PX) {
          onAutoFollowChangeRef.current?.(false);
        }
        return;
      }
      if (distance <= AUTO_FOLLOW_RESUME_DISTANCE_PX) {
        onAutoFollowChangeRef.current?.(true);
      }
    },
    [
      autoFollowEnabled,
      isSourceAutoScrollCooldown,
      previewPlaybackPosition,
      scheduleUserScrollIdleReset,
      startupDotsWarmupActive,
    ],
  );

  const handleScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = Math.max(0, event.nativeEvent.contentOffset.y);
      scrollOffsetRef.current = offset;
      onUserInteraction?.();
      setIsUserTouchScrolling(true);
      userScrollInProgressRef.current = true;
      userDragInProgressRef.current = true;
      userScrollSessionRef.current = true;
      scheduleUserScrollIdleReset();
    },
    [onUserInteraction, scheduleUserScrollIdleReset],
  );

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = Math.max(0, event.nativeEvent.contentOffset.y);
      scrollOffsetRef.current = offset;
      userDragInProgressRef.current = false;
      userScrollInProgressRef.current = false;
      scheduleUserScrollIdleReset();
    },
    [scheduleUserScrollIdleReset],
  );

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = Math.max(0, event.nativeEvent.contentOffset.y);
      scrollOffsetRef.current = offset;
      settledOffsetRef.current = offset;
      userDragInProgressRef.current = false;
      setIsUserTouchScrolling(false);
      clearUserScrollIdleTimer();
      userScrollInProgressRef.current = false;
      userScrollSessionRef.current = false;
    },
    [clearUserScrollIdleTimer],
  );


  useLayoutEffect(() => {
    activeLineRef.current = -1;
    scrollOffsetRef.current = 0;
    settledOffsetRef.current = 0;
    lastCommandedPositionRef.current = null;
    userScrollInProgressRef.current = false;
    userDragInProgressRef.current = false;
    userScrollSessionRef.current = false;
    autoFollowDisableGraceUntilRef.current =
      Date.now() + AUTO_FOLLOW_DISABLE_GRACE_MS;
    onAutoFollowChangeRef.current?.(true);
    rowHeightsRef.current.clear();
    setContentLayoutVersion(0);
  }, [lyrics]);

  // Reset measurement state when layout-affecting props change
  useEffect(() => {
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

    // While the renderer is hidden, reset touch state; the memory gate below
    // unmounts the row tree, so motion simply restarts on return.
    userScrollInProgressRef.current = false;
    userDragInProgressRef.current = false;
    userScrollSessionRef.current = false;
    clearUserScrollIdleTimer();
    setIsUserTouchScrolling(false);
  }, [rendererActive, clearUserScrollIdleTimer]);

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
    followRange(scrollTargetRange, playbackPositionRef.current);
  }, [
    autoFollowEnabled,
    followRange,
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

  const listInsets = useMemo(() => {
    void contentLayoutVersion;
    const lastHeight =
      rowHeightsRef.current.get(Math.max(0, lyrics.length - 1)) ??
      ESTIMATED_ROW_HEIGHT;
    return {
      paddingTop: topListPadding,
      // Enough room below so the last line (and credits) can reach the
      // anchor; measured from the last known row height.
      paddingBottom: Math.max(
        ACTIVE_RANGE_BOTTOM_PADDING,
        viewportHeight - activeLineTopOffset - lastHeight,
      ),
    };
  }, [
    activeLineTopOffset,
    contentLayoutVersion,
    lyrics.length,
    topListPadding,
    viewportHeight,
  ]);

  const renderCreditsRow = () => (
    <View onLayout={(event) => handleCellLayout(lyrics.length, event)}>
      <CreditsFooter
        rendererActive={rendererActive}
        songwriters={songwriters}
        attribution={attribution}
        lastLyricEndTime={lastLyricEndTime}
        onPress={onCreditsTimestampPress}
      />
    </View>
  );

  const flashListRenderItem = useCallback(
    ({ item, index }: { item: LyricLineType; index: number }) => {
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
          onLayout={(event) => handleCellLayout(index, event)}
        >
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
        </View>
      );
    },
    [
      fontScale,
      landscapeMode,
      hasDuetLines,
      onLineLongPress,
      onLinePress,
      selectedLineKeys,
      isUserTouchScrolling,
      showTranslatedText,
      tapToSeekEnabled,
      previewPlaybackPosition,
      rendererActive,
      effectiveWindowState,
      handleCellLayout,
    ],
  );

  const keyExtractor = useCallback(
    (item: LyricLineType, index: number) =>
      `${index}-${item.lineStartTime}-${item.lineEndTime}`,
    [],
  );

  const listFooter = useMemo(() => {
    if (!hasCredits) {
      return null;
    }
    return renderCreditsRow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    attribution,
    handleCellLayout,
    hasCredits,
    lastLyricEndTime,
    onCreditsTimestampPress,
    rendererActive,
    songwriters,
  ]);

  // Coarse fingerprint: only changes when cell rendering actually differs,
  // so recycled rows re-render on line changes but not on clock ticks.
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
      <FlashList
        ref={listRef}
        data={lyrics}
        renderItem={flashListRenderItem}
        keyExtractor={keyExtractor}
        extraData={extraDataFingerprint}
        drawDistance={400}
        ListFooterComponent={listFooter}
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
