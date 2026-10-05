import { usePlaybackStore } from '@/store/playback-store';
import Ionicons from '@react-native-vector-icons/ionicons';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Pressable, StyleSheet, View, TextInput } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  useAnimatedProps,
  useDerivedValue,
  withSpring,
  withSequence,
  type SharedValue,
  useReducedMotion,
} from 'react-native-reanimated';
import { selectionAsync } from 'expo-haptics';

import { usePlaybackTimelineClock, type PreviewPlaybackAnchor } from './use-playback-timeline-clock';
import type { PlayerTourStep } from '@/store/player-tour-store';
import type { PlaybackMode } from '@/lib/playback-source';

const ReanimatedTextInput = Reanimated.createAnimatedComponent(TextInput);

function formatTime(ms: number) {
  "worklet";
  const safe = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(safe / 60);
  const sec = String(safe % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function formatRemainingTime(positionMs: number, durationMs: number) {
  "worklet";
  const remaining = Math.max(0, durationMs - positionMs);
  return `-${formatTime(remaining)}`;
}

const SCRUB_DISPLAY_INTERVAL_MS = 80;
const SCRUB_LYRIC_PREVIEW_INTERVAL_MS = 220;
const INTERACTION_KEEP_ALIVE_MS = 1000;
const UTILITY_ROW_HEIGHT = 44;

export type PlaybackControlsLayout =
  | 'default'
  | 'overlay'
  | 'landscape-utilities';

type PlaybackControlsProps = {
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

type TransportButtonProps = {
  accessibilityLabel: string;
  onPress: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  onUserInteraction?: () => void;
  direction?: 'backward' | 'forward' | 'none';
  children: ReactNode;
  style?: object;
};

function TransportButton({
  accessibilityLabel,
  onPress,
  onLongPress,
  delayLongPress = 280,
  onUserInteraction,
  direction = 'none',
  children,
  style,
}: TransportButtonProps) {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const slide = useSharedValue(0);
  const pressHaloOpacity = useSharedValue(0);
  const longPressTriggeredRef = useRef(false);
  const interactionKeepAliveTimerRef = useRef<ReturnType<
    typeof setInterval
  > | null>(null);

  const stopInteractionKeepAlive = useCallback(() => {
    if (interactionKeepAliveTimerRef.current) {
      clearInterval(interactionKeepAliveTimerRef.current);
      interactionKeepAliveTimerRef.current = null;
    }
  }, []);

  const startInteractionKeepAlive = useCallback(() => {
    stopInteractionKeepAlive();
    interactionKeepAliveTimerRef.current = setInterval(() => {
      onUserInteraction?.();
    }, INTERACTION_KEEP_ALIVE_MS);
  }, [onUserInteraction, stopInteractionKeepAlive]);

  const animateScale = useCallback(
    (toValue: number) => {
      scale.value = withSpring(toValue, {
        stiffness: 260,
        damping: 20,
      });
    },
    [scale],
  );

  const handlePress = useCallback(() => {
    onUserInteraction?.();
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    void selectionAsync().catch(() => {});
    if (direction !== 'none' && !reduceMotion) {
      const delta = direction === 'forward' ? 8 : -8;
      slide.value = withSequence(
        withTiming(delta, {
          duration: 110,
          easing: Easing.out(Easing.quad),
        }),
        withTiming(0, {
          duration: 150,
          easing: Easing.out(Easing.cubic),
        })
      );
    }
    onPress();
  }, [direction, onPress, onUserInteraction, reduceMotion, slide]);

  const handleLongPress = useCallback(() => {
    if (!onLongPress) {
      return;
    }
    longPressTriggeredRef.current = true;
    onUserInteraction?.();
    onLongPress();
  }, [onLongPress, onUserInteraction]);

  useEffect(
    () => () => {
      stopInteractionKeepAlive();
    },
    [stopInteractionKeepAlive],
  );

  const animatePressHalo = useCallback(
    (toValue: number) => {
      pressHaloOpacity.value = withTiming(toValue, {
        duration: toValue > 0 ? 120 : 180,
        easing: Easing.out(Easing.cubic),
      });
    },
    [pressHaloOpacity],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }, { translateX: slide.value }],
  }));

  const haloStyle = useAnimatedStyle(() => ({
    opacity: pressHaloOpacity.value,
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={handlePress}
      onLongPress={onLongPress ? handleLongPress : undefined}
      delayLongPress={delayLongPress}
      onPressIn={() => {
        onUserInteraction?.();
        startInteractionKeepAlive();
        animatePressHalo(1);
        animateScale(reduceMotion ? 1 : 0.92);
      }}
      onPressOut={() => {
        onUserInteraction?.();
        stopInteractionKeepAlive();
        animatePressHalo(0);
        animateScale(1);
      }}
      hitSlop={10}>
      <Reanimated.View
        style={[
          styles.transportButton,
          style,
          animatedStyle,
        ]}>
        <Reanimated.View
          pointerEvents="none"
          style={[styles.transportButtonHalo, haloStyle]}
        />
        {children}
      </Reanimated.View>
    </Pressable>
  );
}

export const PlaybackControls = memo(function PlaybackControls({
  isPlaying,
  durationMs,
  shareSelectionCount: _shareSelectionCount,
  shareSelectionMode: _shareSelectionMode,
  shareBusy: _shareBusy,
  onScrubPreview,
  showResumeAutoFollow = false,
  onResumeAutoFollow,
  onOpenShareMenu: _onOpenShareMenu,
  onPlayPause,
  onPlayPauseResync,
  onNext,
  onPrevious,
  onSeek,
  onRequestTranslate,
  translationLoading = false,
  autoHidePlaybackControls = false,
  onToggleAutoHidePlaybackControls,
  playbackMode = 'desktop',
  latencyMs = 0,
  onUserInteraction,
  fullscreenAlbumMode = false,
  fullscreenActions,
  controlsModeTransitioning = false,
  fullscreenAlbumProgress,
  layout = 'default',
  previewPlayback,
  tourStep,
  previewTranslated,
}: PlaybackControlsProps) {
  const liveTranslated = usePlaybackStore(s => s.lyrics.some(line => Boolean(line.translatedText || line.backgroundTranslatedText)));
  const translated = previewTranslated ?? liveTranslated;
  const isOverlay = layout === 'overlay';
  const isLandscapeUtilities = layout === 'landscape-utilities';
  // Worklets must capture this primitive, never the React elements and their Fiber owners.
  const hasFullscreenActions = Boolean(fullscreenActions);
  const playPauseProgress = useSharedValue(isPlaying ? 1 : 0);

  useEffect(() => {
    playPauseProgress.value = withTiming(isPlaying ? 1 : 0, {
      duration: 180,
      easing: Easing.out(Easing.ease),
    });
  }, [isPlaying, playPauseProgress]);

  const playIconStyle = useAnimatedStyle(() => {
    const progress = playPauseProgress.value;
    return {
      opacity: 1 - progress,
      transform: [{ scale: 1 - progress * 0.1 }],
    };
  });

  const pauseIconStyle = useAnimatedStyle(() => {
    const progress = playPauseProgress.value;
    return {
      opacity: progress,
      transform: [{ scale: 0.88 + progress * 0.12 }],
    };
  });

  const bottomSlotStyle = useAnimatedStyle(() => {
    const fullscreen = fullscreenAlbumProgress.value;

    return {
      height: hasFullscreenActions ? UTILITY_ROW_HEIGHT : UTILITY_ROW_HEIGHT * (1 - fullscreen),
    };
  });

  const utilityLayerStyle = useAnimatedStyle(() => {
    const fullscreen = fullscreenAlbumProgress.value;

    return {
      opacity: 1 - fullscreen,
    };
  });

  const fullscreenLayerStyle = useAnimatedStyle(() => ({
    opacity: fullscreenAlbumProgress.value,
  }));

  const utilityButtons = (
    <>
      {!isLandscapeUtilities ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={autoHidePlaybackControls ? "Keep playback controls visible" : "Auto hide playback controls"}
          accessibilityState={{ selected: !autoHidePlaybackControls }}
          style={({ pressed }) => [
            styles.utilityButton,
            tourStep === 'autoHide' && styles.tourHighlight,
            pressed && styles.utilityButtonPressed,
          ]}
          onPress={() => {
            onUserInteraction?.();
            onToggleAutoHidePlaybackControls?.();
          }}
onPressIn={onUserInteraction}
          onPressOut={onUserInteraction}
          delayLongPress={280}
          hitSlop={8}>
          <View style={[styles.statusButtonInner, !autoHidePlaybackControls && styles.utilityButtonActive]}>
            <Ionicons
              name={autoHidePlaybackControls ? 'eye-off' : 'eye'}
              size={19}
              color={autoHidePlaybackControls ? '#FFFFFF' : '#18201E'}
            />

          </View>
        </Pressable>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Auto scroll to current lyric"
        accessibilityState={{ disabled: !showResumeAutoFollow }}
        style={({ pressed }) => [
          styles.utilityButton,
          tourStep === 'autoScroll' && styles.tourHighlight,
          !showResumeAutoFollow && styles.utilityButtonDisabled,
          pressed && showResumeAutoFollow && styles.utilityButtonPressed,
        ]}
        onPress={() => {
          onUserInteraction?.();
          onResumeAutoFollow?.();
        }}
        onPressIn={onUserInteraction}
        onPressOut={onUserInteraction}
        disabled={!showResumeAutoFollow}
        hitSlop={8}>
        <Ionicons
          name="navigate-circle"
          size={21}
          color={showResumeAutoFollow ? '#FFFFFF' : 'rgba(255,255,255,0.36)'}
        />
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={translationLoading ? "Translating lyrics" : translated ? "Lyrics translated" : "Translate lyrics"}
        accessibilityState={{ selected: translated, busy: translationLoading, disabled: translationLoading }}
        style={({ pressed }) => [
          styles.utilityButton,
          translationLoading && styles.utilityButtonDisabled,
          tourStep === 'translate' && styles.tourHighlight,
          pressed && !translationLoading && styles.utilityButtonPressed,
        ]}
        onPress={() => {
          onUserInteraction?.();
          onRequestTranslate?.();
        }}
        onPressIn={onUserInteraction}
        onPressOut={onUserInteraction}
        delayLongPress={280}
        disabled={translationLoading}
        hitSlop={8}>
        <View style={[styles.translateButtonInner, translated && !translationLoading && styles.utilityButtonActive]}>
          <Ionicons name="language" size={18} color={translated && !translationLoading ? "#18201E" : "#FFFFFF"} />
          {translationLoading ? (
            <View style={styles.translateLoadingDots}>
              <View style={styles.translateLoadingDot} />
              <View style={styles.translateLoadingDot} />
              <View style={styles.translateLoadingDot} />
            </View>
          ) : null}
        </View>
      </Pressable>
    </>
  );

  if (isLandscapeUtilities) {
    return (
      <>
        <View style={styles.landscapeActionSlot}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Auto scroll to current lyric"
            accessibilityState={{ disabled: !showResumeAutoFollow }}
            style={({ pressed }) => [
              styles.landscapeUtilityButton,
              tourStep === 'autoScroll' && styles.tourHighlight,
              !showResumeAutoFollow && styles.utilityButtonDisabled,
              pressed && showResumeAutoFollow && styles.utilityButtonPressed,
            ]}
            onPress={() => {
              onUserInteraction?.();
              onResumeAutoFollow?.();
            }}
            onPressIn={onUserInteraction}
            onPressOut={onUserInteraction}
            disabled={!showResumeAutoFollow}
            hitSlop={8}>
            <Ionicons
              name="navigate-circle"
              size={20}
              color={showResumeAutoFollow ? '#FFFFFF' : 'rgba(255,255,255,0.36)'}
            />
          </Pressable>
        </View>

        <View style={styles.landscapeActionSlot}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={translationLoading ? "Translating lyrics" : translated ? "Lyrics translated" : "Translate lyrics"}
            accessibilityState={{ selected: translated, busy: translationLoading, disabled: translationLoading }}
            style={({ pressed }) => [
              styles.landscapeUtilityButton,
              translationLoading && styles.utilityButtonDisabled,
              tourStep === 'translate' && styles.tourHighlight,
              pressed && !translationLoading && styles.utilityButtonPressed,
            ]}
            onPress={() => {
              onUserInteraction?.();
              onRequestTranslate?.();
            }}
            onPressIn={onUserInteraction}
            onPressOut={onUserInteraction}
            delayLongPress={280}
            disabled={translationLoading}
            hitSlop={8}>
            <View style={[styles.translateButtonInner, translated && !translationLoading && styles.utilityButtonActive]}>
              <Ionicons name="language" size={18} color={translated && !translationLoading ? "#18201E" : "#FFFFFF"} />
              {translationLoading ? (
                <View style={styles.translateLoadingDots}>
                  <View style={styles.translateLoadingDot} />
                  <View style={styles.translateLoadingDot} />
                  <View style={styles.translateLoadingDot} />
                </View>
              ) : null}
            </View>
          </Pressable>
        </View>
      </>
    );
  }

  return (
    <Reanimated.View
      style={[
        styles.card,
        isOverlay && styles.cardOverlay,
      ]}>
      <PlaybackTimeline
        previewPlayback={previewPlayback}
        durationMs={durationMs}
        onScrubPreview={onScrubPreview}
        onSeek={onSeek}
        onUserInteraction={onUserInteraction}
        compact={isOverlay}
      />

      <View style={[styles.controlsRow, isOverlay && styles.controlsRowOverlay]}>
        <TransportButton
          accessibilityLabel="Previous track"
          onPress={onPrevious}
          onUserInteraction={onUserInteraction}
          direction="backward"
          style={isOverlay ? styles.transportButtonOverlay : undefined}>
          <Ionicons
            name="play-skip-back"
            size={isOverlay ? 22 : 34}
            color="#FFFFFF"
          />
        </TransportButton>

        <TransportButton
          accessibilityLabel={isPlaying ? 'Pause playback' : 'Play music'}
          onPress={onPlayPause}
          onLongPress={
            isPlaying && onPlayPauseResync ? onPlayPauseResync : undefined
          }
          onUserInteraction={onUserInteraction}
          style={[isOverlay ? styles.playButtonShellOverlay : styles.playButtonShell, tourStep === 'playback' && styles.tourHighlight]}>
          <View style={isOverlay ? styles.playIconFrameOverlay : styles.playIconFrame}>
            <Reanimated.View
              pointerEvents="none"
              style={[
                styles.playPauseLayer,
                playIconStyle,
              ]}>
              <Ionicons
                name="play"
                size={isOverlay ? 30 : 48}
                color="#FFFFFF"
                style={isOverlay ? styles.playGlyphOverlay : styles.playGlyph}
              />
            </Reanimated.View>

            <Reanimated.View
              pointerEvents="none"
              style={[
                styles.playPauseLayer,
                pauseIconStyle,
              ]}>
              <Ionicons
                name="pause"
                size={isOverlay ? 26 : 44}
                color="#FFFFFF"
              />
            </Reanimated.View>
          </View>
        </TransportButton>

        <TransportButton
          accessibilityLabel="Next track"
          onPress={onNext}
          onUserInteraction={onUserInteraction}
          direction="forward"
          style={isOverlay ? styles.transportButtonOverlay : undefined}>
          <Ionicons
            name="play-skip-forward"
            size={isOverlay ? 22 : 34}
            color="#FFFFFF"
          />
        </TransportButton>
      </View>

      {!isOverlay ? (
        <Reanimated.View
          style={[!fullscreenActions && styles.collapsibleRowClip, styles.bottomSlot, bottomSlotStyle]}>
          <Reanimated.View
            pointerEvents={controlsModeTransitioning || fullscreenAlbumMode ? 'none' : 'auto'}
            accessibilityElementsHidden={fullscreenAlbumMode}
            importantForAccessibility={fullscreenAlbumMode ? 'no-hide-descendants' : 'auto'}
            style={[styles.bottomLayer, styles.bottomUtilityLayer, utilityLayerStyle]}>
            <View style={styles.utilityRow}>{utilityButtons}</View>
          </Reanimated.View>
          {fullscreenActions ? (
            <Reanimated.View
              pointerEvents={fullscreenAlbumMode && !controlsModeTransitioning ? 'auto' : 'none'}
              accessibilityElementsHidden={!fullscreenAlbumMode}
              importantForAccessibility={fullscreenAlbumMode ? 'auto' : 'no-hide-descendants'}
              style={[styles.bottomLayer, styles.bottomUtilityLayer, fullscreenLayerStyle]}>
              <View style={styles.utilityRow}>{fullscreenActions}</View>
            </Reanimated.View>
          ) : null}

  </Reanimated.View>
      ) : null}
    </Reanimated.View>
  );
});

const PlaybackTimeline = memo(function PlaybackTimeline({
  durationMs,
  onScrubPreview,
  onSeek,
  onUserInteraction,
  compact = false,
  previewPlayback,
}: Pick<
  PlaybackControlsProps,
  'durationMs' | 'onScrubPreview' | 'onSeek' | 'onUserInteraction' | 'previewPlayback'
> & {
  compact?: boolean;
}) {
  const [trackWidth, setTrackWidth] = useState(1);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const scrubValueRef = useRef(0);
  const lastScrubPreviewAtRef = useRef(0);
  const scrubProgress = useSharedValue(0);
  const trackScaleY = useSharedValue(1);
  const lastScrubJsCallAt = useSharedValue(0);
  const isScrubbingShared = useSharedValue(false);
  const pendingSeekPositionMsShared = useSharedValue<number | null>(null);
  const maxDuration = Math.max(1, durationMs || 1);
  const playbackPositionShared = usePlaybackTimelineClock(maxDuration, previewPlayback);

  const displayPositionShared = useDerivedValue(() => {
    if (isScrubbingShared.value) {
      return scrubProgress.value * maxDuration;
    }
    if (pendingSeekPositionMsShared.value !== null) {
      return pendingSeekPositionMsShared.value;
    }
    return playbackPositionShared.value;
  }, [maxDuration]);

  const displayValueShared = useDerivedValue(() => {
    return displayPositionShared.value / maxDuration;
  }, [maxDuration]);

  const flushScrubPreview = useCallback(
    (ratio: number, forcePreview = false) => {
      scrubValueRef.current = ratio;
      const now =
        typeof performance !== 'undefined' &&
        typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      if (
        forcePreview ||
        now - lastScrubPreviewAtRef.current >= SCRUB_LYRIC_PREVIEW_INTERVAL_MS
      ) {
        lastScrubPreviewAtRef.current = now;
        onScrubPreview?.(ratio * maxDuration);
      }
    },
    [maxDuration, onScrubPreview],
  );

  useEffect(() => {
    if (!isScrubbing) {
      return;
    }
    const timer = setInterval(() => {
      onUserInteraction?.();
    }, INTERACTION_KEEP_ALIVE_MS);
    return () => {
      clearInterval(timer);
    };
  }, [isScrubbing, onUserInteraction]);

  const finishScrub = useCallback(
    (explicitRatio?: number) => {
      onUserInteraction?.();
      if (explicitRatio !== undefined) {
        scrubValueRef.current = explicitRatio;
      }
      setIsScrubbing(false);
      const seekPositionMs = scrubValueRef.current * maxDuration;
      onSeek(seekPositionMs);
      // The host updates the playback anchor synchronously in onSeek. The UI
      // clock has now accepted it, so release the temporary gesture hold instead
      // of freezing the thumb for another 1.2s while playback continues.
      pendingSeekPositionMsShared.value = null;
      onScrubPreview?.(null);
    },
    [maxDuration, onScrubPreview, onSeek, onUserInteraction, pendingSeekPositionMsShared],
  );

  const cancelScrub = useCallback(() => {
    setIsScrubbing(false);
    onScrubPreview?.(null);
  }, [onScrubPreview]);

  const scrubGesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onBegin((event) => {
          const ratio = Math.max(
            0,
            Math.min(1, event.x / Math.max(1, trackWidth)),
          );
          isScrubbingShared.value = true;
          scrubProgress.value = ratio;
          trackScaleY.value = 1.65;
          lastScrubJsCallAt.value = Date.now();
          if (onUserInteraction) runOnJS(onUserInteraction)();
          runOnJS(setIsScrubbing)(true);
          runOnJS(flushScrubPreview)(ratio, true);
        })
        .onUpdate((event) => {
          const ratio = Math.max(
            0,
            Math.min(1, event.x / Math.max(1, trackWidth)),
          );
          scrubProgress.value = ratio;
          const now = Date.now();
          if (now - lastScrubJsCallAt.value >= SCRUB_DISPLAY_INTERVAL_MS) {
            lastScrubJsCallAt.value = now;
            runOnJS(flushScrubPreview)(ratio, false);
          }
        })
        .onFinalize((event, success) => {
          trackScaleY.value = withTiming(1, { duration: 160 });
          if (success) {
            // Commit the release coordinate, even when the last JS preview
            // was throttled. Hold here until JS installs the new playback anchor.
            const ratio = Math.max(0, Math.min(1, event.x / Math.max(1, trackWidth)));
            pendingSeekPositionMsShared.value = ratio * maxDuration;
            isScrubbingShared.value = false;
            runOnJS(finishScrub)(ratio);
          } else {
            isScrubbingShared.value = false;
            runOnJS(cancelScrub)();
          }
        }),
    [
      cancelScrub,
      finishScrub,
      flushScrubPreview,
      isScrubbingShared,
      lastScrubJsCallAt,
      maxDuration,
      onUserInteraction,
      pendingSeekPositionMsShared,
      scrubProgress,
      trackScaleY,
      trackWidth,
    ],
  );

  const animatedTrackStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: trackScaleY.value }],
  }));

  const animatedFillStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: Math.max(0, Math.min(1, displayValueShared.value)) }],
  }));

  // Format on the UI thread, but update native text only when the second changes.
  const elapsedText = useDerivedValue(() => formatTime(displayPositionShared.value));
  const remainingText = useDerivedValue(() => formatRemainingTime(displayPositionShared.value, maxDuration));
  const animatedTimeProps = useAnimatedProps(() => {
    return {
      text: elapsedText.value,
    } as any;
  });

  const animatedRemainingProps = useAnimatedProps(() => {
    return {
      text: remainingText.value,
    } as any;
  });

  return (
    <>
      <GestureDetector gesture={scrubGesture}>
        <View
          style={styles.timelineTouchTarget}
          onLayout={(event) => {
            setTrackWidth(Math.max(1, event.nativeEvent.layout.width));
          }}>
          <Reanimated.View style={[styles.timelineTrack, animatedTrackStyle]}>
            <Reanimated.View
              style={[styles.timelineFill, animatedFillStyle]}
            />
          </Reanimated.View>
        </View>
      </GestureDetector>

      <View style={[styles.timeRow, compact && styles.timeRowCompact]}>
        <ReanimatedTextInput
          editable={false}
          animatedProps={animatedTimeProps}
          pointerEvents="none"
          style={[
            styles.timeText,
            styles.timeTextLeft,
            compact && styles.timeTextCompact,
          ]}
        />
        <ReanimatedTextInput
          editable={false}
          animatedProps={animatedRemainingProps}
          pointerEvents="none"
          style={[
            styles.timeText,
            styles.timeTextRight,
            compact && styles.timeTextCompact,
          ]}
        />
      </View>
    </>
  );
});

