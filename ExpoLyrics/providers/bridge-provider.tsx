import { type PropsWithChildren, useEffect, useState } from 'react';
import { AppState, type AppStateStatus, Modal, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { bridgeClient } from '@/lib/bridge-client';
import { extractHost, isPrivateIpv4 } from '@/lib/network';
import {
  startPlaybackClock,
  stopPlaybackClock,
  usePlaybackStore,
  initPlaybackStoreDefaults,
} from '@/store/playback-store';
import { Onboarding } from '@/components/onboarding/onboarding-screen';

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

export function BridgeProvider({ children }: PropsWithChildren) {
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Register callback so external code can trigger onboarding
  useEffect(() => {
    _showOnboardingCb = () => setShowOnboarding(true);
    return () => { _showOnboardingCb = null; };
  }, []);

  useEffect(() => {
    // Initialize store with persisted settings
    (async () => {
      try {
        const defaults = await initPlaybackStoreDefaults();
        // Store defaults are already loaded into the store via initPlaybackStoreDefaults
      } catch (error) {
        console.warn('[BridgeProvider] Failed to load persisted settings:', error);
      }
      setInitialized(true);
    })();

    let appState: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener('change', (nextState) => {
      appState = nextState;
      if (nextState === 'active') {
        if (usePlaybackStore.getState().connectionStatus === 'connected') {
          startPlaybackClock();
        }
        return;
      }
      stopPlaybackClock();
    });

    return () => {
      subscription.remove();
      if (appState !== 'active') {
        stopPlaybackClock();
      }
      bridgeClient.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;

    bridgeClient.connect();

    // Check if onboarding was completed before
    (async () => {
      const completed = await getOnboardingCompleted();
      const state = usePlaybackStore.getState();

      // Show onboarding only if never completed before AND using default bridge URL
      if (!completed && (!state.serverUrl || state.serverUrl === inferDefaultBridgeUrl())) {
        setShowOnboarding(true);
      }
      setOnboardingChecked(true);
    })();
  }, [initialized]);

  // Wait for onboarding check to complete before rendering
  if (!onboardingChecked) {
    return <>{children}</>;
  }

  const handleOnboardingDismiss = async () => {
    await setOnboardingCompleted(true);
    setShowOnboarding(false);
  };

  return (
    <>
      {children}
      <Modal
        visible={showOnboarding}
        animationType="fade"
        presentationStyle="fullScreen"
        statusBarTranslucent
      >
        <Onboarding onDismiss={handleOnboardingDismiss} />
      </Modal>
    </>
  );
}