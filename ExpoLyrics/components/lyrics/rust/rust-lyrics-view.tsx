import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState, DevSettings, Linking, PanResponder, Platform, StyleSheet, Text, View, useWindowDimensions, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { usePlaybackStore, type LyricsStyle } from '@/store/playback-store';
import { anchorChanged, nextVisualAnchor, type VisualAnchor } from '@/lib/rust-lyrics-protocol';
import { acceptsTraceSummary, applyTraceReset, type LegacyMetrics, type TraceEvent, type TraceExport, type TraceGate, type TraceReset, type TraceUpdate } from '@/lib/rust-frame-trace';
import { createRustLyricsGesture } from '@/lib/rust-lyrics-gesture';
import { createRustLyricsFollow, type FollowCommand } from '@/lib/rust-lyrics-follow';
import type { LyricLine } from '@/types/bridge';
import type { PreviewPlaybackAnchor } from '@/components/lyrics/use-playback-timeline-clock';

import { prepareRustTrack } from '@/lib/rust-lyrics-preparation';
import { arrivalEvent, arrivalHandle, arrivalSpan } from '@/lib/lyrics-arrival-trace';
import { LANDSCAPE_FONT_SCALE } from '@/constants/player-layout';
import { selectTimedLyricLines, shouldHideTimedRenderer } from '@/lib/lyrics-timing';
import { getStaticLineText, StaticLyricsView } from './static-lyrics-view';
import { RustFpsOverlay } from './rust-fps-overlay';

type NativeApi = { abiVersion(): number; monotonicMs(): number; frameTraceAvailable?(): boolean };
type NativeRef = { setAnchor(value: string): Promise<void>; setFollowing(value: boolean, epoch: number, generation: number, gesture: boolean): Promise<void>; scrollBy(dy: number): Promise<void>; fling(velocity: number): Promise<void>; hitTest(x: number, y: number): Promise<number>; exportFrameTrace?(session: string): Promise<string> };
type Props = ViewProps & { trackJson: string; active: boolean; ref?: React.Ref<NativeRef>;
  onStatus(event: { nativeEvent: { state: string; message: string; generation: number; ownershipEpoch?: number } }): void;
  traceSession?: string;
  tracePanelVisible?: boolean;
  onFrameTrace?(event: { nativeEvent: TraceEvent }): void;
  onFrameTraceReset?(event: { nativeEvent: TraceReset }): void;
  onMetrics?(event: { nativeEvent: LegacyMetrics }): void };
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
const frameTraceSupported = __DEV__ && Platform.OS === 'ios' && api?.frameTraceAvailable?.() === true;
if (frameTraceSupported) {
  DevSettings.addMenuItem('Show Rust debug overlay', () => usePlaybackStore.getState().setShowRustDebugOverlay(true));
}
export const rustLyricsAvailable = NativeView !== null;
let nextGeneration = 0;
function generation() {
  nextGeneration = Math.max(nextGeneration + 1, Math.floor(performance.now() * 1000));
  return nextGeneration;
}

