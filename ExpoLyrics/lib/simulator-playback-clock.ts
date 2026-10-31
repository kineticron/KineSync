// Dev/test-only monotonic playback clock for simulator test harness
// Anchors playback to performance.now to eliminate drift under JS stalls
// Excluded from production builds by compile-time __DEV__ check

export type ClockTickCallback = (positionMs: number, isPlaying: boolean) => void;

export class SimulatorPlaybackClock {
  private basePositionMs: number = 0;
  private baseMonotonicMs: number = 0;
  private isPlayingState: boolean = false;
  private maxDurationMs: number = Number.MAX_SAFE_INTEGER;
  private tickerHandle: ReturnType<typeof setInterval> | null = null;
  private onTickCallback: ClockTickCallback | null = null;

  constructor(onTick?: ClockTickCallback) {
    this.onTickCallback = onTick ?? null;
  }

  public setDuration(durationMs: number): void {
    this.maxDurationMs = Math.max(0, durationMs);
  }

  public getPositionMs(): number {
    if (!this.isPlayingState) {
      return this.basePositionMs;
    }
    const elapsed = Math.max(0, performance.now() - this.baseMonotonicMs);
    const projected = this.basePositionMs + elapsed;
    return Math.min(this.maxDurationMs, Math.round(projected));
  }

  public isPlaying(): boolean {
    return this.isPlayingState;
  }

  public play(fromPositionMs?: number): void {
    const current = fromPositionMs !== undefined ? fromPositionMs : this.getPositionMs();
    this.basePositionMs = Math.max(0, Math.min(this.maxDurationMs, current));
    this.baseMonotonicMs = performance.now();
    this.isPlayingState = true;
    this.emitTick();
    this.startTicker();
  }

  public pause(): void {
    if (!this.isPlayingState) return;
    this.basePositionMs = this.getPositionMs();
    this.isPlayingState = false;
    this.stopTicker();
    this.emitTick();
  }

  public seek(targetPositionMs: number): void {
    this.basePositionMs = Math.max(0, Math.min(this.maxDurationMs, targetPositionMs));
    this.baseMonotonicMs = performance.now();
    this.emitTick();
  }

  public stop(): void {
    this.stopTicker();
    this.isPlayingState = false;
    this.basePositionMs = 0;
    this.baseMonotonicMs = 0;
  }

  public cleanup(): void {
    this.stopTicker();
    this.isPlayingState = false;
    this.onTickCallback = null;
  }

  private startTicker(): void {
    if (this.tickerHandle) return;
    this.tickerHandle = setInterval(() => {
      if (!this.isPlayingState) return;
      if (this.getPositionMs() >= this.maxDurationMs) {
        this.pause();
        return;
      }
      this.emitTick();
    }, 500);
  }

  private stopTicker(): void {
    if (this.tickerHandle) {
      clearInterval(this.tickerHandle);
      this.tickerHandle = null;
    }
  }

  private emitTick(): void {
    if (this.onTickCallback) {
      this.onTickCallback(this.getPositionMs(), this.isPlayingState);
    }
  }
}
