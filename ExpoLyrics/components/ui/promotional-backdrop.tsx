import { Image } from 'expo-image';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

// Original repository banner as an oversized, angled brand print.
export const PromotionalBackdrop = memo(function PromotionalBackdrop() {
  return (
    <View pointerEvents="none" aria-hidden style={styles.root}>
      <Image source={require('@/assets/images/promotional-banner.png')} contentFit="cover" blurRadius={60} style={StyleSheet.absoluteFill} />
      <Image source={require('@/assets/images/promotional-banner.png')} contentFit="cover" style={styles.print} />
      <View style={styles.shade} />
    </View>
  );
});

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, overflow: 'hidden', backgroundColor: '#211B32' },
  print: { position: 'absolute', width: '220%', height: '64%', left: '-60%', top: '18%', opacity: 0.24, transform: [{ rotate: '-24deg' }] },
  shade: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(8,10,18,0.3)' },
});
