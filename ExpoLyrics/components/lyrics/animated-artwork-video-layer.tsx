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
  const hasRenderedFrameRef = useRef(false);

  useEffect(() => {
    hasRenderedFrameRef.current = false;
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
    if (status === 'readyToPlay') {
      if (player.audioTrack !== null) {
        player.audioTrack = null;
      }
    }
    if (status === 'error' || !active || !isAppActive) {
      hasRenderedFrameRef.current = false;
      videoOpacity.value = withTiming(0, { duration: 180 });
    }
  }, [active, isAppActive, player, status, videoOpacity]);

  const handleFirstFrameRender = () => {
    if (!active || !isAppActive || hasRenderedFrameRef.current) {
      return;
    }
    hasRenderedFrameRef.current = true;
    videoOpacity.value = withTiming(1, { duration: VIDEO_FADE_MS });
  };

  const videoAnimatedStyle = useAnimatedStyle(() => ({
    opacity: videoOpacity.value,
  }));

  if (!safeUri) {
    return null;
  }

  return (
    <Animated.View style={[StyleSheet.absoluteFill, videoAnimatedStyle]}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        allowsPictureInPicture={false}
        surfaceType="textureView"
        onFirstFrameRender={handleFirstFrameRender}
      />
    </Animated.View>
  );
});

export { AnimatedArtworkVideoLayer };
