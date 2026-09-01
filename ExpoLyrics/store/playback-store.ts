import { create } from 'zustand';
import { AppState, Platform } from 'react-native';

import { enrichLyrics } from '@/lib/lyrics-enrich';
import { extractHost, isPrivateIpv4 } from '@/lib/network';
import { getBridgeSettings } from '@/lib/bridge-settings';
import { resolvePacketArtworkUrl } from '@/lib/artwork';
import {
  shouldAcceptPlaybackPacket,
  type PlaybackMode,
} from '@/lib/playback-source';
import type {
  BridgeTimingDiagnostics,
  ConnectionStatus,
  LyricLine,
  LyricsMetadata,
  PlaybackPacket,
  Track,
} from '@/types/bridge';

const SEEK_RESET_THRESHOLD_MS = 1800;
// Visual interpolation happens on the UI thread, so a 10 Hz JS clock keeps the
// timeline and line boundaries responsive without waking the JS runtime every frame.
const PLAYBACK_CLOCK_INTERVAL_MS = 100;
const PLAYBACK_POSITION_UPDATE_EPSILON_MS = 32;
const DEFAULT_HANDSHAKE_KEY = '';
const PLAYBACK_PACKET_METADATA_EPSILON_MS = 32;

export type LyricsRendererMode = 'native' | 'webview';

// Cached persisted defaults (fetched once at startup)
let _cachedBridgeUrl: string | null = null;
let _cachedHandshakeKey: string | null = null;

export async function initPlaybackStoreDefaults(): Promise<{ serverUrl: string; handshakeKey: string }> {
  if (_cachedBridgeUrl !== null && _cachedHandshakeKey !== null) {
    return { serverUrl: _cachedBridgeUrl, handshakeKey: _cachedHandshakeKey };
  }
  const settings = await getBridgeSettings();
  _cachedBridgeUrl = settings.serverUrl;
  _cachedHandshakeKey = settings.handshakeKey;
  usePlaybackStore.setState({ playbackMode: settings.playbackMode });
  // Push persisted values into the store — the store initializes synchronously before AsyncStorage resolves.
  // A completed setup with no server URL means phone-only mode, so do not infer the Expo host as a bridge.
  if (settings.serverUrl || settings.onboardingCompleted) {
    usePlaybackStore.setState({ serverUrl: settings.serverUrl });
  }
  if (settings.handshakeKey || settings.onboardingCompleted) {
    usePlaybackStore.setState({ handshakeKey: settings.handshakeKey });
  }
  return { serverUrl: _cachedBridgeUrl, handshakeKey: _cachedHandshakeKey };
}

function getMonotonicNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}


function inferDefaultBridgeUrl() {
  if (Platform.OS === 'web') {
    const hostname =
      typeof window !== 'undefined' && window.location?.hostname
        ? window.location.hostname
        : 'localhost';
    const host =
      hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname;
    return `ws://${host}:3001`;
  }

  const Constants = require('expo-constants').default;
  const constantsAny = Constants as unknown as Record<string, unknown>;
  const expoGoConfig = (constantsAny.expoGoConfig || {}) as Record<
    string,
    unknown
  >;
  const manifest = (constantsAny.manifest || {}) as Record<string, unknown>;

  const candidates = [
    extractHost(expoGoConfig.debuggerHost),
    extractHost(manifest.debuggerHost),
    extractHost(Constants.expoConfig?.hostUri),
    extractHost(constantsAny?.linkingUri),
  ].filter(Boolean);

  const preferredPrivateHost = candidates.find((host) => isPrivateIpv4(host));
  const host =
    preferredPrivateHost ||
    candidates.find(
      (candidate) => candidate === 'localhost' || candidate === '127.0.0.1',
    ) ||
    '';
  if (!host) {
    return '';
  }
  return `ws://${host}:3001`;
}

