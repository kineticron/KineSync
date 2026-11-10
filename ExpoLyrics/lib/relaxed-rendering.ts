import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type RelaxedFlags = { glyphPicture: boolean; blurEnvelope: boolean; epsilon: boolean };
const defaults: RelaxedFlags = { glyphPicture: false, blurEnvelope: false, epsilon: false };
const key = 'kinesync:relaxed-rendering:v1';
let flags = defaults;
let loading: Promise<void> | undefined;
let revision = 0;
let writes = Promise.resolve();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export function loadRelaxedRendering() {
  const started = revision;
  return loading ??= AsyncStorage.getItem(key).then(raw => {
    if (revision !== started || !raw) return;
    const saved = JSON.parse(raw);
    flags = { glyphPicture: saved.glyphPicture === true, blurEnvelope: saved.blurEnvelope === true, epsilon: saved.epsilon === true };
    emit();
  }).catch(() => {});
}
export function setRelaxedRendering(name: keyof RelaxedFlags, enabled: boolean) {
  revision++;
  flags = { ...flags, [name]: enabled };
  emit();
  const snapshot = JSON.stringify(flags);
  writes = writes.then(() => AsyncStorage.setItem(key, snapshot)).catch(() => {});
}
export function useRelaxedRendering() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    void loadRelaxedRendering();
    return () => { listeners.delete(listener); };
  }, () => flags, () => defaults);
}
