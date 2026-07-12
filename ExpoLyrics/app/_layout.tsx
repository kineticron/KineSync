import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-reanimated';

import { BridgeProvider } from '@/providers/bridge-provider';
import { LyricsLiveActivityProvider } from '@/providers/lyrics-live-activity-provider';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { SF_PRO_ENABLED, SF_PRO_FAMILY } from '@/constants/lyrics-typography';

const SF_PRO_FONTS = {
  [SF_PRO_FAMILY]: require('@/assets/fonts/SF-Pro-Display-Regular.otf'),
  [`${SF_PRO_FAMILY}-Bold`]: require('@/assets/fonts/SF-Pro-Display-Bold.otf'),
};

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [fontsLoaded] = useFonts(SF_PRO_ENABLED ? SF_PRO_FONTS : {});

  if (SF_PRO_ENABLED && !fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <BridgeProvider>
            <LyricsLiveActivityProvider>
              <Stack>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
              </Stack>
            </LyricsLiveActivityProvider>
          </BridgeProvider>
          <StatusBar style="light" />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

