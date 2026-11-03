import React, { useEffect, useState } from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import type { LyricLine } from '@/types/bridge';
import { startArrivalCapture, beginArrival, arrivalEvent, snapshotArrivalCapture, stopArrivalCapture } from '@/lib/lyrics-arrival-trace';
import { NativeLyricsView } from '@/components/lyrics/native/native-lyrics-view';

/** Synthetic fixture workload on the real native renderer; never a live-network baseline. */
export default function ArrivalLab() {
  const params = useLocalSearchParams<{ style: string; orientation: string; scenario: string; run: string }>();
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  useEffect(() => {
    if (!__DEV__) return;
    startArrivalCapture();
    const timer = setTimeout(() => {
      const packet: LyricLine[] = Array.from({ length: 100 }, (_, index) => ({
        text: 'Native arrival fixture', lineStartTime: index * 2000, lineEndTime: index * 2000 + (params.scenario === 'overlap' ? 8000 : 1800),
        syllables: [{ text: 'Native arrival fixture', startTime: index * 2000, endTime: index * 2000 + 1800 }],
      }));
      const handle = beginArrival(packet, 'synthetic-native-fixture');
      arrivalEvent(handle, 0, 'fixture-delivered-not-network', undefined, undefined, packet.length);
      setLyrics(packet);
    }, 500);
    const finish = setTimeout(() => {
      const payload = JSON.stringify({ run: params.run, style: params.style, orientation: params.orientation,
        scenario: params.scenario, workload: 'synthetic fixture; hardware results require physical-device verification', trace: snapshotArrivalCapture() });
      const total = Math.ceil(payload.length / 1200);
      for (let index = 0; index < total; index++) console.log('KINESYNC_ARRIVAL_CHUNK ' + JSON.stringify({
        run: params.run, index, total, data: payload.slice(index * 1200, (index + 1) * 1200),
      }));
      stopArrivalCapture();
    }, 10000);
    return () => { clearTimeout(timer); clearTimeout(finish); stopArrivalCapture(); };
  }, [params.run, params.style, params.orientation, params.scenario]);
  if (!__DEV__) return <Redirect href="/" />;
  return <View style={{ flex: 1, backgroundColor: '#000' }}><NativeLyricsView style={params.style === 'spicy' ? 'spicy' : 'amll'}
    reveal="canvas" list="flash" demoLyrics={lyrics} demoLayout="player" demoIsPlaying={false}
    previewPositionMs={params.scenario === 'mid-song' || params.scenario === 'overlap' ? 90000 : 0}
    landscapeMode={params.orientation === 'landscape'} tapToSeekEnabled={false} /></View>;
}
