import Ionicons from '@react-native-vector-icons/ionicons';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';

import { MotionPressable } from '@/components/ui/motion-pressable';
import { Design } from '@/constants/design';

const entrance = FadeInDown.duration(380).reduceMotion(ReduceMotion.System);

export const ListeningEmptyState = memo(function ListeningEmptyState({ mobile, connected, onConnect, onOpenPlayer }: {
  mobile: boolean;
  connected: boolean;
  onConnect: () => void;
  onOpenPlayer: () => void;
}) {
  return (
    <Animated.View entering={entrance} style={styles.container}>
      <View style={styles.symbol}>
        <Ionicons name="musical-notes-outline" size={35} color={Design.accent} />
        <View style={styles.spark}><Ionicons name="sparkles" size={15} color={Design.accent} /></View>
      </View>
      <Text style={styles.eyebrow}>YOUR NEXT FAVORITE MOMENT</Text>
      <Text style={styles.title}>Ready when you are.</Text>
      <Text style={styles.description}>
        {mobile ? 'Open Spotify, pick something you love, and let the words find you.' : connected ? 'Your desktop is connected. Play a song on Spotify and the lyrics will meet you here.' : 'Connect your desktop, press play on Spotify, and follow every word here.'}
      </Text>
      {(mobile || !connected) && (
        <MotionPressable onPress={mobile ? onOpenPlayer : onConnect} style={styles.button}>
          <Ionicons name={mobile ? 'play' : 'link-outline'} size={17} color={Design.accentInk} />
          <Text style={styles.buttonText}>{mobile ? 'Open Spotify player' : 'Connect your desktop'}</Text>
          <Ionicons name="arrow-forward" size={16} color={Design.accentInk} />
        </MotionPressable>
      )}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 20, gap: 14 },
  symbol: { width: 82, height: 82, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(168,240,207,0.08)', borderWidth: 1, borderColor: 'rgba(168,240,207,0.18)', marginBottom: 10 },
  spark: { position: 'absolute', top: -8, right: -7, width: 29, height: 29, borderRadius: 12, backgroundColor: Design.surface, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '12deg' }] },
  eyebrow: { color: Design.accent, fontSize: 9, fontWeight: '700', letterSpacing: 1.7, textAlign: 'center' },
  title: { color: Design.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.9, textAlign: 'center' },
  description: { maxWidth: 310, color: Design.muted, fontSize: 15, lineHeight: 23, textAlign: 'center' },
  button: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: Design.accent, borderRadius: 17, paddingHorizontal: 18, paddingVertical: 15, marginTop: 12 },
  buttonText: { color: Design.accentInk, fontSize: 14, fontWeight: '700', flexShrink: 1 },
});
