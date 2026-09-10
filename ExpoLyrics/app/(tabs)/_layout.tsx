import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';
import { Design } from '@/constants/design';

export default function AppStackLayout() {
  const reduceMotion = useReducedMotion();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Design.background }, animation: reduceMotion ? 'none' : 'slide_from_right', animationDuration: 260 }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="explore" />
      </Stack>
    </GestureHandlerRootView>
  );
}
