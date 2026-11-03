// Evidence validation only: no speed threshold or CI performance gate.
const WORKLOAD = 'synthetic-paused-delayed-arrival-initialized-host-v2';
function validateEvidence(data, requested) {
  for (const key of ['run','style','orientation','scenario']) if (data?.[key] !== requested[key]) throw Error(`Arrival evidence mismatched ${key}`);
  if (data.workload !== WORKLOAD) throw Error('Arrival evidence workload identity missing/mismatched');
  const preview = requested.scenario === 'start' ? 0 : 90000;
  if (data.previewPositionMs !== preview || data.playing !== false || data.fixtureRows !== 100 || data.initializedDelayMs !== 500) throw Error('Arrival fixture scenario configuration mismatch');
  const trace = data.trace;
  if (!trace || trace.counterSchema !== 1 || !Array.isArray(trace.records) || !trace.records.length) throw Error('Missing nonempty arrival trace');
  if (trace.saturated !== false || trace.dropped !== 0 || trace.records.length > 2048) throw Error('Saturated/incomplete arrival trace');
  for (const record of trace.records) if (!Number.isFinite(record.start) || !Number.isFinite(record.end) || record.end < record.start || !Number.isInteger(record.packet) || record.packet < 1 || !Number.isInteger(record.generation) || record.generation < 0) throw Error('Malformed arrival span identity/time');
  for (const stage of ['fixture-delivered-not-network','model','cues','glyph-shaping']) if (!trace.records.some(record => record.stage === stage)) throw Error(`Missing arrival stage ${stage}`);
  for (const key of ['modelCalls','cueBuilds','shapingCalls','paragraphBuilds','voiceRenders','firstPicturePublications']) if (!Number.isSafeInteger(trace.counters?.[key]) || trace.counters[key] <= 0) throw Error(`Missing positive observed counter ${key}`);
  if (trace.uiCounts?.complete !== true || trace.uiCounts.droppedOwners !== 0 || trace.uiCounts.timeouts !== 0 || !Number.isSafeInteger(trace.uiCounts.totals?.pictureBuilds) || trace.uiCounts.totals.pictureBuilds <= 0) throw Error('Missing complete scoped UI sample');
  if (!Array.isArray(trace.unavailable) || !trace.unavailable.includes('actual first presented correct line') || !trace.unavailable.includes('actual first presented correct window')) throw Error('Presentation evidence gap must remain explicit');
  return data;
}
module.exports = { WORKLOAD, validateEvidence };
