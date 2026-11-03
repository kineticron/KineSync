const development = typeof __DEV__ !== 'undefined' && __DEV__;
let enabled = development;
const listeners = new Set<(enabled: boolean) => void>();

/** Same-build, in-memory experiment control. Production builds cannot enable it. */
export function isDealerDeliveryExperimentEnabled() { return development && enabled; }
export function setDealerDeliveryExperimentEnabled(next: boolean) {
  if (!development) return false;
  const value = !!next;
  if (enabled === value) return enabled;
  enabled = value;
  for (const listener of [...listeners]) {
    try { listener(enabled); } catch { /* A diagnostic experiment toggle must not interrupt playback. */ }
  }
  return enabled;
}
export function subscribeDealerDeliveryExperiment(listener: (enabled: boolean) => void) {
  if (!development) return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
