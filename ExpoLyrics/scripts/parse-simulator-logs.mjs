export const REQUIRED_STAGES = ['stage_1_launch', 'stage_2_playback', 'stage_3_seek', 'stage_4_switch_amll', 'stage_5_skip_song', 'stage_6_switch_spicy', 'stage_7_rotation', 'stage_8_complete'];
const TRACKS = ['spotify-connect:sim_rewind_track', 'spotify-connect:sim_seesaw_track'];
const STYLES = ['spicy', 'spicy', 'spicy', 'amll', 'amll', 'spicy', 'spicy'];
const READY_STAGES = new Set([REQUIRED_STAGES[0], REQUIRED_STAGES[3], REQUIRED_STAGES[4], REQUIRED_STAGES[5]]);
// Generic simulator log parser for KineSync test metrics
// Extracts stage timers, heartbeat delays, renderer readiness, and viewport orientation

export class SimulatorLogParser {
  constructor() {
    this.stages = [];
    this.renderers = new Set();
    this.heartbeat = null;
    this.summary = null;
    this.tracksLoaded = 0;
    this.appLaunched = false;
    this.landscapeConfirmed = false;
    this.portraitConfirmed = false;
    this.landscapeDimensions = null;
    this.screenshotRequests = [];
    this.rotationTriggers = [];
    this.errors = [];
    this.rawLines = [];
    this.activeStage = null;
    this.ready = null;
    this.pendingRotation = null;
    this.currentTrack = null;
    this.trackIds = new Set();
    this.scenarioStarted = false;
  }

  processLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    this.rawLines.push(trimmed);

    if (trimmed.includes('[KINESYNC_SIM] INIT_READY')) {
      this.appLaunched = true;
    }

    if (trimmed.includes('[KINESYNC_SIM] SCENARIO_START')) {
      if (this.scenarioStarted) this.errors.push('Repeated scenario start');
      this.scenarioStarted = true;
      return;
    }

    const stageBeginMatch = trimmed.match(/\[KINESYNC_SIM\] STAGE_BEGIN\s+(\w+)\s+timestamp=(\d+)/);
    if (stageBeginMatch) {
      if (!this.scenarioStarted || this.activeStage || stageBeginMatch[1] !== REQUIRED_STAGES[this.stages.length]) this.errors.push('Invalid stage order or overlapping stage');
      this.activeStage = stageBeginMatch[1];
      this.ready = null;
      this.stages.push({
        stage: stageBeginMatch[1],
        status: 'RUNNING',
        startWallMs: Number(stageBeginMatch[2]),
      });
      return;
    }

    const stageEndMatch = trimmed.match(/\[KINESYNC_SIM\] STAGE_END\s+(\w+)\s+status=(\w+)\s+durationMs=(\d+)(?:\s+(.*))?/);
    if (stageEndMatch) {
      const stageName = stageEndMatch[1];
      const status = stageEndMatch[2];
      const durationMs = Number(stageEndMatch[3]);
      const metaRaw = stageEndMatch[4];
      const stage = this.stages.find((s) => s.stage === stageName && s.status === 'RUNNING');
      if (stage) {
        stage.status = status;
        stage.durationMs = durationMs;
        if (metaRaw) {
          try {
            stage.metadata = JSON.parse(metaRaw);
          } catch {
            // Ignore non-json metadata
          }
        }
      }
      if (!stage || status !== 'PASS' || this.activeStage !== stageName) this.errors.push('Invalid or unmatched stage end');
      this.activeStage = null;
      return;
    }

    const stageFailMatch = trimmed.match(/\[KINESYNC_SIM\] STAGE_FAIL\s+(\w+)\s+error=(.*)/);
    if (stageFailMatch) {
      const stageName = stageFailMatch[1];
      const errorMsg = stageFailMatch[2];
      this.errors.push(`Stage ${stageName} failed: ${errorMsg}`);
      const stage = this.stages.find((s) => s.stage === stageName);
      if (stage) {
        stage.status = 'FAIL';
        stage.error = errorMsg;
      }
      return;
    }

    const rendererMatch = trimmed.match(/\[KINESYNC_SIM\] RENDERER_ACTIVE\s+style=(\w+)\s+generation=(\d+)\s+lines=(\d+)\s+track=([^\s]+)/);
    if (rendererMatch) {
      const lines = Number(rendererMatch[3]);
      const track = rendererMatch[4];
      if (lines > 0 && track && track !== 'null' && track !== 'undefined') {
        this.renderers.add(rendererMatch[1]);
        this.ready = { style: rendererMatch[1], track, stage: this.activeStage };
      } else {
        this.errors.push(`Invalid RENDERER_ACTIVE with zero lines or invalid track: ${trimmed}`);
      }
      return;
    }

