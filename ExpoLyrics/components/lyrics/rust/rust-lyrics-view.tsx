import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { usePlaybackStore, type LyricsStyle } from '@/store/playback-store';
import { anchorChanged, nextVisualAnchor, projectPosition, type VisualAnchor } from '@/lib/rust-lyrics-protocol';
import { createRustLyricsGesture } from '@/lib/rust-lyrics-gesture';
import { createRustLyricsFollow, type FollowCommand } from '@/lib/rust-lyrics-follow';
import type { LyricLine } from '@/types/bridge';
import type { PreviewPlaybackAnchor } from '@/components/lyrics/use-playback-timeline-clock';

import { prepareRustTrack } from '@/lib/rust-lyrics-preparation';
import { arrivalEvent, arrivalHandle, arrivalSpan } from '@/lib/lyrics-arrival-trace';
import { LANDSCAPE_FONT_SCALE } from '@/constants/player-layout';
import { selectTimedLyricLines, shouldHideTimedRenderer } from '@/lib/lyrics-timing';
import { getStaticLineText, StaticLyricsView } from './static-lyrics-view';

type NativeApi = { abiVersion(): number; monotonicMs(): number };
type NativeRef = { setAnchor(value: string): Promise<void>; setFollowing(value: boolean, epoch: number, generation: number, gesture: boolean): Promise<void>; scrollBy(dy: number): Promise<void>; fling(velocity: number): Promise<void>; hitTest(x: number, y: number): Promise<number> };
type Metrics = { nextCueNativeMs: number; visibleChanges: boolean; frames: number; generation: number; positionMs: number; sampleNativeMs: number; targetNativeMs: number; playing: boolean; rate: number;
  cpuSceneMs: number; cpuEncodeMs: number; gpuIntervalMs: number; waitMs: number; cpuBlitMs: number; acquireMs: number; blitSubmitMs: number; pollMs: number; presentCallMs: number; gpuCompleted: number; gpuOutstanding: number; gpuBusy: number;
  uiTickMs: number; displayIntervalMs: number; callbackTotal: number; submitted: number; idle: number; busy: number; inactive: number; noDrawable: number;
  busyCallbacksInWindow: number; missedIntervalsInWindow: number; missedObservedIntervalsEstimate: number; requestedHz: number; deliveredCallbackHz: number; presentCallRate: number; windowSeconds: number;
  gpuRendering: boolean; computeBlur: boolean; adapterTimestampQuery: boolean; adapterEncoderTimestamp: boolean; enabledBracketFeatures: boolean; profilerReason: string };
type Props = ViewProps & { trackJson: string; active: boolean; ref?: React.Ref<NativeRef>;
  onStatus(event: { nativeEvent: { state: string; message: string; generation: number; ownershipEpoch?: number } }): void;
  onMetrics?(event: { nativeEvent: Metrics }): void };
// A view can be torn down while a command is in flight during a track switch.
// Expo rejects the stale tag; that is a lifecycle race, not a renderer failure.
const STALE_VIEW = /Unable to find[^\n]*KineSyncRustLyricsView[^\n]*tag/i;
const WAITING_LYRICS = 'Waiting for current-track timed lyrics';
// No native require on web/Expo Go. Missing modules are an explicit unavailable state.
function loadNative(): { api: NativeApi | null; view: React.ComponentType<Props> | null; error: string } {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return { api: null, view: null, error: 'Rust native surfaces require iOS or Android' };
  try {
    const api = requireOptionalNativeModule<NativeApi>('KineSyncRustLyrics');
    if (!api || api.abiVersion() !== 11) return { api: null, view: null, error: 'Use a KineSync build with the compatible Rust lyrics module. Expo Go is unsupported.' };
    return { api, view: requireNativeViewManager<Props>('KineSyncRustLyrics'), error: '' };
  } catch (error) { return { api: null, view: null, error: `Rust module unavailable: ${String(error)}` }; }
}
const { api, view: NativeView, error: moduleError } = loadNative();
export const rustLyricsAvailable = NativeView !== null;
let nextGeneration = 0;
function generation() {
  nextGeneration = Math.max(nextGeneration + 1, Math.floor(performance.now() * 1000));
  return nextGeneration;
}