export const RustLyricsView = memo(function RustLyricsView({ active, previewPositionMs, tapToSeekEnabled, shouldRevealTap, onRevealOwnershipChange, autoFollowEnabled, resumeAutoFollowSignal, onLinePress, onLineLongPress, onAutoFollowChange, onCreditsTimestampPress, onUserInteraction,
  demoLyrics, demoPlayback, demoDurationMs = 25000, demoStyle = 'spicy', demoInteractive = false, fontScale: demoFontScale, showTranslatedText }: {
  active: boolean; previewPositionMs?: number | null; tapToSeekEnabled: boolean; autoFollowEnabled?: boolean; resumeAutoFollowSignal?: number;
  demoLyrics?: LyricLine[]; demoPlayback?: PreviewPlaybackAnchor; demoDurationMs?: number; demoStyle?: LyricsStyle;
  demoInteractive?: boolean;
  fontScale?: number; showTranslatedText?: boolean;
  shouldRevealTap?: (pageY: number) => boolean;
  onRevealOwnershipChange?: (ownsReveal: boolean) => void;
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
  const visual = useRef<(VisualAnchor & { generation: number; surfaceEpoch: number; style: string }) | null>(null);
  const [surfaceEpoch, setSurfaceEpoch] = useState(0);
  const [rate, setRate] = useState(1);
  const [traceRun, setTraceRun] = useState(0);
  const nextTraceRun = useRef<number | null>(null);
  const activeTrace = useRef<TraceGate | null>(null);
  const [status, setStatus] = useState('Preparing Rust Metal renderer');
  const [failed, setFailed] = useState(false);
  const [readySurface, setReadySurface] = useState<{ generation: number; surfaceEpoch: number } | null>(null);
  const traceSubscription = useRef<((update: TraceUpdate) => void) | null>(null);
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
    setReadySurface(null);
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
      const prior = visual.current;
      // A same-track AMLL packet refresh can carry an in-flight Rust return.
      // Keep the clock history so only a playback discontinuity requests a snap.
      const previous = prior?.surfaceEpoch === surfaceEpoch &&
        (prior.generation === revision.generation || (prior.style === 'amll' && style === 'amll'))
        ? prior : null;
      const live = nextVisualAnchor(state, started, api.monotonicMs(), rate, previous, previewPositionMs);
      visual.current = { ...live, generation: revision.generation, surfaceEpoch, style };
      next = live;
    }
    const { positionMs, nativeMs, playing, snap } = next;
    const command = { generation: revision.generation, sequence: ++sequence.current, positionMs, nativeMs, playing, rate, snap };
    void native.current.setAnchor(JSON.stringify(command)).catch(error => {
      if (identity.current.generation !== revision.generation || identity.current.surfaceEpoch !== surfaceEpoch) return;
      commandFailed(error);
    });
  }, [api, commandFailed, demoDurationMs, demoPlayback, demoPlaying, isDemo, payload.error, previewPositionMs, rate, revision.generation, style, surfaceEpoch, trackId]);
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
    if (nativeEvent.state === 'error') setReadySurface(null);
    if (nativeEvent.state === 'ready') {
      setReadySurface({ generation: revision.generation, surfaceEpoch });
      if (arrival) arrivalEvent(arrival, revision.generation, 'rust-track-ready-not-presentation');
      // A handoff sent before the native owner existed is replayed by the owner
      // now. Reassert the current intent rather than a render-captured value.
      const command = follow.current.reassert(revision.generation);
      sendFollow(command);
      sendAnchor();
    }
  }, [arrival, follow, revision.generation, sendFollow, sendAnchor, surfaceEpoch]);
  const onFrameTrace = useCallback(({ nativeEvent }: { nativeEvent: TraceEvent }) => {
    const capture = activeTrace.current;
    if (!mounted.current || identity.current.surfaceEpoch !== surfaceEpoch || nativeEvent.surface !== surfaceEpoch ||
        nativeEvent.generation !== identity.current.generation || !capture || !acceptsTraceSummary(capture, nativeEvent)) return;
    traceSubscription.current?.({ kind: 'trace', event: nativeEvent });
  }, [surfaceEpoch]);
  const onFrameTraceReset = useCallback(({ nativeEvent }: { nativeEvent: TraceReset }) => {
    const capture = activeTrace.current;
    if (!mounted.current || identity.current.surfaceEpoch !== surfaceEpoch || nativeEvent.surface !== surfaceEpoch ||
        nativeEvent.generation !== identity.current.generation || !capture || !applyTraceReset(capture, nativeEvent)) return;
    traceSubscription.current?.({ kind: 'reset' });
  }, [surfaceEpoch]);
  const onMetrics = useCallback(({ nativeEvent }: { nativeEvent: LegacyMetrics }) => {
    if (mounted.current && identity.current.surfaceEpoch === surfaceEpoch && nativeEvent.generation === identity.current.generation) {
      traceSubscription.current?.({ kind: 'legacy', event: nativeEvent });
    }
  }, [surfaceEpoch]);
  const exportFrameTrace = useCallback(async (): Promise<TraceExport> => {
    const view = native.current;
    const capture = activeTrace.current;
    const { generation, surfaceEpoch: surface } = identity.current;
    if (!view?.exportFrameTrace || !capture?.active) throw new Error('Frame trace export is unavailable.');
    const { session, minimumToken } = capture;
    const isCurrent = () => mounted.current && native.current === view &&
      activeTrace.current === capture && capture.active && capture.minimumToken === minimumToken &&
      identity.current.generation === generation && identity.current.surfaceEpoch === surface;
    const json = await view.exportFrameTrace(session);
    if (!isCurrent()) throw new Error('The capture changed before export.');
    return { json, expected: { session, generation, surface, minimumToken, token: minimumToken }, isCurrent };
  }, []);
  const setCapture = useCallback((enabled: boolean) => {
    activeTrace.current = null;
    if (enabled) nextTraceRun.current = (nextTraceRun.current ?? 0) + 1;
    setTraceRun(enabled ? nextTraceRun.current ?? 0 : 0);
  }, []);
  const hideTracePanel = useCallback(() => {
    if (activeTrace.current) activeTrace.current.visibleSince = Infinity;
    usePlaybackStore.getState().setShowRustDebugOverlay(false);
  }, []);
  const recreateSurface = useCallback(() => {
    activeTrace.current = null;
    setSurfaceEpoch(value => value + 1);
    setFailed(false);
    setStatus('Recreating Rust surface');
  }, []);
  const cycleVisualRate = useCallback(() => {
    setRate(value => value === 1 ? 0.5 : value === 0.5 ? 1.5 : 1);
  }, []);
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
    if (__DEV__ && !showStaticLyrics && !isDemo && (unavailable || failed)) console.error('Rust lyrics renderer:', unavailable || status);
  }, [isDemo, unavailable, failed, status, showStaticLyrics]);
  const nativeGestureReady = active && interactive && rustLyricsAvailable && !!payload.json &&
    !unavailable && !failed && readySurface?.generation === revision.generation &&
    readySurface.surfaceEpoch === surfaceEpoch;
  const ownsReveal = !!shouldRevealTap && !!onUserInteraction &&
    ((showStaticLyrics && interactive) || nativeGestureReady);
  useLayoutEffect(() => {
    if (!ownsReveal || !onRevealOwnershipChange) return;
    onRevealOwnershipChange(true);
    return () => onRevealOwnershipChange(false);
  }, [ownsReveal, onRevealOwnershipChange]);
  const visibleError = unavailable || (failed ? status : '');
  const traceSession = frameTraceSupported && traceRun > 0 && !failed && !unavailable && !showStaticLyrics && payload.json
    ? `${revision.generation}:${surfaceEpoch}:${traceRun}` : '';
  if (!traceSession) {
    activeTrace.current = null;
  } else if (activeTrace.current?.session !== traceSession) {
    activeTrace.current = { session: traceSession, minimumToken: 0, active: false, visibleSince: Infinity };
  }
  const trace = activeTrace.current;
  if (trace) {
    if (!showRustDebugOverlay) trace.visibleSince = Infinity;
    else if (trace.visibleSince === Infinity) trace.visibleSince = api?.monotonicMs() ?? 0;
  }
  if (showStaticLyrics) {
    return <StaticLyricsView key={trackId} lines={rawLyrics} fontScale={fontScale} landscape={landscape}
      showTranslation={showTranslation} credits={credits} interactive={interactive}
      shouldRevealTap={shouldRevealTap} onUserInteraction={onUserInteraction} />;
  }
  return <View style={styles.root}>
    <View style={styles.gestureWrap} pointerEvents={interactive ? undefined : 'none'} {...(nativeGestureReady ? panResponder.panHandlers : {})}>
      {(unavailable || failed) ? <Text style={styles.rendererError}>
        {isDemo && !demoInteractive ? 'Lyrics preview unavailable.' : 'Lyrics renderer unavailable.'}
        {' Choose Skia in Settings → Advanced → Lyrics renderer.'}
        {__DEV__ && visibleError ? ` ${visibleError}` : null}
      </Text> : null}
      {payload.json && !unavailable && !failed && NativeView ? <NativeView key={surfaceEpoch} ref={native}
        style={styles.canvas} trackJson={payload.json} active={active} onStatus={onStatus}
        {...(frameTraceSupported ? { traceSession, tracePanelVisible: showRustDebugOverlay, onFrameTrace, onFrameTraceReset } : {})}
        onMetrics={__DEV__ && showRustDebugOverlay && Platform.OS === 'android' ? onMetrics : undefined} /> : null}
    </View>
    {__DEV__ && showRustDebugOverlay && !unavailable ? <RustFpsOverlay key={`${revision.generation}:${surfaceEpoch}:${traceRun}`}
      subscription={traceSubscription} supported={frameTraceSupported} android={Platform.OS === 'android'}
      failed={failed} capturing={!!traceSession} ready={readySurface?.generation === revision.generation && readySurface?.surfaceEpoch === surfaceEpoch}
      visualRate={rate} onCapture={setCapture} onExport={exportFrameTrace} onHide={hideTracePanel}
      onRecreate={recreateSurface} onVisualRate={cycleVisualRate} /> : null}
  </View>;
});
const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, overflow: 'hidden' }, gestureWrap: { flex: 1, minHeight: 0 }, canvas: { flex: 1, minHeight: 0 },
  rendererError: { color: 'rgba(255,255,255,0.82)', fontSize: 12, paddingHorizontal: 12 },
});
