import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { usePlaybackStore } from '@/store/playback-store';
import { anchorChanged, buildRustTrack, projectPosition } from '@/lib/rust-lyrics-protocol';

type NativeApi = { abiVersion(): number; monotonicMs(): number };
type NativeRef = { setAnchor(value: string): Promise<void> };
type Metrics = { frames: number; generation: number; positionMs: number; sampleNativeMs: number; playing: boolean; rate: number;
  cpuSceneMs: number; cpuEncodeMs: number; gpuIntervalMs: number; waitMs: number; presentWaitMs: number;
  uiTickMs: number; displayIntervalMs: number; skippedDisplayCallbacks: number };
type Props = ViewProps & { trackJson: string; active: boolean; ref?: React.Ref<NativeRef>;
  onStatus(event: { nativeEvent: { state: string; message: string; generation: number } }): void;
  onMetrics(event: { nativeEvent: Metrics }): void };
// No native require on Android/web/Expo Go. Missing modules are an explicit unavailable state.
function loadNative(): { api: NativeApi | null; view: React.ComponentType<Props> | null; error: string } {
  if (!__DEV__) return { api: null, view: null, error: 'Rust renderer is available only in a development client' };
  if (Platform.OS !== 'ios') return { api: null, view: null, error: 'Rust native surface is available on iOS only' };
  try {
    const api = requireOptionalNativeModule<NativeApi>('KineSyncRustLyrics');
    if (!api || api.abiVersion() !== 1) return { api: null, view: null, error: 'Rust module unavailable or ABI mismatch. Rebuild the custom arm64 development client. Expo Go is unsupported.' };
    return { api, view: requireNativeViewManager<Props>('KineSyncRustLyrics'), error: '' };
  } catch (error) { return { api: null, view: null, error: `Rust module unavailable: ${String(error)}` }; }
}
const { api, view: NativeView, error: moduleError } = loadNative();
let nextGeneration = 0;
function generation() {
  nextGeneration = Math.max(nextGeneration + 1, Math.floor(performance.now() * 1000));
  return nextGeneration;
}

