import React, { useEffect, useState } from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { buildArrivalFixture, ARRIVAL_LAB_WORKLOAD } from '@/lib/fixtures/lyrics-arrival-fixture';
import type { LyricLine } from '@/types/bridge';
import { startArrivalCapture, beginArrival, arrivalEvent, snapshotArrivalCapture, stopArrivalCapture, flushArrivalUiCounts } from '@/lib/lyrics-arrival-trace';
import { NativeLyricsView } from '@/components/lyrics/native/native-lyrics-view';

/** Synthetic fixture workload on the real native renderer; never a live-network baseline. */
export default function ArrivalLab() {
  const params = useLocalSearchParams<{ style: string; orientation: string; scenario: string; run: string }>();
  const previewPositionMs = params.scenario === 'mid-song' || params.scenario === 'overlap' ? 90000 : 0;
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  useEffect(() => {
    if (!__DEV__) return;
    startArrivalCapture();
    const timer = setTimeout(() => {
      const packet = buildArrivalFixture(params.scenario === 'overlap');
      const handle = beginArrival(packet, 'synthetic-native-fixture');
      arrivalEvent(handle, 0, 'fixture-delivered-not-network', undefined, undefined, packet.length);
      setLyrics(packet);
    }, 500);
    const finish = setTimeout(async () => {
      await flushArrivalUiCounts();
      const payload = JSON.stringify({ run: params.run, style: params.style, orientation: params.orientation,
        scenario: params.scenario, previewPositionMs, playing: false, fixtureRows: 100, initializedDelayMs: 500, workload: ARRIVAL_LAB_WORKLOAD, host: 'initialized for 500ms before packet; paused fixed preview; OS/font/GPU caches uncontrolled', trace: snapshotArrivalCapture() });
      const total = Math.ceil(payload.length / 1200);
      for (let index = 0; index < total; index++) console.log('KINESYNC_ARRIVAL_CHUNK ' + JSON.stringify({
        run: params.run, index, total, data: payload.slice(index * 1200, (index + 1) * 1200),
      }));
      stopArrivalCapture();
    }, 10000);
    return () => { clearTimeout(timer); clearTimeout(finish); stopArrivalCapture(); };
  }, [params.run, params.style, params.orientation, params.scenario, previewPositionMs]);
  if (!__DEV__) return <Redirect href="/" />;
  return <View style={{ flex: 1, backgroundColor: '#000' }}><NativeLyricsView style={params.style === 'spicy' ? 'spicy' : 'amll'}
    reveal="canvas" list="flash" demoLyrics={lyrics} demoLayout="player" demoIsPlaying={false}
    previewPositionMs={previewPositionMs}
    landscapeMode={params.orientation === 'landscape'} tapToSeekEnabled={false} /></View>;
}
