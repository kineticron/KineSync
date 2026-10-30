import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

type Fields = Record<string, string | number | boolean | null>;
export type NativeFrameStats = { uiOffsetMs: number | null; offsetErrorMs: number | null; lastSampleUiMs: number;
  rowCallbacks: number; leadVoiceCallbacks: number; backgroundVoiceCallbacks: number; pictureRebuilds: number;
  maxCallbackMs: number; currentFrameToken: number; currentFrameWorkMs: number; maxFrameWorkMs: number; maxFrameGapMs: number;
  idleCallbacks: number; cachedCallbacks: number; cachedActivations: number; firstGlyphPicture: boolean; captureEnabled: boolean;
  generation: number; captureStartedJsMs: number };
export type ClockProjection = { serial: number; jsTime: number; position: number; playing: boolean; source: string; generation: number; reportedSerial: number };
export type NativeDiagnostics = {
  stats: SharedValue<NativeFrameStats>;
  report: (event: string, fields?: Fields, generation?: number) => void;
  reportUi: (generation: number, event: string, uiPerformanceNowMs: number, fields?: Fields,
    clock?: { offsetMs: number | null; errorMs: number | null }) => void;
  trackMount: (kind: 'row' | 'leadVoice' | 'backgroundVoice', delta: 1 | -1) => void;
  getSessionStartedAt: () => number;
  isCaptureActive: () => boolean;
  registerClockObserver: (observer: (active: boolean, projection?: ClockProjection) => void) => () => void;
  recordProjection: (projection: Omit<ClockProjection, 'generation' | 'reportedSerial'>) => void;
  getGeneration: () => number;
  registerSessionObserver: (observer: (generation: number, startedAtJsMs: number) => void) => () => void;
};

const Context = createContext<NativeDiagnostics | null>(null);
export const useNativeRenderDiagnostics = () => useContext(Context);
let nextRunNumber = 0;
export const allocateNativeDiagnosticRunId = () => ++nextRunNumber;

type PendingUiEvent = { generation: number; event: string; uiTime: number; receivedJsTime: number; fields: Fields };
type SessionMeta = { enabled: boolean; generation: number; startedAtJsMs: number; runId: number; renderer: string; reason: string; count: number };

export function estimateUiClockOffset(sentJsMs: number, uiPerformanceNowMs: number, returnedJsMs: number) {
  const roundTripMs = returnedJsMs - sentJsMs;
  return { offsetMs: uiPerformanceNowMs - (sentJsMs + returnedJsMs) / 2,
    roundTripMs, uncertaintyMs: Math.max(0, roundTripMs / 2) };
}

export function clearFrameStats(current: NativeFrameStats, captureEnabled: boolean, generation: number, captureStartedJsMs = current.captureStartedJsMs) {
  'worklet';
  if (generation <= current.generation) return current;
  return { ...current, lastSampleUiMs: 0, rowCallbacks: 0, leadVoiceCallbacks: 0, backgroundVoiceCallbacks: 0,
    pictureRebuilds: 0, maxCallbackMs: 0, currentFrameToken: -1, currentFrameWorkMs: 0, maxFrameWorkMs: 0,
    maxFrameGapMs: 0, idleCallbacks: 0, cachedCallbacks: 0, cachedActivations: 0, firstGlyphPicture: false,
    captureEnabled, uiOffsetMs: null, offsetErrorMs: null, generation, captureStartedJsMs };
}

export function applyUiClockCalibration(current: NativeFrameStats, generation: number, offsetMs: number, errorMs: number) {
  'worklet';
  return current.generation === generation ? { ...current, uiOffsetMs: offsetMs, offsetErrorMs: errorMs } : current;
}

export function projectUiFrameFromJsProjection(projectionJsTimeMs: number, positionMs: number, isPlaying: boolean,
  uiPerformanceNowMs: number, uiOffsetMs: number) {
  'worklet';
  const elapsed = Math.max(0, uiPerformanceNowMs - (projectionJsTimeMs + uiOffsetMs));
  return { projectionToFrameMs: Number(elapsed.toFixed(2)), expectedPositionMs: Math.round(positionMs + (isPlaying ? elapsed : 0)) };
}

