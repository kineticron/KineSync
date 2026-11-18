// Evidence validation only: no speed threshold or CI performance gate.
const WORKLOAD = 'synthetic-paused-delayed-arrival-rust-host-v3';
function validateEvidence(data, requested) {
  for (const key of ['run','style','orientation','scenario']) if (data?.[key] !== requested[key]) throw Error(`Arrival evidence mismatched ${key}`);
  if (data.workload !== WORKLOAD) throw Error('Arrival evidence workload identity missing/mismatched');
  const preview = requested.scenario === 'start' ? 0 : 90000;
  if (data.previewPositionMs !== preview || data.playing !== false || data.fixtureRows !== 100 || data.initializedDelayMs !== 500) throw Error('Arrival fixture scenario configuration mismatch');
  const trace = data.trace;
  if (!trace || trace.counterSchema !== 1 || !Array.isArray(trace.records) || !trace.records.length) throw Error('Missing nonempty arrival trace');
  if (trace.saturated !== false || trace.dropped !== 0 || trace.records.length > 2048) throw Error('Saturated/incomplete arrival trace');
  for (const record of trace.records) if (!Number.isFinite(record.start) || !Number.isFinite(record.end) || record.end < record.start || !Number.isInteger(record.packet) || record.packet < 1 || !Number.isInteger(record.generation) || record.generation < 0) throw Error('Malformed arrival span identity/time');
  const delivered = trace.records.find(record => record.stage === 'fixture-delivered-not-network');
  if (!delivered) throw Error('Missing arrival fixture delivery');
  const prepared = trace.records.filter(record => record.stage === 'rust-packet-prepared' &&
    record.packet === delivered.packet && record.generation > 0 && record.start >= delivered.end);
  const ready = trace.records.some(record => record.stage === 'rust-track-ready-not-presentation' &&
    prepared.some(packet => packet.packet === record.packet && packet.generation === record.generation && record.start >= packet.end));
  if (!ready) throw Error('Missing or inconsistent Rust arrival stages');
  if (!Array.isArray(trace.unavailable) || !trace.unavailable.includes('actual first presented correct line') || !trace.unavailable.includes('actual first presented correct window')) throw Error('Presentation evidence gap must remain explicit');
  return data;
}
module.exports = { WORKLOAD, validateEvidence };
