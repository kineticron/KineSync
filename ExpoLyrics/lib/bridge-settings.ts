import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { isValidBridgeKey, parseBridgeWebSocketUrl } from '@/lib/network';

const BRIDGE_SETTINGS_KEY = 'kinesync_bridge_settings';
const BRIDGE_SECRET_KEY = 'kinesync_bridge_handshake_key_v1';

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
    const parsed = raw ? JSON.parse(raw) : {};
    let secureKey = '';
    try {
      if (Platform.OS !== 'web') secureKey = (await SecureStore.getItemAsync(BRIDGE_SECRET_KEY))?.trim() || '';
    } catch {
      // Keep a legacy value intact when the secure store is unavailable.
      secureKey = '';
    }
    const legacyKey = String(parsed?.handshakeKey || '').trim();
    const handshakeKey = secureKey || legacyKey;
    if (!secureKey && legacyKey && Platform.OS !== 'web') {
      try {
        await SecureStore.setItemAsync(BRIDGE_SECRET_KEY, legacyKey);
        await AsyncStorage.setItem(BRIDGE_SETTINGS_KEY, JSON.stringify({
          serverUrl: String(parsed?.serverUrl || '').trim(),
          onboardingCompleted: Boolean(parsed?.onboardingCompleted),
        }));
      } catch {
        // Migration is best effort; do not delete or overwrite the old secret.
      }
    }
    return {
      serverUrl: parseBridgeWebSocketUrl(parsed?.serverUrl) || '',
      handshakeKey: isValidBridgeKey(handshakeKey) ? handshakeKey : '',
      onboardingCompleted: Boolean(parsed?.onboardingCompleted),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveBridgeSettings(settings: Partial<BridgeSettings>): Promise<BridgeSettings> {
  const current = await getBridgeSettings();
  const candidate = {
    ...current,
    ...settings,
  };
  const serverUrl = parseBridgeWebSocketUrl(candidate.serverUrl);
  const key = String(candidate.handshakeKey || '').trim();
  if (candidate.serverUrl && !serverUrl) throw new Error('Bridge URL must be a private ws:// URL or a public wss:// URL.');
  if (key && !isValidBridgeKey(key)) throw new Error('Bridge key is invalid.');
  let secureSaved = Platform.OS === 'web';
  if (key && Platform.OS !== 'web') {
    try {
      await SecureStore.setItemAsync(BRIDGE_SECRET_KEY, key);
      secureSaved = true;
    } catch {
      throw new Error('Could not save the bridge key securely on this device.');
    }
  } else if (Object.prototype.hasOwnProperty.call(settings, 'handshakeKey') && Platform.OS !== 'web') {
    try {
      await SecureStore.deleteItemAsync(BRIDGE_SECRET_KEY);
      secureSaved = true;
    } catch {
      throw new Error('Could not remove the bridge key from secure storage.');
    }
  }
  const updated = { ...candidate, serverUrl: serverUrl || '', handshakeKey: secureSaved ? key : current.handshakeKey };
  // The handshake key is intentionally omitted from AsyncStorage on native.
  await AsyncStorage.setItem(BRIDGE_SETTINGS_KEY, JSON.stringify({
    serverUrl: updated.serverUrl,
    onboardingCompleted: updated.onboardingCompleted,
    ...(Platform.OS === 'web' ? { handshakeKey: updated.handshakeKey } : {}),
  }));
  return updated;
}

export async function clearBridgeSettings(): Promise<void> {
  await AsyncStorage.removeItem(BRIDGE_SETTINGS_KEY);
  try {
    if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(BRIDGE_SECRET_KEY);
  } catch {
    // Best effort; secure store may be unavailable in Expo web/preview.
  }
}