type PlaybackState = {
  playbackMode: PlaybackMode;
  connectionStatus: ConnectionStatus;
  serverUrl: string;
  handshakeKey: string;
  currentTrack: Track | null;
  anchorPositionMs: number;
  anchorTimestampMs: number;
  anchorMonotonicMs: number;
  playbackPosition: number;
  isPlaying: boolean;
  driftOffset: number;
  lyrics: LyricLine[];
  lyricsMetadata: LyricsMetadata;
  lyricsSource: string;
  lyricsStatusMessage: string;
  errorMessage: string;
  simulatedLatencyMs: number;
  packetDropRate: number;
  playbackCompensationMs: number;
  playbackTapToSeek: boolean;
  hidePlaybackStatusBar: boolean;
  autoHidePlaybackControls: boolean;
  showTranslatedText: boolean;
  lyricsRendererMode: LyricsRendererMode;
  bridgeTiming: BridgeTimingDiagnostics;
  clockSkewBaselineMs: number;
  lastSourceClockMs: number;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setPlaybackMode: (mode: PlaybackMode) => void;
  setServerUrl: (url: string) => void;
  setHandshakeKey: (key: string) => void;
  setErrorMessage: (message: string) => void;
  ingestPacket: (
    packet: PlaybackPacket,
    source: PlaybackMode,
  ) => { trackChanged: boolean; seekDetected: boolean };
  setLyrics: (lyrics: LyricLine[], source?: string) => void;
  setLyricsMetadata: (metadata: LyricsMetadata) => void;
  beginTranslationRequest: () => void;
  clearLyrics: () => void;
  setLyricsStatusMessage: (message: string) => void;
  setCurrentTrackArtwork: (trackId: string, artworkUrl: string) => void;
  setSimulatedLatencyMs: (ms: number) => void;
  setPacketDropRate: (rate: number) => void;
  setPlaybackCompensationMs: (ms: number) => void;
  setPlaybackTapToSeek: (value: boolean) => void;
  setHidePlaybackStatusBar: (value: boolean) => void;
  setAutoHidePlaybackControls: (value: boolean) => void;
  setShowTranslatedText: (value: boolean) => void;
  setLyricsRendererMode: (mode: LyricsRendererMode) => void;
};

let playbackClockTimer: ReturnType<typeof setInterval> | null = null;
let playbackClockEnabled = AppState.currentState === 'active';

function clearPlaybackClockHandle() {
  if (playbackClockTimer) {
    clearInterval(playbackClockTimer);
  }
  playbackClockTimer = null;
}

function tickPlaybackClock() {
  if (!playbackClockEnabled) {
    return;
  }

  const state = usePlaybackStore.getState();
  if (!state.isPlaying) {
    clearPlaybackClockHandle();
    return;
  }

  const playbackPosition = computePlaybackPosition(state);
  if (
    Math.abs(playbackPosition - state.playbackPosition) >=
    PLAYBACK_POSITION_UPDATE_EPSILON_MS
  ) {
    usePlaybackStore.setState({ playbackPosition });
  }
  const durationMs = state.currentTrack?.durationMs ?? 0;
  if (durationMs > 0 && playbackPosition >= durationMs) {
    clearPlaybackClockHandle();
  }
}

function schedulePlaybackClockTick() {
  if (!playbackClockEnabled || playbackClockTimer) {
    return;
  }
  const state = usePlaybackStore.getState();
  if (!state.isPlaying) {
    clearPlaybackClockHandle();
    return;
  }
  tickPlaybackClock();
  playbackClockTimer = setInterval(tickPlaybackClock, PLAYBACK_CLOCK_INTERVAL_MS);
}

