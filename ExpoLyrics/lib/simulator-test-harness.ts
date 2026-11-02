// Dev/test-only simulator testing harness and fake Spotify playback clock
// Enabled only by explicit compile-time test flags (including a separate Release opt-in).

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
  setSimulatorCaptureFrozen,
} from './simulator-test-bridge';

// Older trusted baselines omit these clock fields from their public packet type.
// Keep the simulator protocol identical without changing baseline production types.
type SimulatorPlaybackPacket = PlaybackPacket & {
  sourcePositionMs: number;
  positionTimestampMs: number;
  sourceServerTimestampMs: number;
};

export type HeartbeatMetrics = {
  samples: number;
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
  private runToken = '';
  private onCompleteCallback: ((summary: ScenarioSummary) => void) | null = null;

  private async screenshot(stage: string, details: string): Promise<void> {
    // Freeze the exact snapshot anchor, then allow native seek/layout animations to settle.
    // Playback-stage timers measure progression, not the snapshot position.
    const snapshotPositions: Record<string, number> = {
      stage_1_launch: 5000, stage_2_playback: 8000, stage_3_seek: 46000,
      stage_4_switch_amll: 46000, stage_5_skip_song: 5000,
      stage_6_switch_spicy: 5000, stage_7_rotation: 5000,
    };
    const positionMs = snapshotPositions[stage];
    if (positionMs === undefined) throw new Error(`Unknown screenshot stage: ${stage}`);
    this.clock.pause();
    this.clock.seek(positionMs);
    setSimulatorCaptureFrozen(true);
    try {
      await this.delay(1000);
      if (this.clock.isPlaying() || this.clock.getPositionMs() !== positionMs) throw new Error('Screenshot playback anchor changed');
      const token = `${this.runToken}_${stage}`;
      console.info(`[KINESYNC_SIM] READY_FOR_SCREENSHOT stage=${stage} token=${token} ${details}`);
      await waitForSimulatorScreenshotAck(stage, token, 120000);
    } finally {
      setSimulatorCaptureFrozen(false);
    }
  }

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
    useSpotifySessionStore.getState().setLoggedOut(false);
    useSpotifySessionStore.setState({ signedIn: true });
    usePlaybackStore.setState({ playbackMode: 'mobile' });

    this.heartbeat.start(20);
    console.info('[KINESYNC_SIM] INIT_READY');
  }

  public beginStage(stage: string): StageTimer {
    if (this.currentStage) {
      throw new Error(`Cannot begin ${stage}: ${this.currentStage.stage} is unfinished`);
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
    const packet: SimulatorPlaybackPacket = {
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

    const packet: SimulatorPlaybackPacket = {
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

    this.runToken = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.stageTimers = [];
    this.tracksLoadedCount = 0;
    console.info(`[KINESYNC_SIM] SCENARIO_START token=${this.runToken}`);

    try {
      // Stage 1: Launch and Song 1 initial load with Spicy renderer
      this.beginStage('stage_1_launch');
      // Set up readiness listener BEFORE triggering state change
      const readyPromise1 = waitForSimulatorRendererReady({ style: 'spicy', trackId: 'spotify-connect:sim_rewind_track', timeoutMs: 120000 });
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
      await this.screenshot('stage_1_launch', `style=spicy track=${track1.id} positionMs=5000`);
      this.endStage('stage_1_launch', 'PASS', { trackId: track1.id, style: 'spicy', lines: track1.linesCount });

      // Stage 2: Normal playback progression
      this.beginStage('stage_2_playback');
      this.clock.play(5000);
      await this.delay(3000);
      this.clock.pause();
      this.clock.seek(8000);
      const pos2 = this.clock.getPositionMs();
      await this.screenshot('stage_2_playback', `style=spicy track=${track1.id} positionMs=${pos2}`);
      this.endStage('stage_2_playback', 'PASS', { positionMs: pos2 });

      // Stage 3: Seek forward
      this.beginStage('stage_3_seek');
      this.clock.seek(45000);
      this.clock.play(45000);
      await this.delay(1000);
      this.clock.pause();
      this.clock.seek(46000);
      const pos3 = this.clock.getPositionMs();
      await this.screenshot('stage_3_seek', `style=spicy track=${track1.id} positionMs=${pos3}`);
      this.endStage('stage_3_seek', 'PASS', { positionMs: pos3 });

      // Stage 4: Switch renderer to AMLL
      this.beginStage('stage_4_switch_amll');
      const readyPromiseAmll = waitForSimulatorRendererReady({ style: 'amll', trackId: track1.id, timeoutMs: 120000 });
      this.switchRenderer('amll');
      const readyAmll = await readyPromiseAmll;
      this.renderersConfirmed.add(readyAmll.style);
      this.clock.pause();
      await this.screenshot('stage_4_switch_amll', `style=amll track=${track1.id} positionMs=${this.clock.getPositionMs()}`);
      this.endStage('stage_4_switch_amll', 'PASS', { style: 'amll', generation: readyAmll.generation });

      // Stage 5: Skip song to Song 2 (exercises parse, row build, and mount bottleneck)
      this.beginStage('stage_5_skip_song');
      const readyPromiseTrack2 = waitForSimulatorRendererReady({ style: 'amll', trackId: 'spotify-connect:sim_seesaw_track', timeoutMs: 120000 });
      const track2 = this.loadTrack(1);
      if (!track2) throw new Error('Failed to load track 2');
      const readyTrack2 = await readyPromiseTrack2;
      this.renderersConfirmed.add(readyTrack2.style);
      this.clock.play(0);
      await this.delay(2000);
      this.clock.pause();
      this.clock.seek(5000);
      await this.screenshot('stage_5_skip_song', `style=amll track=${track2.id} positionMs=5000`);
      this.endStage('stage_5_skip_song', 'PASS', { trackId: track2.id, lines: track2.linesCount });

      // Stage 6: Switch renderer back to Spicy
      this.beginStage('stage_6_switch_spicy');
      const readyPromiseSpicy2 = waitForSimulatorRendererReady({ style: 'spicy', trackId: track2.id, timeoutMs: 120000 });
      this.switchRenderer('spicy');
      const readySpicy2 = await readyPromiseSpicy2;
      this.renderersConfirmed.add(readySpicy2.style);
      this.clock.pause();
      await this.screenshot('stage_6_switch_spicy', `style=spicy track=${track2.id} positionMs=5000`);
      this.endStage('stage_6_switch_spicy', 'PASS', { style: 'spicy', generation: readySpicy2.generation });

      // Stage 7: Orientation rotation stage
      this.beginStage('stage_7_rotation');
      const landscapePromise = waitForSimulatorOrientation('landscape', 120000);
      console.info('[KINESYNC_SIM] TRIGGER_SIMULATOR_ROTATION orientation=landscape');
      const landscapeLayout = await landscapePromise;
      if (landscapeLayout.width <= landscapeLayout.height) {
        throw new Error(`Landscape viewport invariant failed: width=${landscapeLayout.width} <= height=${landscapeLayout.height}`);
      }
      this.clock.pause();
      await this.screenshot('stage_7_rotation', `style=spicy track=${track2.id} positionMs=5000 orientation=landscape width=${Math.round(landscapeLayout.width)} height=${Math.round(landscapeLayout.height)}`);

      // Return back to portrait orientation
      const portraitPromise = waitForSimulatorOrientation('portrait', 120000);
      console.info('[KINESYNC_SIM] TRIGGER_SIMULATOR_ROTATION orientation=portrait');
      await portraitPromise;
      this.endStage('stage_7_rotation', 'PASS', { width: landscapeLayout.width, height: landscapeLayout.height });

      // Stage 8: Finish scenario and report
      this.beginStage('stage_8_complete');
      this.clock.stop();
      const heartbeatMetrics = this.heartbeat.stop();
      this.endStage('stage_8_complete', 'PASS');

      const allStagesPassed = this.stageTimers.length === 8 && this.stageTimers.every((s) => s.status === 'PASS' && s.endWallMs !== undefined);
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
      console.info(`[KINESYNC_SIM] SCENARIO_COMPLETE ${JSON.stringify(this.transportSummary(summary))}`);

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
      console.info(`[KINESYNC_SIM] SCENARIO_COMPLETE ${JSON.stringify(this.transportSummary(summary))}`);

      this.isRunningScenario = false;
      if (this.onCompleteCallback) {
        this.onCompleteCallback(summary);
      }
    }
  }

  private transportSummary(summary: ScenarioSummary) {
    // Wall clocks and renderer metadata already travel in individual stage records.
    // Keep native os_log completion independent of sample count and error size.
    return { ...summary,
      stages: summary.stages.slice(0, 8).map(({ stage, status, durationMs }) => [stage, status, durationMs]),
      heartbeat: { samples: summary.heartbeat.samples },
      errors: summary.errors.slice(0, 1).map(error => error.slice(0, 120)),
    };
  }

  public getSummary(): ScenarioSummary {
    const allStagesPassed = this.stageTimers.length === 8 && this.stageTimers.every((s) => s.status === 'PASS' && s.endWallMs !== undefined);
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
