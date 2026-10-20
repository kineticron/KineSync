import { createVideoPlayer, type VideoPlayer } from 'expo-video';
import { create } from 'zustand';
import { usePlaybackStore } from '@/store/playback-store';

/**
 * Sync Studio taps against either the song KineSync is following (Spotify
 * through the detector or the desktop bridge) or an
 * audio file played inside KineSync, which is sample-accurate and can be slowed.
 * The player screen stays mounted underneath and registers its controls.
 */
type Controls = { seekTo: (positionMs: number) => void; togglePlayPause: () => void };
let controls: Controls | null = null;

export function registerSyncStudioPlaybackControls(next: Controls) {
  controls = next;
  return () => { if (controls === next) controls = null; };
}

const monotonicNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/** A local file being played; `anchor` drives the preview's lyric clock. */
type LocalAudio = { name: string; rate: number; anchor: { positionMs: number; monotonicMs: number; playing: boolean } };
export const useLocalAudio = create<{ local: LocalAudio | null }>(() => ({ local: null }));
let player: VideoPlayer | null = null;
let subscriptions: { remove: () => void }[] = [];

function refreshAnchor() {
  const state = useLocalAudio.getState().local;
  if (!player || !state) return;
  useLocalAudio.setState({ local: { ...state, anchor: { positionMs: player.currentTime * 1000, monotonicMs: monotonicNow(), playing: player.playing } } });
}

export function openLocalAudio(uri: string, name: string) {
  closeLocalAudio();
  if (usePlaybackStore.getState().isPlaying) controls?.togglePlayPause();
  player = createVideoPlayer({ uri });
  player.preservesPitch = true;
  player.timeUpdateEventInterval = 0.5;
  subscriptions = [player.addListener('playingChange', refreshAnchor), player.addListener('timeUpdate', refreshAnchor)];
  useLocalAudio.setState({ local: { name, rate: 1, anchor: { positionMs: 0, monotonicMs: monotonicNow(), playing: false } } });
}

export function closeLocalAudio() {
  subscriptions.forEach((subscription) => subscription.remove());
  subscriptions = [];
  player?.pause();
  player?.release();
  player = null;
  useLocalAudio.setState({ local: null });
}

/** Slow the local file down for fast words; timings stay in song time. */
export function setLocalRate(rate: number) {
  const state = useLocalAudio.getState().local;
  if (!player || !state) return;
  player.playbackRate = rate;
  useLocalAudio.setState({ local: { ...state, rate } });
}

/** The song position right now. */
export function songPositionMs() {
  if (player) return Math.max(0, player.currentTime * 1000);
  const state = usePlaybackStore.getState();
  const elapsed = state.isPlaying ? Math.max(0, monotonicNow() - state.anchorMonotonicMs) : 0;
  const position = state.anchorPositionMs + elapsed;
  const duration = state.currentTrack?.durationMs ?? 0;
  return Math.max(0, duration > 0 ? Math.min(position, duration) : position);
}

export const songIsPlaying = () => (player ? player.playing : usePlaybackStore.getState().isPlaying);

/** Seek the song; the clock moves at once and the source catches up. */
export function seekSong(positionMs: number) {
  const target = Math.max(0, Math.round(positionMs));
  stopSongRange();
  if (player) { player.currentTime = target / 1000; refreshAnchor(); return; }
  usePlaybackStore.setState({ anchorPositionMs: target, anchorTimestampMs: Date.now(), anchorMonotonicMs: monotonicNow(), playbackPosition: target });
  controls?.seekTo(target);
}

export function toggleSong() {
  if (player) { if (player.playing) player.pause(); else player.play(); return; }
  controls?.togglePlayPause();
}
export function playSong() { if (!songIsPlaying()) toggleSong(); }
export function pauseSong() { if (songIsPlaying()) toggleSong(); }
export const hasSongControls = () => player != null || controls != null;

let rangeTimer: ReturnType<typeof setInterval> | null = null;
/** Stop a "Hear it" range early (another seek or play takes over). */
export function stopSongRange() {
  if (rangeTimer) clearInterval(rangeTimer);
  rangeTimer = null;
}
/**
 * "Hear it": play exactly from `startMs` and pause at `endMs`, no lead-in.
 * Spotify reacts to pause a moment late, so a little more may be heard there.
 */
export function playSongRange(startMs: number, endMs: number) {
  stopSongRange();
  seekSong(startMs);
  playSong();
  // Safety net when the clock never moves (the song failed to start).
  const giveUpAt = Date.now() + Math.max(0, endMs - startMs) + 5000;
  rangeTimer = setInterval(() => {
    if (songPositionMs() < endMs && Date.now() < giveUpAt) return;
    stopSongRange();
    pauseSong();
  }, 20);
}
