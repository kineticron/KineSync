import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { usePlaybackStore } from '@/store/playback-store';
import { anchorChanged, nextVisualAnchor, projectPosition, type VisualAnchor } from '@/lib/rust-lyrics-protocol';
import { createRustLyricsGesture } from '@/lib/rust-lyrics-gesture';
import type { LyricLine } from '@/types/bridge';

import { prepareRustTrack } from '@/lib/rust-lyrics-preparation';
import { LANDSCAPE_FONT_SCALE } from '@/constants/player-layout';

type NativeApi = { abiVersion(): number; monotonicMs(): number };
type NativeRef = { setAnchor(value: string): Promise<void>; setFollowing(value: boolean): Promise<void>; scrollBy(dy: number): Promise<void>; hitTest(y: number): Promise<number> };
type Metrics = { frames: number; generation: number; positionMs: number; sampleNativeMs: number; targetNativeMs: number; playing: boolean; rate: number;
  cpuSceneMs: number; cpuEncodeMs: number; gpuIntervalMs: number; waitMs: number; cpuBlitMs: number; acquireMs: number; blitSubmitMs: number; pollMs: number; presentCallMs: number; gpuCompleted: number; gpuOutstanding: number; gpuBusy: number;
  uiTickMs: number; displayIntervalMs: number; callbackTotal: number; submitted: number; idle: number; busy: number; inactive: number; noDrawable: number;
  missedObservedIntervalsEstimate: number; requestedHz: number; deliveredCallbackHz: number; presentCallRate: number; windowSeconds: number;
  gpuRendering: boolean; computeBlur: boolean; adapterTimestampQuery: boolean; adapterEncoderTimestamp: boolean; enabledBracketFeatures: boolean; profilerReason: string };
type Props = ViewProps & { trackJson: string; active: boolean; ref?: React.Ref<NativeRef>;
  onStatus(event: { nativeEvent: { state: string; message: string; generation: number } }): void;
  onMetrics(event: { nativeEvent: Metrics }): void };
