// Dev/test-only simulator testing harness and fake Spotify playback clock
// Excluded from production builds by compile-time __DEV__ check

import type { PlaybackPacket } from '@/types/bridge';
import { usePlaybackStore, type LyricsStyle } from '@/store/playback-store';
import { useSpotifySessionStore } from '@/store/spotify-session-store';
import { SimulatorPlaybackClock } from './simulator-playback-clock';
import {
  isSimulatorTestActive,
  waitForSimulatorRendererReady,
  waitForSimulatorOrientation,
  waitForSimulatorScreenshotAck,
  resetSimulatorBridge,
} from './simulator-test-bridge';

export type HeartbeatMetrics = {
  samples: number;
  delays: number[];
  p50Ms: number;
  p95Ms: number;
  maxDelayMs: number;
  blocksOver50Ms: number;
  blocksOver100Ms: number;
};

export type StageTimer = {
  stage: string;
  status: 'PASS' | 'FAIL';
  startWallMs: number;
  endWallMs?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  error?: string;
};

export type ScenarioSummary = {
  success: boolean;
  stages: StageTimer[];
  heartbeat: HeartbeatMetrics;
  renderersExercised: string[];
  totalDurationMs: number;
  tracksLoaded: number;
  errors: string[];
};

export class SimulatorHeartbeat {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private delays: number[] = [];
  private expected: number = 0;
  private active: boolean = false;

  public start(intervalMs: number = 20): void {
    if (this.active) return;
    this.active = true;
    this.delays = [];
    this.expected = performance.now() + intervalMs;
    this.intervalHandle = setInterval(() => {
      const now = performance.now();
      const delay = Math.max(0, now - this.expected);
      this.delays.push(delay);
      this.expected = now + intervalMs;
    }, intervalMs);
  }

  public stop(): HeartbeatMetrics {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.active = false;
    return this.getMetrics();
  }

  public getMetrics(): HeartbeatMetrics {
    if (this.delays.length === 0) {
      return {
        samples: 0,
        delays: [],
        p50Ms: 0,
        p95Ms: 0,
        maxDelayMs: 0,
        blocksOver50Ms: 0,
        blocksOver100Ms: 0,
      };
    }
    const sorted = [...this.delays].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    const blocks50 = this.delays.filter((d) => d >= 50).length;
    const blocks100 = this.delays.filter((d) => d >= 100).length;
    return {
      samples: this.delays.length,
      delays: this.delays,
      p50Ms: Math.round(p50 * 10) / 10,
      p95Ms: Math.round(p95 * 10) / 10,
      maxDelayMs: Math.round(max * 10) / 10,
      blocksOver50Ms: blocks50,
      blocksOver100Ms: blocks100,
    };
  }
}

export class SimulatorTestHarness {
  private clock: SimulatorPlaybackClock;
  private heartbeat: SimulatorHeartbeat = new SimulatorHeartbeat();
  private stageTimers: StageTimer[] = [];
  private currentStage: StageTimer | null = null;
  private renderersConfirmed: Set<string> = new Set();
  private tracksLoadedCount: number = 0;
  private trackIndex: number = 0;
  private isRunningScenario: boolean = false;
  private isCancelled: boolean = false;
  private scenarioStartTime: number = 0;
  private activeTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();
  private errors: string[] = [];
  private onCompleteCallback: ((summary: ScenarioSummary) => void) | null = null;

  constructor() {
    this.clock = new SimulatorPlaybackClock((posMs, isPlaying) => {
      this.emitPlaybackPacket(posMs, isPlaying);
    });
  }

  public isSupported(): boolean {
    return isSimulatorTestActive();
  }

  public initialize(): void {
    if (!this.isSupported()) return;
    console.info('[KINESYNC_SIM] INIT_BEGIN');

    // Force mobile session so listening empty state does not obscure the player
    useSpotifySessionStore.setState({ signedIn: true, loggedOut: false });
    usePlaybackStore.setState({ playbackMode: 'mobile' });

    this.heartbeat.start(20);
    console.info('[KINESYNC_SIM] INIT_READY');
  }

  public beginStage(stage: string): StageTimer {
    if (this.currentStage) {
      this.endStage(this.currentStage.stage, 'PASS');
    }
    const timer: StageTimer = {
      stage,
      status: 'PASS',
      startWallMs: Date.now(),
    };
    this.currentStage = timer;
    this.stageTimers.push(timer);
    console.info(`[KINESYNC_SIM] STAGE_BEGIN ${stage} timestamp=${timer.startWallMs}`);
    return timer;
  }

