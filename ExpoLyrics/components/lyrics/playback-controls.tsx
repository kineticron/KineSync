import { Ionicons } from '@expo/vector-icons';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Pressable, StyleSheet, View, TextInput, Text } from 'react-native';
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
} from 'react-native-reanimated';

import { usePlaybackStore } from '@/store/playback-store';
import type { ConnectionStatus } from '@/types/bridge';

const ReanimatedTextInput = Reanimated.createAnimatedComponent(TextInput);

function getStatusDescriptor(status: ConnectionStatus, latencyMs: number) {
  if (status !== 'connected') {
    return {
      tint: 'rgba(255,89,115,0.08)',
      border: 'rgba(255,89,115,0.16)',
      signalColor: '#FF93A4',
    };
  }
  if (latencyMs > 210) {
    return {
      tint: 'rgba(255,173,94,0.07)',
      border: 'rgba(255,173,94,0.16)',
      signalColor: '#FFD287',
    };
  }
  if (latencyMs > 120) {
    return {
      tint: 'rgba(255,255,255,0.05)',
      border: 'rgba(255,255,255,0.14)',
      signalColor: '#FFFFFF',
    };
  }
  return {
    tint: 'rgba(111,232,179,0.07)',
    border: 'rgba(111,232,179,0.16)',
    signalColor: '#8FF0C4',
  };
}

const ConnectivityStatusView = memo(function ConnectivityStatusView({
  connectionStatus,
  latencyMs,
  actionText,
  sourceText,
}: {
  connectionStatus: ConnectionStatus;
  latencyMs: number;
  actionText: string;
  sourceText: string;
}) {
  const status = getStatusDescriptor(connectionStatus, latencyMs);

  return (
    <View
      style={[
        styles.capsule,
        {
          backgroundColor: 'transparent',
          borderColor: 'transparent',
        },
      ]}>
      <View style={styles.left}>
        <View style={styles.labelRow}>
          <View style={[styles.dot, { backgroundColor: status.signalColor }]} />
          <Text style={styles.label} numberOfLines={1} ellipsizeMode="tail">
            {actionText}
          </Text>
        </View>
        <Text style={styles.value} numberOfLines={1} ellipsizeMode="tail">
          {sourceText}
        </Text>
      </View>

      <View style={styles.right}>
        <Text style={styles.pingLabel}>Ping</Text>
        <Text style={styles.pingValue}>{Math.max(0, Math.round(latencyMs))} ms</Text>
      </View>
    </View>
  );
});

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

const SEEK_CONFIRM_THRESHOLD_MS = 1200;
const SCRUB_DISPLAY_INTERVAL_MS = 80;
const SCRUB_LYRIC_PREVIEW_INTERVAL_MS = 220;
const INTERACTION_KEEP_ALIVE_MS = 1000;
const FULLSCREEN_CONTROLS_TRANSITION_MS = 320;
const UTILITY_ROW_HEIGHT = 44;
const STATUS_ROW_HEIGHT = 56;

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
  showTranslatedText?: boolean;
  onToggleShowTranslatedText?: (value: boolean) => void;
  autoHidePlaybackControls?: boolean;
  onToggleAutoHidePlaybackControls?: () => void;
  hideStatusBar?: boolean;
  onToggleHideStatusBar?: (value: boolean) => void;
  connectionStatus?: ConnectionStatus;
  latencyMs?: number;
  statusActionText?: string;
  statusSourceText?: string;
  onUserInteraction?: () => void;
  fullscreenAlbumMode?: boolean;
  controlsModeTransitioning?: boolean;
  fullscreenAlbumProgress: SharedValue<number>;
  layout?: PlaybackControlsLayout;
};

type TransportButtonProps = {
  onPress: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  onUserInteraction?: () => void;
  direction?: 'backward' | 'forward' | 'none';
  children: ReactNode;
  style?: object;
};

