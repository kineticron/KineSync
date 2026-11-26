import { AppState, Platform } from 'react-native';
import { usePlaybackStore } from '@/store/playback-store';
import { usePlayerTourStore } from '@/store/player-tour-store';
import { useSpotifySessionStore } from '@/store/spotify-session-store';
import {
  PlaybackCommandQueue,
  type PlaybackCommand,
  type PlaybackCommandState,
  type PlaybackOperation,
  type SendPlaybackCommand,
} from './playback-command-queue';

type Transport = {
  read: () => PlaybackCommandState;
  send: SendPlaybackCommand;
  accountVersion?: () => number;
  canQueue?: () => boolean;
  requestObservation?: () => void;
};

const transports: Partial<Record<'desktop' | 'mobile', Transport>> = {};
let scopeKeys: readonly unknown[] = [];
let foreground = AppState.currentState === 'active';
let observationEpoch = 0;

// Delayed transport packets retain the lifecycle epoch in which they arrived.
export const playbackObservationEpoch = () => observationEpoch;

const now = () => performance.now();
export const playbackCommands = new PlaybackCommandQueue({
  now,
  setTimeout: (fn, delay) => setTimeout(fn, delay),
  clearTimeout: timer => clearTimeout(timer),
});

export const playbackTimelinePreviewSource = {
  getSnapshot: () => playbackCommands.getSnapshot().anchor,
  subscribe: playbackCommands.subscribe,
};

export function refreshPlaybackCommands() {
  const { playbackMode, connectionStatus, serverUrl, handshakeKey } = usePlaybackStore.getState();
  const { active, pending } = usePlayerTourStore.getState();
  const { signedIn, loggedOut } = useSpotifySessionStore.getState();
  const candidate = active || pending ? undefined :
    playbackMode === 'desktop' ? transports.desktop :
    connectionStatus !== 'connected' && signedIn && !loggedOut ? transports.mobile : undefined;
  const transport = candidate?.canQueue?.() === false ? undefined : candidate;
  const keys = playbackMode === 'desktop' ?
    [transport, playbackMode, serverUrl, handshakeKey] :
    [transport, playbackMode, transport?.accountVersion?.()];
  if (!keys.every((key, index) => key === scopeKeys[index]) || keys.length !== scopeKeys.length) {
    scopeKeys = keys;
    playbackCommands.setTransport(keys, transport?.send, transport?.requestObservation);
  }
  if (!transport) return;
  const state = transport.read();
  playbackCommands.update(foreground ? state : { ...state, ready: false, fresh: false });
}

// Dealer publishes health before delivering the sample to the playback store.
// Read both after the synchronous detector event has finished.
let refreshScheduled = false;
export function schedulePlaybackCommandRefresh() {
  if (refreshScheduled) return;
  refreshScheduled = true;
  void Promise.resolve().then(() => {
    refreshScheduled = false;
    refreshPlaybackCommands();
  });
}

export function registerPlaybackCommandTransport(source: 'desktop' | 'mobile', transport: Transport) {
  transports[source] = transport;
  refreshPlaybackCommands();
  return () => {
    if (transports[source] !== transport) return;
    delete transports[source];
    refreshPlaybackCommands();
  };
}

export function cancelPlaybackCommands(source: 'desktop' | 'mobile') {
  if (usePlaybackStore.getState().playbackMode === source) playbackCommands.cancel();
}

export function submitPlaybackCommand(command: PlaybackCommand | 'toggle', expectedSeekEpoch?: number | null) {
  refreshPlaybackCommands();
  return command === 'toggle' ? playbackCommands.toggle() : playbackCommands.enqueue(command, expectedSeekEpoch);
}

export function playbackControlPosition(positionMs: number, commandView = playbackCommands.getSnapshot()) {
  const anchor = commandView.anchor;
  return anchor ? anchor.anchorPositionMs + (anchor.isPlaying ? Math.max(0, now() - anchor.anchorMonotonicMs) : 0) : positionMs;
}

export function nativePlaybackBlocked(action?: PlaybackOperation) {
  const { playbackMode, connectionStatus } = usePlaybackStore.getState();
  if ((Platform.OS !== 'ios' && Platform.OS !== 'android') || playbackMode !== 'mobile' ||
      connectionStatus === 'connected' || usePlayerTourStore.getState().active) return false;
  const { signedIn, loggedOut } = useSpotifySessionStore.getState();
  return !signedIn || loggedOut || !!(action && playbackCommands.getSnapshot().blocked[action]);
}

usePlaybackStore.subscribe((state, previous) => {
  if (state.playbackMode !== previous.playbackMode || state.connectionStatus !== previous.connectionStatus ||
      state.serverUrl !== previous.serverUrl || state.handshakeKey !== previous.handshakeKey) refreshPlaybackCommands();
});
usePlayerTourStore.subscribe((state, previous) => {
  if (state.active !== previous.active || state.pending !== previous.pending) refreshPlaybackCommands();
});
useSpotifySessionStore.subscribe((state, previous) => {
  if (state.signedIn !== previous.signedIn || state.loggedOut !== previous.loggedOut) refreshPlaybackCommands();
});
AppState.addEventListener('change', activity => {
  const active = activity === 'active';
  if (active === foreground) return;
  observationEpoch++;
  // Fence the current revision before reopening dispatch, even if the
  // transport still reports its pre-suspension snapshot as ready.
  if (active) refreshPlaybackCommands();
  foreground = active;
  refreshPlaybackCommands();
});
