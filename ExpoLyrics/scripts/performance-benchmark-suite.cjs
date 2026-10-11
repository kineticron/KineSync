/** Pure JS workload, shared unchanged by Node and the emulator WebView runner. */
function runPerformanceBenchmarks(createTimeline, now = () => performance.now()) {
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  const results = [];
  let checksum = 0;
  for (const lineCount of [180, 1000, 5000]) {
    const ranges = Array.from({ length: lineCount }, (_, index) => ({
      start: index * 2000, end: index * 2000 + 2200, index,
    }));
    const buildStart = now();
    const lookup = createTimeline(ranges);
    const indexBuildMs = now() - buildStart;
    const positions = Array.from({ length: 12000 }, (_, index) =>
      ((index * 7919) % (lineCount * 2000)) + 0.25);
    const baseline = position => ranges.find(range => position >= range.start && position < range.end)?.index ?? -1;
    for (const position of positions) {
      if (lookup(position) !== baseline(position)) throw new Error('Benchmark outputs differ');
    }
    function batch(fn) {
      const start = now();
      for (const position of positions) checksum += fn(position);
      return now() - start;
    }
    // Warm both implementations; alternate order to reduce JIT/thermal bias.
    for (let i = 0; i < 3; i++) { batch(baseline); batch(lookup); }
    const before = [], after = [];
    for (let sample = 0; sample < 9; sample++) {
      if (sample % 2) { after.push(batch(lookup)); before.push(batch(baseline)); }
      else { before.push(batch(baseline)); after.push(batch(lookup)); }
    }
    const baselineMedianMs = percentile(before, 0.5);
    const optimizedMedianMs = percentile(after, 0.5);
    results.push({ lineCount, queriesPerSample: positions.length, samples: 9, indexBuildMs,
      baselineMedianMs, optimizedMedianMs,
      baselineP95BatchMs: percentile(before, 0.95), optimizedP95BatchMs: percentile(after, 0.95),
      speedup: baselineMedianMs / optimizedMedianMs,
      reductionPercent: (1 - optimizedMedianMs / baselineMedianMs) * 100,
      baselineUsPerLookup: baselineMedianMs * 1000 / positions.length,
      optimizedUsPerLookup: optimizedMedianMs * 1000 / positions.length,
    });
  }
  return { results, checksum, caveat: 'Lookup microbenchmarks measure CPU cost, not whole-app FPS or battery drain.' };
}
module.exports = { runPerformanceBenchmarks };
