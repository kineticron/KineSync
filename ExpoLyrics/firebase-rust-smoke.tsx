// Isolated Firebase fixture entry. Selected only by the smoke Gradle property.
import React, { useEffect, useState } from 'react';
import { AppRegistry, View } from 'react-native';
import { hideAsync } from 'expo-splash-screen';
import { usePlaybackStore } from '@/store/playback-store';
import { DEMO_LYRICS } from '@/lib/onboarding-demo-lyrics';
import { RustLyricsView } from '@/components/lyrics/rust/rust-lyrics-view';

function FirebaseRustSmoke() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!__DEV__) throw new Error('Firebase Rust fixture requires a development JS bundle');
    const configure = () => usePlaybackStore.setState({
      currentTrack: { id: 'firebase-smoke-fixture', title: 'Fixture', artist: 'KineSync', durationMs: 60000 },
      lyrics: DEMO_LYRICS, lyricsStyle: 'amll', showRustDebugOverlay: true,
      anchorPositionMs: 6000, anchorMonotonicMs: performance.now(), isPlaying: true,
    });
    configure();
    console.info('KineSyncRust Firebase fixture ready, development JS with bundled native host');
    setReady(true);
    void hideAsync();
    const loop = setInterval(configure, 45000);
    return () => clearInterval(loop);
  }, []);
  return <View style={{ flex: 1, backgroundColor: '#191326', paddingTop: 30 }}>
    {ready ? <RustLyricsView active tapToSeekEnabled={false} /> : null}
  </View>;
}

AppRegistry.registerComponent('main', () => FirebaseRustSmoke);
