import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModule, requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { refreshLyricsForCurrentTrack } from '@/lib/lyrics-sync';
import { resolveSpotifyCatalogMatch } from '@/lib/mobile-lyrics-client';
import { usePlaybackStore } from '@/store/playback-store';
import type { PlaybackPacket } from '@/types/bridge';

/**
 * Phone-only playback can follow either KineSync's built-in Spotify web player
 * or the Spotify app itself (read through Android's media-session API). The
 * app source avoids running the web player; lyrics, timing and UI are shared.
 */
export type PhonePlaybackSource = 'browser' | 'spotify-app';

export type SpotifyAppPlayback = {
  active: boolean;
  hasAccess: boolean;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  positionMs?: number;
  isPlaying?: boolean;
  spotifyTrackId?: string;
  artworkUrl?: string;
  sampledAtMs?: number;
};

type SpotifyAppCommand = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'seek';

declare class SpotifyAppModule extends NativeModule<{ onPlayback: (playback: SpotifyAppPlayback) => void }> {
  hasNotificationAccess(): boolean;
  openNotificationAccessSettings(): void;
  startWatching(): boolean;
  stopWatching(): void;
  getPlayback(): SpotifyAppPlayback | null;
  sendCommand(command: SpotifyAppCommand, positionMs?: number | null): boolean;
}

const native = Platform.OS === 'android'
  ? requireOptionalNativeModule<SpotifyAppModule>('KineSyncSpotifyApp')
  : null;

export const spotifyAppSupported = Boolean(native);

const SOURCE_KEY = 'kinesync_phone_playback_source';
let sourceChanged = false;

export const usePhonePlaybackSource = create<{
  source: PhonePlaybackSource;
  notificationAccess: boolean;
  setSource: (source: PhonePlaybackSource) => void;
}>((set) => ({
  source: 'browser',
  notificationAccess: Boolean(native?.hasNotificationAccess()),
  setSource: (source) => {
    sourceChanged = true;
    const next = source === 'spotify-app' && native ? 'spotify-app' : 'browser';
    set({ source: next });
    void AsyncStorage.setItem(SOURCE_KEY, next).catch(() => {});
  },
}));

if (native) {
  void AsyncStorage.getItem(SOURCE_KEY).then((value) => {
    if (!sourceChanged && value === 'spotify-app') usePhonePlaybackSource.setState({ source: 'spotify-app' });
  }).catch(() => {});
}

export function isFollowingSpotifyApp() {
  return Boolean(native) && usePhonePlaybackSource.getState().source === 'spotify-app';
}

export function refreshNotificationAccess() {
  const notificationAccess = Boolean(native?.hasNotificationAccess());
  usePhonePlaybackSource.setState({ notificationAccess });
  return notificationAccess;
}

export function openNotificationAccessSettings() {
  native?.openNotificationAccessSettings();
}

export const spotifyAppControls = {
  togglePlayPause: () => native?.sendCommand('toggle'),
  skipNext: () => native?.sendCommand('next'),
  skipPrevious: () => native?.sendCommand('previous'),
  seekTo: (positionMs: number) => native?.sendCommand('seek', Math.max(0, positionMs)),
};

// --- Spotify token for the catalog lookup (finds the track ID Spicy Lyrics needs) ---

type TokenWaiter = () => void;
const tokenWaiters = new Set<TokenWaiter>();
export const useSpotifyTokenRequest = create<{ requestedAt: number }>(() => ({ requestedAt: 0 }));

/** Called by the token refresher once a fresh token has been saved. */
export function notifySpotifyTokenRefreshed() {
  for (const waiter of [...tokenWaiters]) waiter();
}

/** Ask the hidden token page to run, and wait (bounded) for it to finish. */
function waitForSpotifyToken(timeoutMs: number) {
  useSpotifyTokenRequest.setState({ requestedAt: Date.now() });
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      tokenWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    tokenWaiters.add(done);
  });
}

// --- Playback ingestion --------------------------------------------------------

type TrackIdentity = {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  spotifyTrackId: string;
  catalogDone: boolean;
};

let identity: TrackIdentity | null = null;
let lastSample: SpotifyAppPlayback | null = null;
let lyricsRequest = 0;

function trackIdFor(title: string, artist: string) {
  // Same shape as the browser source: stable while catalog data arrives.
  return ['spotify-app', title.trim().toLowerCase(), artist.trim().toLowerCase()].join(':');
}

