import React, { createContext, Profiler, useContext, useEffect, useMemo, type DependencyList, type ReactNode } from 'react';
import { arrivalEvent, arrivalHandle, type ArrivalHandle } from './lyrics-arrival-trace';
type Trace = { handle: ArrivalHandle | undefined; generation: number };
const noTrace: Trace = { handle: undefined, generation: 0 };
let sequence = 0;
// Build-invariant hook selection: the production functions call no React hooks.
export const LyricsArrivalContext = (typeof __DEV__ !== 'undefined' && __DEV__ ? createContext(noTrace) : undefined)!;
function useDevVoiceTrace() {
  const trace = useContext(LyricsArrivalContext);
  useEffect(() => {
    arrivalEvent(trace.handle, trace.generation, 'voice-owner-acquired', undefined, undefined, 1);
    return () => arrivalEvent(trace.handle, trace.generation, 'voice-owner-released', undefined, undefined, 1);
  }, [trace]);
  return trace;
}
export const useArrivalVoice = typeof __DEV__ !== 'undefined' && __DEV__ ? useDevVoiceTrace : () => noTrace;
function useDevIdentity(lyrics?: object, dependencies: DependencyList = []) {
  const handle = lyrics ? arrivalHandle(lyrics) : undefined;
  const producers = useMemo(() => ({ model: 0, cues: 0 }), [handle]);
  const identity = useMemo(() => ({ id: ++sequence }), dependencies);
  return useMemo(() => ({ handle, identity, producers }), [handle, identity, producers]);
}
const noIdentity = { handle: undefined, identity: { id: 0 }, producers: { model: 0, cues: 0 } };
export const useArrivalIdentity = typeof __DEV__ !== 'undefined' && __DEV__ ? useDevIdentity : () => noIdentity;
function useDevGeometry(scope: ReturnType<typeof useDevIdentity>, dependencies: DependencyList = []) {
  const generation = useMemo(() => ++sequence, dependencies);
  const context = useMemo(() => ({ handle: scope.handle, generation }), [scope.handle, generation]);
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