function reportFrameSample(diagnostics: NativeDiagnostics, uiNow: number, stats: NativeFrameStats, values: {
  rowCallbacks: number; leadVoiceCallbacks: number; backgroundVoiceCallbacks: number; pictureRebuilds: number;
  maxCallbackBodyMs: number; maxSummedCallbackBodyMsPerFrame: number; maxRawFrameGapMs: number;
  idleCallbacks: number; cachedCallbacks: number; cachedActivations: number;
}) {
  'worklet';
  scheduleOnRN(diagnostics.reportUi, stats.generation, 'native_frame_sample', uiNow, values,
    { offsetMs: stats.uiOffsetMs, errorMs: stats.offsetErrorMs });
}

/** Records only the callback body; the counter update and RN publication are excluded from duration values. */
export function recordNativeFrame(stats: SharedValue<NativeFrameStats>, diagnostics: NativeDiagnostics, kind: 'row' | 'voice',
  startedUiMs: number, finishedUiMs: number, frameToken: number, rawFrameGapMs: number | null, options: {
    background?: boolean; idle?: boolean; cached?: boolean; cachedActivation?: boolean; pictureRebuilt?: boolean;
  } = {}) {
  'worklet';
  if (!__DEV__) return;
  const before = stats.value;
  if (!before.captureEnabled) return;
  const elapsed = Math.max(0, finishedUiMs - startedUiMs);
  const next = { ...before };
  if (next.currentFrameToken !== frameToken) {
    next.maxFrameWorkMs = Math.max(next.maxFrameWorkMs, next.currentFrameWorkMs);
    next.currentFrameToken = frameToken;
    next.currentFrameWorkMs = 0;
  }
  next.currentFrameWorkMs += elapsed;
  next.rowCallbacks += Number(kind === 'row');
  next.leadVoiceCallbacks += Number(kind === 'voice' && !options.background);
  next.backgroundVoiceCallbacks += Number(kind === 'voice' && !!options.background);
  next.pictureRebuilds += Number(!!options.pictureRebuilt);
  next.maxCallbackMs = Math.max(next.maxCallbackMs, elapsed);
  next.maxFrameGapMs = Math.max(next.maxFrameGapMs, rawFrameGapMs ?? 0);
  next.idleCallbacks += Number(!!options.idle);
  next.cachedCallbacks += Number(!!options.cached);
  next.cachedActivations += Number(!!options.cachedActivation);
  if (next.lastSampleUiMs === 0) next.lastSampleUiMs = startedUiMs;
  let values: Parameters<typeof reportFrameSample>[3] | null = null;
  if (startedUiMs - next.lastSampleUiMs >= 1000) {
    next.maxFrameWorkMs = Math.max(next.maxFrameWorkMs, next.currentFrameWorkMs);
    values = { rowCallbacks: next.rowCallbacks, leadVoiceCallbacks: next.leadVoiceCallbacks,
      backgroundVoiceCallbacks: next.backgroundVoiceCallbacks, pictureRebuilds: next.pictureRebuilds,
      maxCallbackBodyMs: next.maxCallbackMs, maxSummedCallbackBodyMsPerFrame: next.maxFrameWorkMs,
      maxRawFrameGapMs: next.maxFrameGapMs, idleCallbacks: next.idleCallbacks,
      cachedCallbacks: next.cachedCallbacks, cachedActivations: next.cachedActivations };
    next.lastSampleUiMs = startedUiMs;
    next.rowCallbacks = 0; next.leadVoiceCallbacks = 0; next.backgroundVoiceCallbacks = 0; next.pictureRebuilds = 0;
    next.maxCallbackMs = 0; next.maxFrameWorkMs = 0; next.maxFrameGapMs = 0; next.idleCallbacks = 0;
    next.cachedCallbacks = 0; next.cachedActivations = 0;
  }
  stats.value = next;
  if (values) reportFrameSample(diagnostics, startedUiMs, next, values);
}

