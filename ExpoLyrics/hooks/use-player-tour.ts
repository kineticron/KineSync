import { useEffect, useState } from 'react';
import { AppState, BackHandler } from 'react-native';
import { getTourPosition, TOUR_DURATION_MS, usePlayerTourStore } from '@/store/player-tour-store';

export function usePlayerTour(focused: boolean) {
  const tour = usePlayerTourStore();
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
    if (!tour.isPlaying) return;
    const remaining = TOUR_DURATION_MS - getTourPosition(usePlayerTourStore.getState());
    const timer = setTimeout(() => {
      const state = usePlayerTourStore.getState();
      if (state.active && state.isPlaying) state.seek(0);
    }, Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [tour.active, tour.isPlaying, tour.anchorPositionMs, tour.anchorMonotonicMs, focused, foreground]);
  return { ...tour, foreground };
}