const styles = StyleSheet.create({
  tourHighlight: { borderWidth: 2, borderColor: '#A8F0CF', backgroundColor: 'rgba(168,240,207,0.12)' },
  card: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 14,
    gap: 10,
  },
  cardOverlay: {
    paddingHorizontal: 6,
    paddingTop: 4,
    paddingBottom: 2,
    gap: 2,
  },
  landscapeActionSlot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  landscapeUtilityButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapsibleRowClip: {
    overflow: 'hidden',
  },
  bottomSlot: {
    position: 'relative',
  },
  bottomLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  bottomUtilityLayer: {
    top: 0,
    height: UTILITY_ROW_HEIGHT,
  },
  timelineTrack: {
    position: 'relative',
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.25)',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  timelineTouchTarget: {
    height: 18,
    justifyContent: 'center',
  },
  timelineFill: {
    width: '100%',
    transformOrigin: 'left center',
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.95)',
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  timeRowCompact: {
    marginTop: -2,
  },
  timeText: {
    width: 66,
    flexShrink: 0,
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    fontWeight: '500',
    includeFontPadding: false,
    padding: 0,
  },
  timeTextCompact: {
    width: 48,
    fontSize: 10,
  },
  timeTextLeft: {
    textAlign: 'left',
  },
  timeTextRight: {
    textAlign: 'right',
  },
  controlsRow: {
    paddingTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 34,
  },
  controlsRowOverlay: {
    gap: 10,
    paddingTop: 0,
  },
  transportButton: {
    width: 62,
    height: 62,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transportButtonOverlay: {
    width: 44,
    height: 44,
  },
  transportButtonHalo: {
    ...StyleSheet.absoluteFill,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  playButtonShell: {
    width: 86,
    height: 86,
  },
  playButtonShellOverlay: {
    width: 56,
    height: 56,
  },
  playIconFrame: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIconFrameOverlay: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playPauseLayer: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: {
    marginLeft: 4,
  },
  playGlyphOverlay: {
    marginLeft: 2,
  },
  utilityRow: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
  },
  utilityButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  utilityButtonDisabled: {
    opacity: 0.42,
  },
  utilityButtonActive: {
    opacity: 1,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 7,
  },
  utilityButtonPressed: {
    transform: [{ scale: 0.94 }],
    opacity: 0.82,
  },
  translateButtonInner: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 20,
  },
  statusButtonInner: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 20,
  },
  statusVisibleMark: {
    position: 'absolute',
    bottom: -5,
    width: 10,
    height: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.88)',
  },
  translateActiveMark: {
    position: 'absolute',
    bottom: -5,
    width: 10,
    height: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.88)',
  },
  translateLoadingDots: {
    position: 'absolute',
    bottom: -7,
    flexDirection: 'row',
    gap: 3,
  },
  translateLoadingDot: {
    width: 3.5,
    height: 3.5,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  capsule: {
    minHeight: 56,
    paddingHorizontal: 2,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: {
    flex: 1,
    gap: 4,
    marginRight: 12,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  label: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 12,
    fontWeight: '500',
  },
  value: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  right: {
    alignItems: 'flex-end',
    gap: 2,
  },
  pingLabel: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 11,
    fontWeight: '500',
  },
  pingValue: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    fontWeight: '600',
  },
});