    if (trimmed.includes('[KINESYNC_SIM] VIEWPORT_LAYOUT')) {
      const fields = Object.fromEntries([...trimmed.matchAll(/(\w+)=([^\s]+)/g)].map(m => [m[1], m[2]]));
      const { orientation } = fields;
      const width = Number(fields.width), height = Number(fields.height);
      const windowWidth = Number(fields.windowWidth), windowHeight = Number(fields.windowHeight);
      const valid = [width, height, windowWidth, windowHeight].every(n => Number.isFinite(n) && n > 0);
      if (valid && this.activeStage === 'stage_7_rotation' && this.pendingRotation === orientation) {
        if (orientation === 'landscape' && width > height && windowWidth > windowHeight) {
          this.landscapeConfirmed = true;
          this.landscapeDimensions = { width, height };
          this.pendingRotation = null;
        }
        if (orientation === 'portrait' && this.landscapeConfirmed && height > width && windowHeight > windowWidth) {
          this.portraitConfirmed = true;
          this.pendingRotation = null;
        }
      }
      return;
    }

    const screenshotMatch = trimmed.match(/\[KINESYNC_SIM\] READY_FOR_SCREENSHOT\s+stage=(\w+)/);
    if (screenshotMatch) {
      const stage = screenshotMatch[1];
      const fields = Object.fromEntries([...trimmed.matchAll(/(\w+)=([^\s]+)/g)].map(m => [m[1], m[2]]));
      if (stage !== this.activeStage || this.screenshotRequests.includes(stage)) this.errors.push('Invalid screenshot stage');
      const index = REQUIRED_STAGES.indexOf(stage);
      const expectedTrack = TRACKS[index < 4 ? 0 : 1];
      if (fields.track !== this.currentTrack || fields.track !== expectedTrack || fields.style !== STYLES[index]) this.errors.push('Screenshot track/style does not match scenario');
      if (READY_STAGES.has(stage) && (!this.ready || this.ready.stage !== stage || this.ready.track !== fields.track || this.ready.style !== fields.style)) this.errors.push(`Missing fresh per-track renderer readiness for ${stage}`);
      this.screenshotRequests.push(stage);
      return;
    }

    const rotationMatch = trimmed.match(/\[KINESYNC_SIM\] TRIGGER_SIMULATOR_ROTATION\s+orientation=(\w+)/);
    if (rotationMatch) {
      this.rotationTriggers.push(rotationMatch[1]);
      if (this.activeStage !== 'stage_7_rotation') this.errors.push('Rotation outside rotation stage');
      this.pendingRotation = rotationMatch[1];
      return;
    }

    const trackMatch = trimmed.match(/\[KINESYNC_SIM\] TRACK_LOADED\s+id=([^\s]+)\s+lines=(\d+)\s+parseMs=([\d.]+)/);
    if (trackMatch) {
      this.currentTrack = trackMatch[1];
      this.trackIds.add(this.currentTrack);
      this.tracksLoaded = this.trackIds.size;
      this.ready = null;
      return;
    }

    const heartbeatMatch = trimmed.match(/\[KINESYNC_SIM\] HEARTBEAT_METRICS\s+(.*)/);
    if (heartbeatMatch) {
      try {
        this.heartbeat = JSON.parse(heartbeatMatch[1]);
      } catch (err) {
        this.errors.push(`Failed to parse heartbeat metrics: ${err.message}`);
      }
      return;
    }

    const summaryMatch = trimmed.match(/\[KINESYNC_SIM\] SCENARIO_COMPLETE\s+(.*)/);
    if (summaryMatch) {
      if (this.summary) this.errors.push('Repeated scenario summary');
      try {
        this.summary = JSON.parse(summaryMatch[1]);
        // Compact native transport tuples preserve the same observed-stage cross-check.
        if (Array.isArray(this.summary?.stages)) this.summary.stages = this.summary.stages.map(stage => Array.isArray(stage) ? { stage: stage[0], status: stage[1], durationMs: stage[2] } : stage);
      } catch (err) {
        this.errors.push(`Failed to parse scenario summary: ${err.message}`);
      }
      return;
    }

