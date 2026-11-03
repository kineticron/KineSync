import React, { createContext, Profiler, useContext, useEffect, useMemo, useRef, type DependencyList, type ReactNode } from 'react';
import { arrivalEvent, arrivalHandle, arrivalReuse, type ArrivalHandle } from './lyrics-arrival-trace';
export type Trace = { handle: ArrivalHandle | undefined; generation: number };
const noTrace: Trace & { voiceInstance: number } = { handle: undefined, generation: 0, voiceInstance: 0 };
let sequence = 0, voiceSequence = 0;
// Build-invariant hook selection: the production functions call no React hooks.
export const LyricsArrivalContext = (typeof __DEV__ !== 'undefined' && __DEV__ ? createContext<Trace>(noTrace) : undefined)!;
function useDevVoiceTrace() {
  const trace = useContext(LyricsArrivalContext);
  const instance = useRef(0);
  if (!instance.current) instance.current = ++voiceSequence;
  useEffect(() => {
    arrivalEvent(trace.handle, trace.generation, 'voice-component-mounted', undefined, undefined, 1, undefined, { voiceInstance: instance.current });
    return () => arrivalEvent(trace.handle, trace.generation, 'voice-component-unmounted', undefined, undefined, 1, undefined, { voiceInstance: instance.current });
  }, []);
  useEffect(() => {
    arrivalEvent(trace.handle, trace.generation, 'voice-owner-acquired', undefined, undefined, undefined, undefined, { voiceInstance: instance.current });
    return () => arrivalEvent(trace.handle, trace.generation, 'voice-owner-released', undefined, undefined, undefined, undefined, { voiceInstance: instance.current });
  }, [trace]);
  return useMemo(() => ({ ...trace, voiceInstance: instance.current }), [trace]);
}

export const useArrivalVoice = typeof __DEV__ !== 'undefined' && __DEV__ ? useDevVoiceTrace : () => noTrace;
function useDevIdentity(lyrics?: object, dependencies: DependencyList = []) {
  const handle = lyrics ? arrivalHandle(lyrics) : undefined;
  const producers = useMemo(() => ({ model: 0, cues: 0 }), [handle]);
  const identity = useMemo(() => handle ? { id: ++sequence } : noIdentity.identity, [handle, ...dependencies.map(value => handle ? value : undefined)]);
  return useMemo(() => ({ handle, identity, producers }), [handle, identity, producers]);
}
const noIdentity = { handle: undefined, identity: { id: 0 }, producers: { model: 0, cues: 0 } };
export const useArrivalIdentity = typeof __DEV__ !== 'undefined' && __DEV__ ? useDevIdentity : () => noIdentity;
function useDevGeometry(scope: ReturnType<typeof useDevIdentity>, dependencies: DependencyList = []) {
  const generation = useMemo(() => scope.handle ? ++sequence : 0, [scope.handle, ...dependencies.map(value => scope.handle ? value : undefined)]);
  const context = useMemo(() => scope.handle ? ({ handle: scope.handle, generation }) : noTrace, [scope.handle, generation]);
  useEffect(() => {
    arrivalEvent(scope.handle, generation, 'react-passive-effect-after-commit');
    arrivalEvent(scope.handle, generation, 'stage-producer-attribution', undefined, undefined, undefined, scope.producers);
  }, [scope, generation]);
  return context;
}
export const useArrivalGeometry = typeof __DEV__ !== 'undefined' && __DEV__ ? useDevGeometry : () => noTrace;

export function LyricsArrivalCommit({ children }: { children: ReactNode }) {
  const trace = useContext(LyricsArrivalContext);
  if (!trace.handle) return children;
  return React.createElement(Profiler, { id: 'lyrics-arrival', onRender: (_id, phase, _duration, _base, start, commit) => {
    arrivalEvent(trace.handle, trace.generation, `react-${phase}-render-to-commit`, start, commit);
  } }, children);
}

function useDevShapeAttribution(trace: Trace & { voiceInstance: number }, shaped: object | null, translation: object | null) {
  useEffect(() => {
    arrivalReuse(trace.handle, trace.generation, 'main-shape', shaped, trace.voiceInstance);
    arrivalReuse(trace.handle, trace.generation, 'translation-layout', translation, trace.voiceInstance);
  }, [trace, shaped, translation]);
}
export const useArrivalShapeAttribution = typeof __DEV__ !== 'undefined' && __DEV__ ? useDevShapeAttribution : (_trace: Trace & { voiceInstance: number }, _shaped: object | null, _translation: object | null) => {};
