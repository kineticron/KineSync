import { DarkTheme, ThemeProvider } from 'expo-router/react-navigation';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useLayoutEffect } from 'react';
import { Platform, type LayoutChangeEvent } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-reanimated';

import { BridgeProvider } from '@/providers/bridge-provider';
import { Design } from '@/constants/design';
import { usePlayerTourStore } from '@/store/player-tour-store';

const appTheme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: Design.background, card: Design.background, primary: Design.accent } };

if (Platform.OS === 'android') {
  console.info('[RootLayout]', Date.now(), 'module loaded', JSON.stringify({
    initialWindowMetricsAvailable: initialWindowMetrics != null,
  }));
}

function traceSafeAreaLayout({ nativeEvent: { layout: { width, height } } }: LayoutChangeEvent) {
  console.info('[RootLayout]', Date.now(), 'safe area provider layout', JSON.stringify({ width, height }));
}

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  useLayoutEffect(() => {
    if (Platform.OS === 'android') console.info('[RootLayout]', Date.now(), 'mounted');
  }, []);

  const touring = usePlayerTourStore(state => state.active || state.pending);
  const portraitOnly = usePlayerTourStore(state => state.active || state.pending);
  return (
    <GestureHandlerRootView style={_stableStyle1}>
      <SafeAreaProvider onLayout={Platform.OS === 'android' ? traceSafeAreaLayout : undefined}>
        <ThemeProvider value={appTheme}>
          <BridgeProvider>
            <Stack screenOptions={{ orientation: portraitOnly ? 'portrait' : 'default', statusBarHidden: false, statusBarStyle: 'light', contentStyle: { backgroundColor: Design.background } }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false, gestureEnabled: !touring }} />
              <Stack.Screen name="modal" options={_stableOptions2} />
            </Stack>
          </BridgeProvider>
          {Platform.OS !== 'ios' && <StatusBar style="light" hidden={false} />}
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// Static native props retain their identity across renders.
const _stableStyle1 = { flex: 1 };
const _stableOptions2 = { presentation: 'modal', title: 'Modal' } as const;
