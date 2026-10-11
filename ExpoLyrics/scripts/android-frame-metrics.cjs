// Legacy SurfaceFlinger columns are desired, actual-present and ready timestamps.
// Filter invalid fences and deduplicate records across its bounded ring buffer.
function collectPresentTimes(text, startNs, records) {
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || !fields.every(field => /^\d+$/.test(field))) continue;
    const actual = Number(fields[1]);
    if (actual > startNs && actual < Number.MAX_SAFE_INTEGER) records.add(actual);
  }
}
function summarizePresentTimes(records, elapsedSeconds) {
  const ordered = [...records].sort((a, b) => a - b);
  const intervals = ordered.slice(1).map((time, index) => (time - ordered[index]) / 1e6);
  const sorted = [...intervals].sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return { presentedFrames: ordered.length, presentedFramesPerSecond: ordered.length / elapsedSeconds,
    presentIntervalP50Ms: percentile(0.5), presentIntervalP95Ms: percentile(0.95), presentIntervalP99Ms: percentile(0.99) };
}
module.exports = { collectPresentTimes, summarizePresentTimes };
