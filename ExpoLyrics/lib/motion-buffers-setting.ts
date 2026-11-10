import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

const available = typeof __DEV__ !== 'undefined' && __DEV__ && Platform.OS !== 'web';
let enabled = false;
const listeners = new Set<() => void>();
export const getMotionBuffers = () => available && enabled;
export function setMotionBuffers(value: boolean) {
  if (!available || enabled === value) return;
  enabled = value === true;
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Session-only, deliberately default OFF for this experiment. */
export function useMotionBuffers() { return useSyncExternalStore(subscribe, getMotionBuffers, () => false); }
