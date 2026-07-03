import AsyncStorage from '@react-native-async-storage/async-storage';

const BRIDGE_SETTINGS_KEY = 'kinesync_bridge_settings';

export interface BridgeSettings {
  serverUrl: string;
  handshakeKey: string;
  onboardingCompleted: boolean;
}

const DEFAULT_SETTINGS: BridgeSettings = {
  serverUrl: '',
  handshakeKey: '',
  onboardingCompleted: false,
};

export async function getBridgeSettings(): Promise<BridgeSettings> {
  try {
    const raw = await AsyncStorage.getItem(BRIDGE_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      serverUrl: String(parsed?.serverUrl || '').trim(),
      handshakeKey: String(parsed?.handshakeKey || '').trim() || DEFAULT_SETTINGS.handshakeKey,
      onboardingCompleted: Boolean(parsed?.onboardingCompleted),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveBridgeSettings(settings: Partial<BridgeSettings>): Promise<BridgeSettings> {
  const current = await getBridgeSettings();
  const updated = {
    ...current,
    ...settings,
  };
  await AsyncStorage.setItem(BRIDGE_SETTINGS_KEY, JSON.stringify(updated));
  return updated;
}

export async function clearBridgeSettings(): Promise<void> {
  await AsyncStorage.removeItem(BRIDGE_SETTINGS_KEY);
}
