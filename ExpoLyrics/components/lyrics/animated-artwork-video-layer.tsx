import { useEvent } from 'expo';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { memo, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { usePlaybackStore } from '@/store/playback-store';

const VIDEO_FADE_MS = 520;

function configureDecorativeArtworkPlayer(player: VideoPlayer) {
  player.loop = true;
  player.muted = true;
  player.volume = 0;
  player.audioMixingMode = 'mixWithOthers';
  player.showNowPlayingNotification = false;
}

type AnimatedArtworkVideoLayerProps = {
  uri: string;
  active: boolean;
};

const AnimatedArtworkVideoLayer = memo(function AnimatedArtworkVideoLayer({
  uri,
  active,
}: AnimatedArtworkVideoLayerProps) {
  const safeUri = String(uri || '').trim();
  const player = useVideoPlayer(
    safeUri ? { uri: safeUri, contentType: 'hls' as const } : null,
    configureDecorativeArtworkPlayer,
  );

  const { status } = useEvent(player, 'statusChange', {
    status: player.status,
  });

  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const [appState, setAppState] = useState(AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener('change', setAppState);
    return () => sub.remove();
  }, []);

  const videoOpacity = useSharedValue(0);
  const wasReadyRef = useRef(false);

  useEffect(() => {
    wasReadyRef.current = false;
    videoOpacity.value = 0;
  }, [safeUri, videoOpacity]);

  const isAppActive = appState === 'active';
  const shouldPlay = active && isPlaying && isAppActive;

  useEffect(() => {
    if (!safeUri) {
      return;
    }
    if (shouldPlay) {
      player.play();
      return;
    }
    player.pause();
  }, [shouldPlay, player, safeUri]);

  useEffect(() => {
    if (status === 'readyToPlay' && active) {
      if (player.audioTrack !== null) {
        player.audioTrack = null;
      }
      if (!wasReadyRef.current) {
        wasReadyRef.current = true;
        videoOpacity.value = withTiming(1, { duration: VIDEO_FADE_MS });
      }
      return;
    }
    if (status === 'error' || !active) {
      wasReadyRef.current = false;
      videoOpacity.value = withTiming(0, { duration: 180 });
    }
  }, [active, player, status, videoOpacity]);

  const videoAnimatedStyle = useAnimatedStyle(() => ({
    opacity: videoOpacity.value,
  }));

  if (!safeUri) {
    return null;
  }

  return (
    <Animated.View style={[StyleSheet.absoluteFillObject, videoAnimatedStyle]}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFillObject}
        contentFit="cover"
        nativeControls={false}
        allowsPictureInPicture={false}
      />
    </Animated.View>
  );
});

export { AnimatedArtworkVideoLayer };
