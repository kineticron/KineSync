// Optional local sidecar comparison. Never builds, dispatches, modifies artifacts or applies a perf gate.
const fs = require('node:fs');
function compare(baseline, candidate, baselinePerf, candidatePerf) {
  if (!!baselinePerf !== !!candidatePerf) throw Error('Both legacy perf artifacts are required');
  const metrics = ['modelCalls', 'cueBuilds', 'shapingCalls', 'paragraphBuilds', 'voiceRenders', 'reactCommits', 'firstPicturePublications', 'instrumentedSpansOver50Ms'];
  for (const data of [baseline, candidate]) {
    if (data.schema !== 1 || data.counterSchema !== 1 || data.buildMode !== 'development') throw Error('Compatible development counter sidecars required');
    for (const key of ['sourceSha', 'fixtureSha', 'instrumentationSha']) if (!/^[a-f0-9]{40,64}$/.test(data[key])) throw Error(`Missing immutable ${key}`);
    if (!data.counters || Object.keys(data.counters).sort().join() !== [...metrics].sort().join()) throw Error('Incomplete counter schema');
    if (Object.values(data.counters).some(value => !Number.isSafeInteger(value) || value < 0)) throw Error('Invalid counters');
  }
  if (baseline.variant !== 'baseline' || candidate.variant !== 'candidate') throw Error('Expected baseline/candidate pair');
  for (const key of ['runId', 'fixtureSha', 'instrumentationSha', 'configuration', 'scenario']) {
    if (typeof baseline[key] !== 'string' || !baseline[key] || baseline[key] !== candidate[key]) throw Error(`Unmatched ${key}`);
  }
  if (Object.keys(baseline.counters).sort().join() !== Object.keys(candidate.counters).sort().join()) throw Error('Counter coverage mismatch');
  const heartbeat = baselinePerf ? Object.fromEntries(['samples', 'blocksOver50Ms', 'blocksOver100Ms', 'maxDelayMs', 'p50Ms', 'p95Ms'].map(key => {
    const before = baselinePerf.heartbeat?.[key], after = candidatePerf.heartbeat?.[key];
    if (![before, after].every(value => Number.isFinite(value) && value >= 0)) throw Error('Invalid legacy heartbeat');
    return [key, { baseline: before, candidate: after, delta: after - before }];
  })) : undefined;
  return { schema: 1, legacyHeartbeat: heartbeat, heartbeatInterpretation: heartbeat ? 'callback lateness; shared-host noise; not measured JS task duration' : undefined, runId: baseline.runId, sourceShas: { baseline: baseline.sourceSha, candidate: candidate.sourceSha },
    fixtureSha: baseline.fixtureSha, instrumentationSha: baseline.instrumentationSha, configuration: baseline.configuration, scenario: baseline.scenario,
    interpretation: 'same-run exploratory counts; no performance gate or physical baseline; firstPicturePublications is not all picture builds; long spans are not JS tasks',
    metrics: Object.fromEntries(Object.keys(baseline.counters).map(key => [key, {
      baseline: baseline.counters[key], candidate: candidate.counters[key], delta: candidate.counters[key] - baseline.counters[key],
      ratio: baseline.counters[key] ? candidate.counters[key] / baseline.counters[key] : null,
    }])), spanRecordsDropped: { baseline: baseline.spanRecordsDropped, candidate: candidate.spanRecordsDropped },
    unavailable: [...new Set([...(baseline.unavailable ?? []), ...(candidate.unavailable ?? [])])] };
}
if (require.main === module) {
  const [baseline, candidate, output, baselinePerf, candidatePerf] = process.argv.slice(2);
  if (!baseline || !candidate || !output) throw Error('Usage: node compare-lyrics-arrival-counts.cjs BASELINE_SIDECAR CANDIDATE_SIDECAR NEW_OUTPUT [BASELINE_PERF CANDIDATE_PERF]');
  const result = compare(JSON.parse(fs.readFileSync(baseline)), JSON.parse(fs.readFileSync(candidate)),
    baselinePerf ? JSON.parse(fs.readFileSync(baselinePerf)) : undefined, candidatePerf ? JSON.parse(fs.readFileSync(candidatePerf)) : undefined);
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
}
module.exports = { compare };
