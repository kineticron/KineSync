import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';
import { Design } from '@/constants/design';
import { usePlayerTourStore } from '@/store/player-tour-store';

export default function AppStackLayout() {
  const reduceMotion = useReducedMotion();
  const touring = usePlayerTourStore(state => state.active || state.pending);
  const portraitOnly = usePlayerTourStore(state => state.active || state.pending);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack screenOptions={{ orientation: portraitOnly ? 'portrait' : 'default', headerShown: false, statusBarHidden: false, statusBarStyle: 'light', contentStyle: { backgroundColor: Design.background }, animation: reduceMotion ? 'none' : 'slide_from_right', animationDuration: 260 }}>
        <Stack.Screen name="index" options={{ gestureEnabled: !touring, fullScreenGestureEnabled: false }} />
        <Stack.Screen name="explore" />
      </Stack>
    </GestureHandlerRootView>
  );
}
