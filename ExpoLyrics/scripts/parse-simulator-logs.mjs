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
  }

  processLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    this.rawLines.push(trimmed);

    if (trimmed.includes('[KINESYNC_SIM] INIT_READY')) {
      this.appLaunched = true;
    }

    const stageBeginMatch = trimmed.match(/\[KINESYNC_SIM\] STAGE_BEGIN\s+(\w+)\s+timestamp=(\d+)/);
    if (stageBeginMatch) {
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
      this.renderers.add(rendererMatch[1]);
      return;
    }

    const layoutMatch = trimmed.match(/\[KINESYNC_SIM\] VIEWPORT_LAYOUT\s+width=(\d+)\s+height=(\d+)\s+orientation=(\w+)\s+style=(\w+)/);
    if (layoutMatch) {
      const width = Number(layoutMatch[1]);
      const height = Number(layoutMatch[2]);
      const orientation = layoutMatch[3];
      if (orientation === 'landscape' && width > height) {
        this.landscapeConfirmed = true;
        this.landscapeDimensions = { width, height };
      }
      if (orientation === 'portrait' && height > width) {
        this.portraitConfirmed = true;
      }
      return;
    }

    const screenshotMatch = trimmed.match(/\[KINESYNC_SIM\] READY_FOR_SCREENSHOT\s+stage=(\w+)/);
    if (screenshotMatch) {
      this.screenshotRequests.push(screenshotMatch[1]);
      return;
    }

    const rotationMatch = trimmed.match(/\[KINESYNC_SIM\] TRIGGER_SIMULATOR_ROTATION\s+orientation=(\w+)/);
    if (rotationMatch) {
      this.rotationTriggers.push(rotationMatch[1]);
      return;
    }

    const trackMatch = trimmed.match(/\[KINESYNC_SIM\] TRACK_LOADED\s+id=([^\s]+)\s+lines=(\d+)\s+parseMs=([\d.]+)/);
    if (trackMatch) {
      this.tracksLoaded++;
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
      try {
        this.summary = JSON.parse(summaryMatch[1]);
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
    if (!this.appLaunched && this.stages.length === 0) {
      failures.push('App did not launch or failed to initialize test harness');
    }
    if (!this.renderers.has('spicy')) {
      failures.push('Spicy renderer was not confirmed active via native readiness callback');
    }
    if (!this.renderers.has('amll')) {
      failures.push('AMLL renderer was not confirmed active via native readiness callback');
    }
    if (this.tracksLoaded < 2) {
      failures.push(`Expected at least 2 tracks loaded, found ${this.tracksLoaded}`);
    }
    if (!this.landscapeConfirmed) {
      failures.push('Rotation stage did not produce confirmed native landscape viewport with width > height');
    }
    const failedStages = this.stages.filter((s) => s.status === 'FAIL');
    if (failedStages.length > 0) {
      for (const fs of failedStages) {
        failures.push(`Stage ${fs.stage} failed: ${fs.error || 'unspecified error'}`);
      }
    }
    if (this.stages.length < 8) {
      failures.push(`Incomplete scenario: expected at least 8 stages, got ${this.stages.length}`);
    }
    if (this.errors.length > 0) {
      for (const err of this.errors) {
        failures.push(`Execution error: ${err}`);
      }
    }
    if (!this.summary) {
      failures.push('Missing SCENARIO_COMPLETE summary record');
    } else if (this.summary.success !== true) {
      failures.push('Summary reported success=false');
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