function computePlaybackPosition(state: PlaybackState) {
  const nowMono = getMonotonicNow();
  const elapsed = state.isPlaying ? Math.max(0, nowMono - state.anchorMonotonicMs) : 0;
  const rawPosition = state.anchorPositionMs + elapsed;
  const durationMs = state.currentTrack?.durationMs ?? 0;
  if (durationMs > 0) {
    return Math.max(0, Math.min(rawPosition, durationMs));
  }
  return Math.max(0, rawPosition);
}

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  playbackMode: 'desktop',
  connectionStatus: 'disconnected',
  serverUrl: _cachedBridgeUrl || inferDefaultBridgeUrl(),
  handshakeKey: _cachedHandshakeKey || DEFAULT_HANDSHAKE_KEY,
  currentTrack: null,
  anchorPositionMs: 0,
  anchorTimestampMs: 0,
  anchorMonotonicMs: 0,
  playbackPosition: 0,
  isPlaying: false,
  driftOffset: 0,
  lyrics: [],
  lyricsMetadata: {},
  lyricsSource: '',
  lyricsStatusMessage: '',
  errorMessage: '',
  simulatedLatencyMs: 0,
  packetDropRate: 0,
  playbackCompensationMs: 0,
  playbackTapToSeek: true,
  hidePlaybackStatusBar: true,
  autoHidePlaybackControls: true,
  showTranslatedText: true,
  lyricsRendererMode: 'webview',
  bridgeTiming: {},
  clockSkewBaselineMs: Number.NaN,
  lastSourceClockMs: 0,
  setConnectionStatus: (status) =>
    set((state) =>
      status === 'connected'
        ? { connectionStatus: status }
        : { connectionStatus: status, clockSkewBaselineMs: Number.NaN, lastSourceClockMs: 0 },
    ),
  setPlaybackMode: (playbackMode) =>
    set({
      playbackMode,
      clockSkewBaselineMs: Number.NaN,
      lastSourceClockMs: 0,
    }),
  setServerUrl: (url) => {
    set({ serverUrl: url.trim() });
  },
  setHandshakeKey: (key) => {
    set({ handshakeKey: key.trim() || DEFAULT_HANDSHAKE_KEY });
  },
  setErrorMessage: (message) => set({ errorMessage: message }),
  ingestPacket: (packet, source) => {
    const nowWall = Date.now();
    const nowMono = getMonotonicNow();
    const prev = get();
    if (!shouldAcceptPlaybackPacket(prev.playbackMode, source)) {
      return { trackChanged: false, seekDetected: false };
    }
    const sourceClockRaw = Number(packet.capturedAtMs ?? packet.timestamp ?? nowWall);
    const sourceClock = Number.isFinite(sourceClockRaw) ? sourceClockRaw : nowWall;
    if (sourceClock + 250 < prev.lastSourceClockMs) {
      return { trackChanged: false, seekDetected: false };
    }
    const observedDelta = Math.max(-60_000, Math.min(60_000, nowWall - sourceClock));
    const baseline = Number.isFinite(prev.clockSkewBaselineMs)
      ? Math.min(prev.clockSkewBaselineMs, observedDelta)
      : observedDelta;
    const latency = Math.min(1_500, Math.max(0, observedDelta - baseline));
    const correctedPosition = Math.max(
      0,
      packet.positionMs + (packet.isPlaying ? latency : 0) + prev.playbackCompensationMs,
    );
    const previousArtwork = prev.currentTrack?.artworkUrl;

    const incomingTrack: Track = {
      id: packet.trackId,
      title: packet.title,
      artist: packet.artist,
      album: packet.album,
      // Keep the last cover visible while the bridge resolves art for a new track.
      // Explicit empty artwork clears stale covers for mobile-only browser playback.
      artworkUrl: resolvePacketArtworkUrl(previousArtwork, packet),
      durationMs: packet.durationMs,
      spotifyTrackId: packet.spotifyTrackId,
    };

    const trackChanged = prev.currentTrack?.id !== incomingTrack.id;
    const projected =
      prev.anchorPositionMs + (prev.isPlaying ? nowMono - prev.anchorMonotonicMs : 0);
    const seekDetected =
      !trackChanged && Math.abs(projected - correctedPosition) >= SEEK_RESET_THRESHOLD_MS;
    const playStateChanged = prev.isPlaying !== packet.isPlaying;
    const metadataChanged =
      trackChanged ||
      prev.currentTrack?.title !== incomingTrack.title ||
      prev.currentTrack?.artist !== incomingTrack.artist ||
      prev.currentTrack?.album !== incomingTrack.album ||
      prev.currentTrack?.artworkUrl !== incomingTrack.artworkUrl ||
      prev.currentTrack?.durationMs !== incomingTrack.durationMs ||
      prev.currentTrack?.spotifyTrackId !== incomingTrack.spotifyTrackId;
    const stationaryDuplicate =
      !metadataChanged &&
      !playStateChanged &&
      !seekDetected &&
      !packet.isPlaying &&
      Math.abs(prev.playbackPosition - correctedPosition) < PLAYBACK_PACKET_METADATA_EPSILON_MS &&
      Math.abs(prev.anchorPositionMs - correctedPosition) < PLAYBACK_PACKET_METADATA_EPSILON_MS;
    if (stationaryDuplicate) {
      if (packet.timing && typeof packet.timing === 'object') {
        set({ bridgeTiming: packet.timing });
      }
      return { trackChanged: false, seekDetected: false };
    }

    set({
      currentTrack: metadataChanged ? incomingTrack : prev.currentTrack,
      anchorPositionMs: correctedPosition,
      anchorTimestampMs: nowWall,
      anchorMonotonicMs: nowMono,
      playbackPosition: correctedPosition,
      isPlaying: packet.isPlaying,
      driftOffset: Math.round(latency),
      bridgeTiming:
        packet.timing && typeof packet.timing === 'object'
          ? packet.timing
          : prev.bridgeTiming,
      clockSkewBaselineMs: baseline,
      lastSourceClockMs: Math.max(prev.lastSourceClockMs, sourceClock),
    });
    if (packet.isPlaying) {
      schedulePlaybackClockTick();
    } else {
      clearPlaybackClockHandle();
    }

    return { trackChanged, seekDetected };
  },
  setLyrics: (lyrics, source = 'qq-music') =>
    set({ lyrics: enrichLyrics(lyrics), lyricsSource: source }),
  setLyricsMetadata: (metadata) => set({ lyricsMetadata: metadata || {} }),
  beginTranslationRequest: () =>
    set((state) => ({
      lyricsMetadata: {
        ...state.lyricsMetadata,
        translation: {
          ...(state.lyricsMetadata.translation || {}),
          isLoading: true,
          requestedAt: Date.now(),
        },
      },
    })),
  clearLyrics: () => set({ lyrics: [], lyricsMetadata: {}, lyricsSource: '', lyricsStatusMessage: '' }),
  setLyricsStatusMessage: (message) => set({ lyricsStatusMessage: message }),
  setCurrentTrackArtwork: (trackId, artworkUrl) =>
    set((state) => {
      const currentTrack = state.currentTrack;
      const nextArtworkUrl = String(artworkUrl || '').trim();
      if (!currentTrack || currentTrack.id !== trackId || !nextArtworkUrl) {
        return state;
      }
      if (currentTrack.artworkUrl === nextArtworkUrl) {
        return state;
      }
      return { currentTrack: { ...currentTrack, artworkUrl: nextArtworkUrl } };
    }),
  setSimulatedLatencyMs: (ms) => {
    const safe = Number.isFinite(ms) ? ms : 0;
    set({ simulatedLatencyMs: Math.max(0, Math.min(3000, Math.floor(safe))) });
  },
  setPacketDropRate: (rate) => {
    const safe = Number.isFinite(rate) ? rate : 0;
    set({ packetDropRate: Math.max(0, Math.min(0.9, safe)) });
  },
  setPlaybackCompensationMs: (ms) => {
    const safe = Number.isFinite(ms) ? ms : 0;
    set({ playbackCompensationMs: Math.max(-2000, Math.min(4000, Math.floor(safe))) });
  },
  setPlaybackTapToSeek: (value) => set({ playbackTapToSeek: Boolean(value) }),
  setHidePlaybackStatusBar: (value) => set({ hidePlaybackStatusBar: Boolean(value) }),
  setAutoHidePlaybackControls: (value) => set({ autoHidePlaybackControls: Boolean(value) }),
  setShowTranslatedText: (value) => set({ showTranslatedText: Boolean(value) }),
  setLyricsRendererMode: (mode) =>
    set({ lyricsRendererMode: mode === 'webview' ? 'webview' : 'native' }),
}));

export function startPlaybackClock() {
  if (playbackClockEnabled) {
    schedulePlaybackClockTick();
    return;
  }
  playbackClockEnabled = true;
  schedulePlaybackClockTick();
}

export function stopPlaybackClock() {
  playbackClockEnabled = false;
  clearPlaybackClockHandle();
}
