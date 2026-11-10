import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

const key = 'kinesync_dev_batched_amll_motion_v1';
let enabled = false;
let revision = 0;
let loading: Promise<void> | undefined;
let writes = Promise.resolve();
const listeners = new Set<() => void>();
const development = typeof __DEV__ !== 'undefined' && __DEV__;
export const getBatchedAmllMotion = () => development && enabled;
const notify = () => listeners.forEach(listener => listener());
export function loadBatchedAmllMotion() {
  if (!development) return Promise.resolve();
  if (!loading) {
    const started = revision;
    loading = AsyncStorage.getItem(key).then(value => {
      if (revision === started) { enabled = value === 'true'; notify(); }
    }).catch(() => {});
  }
  return loading;
}
export function setBatchedAmllMotion(value: boolean) {
  if (!development) return;
  revision++;
  enabled = value === true;
  notify();
  const stored = String(enabled);
  writes = writes.then(() => AsyncStorage.setItem(key, stored)).catch(() => {});
  return writes;
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useBatchedAmllMotion() {
  const value = useSyncExternalStore(subscribe, getBatchedAmllMotion, () => false);
  useEffect(() => { void loadBatchedAmllMotion(); }, []);
  return value;
}
