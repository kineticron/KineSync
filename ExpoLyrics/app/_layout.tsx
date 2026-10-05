import { DarkTheme, ThemeProvider } from 'expo-router/react-navigation';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-reanimated';

import { BridgeProvider } from '@/providers/bridge-provider';
import { Design } from '@/constants/design';
import { usePlayerTourStore } from '@/store/player-tour-store';

const appTheme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: Design.background, card: Design.background, primary: Design.accent } };

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const touring = usePlayerTourStore(state => state.active || state.pending);
  const portraitOnly = usePlayerTourStore(state => state.active || state.pending);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider value={appTheme}>
          <BridgeProvider>
            <Stack screenOptions={{ orientation: portraitOnly ? 'portrait' : 'default', statusBarHidden: false, statusBarStyle: 'light', contentStyle: { backgroundColor: Design.background } }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false, gestureEnabled: !touring }} />
              <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
            </Stack>
          </BridgeProvider>
          {Platform.OS !== 'ios' && <StatusBar style="light" hidden={false} />}
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
