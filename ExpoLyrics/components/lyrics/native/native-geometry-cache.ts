/** Immutable geometry only. Eviction releases lookup ownership, never live native handles. */
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) &&
    equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export function createNativeGeometryCache(maxEntries = 64, maxWeight = 65536) {
  const entries: { fonts: object; key: readonly unknown[]; weight: number; value: unknown }[] = [];
  let weight = 0;
  return {
    get size() { return entries.length; },
    get weight() { return weight; },
    get<T>(fonts: object, key: readonly unknown[], cost: number, build: () => T): T {
      const index = entries.findIndex(entry => entry.fonts === fonts && equal(entry.key, key));
      if (index >= 0) {
        const entry = entries.splice(index, 1)[0];
        entries.push(entry);
        return entry.value as T;
      }
      const value = build();
      if (Number.isFinite(cost) && cost >= 0 && cost <= maxWeight) {
        entries.push({ fonts, key, weight: cost, value });
        weight += cost;
        while (entries.length > maxEntries || weight > maxWeight) weight -= entries.shift()!.weight;
      }
      return value;
    },
  };
}

// Bounds describe retained entries/source UTF-16 units, not native byte usage.
export const nativeGeometryCache = createNativeGeometryCache();