    const failMatch = trimmed.match(/\[KINESYNC_SIM\] SCENARIO_FAILED\s+error=(.*)/);
    if (failMatch) {
      this.errors.push(`Scenario failed: ${failMatch[1]}`);
      return;
    }
  }

  validateAssertions() {
    const failures = [];
    if (!this.appLaunched) {
      failures.push('App did not launch or failed to initialize test harness');
    }
    if (!this.renderers.has('spicy')) {
      failures.push('Spicy renderer was not confirmed active via native readiness callback');
    }
    if (!this.renderers.has('amll')) {
      failures.push('AMLL renderer was not confirmed active via native readiness callback');
    }
    if (this.tracksLoaded !== 2) {
      failures.push(`Expected exactly 2 tracks loaded, found ${this.tracksLoaded}`);
    }
    if (!this.landscapeConfirmed) {
      failures.push('Rotation stage did not produce confirmed native landscape viewport with width > height');
    }
    if (!this.portraitConfirmed) {
      failures.push('Rotation stage did not produce confirmed native portrait viewport with height > width');
    }
    const failedStages = this.stages.filter((s) => s.status !== 'PASS');
    if (failedStages.length > 0) {
      for (const fs of failedStages) {
        failures.push(`Stage ${fs.stage} failed: ${fs.error || 'unspecified error'}`);
      }
    }
    if (this.stages.length !== 8 || this.stages.some((s, i) => s.stage !== REQUIRED_STAGES[i])) {
      failures.push(`Incomplete scenario: expected 8 ordered completed stages, got ${this.stages.length}`);
    }
    if (this.errors.length > 0) {
      for (const err of this.errors) {
        failures.push(`Execution error: ${err}`);
      }
    }
    if (!this.heartbeat || !Number.isInteger(this.heartbeat.samples) || this.heartbeat.samples <= 0) {
      failures.push('Missing or empty heartbeat performance metrics');
    }
    const hb = this.heartbeat;
    if (!hb || !['p50Ms', 'p95Ms', 'maxDelayMs', 'blocksOver50Ms', 'blocksOver100Ms'].every(key => Number.isFinite(hb[key]) && hb[key] >= 0) ||
        !Number.isInteger(hb.blocksOver50Ms) || !Number.isInteger(hb.blocksOver100Ms) ||
        hb.p50Ms > hb.p95Ms || hb.p95Ms > hb.maxDelayMs || hb.blocksOver100Ms > hb.blocksOver50Ms || hb.blocksOver50Ms > hb.samples) {
      failures.push('Incomplete heartbeat delay/stall metrics or contradictory values');
    }
    const requiredScreenshots = [
      'stage_1_launch',
      'stage_2_playback',
      'stage_3_seek',
      'stage_4_switch_amll',
      'stage_5_skip_song',
      'stage_6_switch_spicy',
      'stage_7_rotation',
    ];
    for (const req of requiredScreenshots) {
      if (!this.screenshotRequests.includes(req)) {
        failures.push(`Missing screenshot request for ${req}`);
      }
    }
    if (!this.summary) {
      failures.push('Missing SCENARIO_COMPLETE summary record');
    } else if (this.summary.success !== true) {
      failures.push('Summary reported success=false');
    }
    if (this.rotationTriggers.join(',') !== 'landscape,portrait' || this.pendingRotation) failures.push('Incomplete or repeated rotation transitions');
    if (this.summary?.success === true) {
      const reported = this.summary.stages;
      if (!Array.isArray(reported) || reported.length !== this.stages.length || reported.some((s, i) => !s || s.stage !== this.stages[i]?.stage || s.status !== this.stages[i]?.status || s.durationMs !== this.stages[i]?.durationMs) ||
          this.summary.tracksLoaded !== this.tracksLoaded || !Array.isArray(this.summary.errors) || this.summary.errors.length !== 0 ||
          !Array.isArray(this.summary.renderersExercised) || this.summary.renderersExercised.length !== this.renderers.size || [...this.renderers].some(r => !this.summary.renderersExercised.includes(r)) ||
          this.summary.heartbeat?.samples !== this.heartbeat?.samples) failures.push('Summary contradicts observed evidence');
    }
    return failures;
  }

  generateMarkdownReport() {
    const renderersList = Array.from(this.renderers).join(', ') || 'none';
    const hb = this.heartbeat || { p50Ms: 0, p95Ms: 0, maxDelayMs: 0, blocksOver50Ms: 0, blocksOver100Ms: 0 };
    const assertionFailures = this.validateAssertions();
    const passed = assertionFailures.length === 0;

    const lines = [
      '# Simulator Test Scenario Summary',
      '',
      `* Status: ${passed ? 'PASSED' : 'FAILED'}`,
      `* App Launched: ${this.appLaunched ? 'Yes' : 'No'}`,
      `* Tracks Loaded: ${this.tracksLoaded}`,
      `* Renderers Exercised: ${renderersList}`,
      `* Landscape Viewport Confirmed: ${this.landscapeConfirmed ? 'Yes' : 'No'}`,
      '',
      '## Performance and Event Loop Metrics',
      '',
      `* JS Delay p50: ${hb.p50Ms} ms`,
      `* JS Delay p95: ${hb.p95Ms} ms`,
      `* JS Delay Max: ${hb.maxDelayMs} ms`,
      `* JS Stalls (>50ms): ${hb.blocksOver50Ms}`,
      `* JS Stalls (>100ms): ${hb.blocksOver100Ms}`,
      '',
      '## Scenario Stage Timers',
      '',
      '| Stage | Status | Duration (ms) | Notes |',
      '| --- | --- | --- | --- |',
    ];

    for (const stage of this.stages) {
      const dur = stage.durationMs !== undefined ? `${stage.durationMs}` : 'Incomplete';
      const notes = stage.error ? stage.error : stage.metadata ? JSON.stringify(stage.metadata) : 'OK';
      lines.push(`| ${stage.stage} | ${stage.status} | ${dur} | ${notes} |`);
    }

    if (assertionFailures.length > 0) {
      lines.push('', '## Assertion Failures', '');
      for (const failure of assertionFailures) {
        lines.push(`* ${failure}`);
      }
    }

    return lines.join('\n');
  }
}