function TransportButton({
  onPress,
  onLongPress,
  delayLongPress = 280,
  onUserInteraction,
  direction = 'none',
  children,
  style,
}: TransportButtonProps) {
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
    if (direction !== 'none') {
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
  }, [direction, onPress, onUserInteraction, slide]);

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
      onPress={handlePress}
      onLongPress={onLongPress ? handleLongPress : undefined}
      delayLongPress={delayLongPress}
      onPressIn={() => {
        onUserInteraction?.();
        startInteractionKeepAlive();
        animatePressHalo(1);
        animateScale(0.78);
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
  showTranslatedText = true,
  onToggleShowTranslatedText,
  autoHidePlaybackControls = false,
  onToggleAutoHidePlaybackControls,
  hideStatusBar = false,
  onToggleHideStatusBar,
  connectionStatus = 'disconnected',
  latencyMs = 0,
  statusActionText = 'Connecting to bridge...',
  statusSourceText = 'Bridge offline',
  onUserInteraction,
  fullscreenAlbumMode = false,
  controlsModeTransitioning = false,
  fullscreenAlbumProgress,
  layout = 'default',
}: PlaybackControlsProps) {
  const isOverlay = layout === 'overlay';
  const isLandscapeUtilities = layout === 'landscape-utilities';
  const playPauseProgress = useSharedValue(isPlaying ? 1 : 0);
  const statusPreferenceProgress = useSharedValue(hideStatusBar ? 0 : 1);
  const statusLongPressTriggeredRef = useRef(false);

  useEffect(() => {
    playPauseProgress.value = withTiming(isPlaying ? 1 : 0, {
      duration: 180,
      easing: Easing.out(Easing.ease),
    });
  }, [isPlaying, playPauseProgress]);

  useEffect(() => {
    statusPreferenceProgress.value = withTiming(hideStatusBar ? 0 : 1, {
      duration: FULLSCREEN_CONTROLS_TRANSITION_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [hideStatusBar, statusPreferenceProgress]);

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
    const preference = statusPreferenceProgress.value;
    const fullscreen = fullscreenAlbumProgress.value;

    return {
      height:
        UTILITY_ROW_HEIGHT * (1 - fullscreen) +
        STATUS_ROW_HEIGHT * Math.max(preference, fullscreen),
    };
  });

  const utilityLayerStyle = useAnimatedStyle(() => {
    const fullscreen = fullscreenAlbumProgress.value;

    return {
      opacity: 1 - fullscreen,
    };
  });

  const statusLayerStyle = useAnimatedStyle(() => {
    const preference = statusPreferenceProgress.value;
    const fullscreen = fullscreenAlbumProgress.value;
    const layoutBlend = 1 - preference;
    const slotHeight =
      UTILITY_ROW_HEIGHT * (1 - fullscreen) +
      STATUS_ROW_HEIGHT * Math.max(preference, fullscreen);
    const statusOpacity = preference + (1 - preference) * fullscreen;

    return {
      opacity: statusOpacity,
      top:
        layoutBlend * Math.max(0, slotHeight - STATUS_ROW_HEIGHT) +
        (1 - layoutBlend) * UTILITY_ROW_HEIGHT * (1 - fullscreen),
    };
  });

  const utilityButtons = (
    <>
      {!isLandscapeUtilities ? (
        <Pressable
          style={({ pressed }) => [
            styles.utilityButton,
            autoHidePlaybackControls && styles.utilityButtonActive,
            pressed && styles.utilityButtonPressed,
          ]}
          onPress={() => {
            onUserInteraction?.();
            if (statusLongPressTriggeredRef.current) {
              statusLongPressTriggeredRef.current = false;
              return;
            }
            onToggleAutoHidePlaybackControls?.();
          }}
          onLongPress={() => {
            statusLongPressTriggeredRef.current = true;
            onUserInteraction?.();
            onToggleHideStatusBar?.(!hideStatusBar);
          }}
          onPressIn={onUserInteraction}
          onPressOut={onUserInteraction}
          delayLongPress={280}
          hitSlop={8}>
          <View style={styles.statusButtonInner}>
            <Ionicons
              name={autoHidePlaybackControls ? 'eye-off' : 'eye'}
              size={19}
              color={autoHidePlaybackControls ? '#FFFFFF' : 'rgba(255,255,255,0.62)'}
            />
            {!hideStatusBar && <View style={styles.statusVisibleMark} />}
          </View>
        </Pressable>
      ) : null}

      <Pressable
        style={({ pressed }) => [
          styles.utilityButton,
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
        style={({ pressed }) => [
          styles.utilityButton,
          showTranslatedText && styles.utilityButtonActive,
          translationLoading && styles.utilityButtonDisabled,
          pressed && !translationLoading && styles.utilityButtonPressed,
        ]}
        onPress={() => {
          onUserInteraction?.();
          onRequestTranslate?.();
        }}
        onPressIn={onUserInteraction}
        onPressOut={onUserInteraction}
        onLongPress={() => {
          onUserInteraction?.();
          onToggleShowTranslatedText?.(!showTranslatedText);
        }}
        delayLongPress={280}
        disabled={translationLoading}
        hitSlop={8}>
        <View style={styles.translateButtonInner}>
          <Ionicons name="language" size={18} color="#FFFFFF" />
          {translationLoading ? (
            <View style={styles.translateLoadingDots}>
              <View style={styles.translateLoadingDot} />
              <View style={styles.translateLoadingDot} />
              <View style={styles.translateLoadingDot} />
            </View>
          ) : (
            showTranslatedText && <View style={styles.translateActiveMark} />
          )}
        </View>
      </Pressable>
    </>
  );

  if (isLandscapeUtilities) {
    return (
      <>
        <View style={styles.landscapeActionSlot}>
          <Pressable
            style={({ pressed }) => [
              styles.landscapeUtilityButton,
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
            style={({ pressed }) => [
              styles.landscapeUtilityButton,
              showTranslatedText && styles.utilityButtonActive,
              translationLoading && styles.utilityButtonDisabled,
              pressed && !translationLoading && styles.utilityButtonPressed,
            ]}
            onPress={() => {
              onUserInteraction?.();
              onRequestTranslate?.();
            }}
            onPressIn={onUserInteraction}
            onPressOut={onUserInteraction}
            onLongPress={() => {
              onUserInteraction?.();
              onToggleShowTranslatedText?.(!showTranslatedText);
            }}
            delayLongPress={280}
            disabled={translationLoading}
            hitSlop={8}>
            <View style={styles.translateButtonInner}>
              <Ionicons name="language" size={18} color="#FFFFFF" />
              {translationLoading ? (
                <View style={styles.translateLoadingDots}>
                  <View style={styles.translateLoadingDot} />
                  <View style={styles.translateLoadingDot} />
                  <View style={styles.translateLoadingDot} />
                </View>
              ) : (
                showTranslatedText && <View style={styles.translateActiveMark} />
              )}
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
        durationMs={durationMs}
        onScrubPreview={onScrubPreview}
        onSeek={onSeek}
        onUserInteraction={onUserInteraction}
        compact={isOverlay}
      />

      <View style={[styles.controlsRow, isOverlay && styles.controlsRowOverlay]}>
        <TransportButton
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
          onPress={onPlayPause}
          onLongPress={
            isPlaying && onPlayPauseResync ? onPlayPauseResync : undefined
          }
          onUserInteraction={onUserInteraction}
          style={isOverlay ? styles.playButtonShellOverlay : styles.playButtonShell}>
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
          style={[styles.collapsibleRowClip, styles.bottomSlot, bottomSlotStyle]}>
          <Reanimated.View
            pointerEvents={controlsModeTransitioning ? 'none' : 'auto'}
            style={[styles.bottomLayer, styles.bottomUtilityLayer, utilityLayerStyle]}>
            <View style={styles.utilityRow}>{utilityButtons}</View>
          </Reanimated.View>

          <Reanimated.View
            pointerEvents={
              controlsModeTransitioning || !hideStatusBar ? 'auto' : 'none'
            }
            style={[styles.bottomLayer, statusLayerStyle]}>
            <ConnectivityStatusView
              connectionStatus={connectionStatus}
              latencyMs={latencyMs}
              actionText={statusActionText}
              sourceText={statusSourceText}
            />
          </Reanimated.View>
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
}: Pick<
  PlaybackControlsProps,
  'durationMs' | 'onScrubPreview' | 'onSeek' | 'onUserInteraction'
> & {
  compact?: boolean;
}) {
  const [trackWidth, setTrackWidth] = useState(1);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [pendingSeekPositionMs, setPendingSeekPositionMs] = useState<number | null>(null);
  const scrubValueRef = useRef(0);
  const lastScrubDisplayAtRef = useRef(0);
  const lastScrubPreviewAtRef = useRef(0);
  const pendingSeekRef = useRef(false);
  const scrubProgress = useSharedValue(0);
  const trackScaleY = useSharedValue(1);
  const lastScrubJsCallAt = useSharedValue(0);
  const isScrubbingShared = useSharedValue(false);
  const pendingSeekPositionMsShared = useSharedValue<number | null>(null);
  const playbackPositionShared = useSharedValue(
    usePlaybackStore.getState().playbackPosition,
  );

  const maxDuration = Math.max(1, durationMs || 1);

  useEffect(() => {
    pendingSeekRef.current = pendingSeekPositionMs !== null;
  }, [pendingSeekPositionMs]);

  useEffect(() => {
    const syncPlaybackPosition = (positionMs: number) => {
      playbackPositionShared.value = Math.max(0, Math.min(positionMs, maxDuration));
    };

    syncPlaybackPosition(usePlaybackStore.getState().playbackPosition);

    let previousPosition = usePlaybackStore.getState().playbackPosition;
    return usePlaybackStore.subscribe((state) => {
      const playbackPosition = state.playbackPosition;
      if (playbackPosition === previousPosition) {
        return;
      }
      previousPosition = playbackPosition;
      if (!isScrubbingShared.value && pendingSeekPositionMsShared.value === null) {
        syncPlaybackPosition(playbackPosition);
      }
    });
  }, [isScrubbingShared, maxDuration, pendingSeekPositionMsShared, playbackPositionShared]);

  useEffect(() => {
    isScrubbingShared.value = isScrubbing;
  }, [isScrubbing, isScrubbingShared]);

  useEffect(() => {
    pendingSeekPositionMsShared.value = pendingSeekPositionMs;
  }, [pendingSeekPositionMs, pendingSeekPositionMsShared]);

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

  useDerivedValue(() => {
    if (!isScrubbingShared.value) {
      scrubProgress.value = withTiming(displayValueShared.value, { duration: 120 });
    }
  });

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
        now - lastScrubDisplayAtRef.current >= SCRUB_DISPLAY_INTERVAL_MS
      ) {
        lastScrubDisplayAtRef.current = now;
      }
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
    if (pendingSeekPositionMs === null) {
      return;
    }
    if (pendingSeekPositionMs > maxDuration) {
      setPendingSeekPositionMs(null);
      return;
    }
    // We need to check if the actual position caught up to the seek position.
    // Instead of subscribing to playbackPosition, we can just clear it after a timeout
    // or when anchorPositionMs changes significantly.
    const timer = setTimeout(() => {
      setPendingSeekPositionMs(null);
    }, SEEK_CONFIRM_THRESHOLD_MS);
    return () => clearTimeout(timer);
  }, [maxDuration, pendingSeekPositionMs]);

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
      setPendingSeekPositionMs(seekPositionMs);
      onSeek(seekPositionMs);
      onScrubPreview?.(null);
    },
    [maxDuration, onScrubPreview, onSeek, onUserInteraction],
  );

  const scrubGesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onBegin((event) => {
          const ratio = Math.max(
            0,
            Math.min(1, event.x / Math.max(1, trackWidth)),
          );
          scrubProgress.value = ratio;
          trackScaleY.value = 1.65;
          lastScrubJsCallAt.value = Date.now();
          runOnJS(onUserInteraction ?? (() => undefined))();
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
        .onFinalize(() => {
          trackScaleY.value = withTiming(1, { duration: 160 });
          runOnJS(finishScrub)();
        }),
    [
      finishScrub,
      flushScrubPreview,
      lastScrubJsCallAt,
      onUserInteraction,
      scrubProgress,
      trackScaleY,
      trackWidth,
    ],
  );

  const animatedTrackStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: trackScaleY.value }],
  }));

  const animatedFillStyle = useAnimatedStyle(() => ({
    width: `${scrubProgress.value * 100}%`,
  }));

  const animatedTimeProps = useAnimatedProps(() => {
    return {
      text: formatTime(displayPositionShared.value),
    } as any;
  });

  const animatedRemainingProps = useAnimatedProps(() => {
    return {
      text: formatRemainingTime(displayPositionShared.value, maxDuration),
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
    ...StyleSheet.absoluteFillObject,
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
  },
  utilityButtonPressed: {
    transform: [{ scale: 0.94 }],
    opacity: 0.82,
  },
  translateButtonInner: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 20,
  },
  statusButtonInner: {
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
