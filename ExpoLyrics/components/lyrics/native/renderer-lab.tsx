import React, { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { NativeLyricsView } from '@/components/lyrics/native/native-lyrics-view';
import { DEMO_LYRICS } from '@/lib/onboarding-demo-lyrics';
import type { LyricLine } from '@/types/bridge';
import { usePlaybackStore } from '@/store/playback-store';

// Explicit extensions select the unchanged reference hosts, independent of native platform resolution.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AmllLyricsView } = require('../amll-lyrics-view.tsx') as typeof import('@/components/lyrics/amll-lyrics-view');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SpicyLyricsView } = require('../spicy-lyrics-view.tsx') as typeof import('@/components/lyrics/spicy-lyrics-view');

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
const paritySession = globalThis as typeof globalThis & { nativeLyricsParityFixture?: LyricLine[];
  nativeLyricsParityArm?: (position: number, playing: boolean) => void };

/** Development-only deterministic workload; live fixtures snapshot already fetched lyrics without changing playback. */
export function RendererLab() {
  const params = useLocalSearchParams<{ renderer?: string; backend?: string; reveal?: string; lines?: string; position?: string; paused?: string; stall?: string; run?: string; fixture?: string }>();
  const style = params.renderer === 'amll' ? 'amll' : 'spicy';
  const backend = params.backend === 'webview' ? 'webview' : params.backend === 'flat' ? 'flat' : 'flash';
  const reveal = params.reveal === 'tree' ? 'tree' : params.reveal === 'canvas' ? 'canvas' : params.reveal === 'mask' ? 'mask' : 'clip';
  const count = Math.max(5, Math.min(2000, Number(params.lines) || 100));
  const requestedStart = Math.max(0, Number(params.position) || 1000);
  const [playback, setPlayback] = useState({ start: requestedStart, playing: params.paused !== '1' });
  const { start, playing } = playback;
  useEffect(() => { setPlayback({ start: requestedStart, playing: params.paused !== '1' }); }, [requestedStart, params.paused, params.run]);
  useEffect(() => {
    const arm = (position: number, isPlaying: boolean) => setPlayback({ start: position, playing: isPlaying });
    paritySession.nativeLyricsParityArm = arm;
    return () => { if (paritySession.nativeLyricsParityArm === arm) delete paritySession.nativeLyricsParityArm; };
  }, []);
  const lyrics = useMemo<LyricLine[]>(() => Array.from({ length: count }, (_, index) => {
    const template = DEMO_LYRICS[index % DEMO_LYRICS.length];
    if (params.fixture === 'static') return { ...template, lineStartTime: 0, lineEndTime: 0,
      syllables: template.syllables.map(part => ({ ...part, startTime: 0, endTime: 0 })),
      backgroundSyllables: template.backgroundSyllables?.map(part => ({ ...part, startTime: 0, endTime: 0 })) };
    const offset = index * 5000 - template.lineStartTime;
    return { ...template, lineStartTime: index * 5000, lineEndTime: index * 5000 + 4600,
      syllables: template.syllables.map(part => ({ ...part, startTime: part.startTime + offset, endTime: part.endTime + offset })),
      backgroundSyllables: template.backgroundSyllables?.map(part => ({ ...part, startTime: part.startTime + offset, endTime: part.endTime + offset })) };
  }), [count, params.fixture]);
  const liveLyrics = useMemo(() => params.fixture === 'live'
    ? paritySession.nativeLyricsParityFixture ??= usePlaybackStore.getState().lyrics : undefined, [params.fixture]);
  const commits = useRef<number[]>([]);
  const onRender = useCallback((_id: string, _phase: string, duration: number) => { commits.current.push(duration); }, []);
  const [summary, setSummary] = useState('Recording 12s after 3s warmup');
  useEffect(() => {
    console.info('KINESYNC_LAB_READY ' + JSON.stringify({ run: params.run, style, backend, reveal }));
    commits.current = [];
    setSummary('Recording 12s after 3s warmup');
    const delays: number[] = [];
    let expected = performance.now() + 50;
    const began = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      if (now - began > 3000) delays.push(Math.max(0, now - expected));
      expected = now + 50;
    }, 50);
    const blocker = params.stall === '1' ? setInterval(() => { const until = performance.now() + 150; while (performance.now() < until) { /* deliberate JS contention */ } }, 1000) : undefined;
    const timeout = setTimeout(() => {
      clearInterval(interval);
      if (blocker) clearInterval(blocker);
      const result = { run: params.run, style, backend, reveal, count: liveLyrics?.length ?? count, start, playing, injectedJsStalls: !!blocker,
        jsDelaySamples: delays.length, jsDelayP95Ms: percentile(delays, 0.95), jsDelayMaxMs: Math.max(0, ...delays),
        reactCommits: commits.current.length, reactCommitP95Ms: percentile(commits.current, 0.95),
        scope: 'Exploratory debug build. React Profiler timings may be disabled by the runtime. Use SurfaceFlinger for presentation metrics.' };
      console.info('KINESYNC_NATIVE_PROFILE ' + JSON.stringify(result));
      setSummary(`JS delay p95 ${result.jsDelayP95Ms?.toFixed(1)}ms · ${result.reactCommits} React commits`);
    }, 15000);
    return () => { clearInterval(interval); clearTimeout(timeout); if (blocker) clearInterval(blocker); };
  }, [backend, count, liveLyrics, params.run, params.stall, playing, reveal, start, style]);
  const Reference = style === 'amll' ? AmllLyricsView : SpicyLyricsView;
  const fixture = liveLyrics ?? lyrics;
  const demoDurationMs = useMemo(() => Math.max(25000, ...fixture.map(line => Math.max(line.lineEndTime,
    ...(line.backgroundSyllables ?? []).map(part => part.endTime),
    ...(line.spicyBackgrounds ?? []).map(block => block.lineEndTime)))) + 1000, [fixture]);
  const shared = { demoLyrics: liveLyrics ?? lyrics, demoLayout: 'player' as const, demoIsPlaying: playing,
    demoDurationMs, previewPositionMs: start, tapToSeekEnabled: false, showTranslatedText: true };
  return <View style={styles.root}>
    <Stack.Screen options={{ headerShown: false }} />
    <View style={styles.status}><Text style={styles.label}>{style} · {backend} · {reveal} · {liveLyrics?.length ?? count} lines</Text><Text style={styles.caption}>{summary}</Text></View>
    <Profiler id="lyrics" onRender={onRender}>
      {backend === 'webview' ? <Reference key={params.run} {...shared} /> : <NativeLyricsView key={`${style}:${backend}:${reveal}:${params.run}`} {...shared} style={style} list={backend} reveal={reveal} />}
    </Profiler>
  </View>;
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: '#191326', paddingTop: 30 },
  status: { paddingHorizontal: 18, paddingVertical: 8 }, label: { color: '#fff', fontSize: 14 }, caption: { color: '#aaa', fontSize: 11 } });