  public endStage(stage: string, status: 'PASS' | 'FAIL' = 'PASS', metadata: Record<string, unknown> = {}, error?: string): void {
    const timer = this.currentStage;
    if (!timer || timer.stage !== stage) return;
    timer.status = status;
    timer.endWallMs = Date.now();
    timer.durationMs = Math.max(0, timer.endWallMs - timer.startWallMs);
    timer.metadata = metadata;
    if (error) {
      timer.error = error;
      this.errors.push(`${stage}: ${error}`);
      console.error(`[KINESYNC_SIM] STAGE_FAIL ${stage} error=${error}`);
    }
    this.currentStage = null;
    const metaStr = Object.keys(metadata).length > 0 ? ` ${JSON.stringify(metadata)}` : '';
    console.info(`[KINESYNC_SIM] STAGE_END ${stage} status=${status} durationMs=${timer.durationMs}${metaStr}`);
  }

  public loadTrack(index: number): { id: string; title: string; linesCount: number } | null {
    if (!this.isSupported()) return null;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SIMULATOR_FIXTURE_TRACKS } = require('@/lib/fixtures/simulator-test-fixtures') as typeof import('@/lib/fixtures/simulator-test-fixtures');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseTtmlToLyrics } = require('@/lib/lyrics-ttml-import') as typeof import('@/lib/lyrics-ttml-import');

    const track = SIMULATOR_FIXTURE_TRACKS[index % SIMULATOR_FIXTURE_TRACKS.length];
    this.trackIndex = index % SIMULATOR_FIXTURE_TRACKS.length;
    this.tracksLoadedCount++;
    this.clock.stop();
    this.clock.setDuration(track.durationMs);

    const parseStart = performance.now();
    const parsed = parseTtmlToLyrics(track.ttml);
    const parseDurationMs = Math.round((performance.now() - parseStart) * 10) / 10;

    console.info(`[KINESYNC_SIM] TRACK_LOADED id=${track.id} lines=${parsed.lyrics.length} parseMs=${parseDurationMs}`);

    const store = usePlaybackStore.getState();
    const packet: PlaybackPacket = {
      type: 'playback',
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs,
      positionMs: 0,
      isPlaying: false,
      timestamp: Date.now(),
      capturedAtMs: Date.now(),
      spotifyTrackId: track.spotifyTrackId,
      sourcePositionMs: 0,
      positionTimestampMs: Date.now(),
      sourceServerTimestampMs: Date.now(),
    };

    store.ingestPacket(packet, 'mobile');
    store.setLyrics(parsed.lyrics, 'lrc-red');
    store.setLyricsMetadata(parsed.metadata || {});
    store.setLyricsStatusMessage(`Loaded ${parsed.lyrics.length} lines from lrc-red.`);

    return { id: track.id, title: track.title, linesCount: parsed.lyrics.length };
  }

  public switchRenderer(style: LyricsStyle): void {
    const store = usePlaybackStore.getState();
    store.setLyricsStyle(style);
  }

  private emitPlaybackPacket(positionMs: number, isPlaying: boolean): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SIMULATOR_FIXTURE_TRACKS } = require('@/lib/fixtures/simulator-test-fixtures') as typeof import('@/lib/fixtures/simulator-test-fixtures');
    const track = SIMULATOR_FIXTURE_TRACKS[this.trackIndex % SIMULATOR_FIXTURE_TRACKS.length];

    const packet: PlaybackPacket = {
      type: 'playback',
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs,
      positionMs,
      isPlaying,
      timestamp: Date.now(),
      capturedAtMs: Date.now(),
      spotifyTrackId: track.spotifyTrackId,
      sourcePositionMs: positionMs,
      positionTimestampMs: Date.now(),
      sourceServerTimestampMs: Date.now(),
    };
    usePlaybackStore.getState().ingestPacket(packet, 'mobile');
  }

  private delay(ms: number): Promise<void> {
    if (this.isCancelled) return Promise.reject(new Error('CANCELLED'));
    return new Promise((resolve) => {
      const handle = setTimeout(() => {
        this.activeTimeouts.delete(handle);
        resolve();
      }, ms);
      this.activeTimeouts.add(handle);
    });
  }

  public async runAutomatedScenario(onComplete?: (summary: ScenarioSummary) => void): Promise<void> {
    if (!this.isSupported() || this.isRunningScenario) return;
    this.isRunningScenario = true;
    this.isCancelled = false;
    this.scenarioStartTime = Date.now();
    this.onCompleteCallback = onComplete || null;
    this.errors = [];
    this.renderersConfirmed.clear();

    console.info('[KINESYNC_SIM] SCENARIO_START');

    try {
      // Stage 1: Launch and Song 1 initial load with Spicy renderer
      this.beginStage('stage_1_launch');
      // Set up readiness listener BEFORE triggering state change
      const readyPromise1 = waitForSimulatorRendererReady({ style: 'spicy', timeoutMs: 12000 });
      this.switchRenderer('spicy');
      const track1 = this.loadTrack(0);
      if (!track1) throw new Error('Failed to load track 1');

      // Await real native renderer readiness verification
      const ready1 = await readyPromise1;
      this.renderersConfirmed.add(ready1.style);

      // Advance playback deterministically using monotonic clock to 5000ms
      this.clock.play(0);
      await this.delay(2000);
      this.clock.pause();
      this.clock.seek(5000);

      // Emit screenshot readiness marker and await handshake acknowledgement
      console.info(`[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_1_launch style=spicy track=${track1.id} positionMs=5000`);
      await waitForSimulatorScreenshotAck('stage_1_launch', 12000);
      this.endStage('stage_1_launch', 'PASS', { trackId: track1.id, style: 'spicy', lines: track1.linesCount });

      // Stage 2: Normal playback progression
      this.beginStage('stage_2_playback');
      this.clock.play(5000);
      await this.delay(3000);
      this.clock.pause();
      const pos2 = this.clock.getPositionMs();
      console.info(`[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_2_playback style=spicy track=${track1.id} positionMs=${pos2}`);
      await waitForSimulatorScreenshotAck('stage_2_playback', 12000);
      this.endStage('stage_2_playback', 'PASS', { positionMs: pos2 });

      // Stage 3: Seek forward
      this.beginStage('stage_3_seek');
      this.clock.seek(45000);
      this.clock.play(45000);
      await this.delay(1000);
      this.clock.pause();
      const pos3 = this.clock.getPositionMs();
      console.info(`[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_3_seek style=spicy track=${track1.id} positionMs=${pos3}`);
      await waitForSimulatorScreenshotAck('stage_3_seek', 12000);
      this.endStage('stage_3_seek', 'PASS', { positionMs: pos3 });

      // Stage 4: Switch renderer to AMLL
      this.beginStage('stage_4_switch_amll');
      const readyPromiseAmll = waitForSimulatorRendererReady({ style: 'amll', timeoutMs: 12000 });
      this.switchRenderer('amll');
      const readyAmll = await readyPromiseAmll;
      this.renderersConfirmed.add(readyAmll.style);
      this.clock.pause();
      console.info(`[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_4_switch_amll style=amll track=${track1.id} positionMs=${this.clock.getPositionMs()}`);
      await waitForSimulatorScreenshotAck('stage_4_switch_amll', 12000);
      this.endStage('stage_4_switch_amll', 'PASS', { style: 'amll', generation: readyAmll.generation });

      // Stage 5: Skip song to Song 2 (exercises parse, row build, and mount bottleneck)
      this.beginStage('stage_5_skip_song');
      const readyPromiseTrack2 = waitForSimulatorRendererReady({ style: 'amll', timeoutMs: 12000 });
      const track2 = this.loadTrack(1);
      if (!track2) throw new Error('Failed to load track 2');
      const readyTrack2 = await readyPromiseTrack2;
      this.renderersConfirmed.add(readyTrack2.style);
      this.clock.play(0);
      await this.delay(2000);
      this.clock.pause();
      this.clock.seek(5000);
      console.info(`[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_5_skip_song style=amll track=${track2.id} positionMs=5000`);
      await waitForSimulatorScreenshotAck('stage_5_skip_song', 12000);
      this.endStage('stage_5_skip_song', 'PASS', { trackId: track2.id, lines: track2.linesCount });

      // Stage 6: Switch renderer back to Spicy
      this.beginStage('stage_6_switch_spicy');
      const readyPromiseSpicy2 = waitForSimulatorRendererReady({ style: 'spicy', timeoutMs: 12000 });
      this.switchRenderer('spicy');
      const readySpicy2 = await readyPromiseSpicy2;
      this.renderersConfirmed.add(readySpicy2.style);
      this.clock.pause();
      console.info(`[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_6_switch_spicy style=spicy track=${track2.id} positionMs=5000`);
      await waitForSimulatorScreenshotAck('stage_6_switch_spicy', 12000);
      this.endStage('stage_6_switch_spicy', 'PASS', { style: 'spicy', generation: readySpicy2.generation });

      // Stage 7: Orientation rotation stage
      this.beginStage('stage_7_rotation');
      const landscapePromise = waitForSimulatorOrientation('landscape', 12000);
      console.info('[KINESYNC_SIM] TRIGGER_SIMULATOR_ROTATION orientation=landscape');
      const landscapeLayout = await landscapePromise;
      if (landscapeLayout.width <= landscapeLayout.height) {
        throw new Error(`Landscape viewport invariant failed: width=${landscapeLayout.width} <= height=${landscapeLayout.height}`);
      }
      this.clock.pause();
      console.info(`[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=stage_7_rotation style=spicy track=${track2.id} positionMs=5000 orientation=landscape width=${Math.round(landscapeLayout.width)} height=${Math.round(landscapeLayout.height)}`);
      await waitForSimulatorScreenshotAck('stage_7_rotation', 12000);

      // Return back to portrait orientation
      const portraitPromise = waitForSimulatorOrientation('portrait', 12000);
      console.info('[KINESYNC_SIM] TRIGGER_SIMULATOR_ROTATION orientation=portrait');
      await portraitPromise;
      this.endStage('stage_7_rotation', 'PASS', { width: landscapeLayout.width, height: landscapeLayout.height });
      this.endStage('stage_7_rotation', 'PASS', { width: landscapeLayout.width, height: landscapeLayout.height });

      // Stage 8: Finish scenario and report
      this.beginStage('stage_8_complete');
      this.clock.stop();
      const heartbeatMetrics = this.heartbeat.stop();
      this.endStage('stage_8_complete', 'PASS');

      const allStagesPassed = this.stageTimers.length >= 8 && this.stageTimers.every((s) => s.status === 'PASS');
      const allRenderersConfirmed = this.renderersConfirmed.has('spicy') && this.renderersConfirmed.has('amll');
      const tracksAdequate = this.tracksLoadedCount >= 2;
      const success = allStagesPassed && allRenderersConfirmed && tracksAdequate && this.errors.length === 0;

      const summary: ScenarioSummary = {
        success,
        stages: this.stageTimers,
        heartbeat: heartbeatMetrics,
        renderersExercised: Array.from(this.renderersConfirmed),
        totalDurationMs: Date.now() - this.scenarioStartTime,
        tracksLoaded: this.tracksLoadedCount,
        errors: this.errors,
      };

      console.info(`[KINESYNC_SIM] HEARTBEAT_METRICS ${JSON.stringify(heartbeatMetrics)}`);
      console.info(`[KINESYNC_SIM] SCENARIO_COMPLETE ${JSON.stringify(summary)}`);

      this.isRunningScenario = false;
      if (this.onCompleteCallback) {
        this.onCompleteCallback(summary);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.currentStage) {
        this.endStage(this.currentStage.stage, 'FAIL', {}, errMsg);
      }
      this.errors.push(errMsg);
      this.clock.stop();
      const heartbeatMetrics = this.heartbeat.stop();

      const summary: ScenarioSummary = {
        success: false,
        stages: this.stageTimers,
        heartbeat: heartbeatMetrics,
        renderersExercised: Array.from(this.renderersConfirmed),
        totalDurationMs: Date.now() - this.scenarioStartTime,
        tracksLoaded: this.tracksLoadedCount,
        errors: this.errors,
      };

      console.error(`[KINESYNC_SIM] SCENARIO_FAILED error=${errMsg}`);
      console.info(`[KINESYNC_SIM] SCENARIO_COMPLETE ${JSON.stringify(summary)}`);

      this.isRunningScenario = false;
      if (this.onCompleteCallback) {
        this.onCompleteCallback(summary);
      }
    }
  }

  public getSummary(): ScenarioSummary {
    const allStagesPassed = this.stageTimers.length >= 8 && this.stageTimers.every((s) => s.status === 'PASS');
    const allRenderersConfirmed = this.renderersConfirmed.has('spicy') && this.renderersConfirmed.has('amll');
    const tracksAdequate = this.tracksLoadedCount >= 2;
    const success = allStagesPassed && allRenderersConfirmed && tracksAdequate && this.errors.length === 0;

    return {
      success,
      stages: this.stageTimers,
      heartbeat: this.heartbeat.getMetrics(),
      renderersExercised: Array.from(this.renderersConfirmed),
      totalDurationMs: Date.now() - this.scenarioStartTime,
      tracksLoaded: this.tracksLoadedCount,
      errors: this.errors,
    };
  }

  public cleanup(): void {
    this.isCancelled = true;
    for (const handle of this.activeTimeouts) {
      clearTimeout(handle);
    }
    this.activeTimeouts.clear();
    this.clock.cleanup();
    this.heartbeat.stop();
    resetSimulatorBridge();
    if (this.currentStage) {
      this.endStage(this.currentStage.stage, 'FAIL', {}, 'CANCELLED_DURING_CLEANUP');
    }
  }
}

export const simulatorHarness = new SimulatorTestHarness();
