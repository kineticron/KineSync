import { useEffect, useState } from 'react';
import { AppState, BackHandler } from 'react-native';
import { getTourPosition, TOUR_DURATION_MS, usePlayerTourStore } from '@/store/player-tour-store';

export function usePlayerTour(focused: boolean) {
  const tour = usePlayerTourStore();
  const [position, setPosition] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    if (focused && tour.pending) usePlayerTourStore.getState().start();
  }, [focused, tour.pending]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!focused || !tour.active) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [focused, tour.active]);
  useEffect(() => {
    if (!tour.active || !focused || !foreground) return;
    const sync = () => {
      const state = usePlayerTourStore.getState();
      const next = getTourPosition(state);
      if (next >= TOUR_DURATION_MS && state.isPlaying) state.seek(0);
      setPosition(next >= TOUR_DURATION_MS && state.isPlaying ? 0 : next);
    };
    sync();
    if (!tour.isPlaying) return;
    const timer = setInterval(sync, 100);
    return () => clearInterval(timer);
  }, [tour.active, tour.isPlaying, tour.anchorPositionMs, tour.anchorMonotonicMs, focused, foreground]);
  return { ...tour, position, foreground };
}
