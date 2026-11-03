import React, { createContext, Profiler, useContext, type ReactNode } from 'react';
import { arrivalEvent, type ArrivalHandle } from './lyrics-arrival-trace';
export const LyricsArrivalContext = createContext<{ handle: ArrivalHandle | undefined; generation: number }>({ handle: undefined, generation: 0 });
export function LyricsArrivalCommit({ children }: { children: ReactNode }) {
  const trace = useContext(LyricsArrivalContext);
  if (!__DEV__ || !trace.handle) return children;
  return React.createElement(Profiler, { id: 'lyrics-arrival', onRender: (_id, phase, _duration, _base, start, commit) => {
    arrivalEvent(trace.handle, trace.generation, `react-${phase}-render-to-commit`, start, commit);
  } }, children);
}
