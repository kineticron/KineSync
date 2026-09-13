import Ionicons from '@react-native-vector-icons/ionicons';
import { BlurView } from 'expo-blur';
import { memo } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';

import { MotionPressable } from '@/components/ui/motion-pressable';

const entrance = FadeInDown.duration(380).reduceMotion(ReduceMotion.System);

export const ListeningEmptyState = memo(function ListeningEmptyState({ mobile, connected, signedIn, onConnect, onSignIn, onOpenPlayer }: {
  mobile: boolean;
  connected: boolean;
  signedIn: boolean;
  onConnect: () => void;
  onSignIn: () => void;
  onOpenPlayer: () => void;
}) {
  const needsLogin = mobile && !signedIn;
  const needsBridge = !mobile && !connected;
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      <Animated.View entering={entrance} style={styles.card}>
        <BlurView pointerEvents="none" intensity={30} tint="dark" style={StyleSheet.absoluteFill} />
        <Ionicons name={needsBridge ? 'desktop-outline' : needsLogin ? 'person-outline' : 'musical-notes-outline'} size={28} color="#FFFFFF" />
        <Text style={styles.title}>
          {needsBridge ? 'Desktop Bridge is not connected' : needsLogin ? 'No Spotify Login' : 'Play a song on Spotify'}
        </Text>
        {(mobile || needsBridge) && (
          <MotionPressable
            accessibilityLabel={needsLogin ? 'Sign in with Spotify' : undefined}
            onPress={needsBridge ? onConnect : needsLogin ? onSignIn : onOpenPlayer}
            style={styles.button}>
            <Ionicons name={needsBridge ? 'qr-code-outline' : needsLogin ? 'log-in-outline' : 'play'} size={18} color="#FFFFFF" />
            <Text style={styles.buttonText}>{needsBridge ? 'Scan QR code' : needsLogin ? 'Log In' : 'Open Spotify'}</Text>
          </MotionPressable>
        )}
      </Animated.View>
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  container: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 16 },
  card: { width: '100%', maxWidth: 320, alignItems: 'center', padding: 22, gap: 18, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', backgroundColor: 'rgba(255,255,255,0.04)', overflow: 'hidden' },
  title: { color: '#FFFFFF', fontSize: 21, fontWeight: '600', letterSpacing: -0.4, textAlign: 'center' },
  button: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', borderRadius: 14, paddingHorizontal: 18, paddingVertical: 12 },
  buttonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', flexShrink: 1 },
});
