import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { PromotionalBackdrop } from '@/components/ui/promotional-backdrop';
import { BridgedArtworkImage } from './bridged-artwork-image';

export type ArtworkBackgroundProps = { uri: string; playing: boolean; active: boolean };

export const ArtworkBackgroundFallback = memo(function ArtworkBackgroundFallback({ uri }: ArtworkBackgroundProps) {
  return <View pointerEvents="none" aria-hidden style={StyleSheet.absoluteFill}>
    {uri ? <>
      <BridgedArtworkImage uri={uri} style={StyleSheet.absoluteFill} contentFit="cover" blurRadius={40} />
      <View style={styles.shade} />
    </> : <PromotionalBackdrop />}
  </View>;
});

const styles = StyleSheet.create({
  shade: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(8,9,14,0.58)' },
});
