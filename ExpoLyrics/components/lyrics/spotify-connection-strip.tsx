import { memo } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlaybackStore } from '@/store/playback-store';
import { usePlayerTourStore } from '@/store/player-tour-store';
import { useSpotifyConnectionStore } from '@/store/spotify-connection-store';
import { spotifyHealthMessage } from '@/lib/spotify-detector/health';
import { requestOpenSpotifyBrowser, requestReloadSpotifyBrowser } from '@/lib/spotify-player-actions';

/** Independent of lyrics, artwork, renderer readiness and the bootstrap browser. */
export const SpotifyConnectionStrip = memo(function SpotifyConnectionStrip() {
  const selected = usePlaybackStore(s => s.playbackMode === 'mobile' && s.connectionStatus !== 'connected');
  const tour = usePlayerTourStore(s => s.active || s.pending);
  const h = useSpotifyConnectionStore(s => s.health);
  const insets = useSafeAreaInsets();
  if (!selected || tour) return null;
  const signIn = h.phase === 'signInRequired' || h.phase === 'denied' || h.phase === 'idle';
  const openDevice = h.phase === 'ready' && h.target === 'absent';
  const retry = h.phase === 'retryWait';
  return <View style={[styles.strip, { top: insets.top + 4 }]}>
    <Text accessibilityLiveRegion="polite" style={styles.message}>{spotifyHealthMessage(h)}{h.phase !== 'ready' || h.target === 'absent' ? ' · Last known playback' : ''}</Text>
    {(signIn || openDevice || retry) && <Pressable accessibilityRole="button"
      accessibilityLabel={openDevice ? 'Open Spotify' : signIn ? 'Review Spotify sign-in' : 'Retry Spotify connection'}
      hitSlop={8} onPress={() => {
        if (openDevice) { void Linking.openURL('spotify://').catch(() => {}); }
        else if (signIn) requestOpenSpotifyBrowser();
        else requestReloadSpotifyBrowser();
      }}><Text style={styles.action}>{openDevice ? 'Open Spotify' : signIn ? 'Sign in' : 'Retry now'}</Text></Pressable>}
  </View>;
});
const styles = StyleSheet.create({
  strip: { position: 'absolute', zIndex: 30, alignSelf: 'center', maxWidth: '94%', flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 12, backgroundColor: 'rgba(12,20,18,0.92)', borderWidth: 1, borderColor: 'rgba(143,240,196,0.18)' },
  message: { color: '#E5EEE9', fontSize: 11, flexShrink: 1, lineHeight: 16 },
  action: { color: '#8FF0C4', fontSize: 12, fontWeight: '600' },
});