/** Development-only selection in the actual player, using its current track/store anchors. */
export const RustLyricsView = memo(function RustLyricsView({ active, previewPositionMs }: { active: boolean; previewPositionMs?: number | null }) {
  const lyrics = usePlaybackStore(state => state.lyrics);
  const trackId = usePlaybackStore(state => state.currentTrack?.id ?? '');
  const revision = useMemo(() => ({ generation: generation(), lyrics, trackId }), [lyrics, trackId]);
  const payload = useMemo(() => {
    try { return { json: buildRustTrack(trackId, revision.generation, lyrics), error: '' }; }
    catch (error) { return { json: '', error: String(error) }; }
  }, [lyrics, trackId, revision.generation]);
  const native = useRef<NativeRef | null>(null);
  const sequence = useRef(0);
  const work = useRef({ renders: 0, anchors: 0, anchorMs: 0 });
  work.current.renders++;
  const [surfaceEpoch, setSurfaceEpoch] = useState(0);
  const [rate, setRate] = useState(1);
  const [showMetrics, setShowMetrics] = useState(false);
  const [status, setStatus] = useState('Preparing Rust Metal renderer');
  const [failed, setFailed] = useState(false);
  const [metrics, setMetrics] = useState<{ native: Metrics; delta: number; deliveryMs: number } | null>(null);
  const identity = useRef({ generation: revision.generation, surfaceEpoch });
  identity.current = { generation: revision.generation, surfaceEpoch };
  const latestMetrics = useRef<{ native: Metrics; delta: number; deliveryMs: number } | null>(null);
  const sendAnchor = useCallback(() => {
    if (!api || !native.current || payload.error || identity.current.generation !== revision.generation || identity.current.surfaceEpoch !== surfaceEpoch) return;
    const state = usePlaybackStore.getState();
    if (state.currentTrack?.id !== trackId) return;
    const started = performance.now();
    const position = previewPositionMs ?? projectPosition(state, started);
    const command = { generation: revision.generation, sequence: ++sequence.current,
      positionMs: position, nativeMs: api.monotonicMs(), playing: previewPositionMs == null && state.isPlaying, rate };
    work.current.anchors++;
    void native.current.setAnchor(JSON.stringify(command)).catch(error => {
      if (identity.current.generation !== revision.generation || identity.current.surfaceEpoch !== surfaceEpoch) return;
      setFailed(true); setStatus(String(error));
    });
    work.current.anchorMs = performance.now() - started;
  }, [payload.error, previewPositionMs, rate, revision.generation, surfaceEpoch, trackId]);
  useEffect(() => {
    sendAnchor();
    const unsubscribe = usePlaybackStore.subscribe((state, previous) => { if (anchorChanged(state, previous)) sendAnchor(); });
    const appState = AppState.addEventListener('change', state => { if (state === 'active') sendAnchor(); });
    return () => { unsubscribe(); appState.remove(); };
  }, [active, sendAnchor]);
  const onStatus = useCallback(({ nativeEvent }: { nativeEvent: { state: string; message: string; generation: number } }) => {
    if (identity.current.generation !== revision.generation || identity.current.surfaceEpoch !== surfaceEpoch || nativeEvent.generation !== revision.generation) return;
    setStatus(nativeEvent.message);
    setFailed(nativeEvent.state === 'error');
    if (nativeEvent.state === 'ready') sendAnchor();
  }, [revision.generation, sendAnchor, surfaceEpoch]);
  const onMetrics = useCallback(({ nativeEvent: value }: { nativeEvent: Metrics }) => {
    if (identity.current.generation !== revision.generation || identity.current.surfaceEpoch !== surfaceEpoch || value.generation !== revision.generation || !api) return;
    const now = performance.now();
    const deliveryMs = Math.max(0, api.monotonicMs() - value.sampleNativeMs);
    const projected = value.positionMs + (value.playing ? deliveryMs * value.rate : 0);
    latestMetrics.current = { native: value, delta: projected - projectPosition(usePlaybackStore.getState(), now), deliveryMs };
    if (showMetrics) setMetrics(latestMetrics.current);
  }, [revision.generation, showMetrics, surfaceEpoch]);
  const unavailable = moduleError || payload.error;
  return <View style={styles.root}>
    {!unavailable && NativeView ? <NativeView key={surfaceEpoch} ref={native} style={styles.canvas} trackJson={payload.json} active={active} onStatus={onStatus} onMetrics={onMetrics} /> : null}
    <View pointerEvents="box-none" style={styles.overlay}>
      <Text style={styles.caption}>{unavailable || (failed ? `Rust error: ${status}` : status)}</Text>
      <View style={styles.actions}>
      {!unavailable ? <Pressable accessibilityRole="button" onPress={() => { setSurfaceEpoch(value => value + 1); setFailed(false); setMetrics(null); setStatus('Recreating Rust surface'); }}>
        <Text style={styles.caption}>Recreate Rust surface</Text>
      </Pressable> : null}
      {!unavailable && !failed ? <Pressable accessibilityRole="button" onPress={() => setRate(value => value === 1 ? 0.5 : value === 0.5 ? 1.5 : 1)}>
        <Text style={styles.caption}>Visual rate {rate}× · audio unchanged</Text>
      </Pressable> : null}
      {!unavailable ? <Pressable accessibilityRole="button" onPress={() => { setShowMetrics(value => !value); setMetrics(latestMetrics.current); }}>
        <Text style={styles.caption}>{showMetrics ? 'Hide metrics' : 'Show metrics'}</Text>
      </Pressable> : null}
      </View>
      {showMetrics && metrics && metrics.native.generation === revision.generation && !failed && !unavailable ? <Text style={styles.metrics}>
        {`Rust frames ${metrics.native.frames} · scene ${metrics.native.cpuSceneMs.toFixed(2)} ms · encode ${metrics.native.cpuEncodeMs.toFixed(2)} ms\n`}
        {`GPU Vello+blur ${metrics.native.gpuIntervalMs < 0 ? 'unsupported' : metrics.native.gpuIntervalMs.toFixed(2) + ' ms'} · present+wait ${metrics.native.presentWaitMs.toFixed(2)} ms\n`}
        {`UI tick ${metrics.native.uiTickMs.toFixed(2)} ms · skipped callbacks ${metrics.native.skippedDisplayCallbacks}\n`}
        {`JS anchors ${work.current.anchors} · renders ${work.current.renders} · anchor work ${work.current.anchorMs.toFixed(2)} ms\n`}
        {`Native − JS ${metrics.delta.toFixed(1)} ms · sample age ${metrics.deliveryMs.toFixed(1)} ms\nExperimental metrics, no phone performance conclusion`}
      </Text> : null}
    </View>
  </View>;
});
const styles = StyleSheet.create({
  root: { flex: 1 }, canvas: { flex: 1 },
  overlay: { position: 'absolute', top: 8, left: 28, right: 28 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  caption: { color: 'rgba(255,255,255,0.68)', fontSize: 11, marginBottom: 4 },
  metrics: { color: 'rgba(255,255,255,0.48)', fontSize: 10, lineHeight: 14 },
});
