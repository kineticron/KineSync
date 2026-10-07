import { NativeModule, requireOptionalNativeModule } from 'expo';
import { AppState, Platform } from 'react-native';
import { create } from 'zustand';

import { liveActivityInputChanged, makeLiveActivitySnapshot } from '@/lib/live-activity-snapshot';
import { usePlaybackStore } from '@/store/playback-store';

type Status = { state: string; message: string };
declare class LyricsModule extends NativeModule<{ onStatus: (status: Status) => void }> {
  sync(snapshot: string, retry: boolean): Promise<Status>;
  stop(): Promise<void>;
}

const native = Platform.OS === 'ios' ? requireOptionalNativeModule<LyricsModule>('KineSyncLiveActivity') : null;
export const useLiveActivityStatus = create<Status>(() => ({
  state: native ? 'idle' : 'unavailable',
  message: native ? 'Open KineSync to show playback details.' : 'Live Activity requires an iOS build with the KineSync widget extension. Expo Go is not supported.',
}));

let running = false;
let pending = false;
let retryRequested = false;
let enabled = false;

// One in-flight native operation; rapid seeks/source/track changes replace pending
// work with the newest store snapshot instead of replaying an obsolete queue.
async function flush() {
  if (running || !native || !enabled) return;
  running = true;
  try {
    while (pending && enabled) {
      pending = false;
      const retry = retryRequested;
      retryRequested = false;
      const state = usePlaybackStore.getState();
      const snapshot = makeLiveActivitySnapshot(state);
      try {
        const status = await native.sync(JSON.stringify(snapshot), retry);
        if (enabled) useLiveActivityStatus.setState(status);
      } catch (error) {
        useLiveActivityStatus.setState({ state: 'error', message: `Live Activity failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  } finally {
    running = false;
  }
}

function enqueue(retry = false) {
  if (!native || !enabled) return;
  pending = true;
  retryRequested ||= retry;
  void flush();
}

export function restartLiveActivity() { enqueue(true); }

export function startLiveActivitySync() {
  if (!native) return () => {};
  enabled = true;
  const unsubscribe = usePlaybackStore.subscribe((next, previous) => {
    if (liveActivityInputChanged(next, previous)) enqueue();
  });
  const lifecycle = AppState.addEventListener('change', () => enqueue());
  const statusListener = native.addListener('onStatus', (status) => useLiveActivityStatus.setState(status));
  enqueue();
  return () => {
    enabled = false;
    pending = false;
    unsubscribe();
    lifecycle.remove();
    statusListener.remove();
    // Only an explicit stop, system timeout, or user dismissal ends the activity.
  };
}
