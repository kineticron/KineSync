import { Image as ExpoImage } from 'expo-image';
import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AnimatedArtworkVideoLayer } from '@/components/lyrics/animated-artwork-video-layer';

type AnimatedBridgedArtworkProps = {
  staticUri: string;
  animatedUri?: string;
  active?: boolean;
  style?: StyleProp<ViewStyle>;
  recyclingKey?: string;
};

export const AnimatedBridgedArtwork = memo(function AnimatedBridgedArtwork({
  staticUri,
  animatedUri,
  active = true,
  style,
  recyclingKey,
}: AnimatedBridgedArtworkProps) {
  const safeStaticUri = String(staticUri || '').trim();
  const safeAnimatedUri = String(animatedUri || '').trim();
  const shouldPlayVideo = Boolean(safeAnimatedUri && active);

  if (!safeStaticUri && !safeAnimatedUri) {
    return null;
  }

  return (
    <View style={style} pointerEvents="none">
      {safeStaticUri ? (
        <ExpoImage
          source={{ uri: safeStaticUri }}
          style={StyleSheet.absoluteFillObject}
          cachePolicy="memory-disk"
          recyclingKey={recyclingKey ?? safeStaticUri}
          contentFit="cover"
        />
      ) : null}

      {shouldPlayVideo ? (
        <AnimatedArtworkVideoLayer
          key={safeAnimatedUri}
          uri={safeAnimatedUri}
          active={active}
        />
      ) : null}
    </View>
  );
});
