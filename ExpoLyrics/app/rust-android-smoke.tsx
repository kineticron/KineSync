import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { usePlaybackStore } from '@/store/playback-store';
import { DEMO_LYRICS } from '@/lib/onboarding-demo-lyrics';

// Development-only fixture host for the Android emulator smoke test.
// Release bundles redirect away; nothing here is reachable from the UI.
export default function RustAndroidSmokeRoute() {
  if (!__DEV__) return <Redirect href="/" />;
  return <Smoke />;
}

function Smoke() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    usePlaybackStore.setState({
      currentTrack: { id: 'smoke-fixture', title: 'Fixture', artist: 'KineSync', durationMs: 60000 },
      lyrics: DEMO_LYRICS, lyricsStyle: 'amll', showRustDebugOverlay: true,
      anchorPositionMs: 6000, anchorMonotonicMs: performance.now(), isPlaying: false,
    });
    setReady(true);
  }, []);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RustLyricsView } = require('@/components/lyrics/rust/rust-lyrics-view') as typeof import('@/components/lyrics/rust/rust-lyrics-view');
  return <View style={{ flex: 1, backgroundColor: '#191326', paddingTop: 30 }}>
    <Stack.Screen options={{ headerShown: false }} />
    <Text style={{ color: '#0f0', fontSize: 12, position: 'absolute', top: 4, left: 8, zIndex: 9 }}>SMOKE ROUTE MOUNTED</Text>
    {ready ? <RustLyricsView active tapToSeekEnabled={false} /> : null}
  </View>;
}
