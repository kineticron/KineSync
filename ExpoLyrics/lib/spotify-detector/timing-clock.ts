// Receipt timestamps are used for production playback projection.
export type ClockStamp = Readonly<{ wallMs: number; monotonicMs: number }>;
export type TimingOrigin = 'dealer' | 'registration' | 'parser';
export type TimingContext = {
  receipt?: ClockStamp;
  origin?: TimingOrigin;
  connectionId?: string;
  generation?: number;
};

export function timingNow(wallMs = Date.now()): ClockStamp {
  return Object.freeze({ wallMs, monotonicMs: performance.now() });
}
