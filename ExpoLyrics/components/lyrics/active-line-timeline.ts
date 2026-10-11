/** Precompute half-open intervals, preserving the first matching line on overlaps. */
export function createActiveLineTimeline(ranges: { start: number; end: number; index: number }[]) {
  const events = ranges.flatMap((range, priority) => [
    { time: range.start, priority, active: true },
    { time: range.end, priority, active: false },
  ]).sort((a, b) => a.time - b.time);
  const active = new Set<number>();
  const boundaries: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < events.length;) {
    const time = events[i].time;
    do {
      const event = events[i++];
      if (event.active) active.add(event.priority);
      else active.delete(event.priority);
    } while (i < events.length && events[i].time === time);
    let first = Infinity;
    for (const priority of active) first = Math.min(first, priority);
    boundaries.push(time);
    indices.push(ranges[first]?.index ?? -1);
  }
  return (position: number) => {
    let low = 0;
    let high = boundaries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (boundaries[mid] <= position) low = mid + 1;
      else high = mid;
    }
    return indices[low - 1] ?? -1;
  };
}