function ingest(sample: SpotifyAppPlayback, hasValidToken: () => boolean) {
  const store = usePlaybackStore.getState();
  if (store.playbackMode !== 'mobile' || store.connectionStatus === 'connected') return;
  if (!sample.active || !sample.title) {
    // Spotify closed or stopped: keep the last song on screen, paused.
    if (lastSample?.active && store.currentTrack && store.isPlaying) {
      ingest({ ...lastSample, isPlaying: false, sampledAtMs: Date.now() }, hasValidToken);
    }
    return;
  }

  const title = String(sample.title).trim();
  const artist = String(sample.artist || '').trim();
  const trackId = trackIdFor(title, artist);
  if (identity?.trackId !== trackId) {
    identity = {
      trackId,
      title,
      artist,
      album: String(sample.album || '').trim(),
      spotifyTrackId: String(sample.spotifyTrackId || '').trim(),
      catalogDone: false,
    };
  } else if (!identity.spotifyTrackId && sample.spotifyTrackId) {
    identity = { ...identity, spotifyTrackId: sample.spotifyTrackId };
  }
  lastSample = sample;

  const sampledAt = Number(sample.sampledAtMs) || Date.now();
  const positionMs = Math.max(0, Number(sample.positionMs) || 0);
  const packet: PlaybackPacket = {
    type: 'playback',
    trackId,
    title,
    artist: identity.artist,
    album: identity.album,
    spotifyTrackId: identity.spotifyTrackId || undefined,
    // Explicit empty artwork only on a new song; otherwise keep the cover
    // KineSync resolved itself (Spotify rarely exposes a web artwork URL).
    ...(sample.artworkUrl || store.currentTrack?.id !== trackId ? { artworkUrl: String(sample.artworkUrl || '') } : {}),
    durationMs: Math.max(0, Number(sample.durationMs) || 0),
    positionMs,
    isPlaying: Boolean(sample.isPlaying),
    timestamp: sampledAt,
    capturedAtMs: sampledAt,
    timing: { anchorPositionMs: positionMs, isPlaying: Boolean(sample.isPlaying), nativeExtrapolationEnabled: true },
  };
  const result = store.ingestPacket(packet, 'mobile');
  if (result.trackChanged) {
    store.clearLyrics();
    store.setLyricsStatusMessage('Spotify app playback detected. Loading lyrics...');
    void loadLyrics(trackId, hasValidToken);
  }
}

/** Resolve the Spotify catalog identity (id-based sources need it), then fetch lyrics. */
async function loadLyrics(trackId: string, hasValidToken: () => boolean) {
  const request = ++lyricsRequest;
  const isCurrent = () => request === lyricsRequest && identity?.trackId === trackId &&
    usePlaybackStore.getState().currentTrack?.id === trackId;

  // Spicy Lyrics only needs the Spotify track ID. A web token is needed just to
  // look that ID up when Spotify's media session does not include it.
  if (!identity?.spotifyTrackId && !hasValidToken()) await waitForSpotifyToken(12_000);
  if (!isCurrent()) return;

  const current = identity;
  if (current && (!current.spotifyTrackId || !current.album) && !current.catalogDone) {
    try {
      const match = await resolveSpotifyCatalogMatch({
        title: current.title,
        artist: current.artist,
        album: current.album,
        durationMs: Number(lastSample?.durationMs) || 0,
        spotifyTrackId: current.spotifyTrackId,
      });
      if (!isCurrent() || !identity) return;
      identity = {
        ...identity,
        catalogDone: true,
        ...(match
          ? {
              spotifyTrackId: match.spotifyTrackId,
              artist: match.artist || identity.artist,
              album: identity.album || match.album,
            }
          : {}),
      };
      // Re-emit the same song with its catalog identity; this is not a track change.
      if (match && lastSample) ingest({ ...lastSample, sampledAtMs: Date.now(), positionMs: projectedPosition() }, hasValidToken);
    } catch {
      // Catalog lookup is optional; title/artist sources still work.
    }
  }
  if (!isCurrent()) return;
  await refreshLyricsForCurrentTrack('auto');
}

function projectedPosition() {
  const state = usePlaybackStore.getState();
  const now = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  return state.anchorPositionMs + (state.isPlaying ? Math.max(0, now - state.anchorMonotonicMs) : 0);
}

/** Start following the Spotify app. Returns a cleanup function. */
export function startSpotifyAppTracking(hasValidToken: () => boolean) {
  const module = native;
  if (!module) return () => {};
  identity = null;
  lastSample = null;
  const subscription = module.addListener('onPlayback', (playback) => {
    usePhonePlaybackSource.setState({ notificationAccess: Boolean(playback.hasAccess) });
    ingest(playback, hasValidToken);
  });
  const hasAccess = module.startWatching();
  usePhonePlaybackSource.setState({ notificationAccess: hasAccess });
  const initial = module.getPlayback();
  if (initial) ingest(initial, hasValidToken);
  return () => {
    subscription.remove();
    module.stopWatching();
    lyricsRequest += 1;
  };
}

/** Re-read Spotify's current state (e.g. when KineSync returns to the foreground). */
export function resyncSpotifyApp(hasValidToken: () => boolean) {
  if (!native) return;
  // Access may have just been granted in Android settings: start watching now
  // (a no-op if already watching). Spotify's state then arrives as an event.
  usePhonePlaybackSource.setState({ notificationAccess: native.startWatching() });
  const playback = native.getPlayback();
  if (playback) ingest(playback, hasValidToken);
}
