import { create } from 'zustand';
import type { Track } from '@/types/bridge';

export const TOUR_DURATION_MS = 25000;
export const TOUR_TRACK: Track = {
  id: 'kinesync-tour', title: 'Follow the lyrics', artist: 'KineSync Diagnostics',
  album: 'Diagnostic song · No chart ambitions', durationMs: TOUR_DURATION_MS,
};
export const TOUR_STEPS = ['welcome', 'artwork', 'lyrics', 'seek', 'playback', 'translate', 'autoScroll', 'autoHide', 'done'] as const;
export type PlayerTourStep = typeof TOUR_STEPS[number];
const now = () => performance.now();

type PlayerTourState = {
  onboardingVisible: boolean;
  active: boolean;
  pending: boolean;
  step: PlayerTourStep;
  anchorPositionMs: number;
  anchorMonotonicMs: number;
  isPlaying: boolean;
  translated: boolean;
  autoHideControls: boolean;
  start: () => void;
  requestStart: () => void;
  finish: () => void;
  advance: (expected: PlayerTourStep) => void;
  seek: (positionMs: number) => void;
  togglePlayback: () => void;
  translate: () => void;
  toggleAutoHide: () => void;
};

export function getTourPosition(state: Pick<PlayerTourState, 'anchorPositionMs' | 'anchorMonotonicMs' | 'isPlaying'>) {
  return Math.min(TOUR_DURATION_MS, Math.max(0, state.anchorPositionMs + (state.isPlaying ? now() - state.anchorMonotonicMs : 0)));
}

/** Sample state is isolated from live playback, saved preferences, and bridge commands. */
export const usePlayerTourStore = create<PlayerTourState>((set, get) => ({
  onboardingVisible: true,
  active: false, pending: false, step: 'welcome', anchorPositionMs: 0, anchorMonotonicMs: 0,
  isPlaying: false, translated: false, autoHideControls: false,
  requestStart: () => set({ pending: true, active: false, isPlaying: false }),
  start: () => set({ active: true, pending: false, step: 'welcome', anchorPositionMs: 0, anchorMonotonicMs: now(), isPlaying: true, translated: false, autoHideControls: false }),
  finish: () => set({ active: false, pending: false, isPlaying: false, autoHideControls: false }),
  advance: expected => {
    const state = get();
    if (!state.active || state.step !== expected) return;
    if (expected === 'autoHide' && !state.autoHideControls) return;
    set({ step: TOUR_STEPS[Math.min(TOUR_STEPS.indexOf(expected) + 1, TOUR_STEPS.length - 1)], autoHideControls: false });
  },
  seek: positionMs => {
    if (!get().active) return;
    set({ anchorPositionMs: Math.max(0, Math.min(TOUR_DURATION_MS, positionMs)), anchorMonotonicMs: now() });
  },
  togglePlayback: () => {
    const state = get();
    if (!state.active) return;
    const position = getTourPosition(state);
    set({ anchorPositionMs: position === TOUR_DURATION_MS ? 0 : position, anchorMonotonicMs: now(), isPlaying: !state.isPlaying });
    state.advance('playback');
  },
  translate: () => {
    if (!get().active) return;
    set({ translated: true });
    get().advance('translate');
  },
  toggleAutoHide: () => {
    const state = get();
    if (!state.active || state.step !== 'autoHide') return;
    set({ autoHideControls: !state.autoHideControls });
  },
}));
