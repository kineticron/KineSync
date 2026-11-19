import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LyricsAttribution } from '@/components/lyrics/lyrics-attribution';
import type { LyricsMetadata } from '@/types/bridge';
import { Design } from '@/constants/design';

const mockMetadata: LyricsMetadata = {
  attribution: {
    source: 'spicy_lyrics',
    provider: 'Spicy Lyrics',
    uploader: {
      username: 'syncmaker',
      url: 'https://spicylyrics.org/profile/syncmaker',
    },
    maker: {
      username: 'lyricmaker',
      url: 'https://spicylyrics.org/profile/lyricmaker',
    },
  },
  credits: {
    songwriters: ['Test Writer'],
  },
};

export default function AttributionThrowawayRoute() {
  const controlsProgress = useSharedValue(1);
  const controlsTarget = useSharedValue(1);
  const controlsVisible = true;
  const controlsHeight = 100;
  const bottomInset = 0;
  const [interactions, setInteractions] = useState(0);

  const handleInteraction = useCallback(() => {
    setInteractions(c => c + 1);
  }, []);

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        {/* Mock background lyrics to simulate live player context */}
        <View style={styles.playerBackground}>
          <View style={styles.trackHeader}>
            <Text style={styles.trackTitle}>Spicy Sync Reference Track</Text>
            <Text style={styles.trackArtist}>Test Artist &middot; Reference Album</Text>
          </View>
          <View style={styles.lyricsList}>
            <Text style={styles.inactiveLyric}>Previous lyric line fading into atmosphere</Text>
            <Text style={styles.activeLyric}>Active lyric line singing now in karaoke glow</Text>
            <Text style={styles.futureLyric}>Next upcoming syllable line in synced timing</Text>
            <Text style={styles.futureLyric}>Another line waiting in the synchronized stream</Text>
          </View>
        </View>

        {/* Real production LyricsAttribution component */}
        <LyricsAttribution
          metadata={mockMetadata}
          trackId="reference-spicy-track"
          controlsProgress={controlsProgress}
          controlsTarget={controlsTarget}
          controlsVisible={controlsVisible}
          controlsHeight={controlsHeight}
          bottomInset={bottomInset}
          onInteraction={handleInteraction}
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Design.background,
    width: '100%',
    height: '100%',
    overflow: 'hidden',
  },
  safeArea: {
    flex: 1,
    position: 'relative',
  },
  playerBackground: {
    flex: 1,
    paddingTop: 54,
    paddingHorizontal: 24,
    justifyContent: 'flex-start',
  },
  trackHeader: {
    marginBottom: 40,
  },
  trackTitle: {
    color: Design.text,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.4,
    marginBottom: 6,
  },
  trackArtist: {
    color: Design.muted,
    fontSize: 15,
    fontWeight: '500',
  },
  lyricsList: {
    gap: 22,
  },
  inactiveLyric: {
    color: 'rgba(255, 255, 255, 0.35)',
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 32,
  },
  activeLyric: {
    color: '#FFF',
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 36,
  },
  futureLyric: {
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 32,
  },
});
