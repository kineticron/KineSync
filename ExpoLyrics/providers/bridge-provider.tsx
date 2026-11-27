import { type PropsWithChildren, useEffect, useState } from 'react';
import { AppState, BackHandler, Platform, StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { bridgeClient } from '@/lib/bridge-client';
import { getBridgeSettings, saveBridgeSettings } from '@/lib/bridge-settings';
import { extractHost, isPrivateIpv4 } from '@/lib/network';
import {
  startPlaybackClock,
  stopPlaybackClock,
  usePlaybackStore,
  initPlaybackStoreDefaults,
} from '@/store/playback-store';
import { Onboarding } from '@/components/onboarding/onboarding-screen';
import { startLiveActivitySync } from '@/lib/live-activity';
import { LaunchTransition } from '@/components/ui/launch-transition';
import { usePlayerTourStore } from '@/store/player-tour-store';
import { router, usePathname } from 'expo-router';

const ONBOARDING_COMPLETED_KEY = 'kinesync_onboarding_completed';

// ponytail: module-level callback so explore.tsx can trigger re-show without re-mounting
let _showOnboardingCb: (() => void) | null = null;
export function requestShowOnboarding() {
  _showOnboardingCb?.();
}

async function getOnboardingCompleted(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(ONBOARDING_COMPLETED_KEY);
    return value === 'true';
  } catch {
    if (__DEV__) console.warn('[BridgeProvider] Could not read onboarding completion');
    return false;
  }
}

async function setOnboardingCompleted(completed: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_COMPLETED_KEY, String(completed));
  } catch {
    // Ignore storage errors
  }
}


function inferDefaultBridgeUrl() {
  const configuredBridgeUrl =
    process.env.EXPO_PUBLIC_BRIDGE_WS_URL?.trim() ||
    ''; // Set EXPO_PUBLIC_BRIDGE_WS_URL or configure in Bridge Settings

  if (configuredBridgeUrl) {
    return configuredBridgeUrl;
  }

  if (Platform.OS === 'web') {
    const hostname =
      typeof window !== 'undefined' && window.location?.hostname
        ? window.location.hostname
        : 'localhost';
    const host =
      hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname;
    return `ws://${host}:3001`;
  }

  if (__DEV__) {
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
  return '';
}

export function BridgeProvider({ children }: PropsWithChildren) {
  const pathname = usePathname();
  useEffect(startLiveActivitySync, []);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);

  // Keep setup portrait-only, including the handoff from onboarding to the tour.
  useEffect(() => {
    usePlayerTourStore.setState({ onboardingVisible: !onboardingChecked || showOnboarding });
  }, [onboardingChecked, showOnboarding]);

  useEffect(() => {
    if (!showOnboarding) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [showOnboarding]);

  // Register callback so external code can trigger onboarding
  useEffect(() => {
    _showOnboardingCb = () => setShowOnboarding(true);
    return () => { _showOnboardingCb = null; };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        const playbackState = usePlaybackStore.getState();
        if (playbackState.isPlaying) {
          startPlaybackClock();
        }
        return;
      }
      stopPlaybackClock();
    });

    return () => {
      subscription.remove();
      stopPlaybackClock();
      bridgeClient.disconnect();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await initPlaybackStoreDefaults();
      } catch {
        if (__DEV__ && active) console.warn('[BridgeProvider] Failed to load persisted playback settings');
      }
      if (!active) return;

      // Keep the benchmark path available even if optional defaults fail.
      const performanceScenario = process.env.EXPO_PUBLIC_PERFORMANCE_SCENARIO;
      if (performanceScenario === 'tour-amll' || performanceScenario === 'tour-spicy') {
        usePlaybackStore.getState().setLyricsStyle(performanceScenario === 'tour-amll' ? 'amll' : 'spicy');
        usePlayerTourStore.getState().requestStart();
        setShowOnboarding(false);
        setOnboardingChecked(true);
        return;
      }

      let stage = 'reading bridge settings';
      try {
        const completed = await getOnboardingCompleted();
        if (!active) return;
        const bridgeSettings = await getBridgeSettings();
        if (!active) return;

        let state = usePlaybackStore.getState();
        stage = 'resolving the default bridge URL';
        const defaultBridgeUrl = inferDefaultBridgeUrl();

        if (
          completed &&
          bridgeSettings.playbackMode === 'desktop' &&
          !bridgeSettings.serverUrl &&
          state.serverUrl === defaultBridgeUrl
        ) {
          stage = 'clearing the legacy bridge configuration';
          state.setServerUrl("");
          state.setHandshakeKey("");
          await saveBridgeSettings({
            serverUrl: "",
            handshakeKey: "",
            onboardingCompleted: true,
          }, { isCurrent: () => active });
          if (!active) return;
          state = usePlaybackStore.getState();
        }

        if (!completed && (!state.serverUrl || state.serverUrl === defaultBridgeUrl)) {
          setShowOnboarding(true);
        }
        if (bridgeSettings.playbackMode === 'desktop' && state.serverUrl) {
          stage = 'connecting to the desktop bridge';
          bridgeClient.connect();
        }
      } catch {
        if (!active) return;
        if (__DEV__) console.warn(`[BridgeProvider] Setup restore failed while ${stage}`);
        setShowOnboarding(true);
      } finally {
        if (active) setOnboardingChecked(true);
      }
    })();
    return () => { active = false; };
  }, []);

  const handleOnboardingDismiss = async () => {
    await setOnboardingCompleted(true);
    usePlayerTourStore.getState().requestStart();
    if (pathname !== '/') router.replace('/');
    setShowOnboarding(false);
  };

  return (
    <LaunchTransition ready={onboardingChecked}>
      <View style={_stableStyle1} aria-hidden={showOnboarding} accessibilityElementsHidden={showOnboarding} importantForAccessibility={showOnboarding ? 'no-hide-descendants' : 'auto'}>
        {children}
      </View>
      {onboardingChecked && showOnboarding && (
        <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
          <Onboarding onDismiss={handleOnboardingDismiss} />
        </View>
      )}
    </LaunchTransition>
  );
}

// Static native props retain their identity across renders.
const _stableStyle1 = { flex: 1, overflow: 'hidden' as const };