export function NativeRenderDiagnosticsProvider({ enabled, renderer, runId, reason, children }: React.PropsWithChildren<{
  enabled: boolean; renderer: string; runId: number; reason: string;
}>) {
  const [captureEnabled, setCaptureEnabled] = useState(enabled && __DEV__);
  const [sessionVersion, setSessionVersion] = useState(0);
  const initialSessionStartedAt = useRef(performance.now()).current;
  const stats = useSharedValue<NativeFrameStats>({ uiOffsetMs: null, offsetErrorMs: null, lastSampleUiMs: 0,
    rowCallbacks: 0, leadVoiceCallbacks: 0, backgroundVoiceCallbacks: 0, pictureRebuilds: 0, maxCallbackMs: 0,
    currentFrameToken: -1, currentFrameWorkMs: 0, maxFrameWorkMs: 0, maxFrameGapMs: 0, idleCallbacks: 0,
    cachedCallbacks: 0, cachedActivations: 0, firstGlyphPicture: false, captureEnabled: false, generation: 0, captureStartedJsMs: initialSessionStartedAt });
  const session = useRef<SessionMeta>({ enabled: false, generation: 0, startedAtJsMs: initialSessionStartedAt, runId, renderer, reason, count: 0 });
  session.current.enabled = captureEnabled;
  session.current.renderer = renderer;
  const mounted = useRef({ row: 0, leadVoice: 0, backgroundVoice: 0 });
  const pendingUiEvents = useRef<PendingUiEvent[]>([]);
  const clockObservers = useRef(new Set<(active: boolean, projection?: ClockProjection) => void>());
  const sessionObservers = useRef(new Set<(generation: number, startedAtJsMs: number) => void>());
  const latestProjection = useRef<ClockProjection | undefined>(undefined);
  const publish = useCallback((event: string, fields: Fields = {}, jsElapsedMs?: number, runIdOverride?: number,
    expectedGeneration?: number) => {
    const meta = session.current;
    if (!meta.enabled || expectedGeneration != null && expectedGeneration !== meta.generation) return;
    if (meta.count >= 160 || performance.now() - meta.startedAtJsMs > 120000) {
      meta.enabled = false;
      const expiredGeneration = meta.generation;
      meta.generation += 1;
      pendingUiEvents.current = [];
      setCaptureEnabled(false);
      scheduleOnUI((shared: SharedValue<NativeFrameStats>, expected: number) => { 'worklet';
        if (shared.value.generation === expected) shared.value = { ...shared.value, captureEnabled: false, generation: expected + 1 };
      }, stats, expiredGeneration);
      clockObservers.current.forEach(observer => observer(false));
      return;
    }
    meta.count += 1;
    const record = { runId: runIdOverride ?? meta.runId, renderer: meta.renderer, event, reason: meta.reason,
      jsElapsedMs: Number((jsElapsedMs ?? performance.now() - meta.startedAtJsMs).toFixed(2)), ...fields };
    setTimeout(() => {
      if (session.current !== meta || !meta.enabled || expectedGeneration != null && expectedGeneration !== meta.generation) return;
      try { console.info('KINESYNC_NATIVE_RENDER_DIAG ' + JSON.stringify(record)); }
      catch { /* diagnostics must not interfere with rendering */ }
    }, 0);
  }, [stats]);
  const report = useCallback((event: string, fields: Fields = {}, generation?: number) => publish(event, fields, undefined, undefined, generation), [publish]);
  const reportUi = useCallback((generation: number, event: string, uiPerformanceNowMs: number, fields: Fields = {},
    clock: { offsetMs: number | null; errorMs: number | null } = { offsetMs: null, errorMs: null }) => {
    if (!session.current.enabled || generation !== session.current.generation) return;
    const receivedJsTime = performance.now();
    if (clock.offsetMs == null) {
      pendingUiEvents.current.push({ generation, event, uiTime: uiPerformanceNowMs, receivedJsTime, fields });
      if (pendingUiEvents.current.length > 16) pendingUiEvents.current.shift();
      return;
    }
    const uiAsJs = uiPerformanceNowMs - clock.offsetMs;
    publish(event, { ...fields, uiClockDomain: 'ui_performance_now', jsClockDomain: 'js_performance_now',
      uiPerformanceNowMs: Number(uiPerformanceNowMs.toFixed(2)), uiElapsedEstimatedMs: Number((uiAsJs - session.current.startedAtJsMs).toFixed(2)),
      jsReceiptElapsedMs: Number((receivedJsTime - session.current.startedAtJsMs).toFixed(2)),
      uiClockOffsetMs: Number(clock.offsetMs.toFixed(2)), uiClockUncertaintyMs: Number(clock.errorMs?.toFixed(2) ?? 0),
      calibrationAppliedAfterEvent: false }, undefined, undefined, generation);
  }, [publish]);
  const trackMount = useCallback((kind: 'row' | 'leadVoice' | 'backgroundVoice', delta: 1 | -1) => {
    mounted.current[kind] = Math.max(0, mounted.current[kind] + delta);
  }, []);
  const getSessionStartedAt = useCallback(() => session.current.startedAtJsMs, []);
  const getGeneration = useCallback(() => session.current.generation, []);
  const isCaptureActive = useCallback(() => session.current.enabled, []);
  const recordProjection = useCallback((projection: Omit<ClockProjection, 'generation' | 'reportedSerial'>) => {
    latestProjection.current = { ...projection, generation: session.current.generation, reportedSerial: 0 };
  }, []);
  const registerClockObserver = useCallback((observer: (active: boolean, projection?: ClockProjection) => void) => {
    clockObservers.current.add(observer);
    observer(session.current.enabled, latestProjection.current);
    return () => { clockObservers.current.delete(observer); observer(false); };
  }, []);
  const registerSessionObserver = useCallback((observer: (generation: number, startedAtJsMs: number) => void) => {
    sessionObservers.current.add(observer);
    observer(session.current.generation, session.current.startedAtJsMs);
    return () => { sessionObservers.current.delete(observer); };
  }, []);
  const value = useMemo(() => ({ stats, report, reportUi, trackMount, getSessionStartedAt, isCaptureActive,
    registerClockObserver, recordProjection, getGeneration, registerSessionObserver }),
    [stats, report, reportUi, trackMount, getSessionStartedAt, isCaptureActive, registerClockObserver, recordProjection, getGeneration, registerSessionObserver]);

  const endCapture = useCallback(() => {
    session.current.enabled = false;
    latestProjection.current = undefined;
    setCaptureEnabled(false);
    const generation = session.current.generation;
    scheduleOnUI((shared: SharedValue<NativeFrameStats>, expected: number) => { 'worklet';
      if (shared.value.generation === expected) shared.value = { ...shared.value, captureEnabled: false };
    }, stats, generation);
    clockObservers.current.forEach(observer => observer(false));
  }, [stats]);
  const startCapture = useCallback((nextReason: string) => {
    const newRunId = allocateNativeDiagnosticRunId();
    const generation = session.current.generation + 1;
    session.current = { enabled: true, generation, startedAtJsMs: performance.now(), runId: newRunId, renderer, reason: nextReason, count: 0 };
    pendingUiEvents.current = [];
    setCaptureEnabled(true);
    setSessionVersion(version => version + 1);
    scheduleOnUI((shared: SharedValue<NativeFrameStats>, nextGeneration: number, sessionStartJsMs: number) => {
      'worklet'; shared.value = clearFrameStats(shared.value, true, nextGeneration, sessionStartJsMs);
    }, stats, generation, session.current.startedAtJsMs);
    if (latestProjection.current) latestProjection.current = { ...latestProjection.current, generation, reportedSerial: 0 };
    clockObservers.current.forEach(observer => observer(true, latestProjection.current));
    sessionObservers.current.forEach(observer => observer(generation, session.current.startedAtJsMs));
  }, [renderer, stats]);
  const startCaptureRef = useRef(startCapture);
  startCaptureRef.current = startCapture;

  useEffect(() => {
    if (!captureEnabled) return;
    let active = true;
    const generation = session.current.generation;
    let finished = 0;
    const samples: { offset: number; rtt: number }[] = [];
    const receivePing = (expectedGeneration: number, sentJsMs: number, uiMs: number) => {
      if (!active || expectedGeneration !== generation || !session.current.enabled || session.current.generation !== generation) return;
      const returnedJsMs = performance.now();
      const estimate = estimateUiClockOffset(sentJsMs, uiMs, returnedJsMs);
      samples.push({ offset: estimate.offsetMs, rtt: estimate.roundTripMs });
      finished += 1;
      if (finished < 5) { sendPing(); return; }
      samples.sort((a, b) => a.rtt - b.rtt);
      const best = samples[0];
      const offsetErrorMs = best.rtt / 2;
      scheduleOnUI((shared: SharedValue<NativeFrameStats>, expected: number, offsetMs: number, errorMs: number) => {
        'worklet'; shared.value = applyUiClockCalibration(shared.value, expected, offsetMs, errorMs);
      }, stats, generation, best.offset, offsetErrorMs);
      publish('clock_calibrated', { method: 'JS/UI/JS midpoint; UI performance.now only', uiClockOffsetMs: Number(best.offset.toFixed(2)),
        uncertaintyBoundMs: Number(offsetErrorMs.toFixed(2)), roundTripMs: Number(best.rtt.toFixed(2)), samples: samples.length });
      const pending = pendingUiEvents.current.splice(0);
      for (const item of pending) {
        const uiAsJs = item.uiTime - best.offset;
        if (item.generation !== session.current.generation) continue;
        const projectionJs = typeof item.fields.projectionJsTimeMs === 'number' ? item.fields.projectionJsTimeMs : null;
        const projectionPosition = typeof item.fields.projectedPositionMs === 'number' ? item.fields.projectedPositionMs : null;
        const playing = item.fields.isPlaying === true;
        const projected = projectionJs == null || projectionPosition == null ? null :
          projectUiFrameFromJsProjection(projectionJs, projectionPosition, playing, item.uiTime, best.offset);
        publish(item.event, { ...item.fields,
          projectionToFrameMs: projected?.projectionToFrameMs ?? item.fields.projectionToFrameMs,
          expectedPositionMs: projected?.expectedPositionMs ?? item.fields.expectedPositionMs,
          uiClockDomain: 'ui_performance_now', jsClockDomain: 'js_performance_now',
          uiPerformanceNowMs: Number(item.uiTime.toFixed(2)), uiElapsedEstimatedMs: Number((uiAsJs - session.current.startedAtJsMs).toFixed(2)),
          jsReceiptElapsedMs: Number((item.receivedJsTime - session.current.startedAtJsMs).toFixed(2)),
          uiClockOffsetMs: Number(best.offset.toFixed(2)), uiClockUncertaintyMs: Number(offsetErrorMs.toFixed(2)),
          calibrationAppliedAfterEvent: true }, undefined, undefined, item.generation);
      }
    };
    const sendPing = () => {
      if (!active || !session.current.enabled) return;
      const sentJsMs = performance.now();
      scheduleOnUI((sent: number, expected: number, receive: typeof receivePing) => {
        'worklet';
        scheduleOnRN(receive, expected, sent, performance.now());
      }, sentJsMs, generation, receivePing);
    };
    scheduleOnUI((shared: SharedValue<NativeFrameStats>, expected: number) => { 'worklet';
      if (shared.value.generation === expected) shared.value = { ...shared.value, captureEnabled: true, uiOffsetMs: null, offsetErrorMs: null };
    }, stats, generation);
    sendPing();
    return () => { active = false; };
  }, [captureEnabled, publish, sessionVersion, stats]);

  useEffect(() => {
    if (captureEnabled) publish('capture_started', { reason: session.current.reason, renderer,
      clocks: 'js_performance_now + calibrated_ui_performance_now', physicalPresentation: 'not measured' });
  }, [captureEnabled, publish, renderer, sessionVersion]);
  useEffect(() => {
    if (!captureEnabled) return;
    const timer = setInterval(() => publish('native_scroll_sample', { mountedRows: mounted.current.row,
      mountedLeadVoices: mounted.current.leadVoice, mountedBackgroundVoices: mounted.current.backgroundVoice }), 1000);
    const expiry = setTimeout(endCapture, 120000);
    return () => { clearInterval(timer); clearTimeout(expiry); };
  }, [captureEnabled, endCapture, publish, sessionVersion]);
  const previousConfig = useRef({ enabled, renderer });
  useEffect(() => {
    const previous = previousConfig.current;
    previousConfig.current = { enabled, renderer };
    if (!enabled || !__DEV__) endCapture();
    else if (!previous.enabled) startCapture('native_instance_reactivated');
    else if (previous.renderer !== renderer) startCapture('renderer_switch');
  }, [enabled, endCapture, renderer, startCapture]);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const effectReplay = useRef(false);
  const observersForCleanup = clockObservers.current;
  useEffect(() => {
    if (effectReplay.current && enabledRef.current && __DEV__) {
      startCaptureRef.current('strict_effect_reactivation');
    }
    effectReplay.current = false;
    return () => {
      effectReplay.current = true;
      const expiredGeneration = session.current.generation;
      session.current.enabled = false;
      session.current.generation += 1;
      pendingUiEvents.current = [];
      scheduleOnUI((shared: SharedValue<NativeFrameStats>, expected: number) => { 'worklet';
        if (shared.value.generation === expected) shared.value = { ...shared.value, captureEnabled: false, generation: expected + 1 };
      }, stats, expiredGeneration);
      observersForCleanup.forEach(observer => observer(false));
    };
  }, [observersForCleanup, stats]);
  useEffect(() => {
    let backgrounded = false;
    const appState = AppState.addEventListener('change', state => {
      if (state !== 'active') { backgrounded = true; endCapture(); }
      else if (backgrounded && enabled && __DEV__) { backgrounded = false; startCapture('foreground'); }
    });
    return () => appState.remove();
  }, [enabled, endCapture, startCapture]);
  return <Context.Provider value={__DEV__ ? value : null}>{children}</Context.Provider>;
}