export const RustLyricsView = memo(function RustLyricsView({ active, previewPositionMs, tapToSeekEnabled, shouldRevealTap, autoFollowEnabled, resumeAutoFollowSignal, onLinePress, onLineLongPress, onAutoFollowChange, onCreditsTimestampPress, onUserInteraction,
  demoLyrics, demoPlayback, demoDurationMs = 25000, demoStyle = 'spicy', demoInteractive = false, fontScale: demoFontScale, showTranslatedText }: {
  active: boolean; previewPositionMs?: number | null; tapToSeekEnabled: boolean; autoFollowEnabled?: boolean; resumeAutoFollowSignal?: number;
  demoLyrics?: LyricLine[]; demoPlayback?: PreviewPlaybackAnchor; demoDurationMs?: number; demoStyle?: LyricsStyle;
  demoInteractive?: boolean;
  fontScale?: number; showTranslatedText?: boolean;
  shouldRevealTap?: (pageY: number) => boolean;
  onLinePress?: (line: LyricLine) => void; onLineLongPress?: (line: LyricLine) => void;
  onCreditsTimestampPress?: (position: number) => void;
  onAutoFollowChange?: (enabled: boolean) => void; onUserInteraction?: () => void;
}) {
  const isDemo = demoLyrics !== undefined;
  const interactive = !isDemo || demoInteractive;
  const rawLyrics = usePlaybackStore(state => demoLyrics ?? state.lyrics);
  const arrival = __DEV__ ? arrivalHandle(rawLyrics) : undefined;
  const metadata = usePlaybackStore(state => isDemo ? null : state.lyricsMetadata);
  const lyricsSource = usePlaybackStore(state => isDemo ? '' : state.lyricsSource);
  // Plain lyrics use the raw store rows, including older provider results
  // that lack the untimed flag.
  const timedLyrics = useMemo(() => selectTimedLyricLines(rawLyrics), [rawLyrics]);
  const untimed = shouldHideTimedRenderer(rawLyrics, lyricsSource, metadata?.untimed) ||
    (rawLyrics.length > 0 && !timedLyrics.length);
  const showStaticLyrics = useMemo(() => untimed && rawLyrics.some(getStaticLineText), [rawLyrics, untimed]);
  const lyrics = useMemo(() => untimed ? [] : timedLyrics, [timedLyrics, untimed]);
  const credits = useMemo(() => {
    const songwriters = metadata?.credits?.songwriters?.filter(name => typeof name === 'string' && name.length > 0) ?? [];
    const a = metadata?.attribution;
    const attribution = a ? {
      ...(a.provider ? { provider: a.provider } : {}),
      ...(a.community ? { community: true } : {}),
      ...(a.maker?.username ? { maker: a.maker.username, ...(a.maker.url ? { maker_url: a.maker.url } : {}) } : {}),
      ...(a.uploader?.username ? { uploader: a.uploader.username, ...(a.uploader.url ? { uploader_url: a.uploader.url } : {}) } : {}),
    } : null;
    const hasAttribution = attribution && Object.keys(attribution).length > 0;
    if (!songwriters.length && !hasAttribution) return null;
    return { ...(songwriters.length ? { songwriters } : {}), ...(hasAttribution ? { attribution } : {}) };
  }, [metadata]);
  const lyricsStatusMessage = usePlaybackStore(state => isDemo ? '' : state.lyricsStatusMessage);
  const empty = useMemo(() => lyrics.length ? null : {
    title: untimed ? 'Plain lyrics available' : metadata?.instrumental ? 'This song is an instrumental' : 'No synced lyrics yet',
    subtitle: untimed ? 'Timed lyrics are unavailable for this recording.' : lyricsStatusMessage || `Source: ${lyricsSource || 'unavailable'}`,
  }, [lyrics.length, metadata?.instrumental, lyricsStatusMessage, lyricsSource, untimed]);
  const showRustDebugOverlay = usePlaybackStore(state => __DEV__ && !isDemo && state.showRustDebugOverlay);
  const trackId = usePlaybackStore(state => isDemo ? 'kinesync-demo' : state.currentTrack?.id ?? '');
  const style = usePlaybackStore(state => isDemo ? demoStyle : state.lyricsStyle);
  const showTranslation = usePlaybackStore(state => isDemo ? showTranslatedText ?? true : state.showTranslatedText);
  const window = useWindowDimensions();
  const landscape = window.width > window.height;
  const fontScale = (isDemo ? demoFontScale : undefined) ?? (landscape ? LANDSCAPE_FONT_SCALE : 1);
  const revision = useMemo(() => ({ generation: generation(), lyrics, trackId, style, fontScale, landscape, showTranslation, credits, empty }), [lyrics, trackId, style, fontScale, landscape, showTranslation, credits, empty]);
  const payload = useMemo(() => {
    if (showStaticLyrics) return { json: '', error: '' };
    try {
      const prepare = () => prepareRustTrack(trackId, revision.generation, lyrics, style === 'amll' ? 'amll' : 'spicy', fontScale, landscape, showTranslation, credits, empty);
      const json = arrival ? arrivalSpan(arrival, revision.generation, 'rust-packet-prepared', prepare) : prepare();
      return { json, error: '' };
    }
    catch (error) { return { json: '', error: String(error) }; }
  }, [arrival, lyrics, trackId, revision.generation, style, fontScale, landscape, showTranslation, credits, empty, showStaticLyrics]);
  const native = useRef<NativeRef | null>(null);
  const mounted = useRef(true);
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
  const latest = useRef({ shouldRevealTap, tapToSeekEnabled, onLinePress, onLineLongPress, onAutoFollowChange, onUserInteraction, onCreditsTimestampPress, metadata, lyrics });
  latest.current = { shouldRevealTap, tapToSeekEnabled, onLinePress, onLineLongPress, onAutoFollowChange, onUserInteraction, onCreditsTimestampPress, metadata, lyrics };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const commandFailed = useCallback((error: unknown) => {
    if (!mounted.current || STALE_VIEW.test(String(error))) return;
    setFailed(true);
    setStatus(String(error));
  }, []);
  const send = useCallback((run: (view: NativeRef) => Promise<unknown>) => {
    const view = native.current;
    if (!view || !mounted.current) return;
    void run(view).catch(commandFailed);
  }, [commandFailed]);
  const followEnabled = autoFollowEnabled ?? true;
  const follow = useRef(createRustLyricsFollow());
  follow.current.sync(trackId, followEnabled);
  const followGeneration = useRef(revision.generation);
  followGeneration.current = revision.generation;
  const followSurface = useRef(surfaceEpoch);
  const sendFollow = useCallback((command: FollowCommand) => {
    send(view => view.setFollowing(command.value, command.epoch, command.generation, command.gesture));
  }, [send]);
  const setFollow = useCallback((enabled: boolean) => {
    sendFollow(follow.current.issue(enabled, followGeneration.current, true));
  }, [follow, sendFollow]);
  const gesture = useMemo(() => createRustLyricsGesture({
    hitTest: (y, x) => native.current ? native.current.hitTest(x, y) : Promise.resolve(-1),
    // UIKit pan recognizer drives drag/fling directly on the native owner.
    scrollBy: () => {},
    fling: () => {},
    setFollowing: setFollow,
    tapEnabled: () => latest.current.tapToSeekEnabled,
    shouldRevealTap: pageY => latest.current.shouldRevealTap?.(pageY) ?? false,
    // Native down advances its epoch floor even without pan ownership. Reserve
    // that epoch locally so the next resume can pass the native guard, without
    // sending true/false commands that would freeze follow or reset grace.
    reserveTouchEpoch: () => { follow.current.issue(follow.current.desired, followGeneration.current, true); },
    onFooterPress: target => {
      const value = latest.current;
      if (target === -2) value.onCreditsTimestampPress?.(Math.max(0, ...value.lyrics.map(line => line.lineEndTime)));
      else {
        const profile = target === -3 ? value.metadata?.attribution?.maker : value.metadata?.attribution?.uploader;
        if (profile?.url && /^https:\/\//i.test(profile.url)) void Linking.openURL(profile.url).catch(() => {});
      }
    },
    onLinePress: index => { const line = latest.current.lyrics[index]; if (line) latest.current.onLinePress?.(line); },
    onLineLongPress: index => { const line = latest.current.lyrics[index]; if (line) latest.current.onLineLongPress?.(line); },
    onAutoFollowChange: enabled => latest.current.onAutoFollowChange?.(enabled),
    onUserInteraction: () => latest.current.onUserInteraction?.(),
  }), [setFollow]);
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: event => gesture.grant(event.nativeEvent.locationY, event.nativeEvent.locationX, event.nativeEvent.pageY),
    onPanResponderMove: (_event, state) => gesture.move(state.dy, state.dx),
    onPanResponderRelease: () => gesture.release(),
    onPanResponderTerminate: () => gesture.terminate(),
    onPanResponderTerminationRequest: () => false,
    // Keep Android's native drag stream while JS classifies taps and holds.
    onShouldBlockNativeResponder: () => Platform.OS !== 'android',
  }), [gesture]);
  useEffect(() => () => gesture.terminate(), [gesture, showStaticLyrics]);
  useEffect(() => {
    if (!api || !native.current) return;
    const recreated = followSurface.current !== surfaceEpoch;
    followSurface.current = surfaceEpoch;
    const command = recreated ? follow.current.reassert(revision.generation) : follow.current.reconcile(revision.generation);
    if (command) sendFollow(command);
    // A stale parent false from the previous song must not undo the fresh
    // track reset. Ask the player to acknowledge follow once for this track.
    if (follow.current.resetPending && !followEnabled) latest.current.onAutoFollowChange?.(true);
    // `resumeAutoFollowSignal` re-asserts the same value after the player's
    // explicit resume gesture; the number itself carries no state.
  }, [followEnabled, resumeAutoFollowSignal, revision.generation, sendFollow, surfaceEpoch, trackId]);
  const demoPlaying = isDemo && active && demoPlayback?.isPlaying === true;
  const sendAnchor = useCallback(() => {
    if (!mounted.current || !api || !native.current || payload.error || identity.current.generation !== revision.generation || identity.current.surfaceEpoch !== surfaceEpoch) return;
    const state = isDemo ? null : usePlaybackStore.getState();
    if (state && state.currentTrack?.id !== trackId) return;
    const started = performance.now();
    let next: Pick<VisualAnchor, 'positionMs' | 'nativeMs' | 'playing' | 'snap'>;
    if (!state) {
      const elapsed = demoPlayback?.isPlaying ? Math.max(0, started - demoPlayback.anchorMonotonicMs) : 0;
      const projected = (demoPlayback?.anchorPositionMs ?? 0) + elapsed;
      const positionMs = Math.max(0, Math.min(demoDurationMs, previewPositionMs ?? projected));
      next = { positionMs, nativeMs: api.monotonicMs(), playing: demoPlaying && previewPositionMs == null && positionMs < demoDurationMs, snap: true };
    } else {
      const previous = visual.current?.generation === revision.generation ? visual.current : null;
      const live = nextVisualAnchor(state, started, api.monotonicMs(), rate, previous, previewPositionMs);
      visual.current = { ...live, generation: revision.generation };
      next = live;
    }
    const { positionMs, nativeMs, playing, snap } = next;
    const command = { generation: revision.generation, sequence: ++sequence.current, positionMs, nativeMs, playing, rate, snap };
    work.current.anchors++;
    void native.current.setAnchor(JSON.stringify(command)).catch(error => {
      if (identity.current.generation !== revision.generation || identity.current.surfaceEpoch !== surfaceEpoch) return;
      commandFailed(error);
    });
    work.current.anchorMs = performance.now() - started;
  }, [api, commandFailed, demoDurationMs, demoPlayback, demoPlaying, isDemo, payload.error, previewPositionMs, rate, revision.generation, surfaceEpoch, trackId]);
  useEffect(() => {
    if (showStaticLyrics) return;
    sendAnchor();
    if (isDemo) return;
    const unsubscribe = usePlaybackStore.subscribe((state, previous) => { if (anchorChanged(state, previous)) sendAnchor(); });
    const appState = AppState.addEventListener('change', state => { if (state === 'active') sendAnchor(); });
    return () => { unsubscribe(); appState.remove(); };
  }, [active, isDemo, sendAnchor, showStaticLyrics]);
  const onStatus = useCallback(({ nativeEvent }: { nativeEvent: { state: string; message: string; generation: number; ownershipEpoch?: number } }) => {
    if (!mounted.current || identity.current.generation !== revision.generation || identity.current.surfaceEpoch !== surfaceEpoch || nativeEvent.generation !== revision.generation) return;
    if (nativeEvent.state === 'follow') {
      // The native release recaptured follow near the active line. Only the
      // exact latest ownership epoch may move parent state. A delayed release
      // from an earlier touch on the same song is ignored after a newer touch.
      if (!follow.current.accept(nativeEvent.ownershipEpoch ?? -1, revision.generation)) return;
      latest.current.onAutoFollowChange?.(true);
      return;
    }
    setStatus(nativeEvent.message);
    setFailed(nativeEvent.state === 'error');
    if (nativeEvent.state === 'ready') {
      if (arrival) arrivalEvent(arrival, revision.generation, 'rust-track-ready-not-presentation');
      // A handoff sent before the native owner existed is replayed by the owner
      // now. Reassert the current intent rather than a render-captured value.
      const command = follow.current.reassert(revision.generation);
      sendFollow(command);
      sendAnchor();
    }
  }, [arrival, follow, revision.generation, sendFollow, sendAnchor, surfaceEpoch]);
  const onMetrics = useCallback(({ nativeEvent: value }: { nativeEvent: Metrics }) => {
    if (isDemo || identity.current.generation !== revision.generation || identity.current.surfaceEpoch !== surfaceEpoch || value.generation !== revision.generation || !api) return;
    const now = performance.now();
    const deliveryMs = Math.max(0, api.monotonicMs() - value.sampleNativeMs);
    const projected = value.positionMs + (value.playing ? (api.monotonicMs() - value.targetNativeMs) * value.rate : 0);
    // Both diagnostic views share the native sample.
    setMetrics({ native: value, delta: projected - projectPosition(usePlaybackStore.getState(), now), deliveryMs });
  }, [api, isDemo, revision.generation, surfaceEpoch]);
  const waiting = !isDemo && payload.error.includes(WAITING_LYRICS);
  const unavailable = moduleError || (waiting ? '' : payload.error);
  useEffect(() => {
    if (waiting) setStatus(WAITING_LYRICS);
  }, [waiting]);
  useEffect(() => {
    // A new track gets a fresh chance even if the previous surface raced with
    // teardown; genuine errors return on the next status/anchor command.
    setFailed(false);
  }, [revision.generation]);
  useEffect(() => {
    if (!showStaticLyrics && !isDemo && (unavailable || failed)) console.error('Rust lyrics renderer:', unavailable || status);
  }, [isDemo, unavailable, failed, status, showStaticLyrics]);
  const currentMetrics = !failed && !unavailable && metrics?.native.generation === revision.generation ? metrics.native : null;
  const visibleError = unavailable || (failed ? status : '');
  if (showStaticLyrics) {
    return <StaticLyricsView key={trackId} lines={rawLyrics} fontScale={fontScale} landscape={landscape}
      showTranslation={showTranslation} credits={credits} interactive={interactive}
      shouldRevealTap={shouldRevealTap} onUserInteraction={onUserInteraction} />;
  }
  return <View style={styles.root}>
    {__DEV__ && showRustDebugOverlay ? <View pointerEvents="none" style={styles.fpsStrip}>
      <Text numberOfLines={1} style={styles.fps} accessibilityLabel="Rust presents per second, callback interval, busy skips and estimated missed callback intervals in this window. Not display scanout or measured GPU time.">
        {currentMetrics ? `${currentMetrics.presentCallRate.toFixed(0)} presents/s · cb ${currentMetrics.displayIntervalMs.toFixed(1)}ms · busy ${currentMetrics.busyCallbacksInWindow ?? 0} · gaps~${currentMetrics.missedIntervalsInWindow ?? 0}` : 'presents/s · awaiting native sample'}
      </Text>
    </View> : null}
    {showRustDebugOverlay ? <ScrollView style={styles.overlay} contentContainerStyle={styles.diagnostics}>
      <Text style={styles.caption}>{unavailable || (failed ? `Rust error: ${status}` : status)}</Text>
      <View style={styles.actions}>
      {!unavailable ? <Pressable accessibilityRole="button" onPress={() => { setSurfaceEpoch(value => value + 1); setFailed(false); setMetrics(null); setStatus('Recreating Rust surface'); }}>
        <Text style={styles.caption}>Recreate Rust surface</Text>
      </Pressable> : null}
      {!unavailable && !failed ? <Pressable accessibilityRole="button" onPress={() => setRate(value => value === 1 ? 0.5 : value === 0.5 ? 1.5 : 1)}>
        <Text style={styles.caption}>Visual rate {rate}× · audio unchanged</Text>
      </Pressable> : null}
      {!unavailable ? <Pressable accessibilityRole="button" onPress={() => setShowMetrics(value => !value)}>
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
        {`Next cue ${metrics.native.nextCueNativeMs < 0 ? 'none' : `${Math.max(0, metrics.native.nextCueNativeMs - metrics.native.sampleNativeMs).toFixed(1)} ms`} · visible changes ${metrics.native.visibleChanges ? 'yes' : 'no'}\n`}
        {`Observed interval gaps (estimate) ${metrics.native.missedObservedIntervalsEstimate} · UI tick ${metrics.native.uiTickMs.toFixed(2)} ms\n`}
        {`JS anchors ${work.current.anchors} · renders ${work.current.renders} · anchor work ${work.current.anchorMs.toFixed(2)} ms\n`}
        {`Native − JS ${metrics.delta.toFixed(1)} ms · sample age ${metrics.deliveryMs.toFixed(1)} ms\nPresent calls and GPU blit completion are not measured scanout. All costs shown are CPU wall time. Vello internal submits are included in encode. No phone performance conclusion.`}
      </Text> : null}
    </ScrollView> : null}
    <View style={styles.gestureWrap} pointerEvents={interactive ? undefined : 'none'} {...(interactive && rustLyricsAvailable ? panResponder.panHandlers : {})}>
      {visibleError && !showRustDebugOverlay ? <Text style={styles.rendererError}>{isDemo ? 'Lyrics preview unavailable.' : 'Lyrics renderer unavailable.'} {visibleError}</Text> : null}
      {payload.json && !unavailable && !failed && NativeView ? <NativeView key={surfaceEpoch} ref={native} style={styles.canvas} trackJson={payload.json} active={active} onStatus={onStatus} onMetrics={showRustDebugOverlay ? onMetrics : undefined} /> : null}
    </View>
  </View>;
});
const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, overflow: 'hidden' }, gestureWrap: { flex: 1, minHeight: 0 }, canvas: { flex: 1, minHeight: 0 },
  fpsStrip: { height: 16, flexShrink: 0, paddingHorizontal: 28, backgroundColor: 'rgba(10,11,17,0.8)' },
  fps: { color: 'rgba(255,255,255,0.68)', fontSize: 10, lineHeight: 16, fontVariant: ['tabular-nums'] },
  overlay: { flexGrow: 0, flexShrink: 1, maxHeight: '45%', backgroundColor: 'rgba(10,11,17,0.8)' },
  diagnostics: { paddingTop: 8, paddingHorizontal: 28 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  caption: { color: 'rgba(255,255,255,0.68)', fontSize: 11, marginBottom: 4 },
  rendererError: { color: 'rgba(255,255,255,0.82)', fontSize: 12, paddingHorizontal: 12 },
  metrics: { color: 'rgba(255,255,255,0.48)', fontSize: 10, lineHeight: 14 },
});