// No native require on Android/web/Expo Go. Missing modules are an explicit unavailable state.
function loadNative(): { api: NativeApi | null; view: React.ComponentType<Props> | null; error: string } {
  if (!__DEV__) return { api: null, view: null, error: 'Rust renderer is available only in a development client' };
  if (Platform.OS !== 'ios') return { api: null, view: null, error: 'Rust native surface is available on iOS only' };
  try {
    const api = requireOptionalNativeModule<NativeApi>('KineSyncRustLyrics');
    if (!api || api.abiVersion() !== 8) return { api: null, view: null, error: 'Rust module unavailable or ABI mismatch. Rebuild the custom arm64 development client. Expo Go is unsupported.' };
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
export const RustLyricsView = memo(function RustLyricsView({ active, previewPositionMs, tapToSeekEnabled, autoFollowEnabled, resumeAutoFollowSignal, onLinePress, onLineLongPress, onAutoFollowChange, onUserInteraction }: {
  active: boolean; previewPositionMs?: number | null; tapToSeekEnabled: boolean; autoFollowEnabled?: boolean; resumeAutoFollowSignal?: number;
  onLinePress?: (line: LyricLine) => void; onLineLongPress?: (line: LyricLine) => void;
  onAutoFollowChange?: (enabled: boolean) => void; onUserInteraction?: () => void;
}) {
  const lyrics = usePlaybackStore(state => state.lyrics);
  const metadata = usePlaybackStore(state => state.lyricsMetadata);
  const credits = useMemo(() => {
    const songwriters = metadata?.credits?.songwriters?.filter(name => typeof name === 'string' && name.length > 0) ?? [];
    const a = metadata?.attribution;
    const attribution = a ? {
      ...(a.provider ? { provider: a.provider } : {}),
      ...(a.community ? { community: true } : {}),
      ...(a.maker?.username ? { maker: a.maker.username } : {}),
      ...(a.uploader?.username ? { uploader: a.uploader.username } : {}),
    } : null;
    const hasAttribution = attribution && Object.keys(attribution).length > 0;
    if (!songwriters.length && !hasAttribution) return null;
    return { ...(songwriters.length ? { songwriters } : {}), ...(hasAttribution ? { attribution } : {}) };
  }, [metadata]);
  const showRustDebugOverlay = usePlaybackStore(state => state.showRustDebugOverlay);
  const trackId = usePlaybackStore(state => state.currentTrack?.id ?? '');
  const style = usePlaybackStore(state => state.lyricsStyle);
  const showTranslation = usePlaybackStore(state => state.showTranslatedText);
  const window = useWindowDimensions();
  const landscape = window.width > window.height;
  const fontScale = landscape ? LANDSCAPE_FONT_SCALE : 1;
  const revision = useMemo(() => ({ generation: generation(), lyrics, trackId, style, fontScale, landscape, showTranslation }), [lyrics, trackId, style, fontScale, landscape, showTranslation]);
  const payload = useMemo(() => {
    try { return { json: prepareRustTrack(trackId, revision.generation, lyrics, style === 'amll' ? 'amll' : 'spicy', fontScale, landscape, showTranslation, credits), error: '' }; }
    catch (error) { return { json: '', error: String(error) }; }
  }, [lyrics, trackId, revision.generation, style, fontScale, landscape, showTranslation, credits]);
  const native = useRef<NativeRef | null>(null);
  const sequence = useRef(0);
  const visual = useRef<(VisualAnchor & { generation: number }) | null>(null);
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
  const latest = useRef({ tapToSeekEnabled, onLinePress, onLineLongPress, onAutoFollowChange, onUserInteraction, lyrics });
  latest.current = { tapToSeekEnabled, onLinePress, onLineLongPress, onAutoFollowChange, onUserInteraction, lyrics };
  const gesture = useMemo(() => createRustLyricsGesture({
    hitTest: y => native.current ? native.current.hitTest(y) : Promise.resolve(-1),
    scrollBy: dy => { void native.current?.scrollBy(dy).catch(() => {}); },
    setFollowing: following => { void native.current?.setFollowing(following).catch(() => {}); },
    tapEnabled: () => latest.current.tapToSeekEnabled,
    onLinePress: index => { const line = latest.current.lyrics[index]; if (line) latest.current.onLinePress?.(line); },
    onLineLongPress: index => { const line = latest.current.lyrics[index]; if (line) latest.current.onLineLongPress?.(line); },
    onAutoFollowChange: enabled => latest.current.onAutoFollowChange?.(enabled),
    onUserInteraction: () => latest.current.onUserInteraction?.(),
  }), []);
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: event => gesture.grant(event.nativeEvent.locationY),
    onPanResponderMove: (_event, state) => gesture.move(state.dy),
    onPanResponderRelease: () => gesture.release(),
    onPanResponderTerminate: () => gesture.terminate(),
    onPanResponderTerminationRequest: () => false,
  }), [gesture]);
  useEffect(() => () => gesture.terminate(), [gesture]);
  const followEnabled = autoFollowEnabled ?? true;
  useEffect(() => {
    if (!api || !native.current) return;
    void native.current.setFollowing(followEnabled).catch(error => { setFailed(true); setStatus(String(error)); });
    // `resumeAutoFollowSignal` re-asserts the same value after the player's
    // explicit resume gesture; the number itself carries no state.
  }, [followEnabled, resumeAutoFollowSignal, revision.generation, surfaceEpoch]);
  const sendAnchor = useCallback(() => {
    if (!api || !native.current || payload.error || identity.current.generation !== revision.generation || identity.current.surfaceEpoch !== surfaceEpoch) return;
    const state = usePlaybackStore.getState();
    if (state.currentTrack?.id !== trackId) return;
    const started = performance.now();
    const previous = visual.current?.generation === revision.generation ? visual.current : null;
    const next = nextVisualAnchor(state, started, api.monotonicMs(), rate, previous, previewPositionMs);
    visual.current = { ...next, generation: revision.generation };
    const { positionMs, nativeMs, playing, snap } = next;
    const command = { generation: revision.generation, sequence: ++sequence.current, positionMs, nativeMs, playing, rate, snap };
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
    const projected = value.positionMs + (value.playing ? (api.monotonicMs() - value.targetNativeMs) * value.rate : 0);
    latestMetrics.current = { native: value, delta: projected - projectPosition(usePlaybackStore.getState(), now), deliveryMs };
    if (showRustDebugOverlay && showMetrics) setMetrics(latestMetrics.current);
  }, [revision.generation, showRustDebugOverlay, showMetrics, surfaceEpoch]);
  const unavailable = moduleError || payload.error;
  useEffect(() => {
    if (unavailable || failed) console.error('Rust lyrics renderer:', unavailable || status);
  }, [unavailable, failed, status]);
  return <View style={styles.root}>
    {showRustDebugOverlay ? <ScrollView style={styles.overlay} contentContainerStyle={styles.diagnostics}>
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
        {`Rust present calls ${metrics.native.frames} · scene ${metrics.native.cpuSceneMs.toFixed(2)} ms · encode ${metrics.native.cpuEncodeMs.toFixed(2)} ms\n`}
        {`Metal GPU Vello ${metrics.native.gpuRendering ? 'active' : 'unavailable'} · compute blur ${metrics.native.computeBlur ? 'active' : 'unavailable'}\n`}
        {`GPU timestamp profiler: ${metrics.native.profilerReason}\n`}
        {`Adapter queries ${metrics.native.adapterTimestampQuery ? 'yes' : 'no'} / encoder ${metrics.native.adapterEncoderTimestamp ? 'yes' : 'no'} · bracket features ${metrics.native.enabledBracketFeatures ? 'enabled' : 'disabled'}\n`}
        {`CPU encode ${metrics.native.cpuEncodeMs.toFixed(2)} ms · CPU blit ${metrics.native.cpuBlitMs.toFixed(2)} ms\n`}
        {`Requested ${metrics.native.requestedHz.toFixed(0)} Hz · callbacks ${metrics.native.deliveredCallbackHz.toFixed(1)} Hz · present calls ${metrics.native.presentCallRate.toFixed(1)}/s (${metrics.native.windowSeconds.toFixed(2)}s window)\n`}
        {`Acquire ${metrics.native.acquireMs.toFixed(2)} ms · blit submit ${metrics.native.blitSubmitMs.toFixed(2)} ms · present call ${metrics.native.presentCallMs.toFixed(2)} ms · poll ${metrics.native.pollMs.toFixed(2)} ms\n`}
        {`Observed GPU blit completions ${metrics.native.gpuCompleted} · outstanding ${metrics.native.gpuOutstanding}/2 · capacity retries ${metrics.native.gpuBusy}\n`}
        {`Callbacks ${metrics.native.callbackTotal} · worker requests ${metrics.native.submitted} · busy ${metrics.native.busy} · idle ${metrics.native.idle} · inactive ${metrics.native.inactive} · no drawable ${metrics.native.noDrawable}\n`}
        {`Observed interval gaps (estimate) ${metrics.native.missedObservedIntervalsEstimate} · UI tick ${metrics.native.uiTickMs.toFixed(2)} ms\n`}
        {`JS anchors ${work.current.anchors} · renders ${work.current.renders} · anchor work ${work.current.anchorMs.toFixed(2)} ms\n`}
        {`Native − JS ${metrics.delta.toFixed(1)} ms · sample age ${metrics.deliveryMs.toFixed(1)} ms\nPresent calls and GPU blit completion are not measured scanout. All costs shown are CPU wall time. Vello internal submits are included in encode. No phone performance conclusion.`}
      </Text> : null}
    </ScrollView> : null}
    {!unavailable && NativeView ? <View style={styles.gestureWrap} {...panResponder.panHandlers}>
      <NativeView key={surfaceEpoch} ref={native} style={styles.canvas} trackJson={payload.json} active={active} onStatus={onStatus} onMetrics={onMetrics} />
    </View> : null}
  </View>;
});
const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, overflow: 'hidden' }, gestureWrap: { flex: 1, minHeight: 0 }, canvas: { flex: 1, minHeight: 0 },
  overlay: { flexGrow: 0, flexShrink: 1, maxHeight: '45%', backgroundColor: 'rgba(10,11,17,0.8)' },
  diagnostics: { paddingTop: 8, paddingHorizontal: 28 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  caption: { color: 'rgba(255,255,255,0.68)', fontSize: 11, marginBottom: 4 },
  metrics: { color: 'rgba(255,255,255,0.48)', fontSize: 10, lineHeight: 14 },
});
