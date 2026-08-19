import Ionicons from '@react-native-vector-icons/ionicons';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LiveActivityDebugPanel } from '@/components/lyrics/live-activity-debug-panel';
import { bridgeClient } from '@/lib/bridge-client';
import { getBridgeSettings, saveBridgeSettings } from '@/lib/bridge-settings';
import {
  getMobileLyricsSettings,
  saveMobileLyricsSettings,
} from '@/lib/mobile-lyrics-settings';
import { getMobileMusixmatchTokenStatus } from '@/lib/mobile-musixmatch-token';
import { usePlaybackStore } from '@/store/playback-store';
import type { ConnectionStatus } from '@/types/bridge';
import { requestShowOnboarding } from '@/providers/bridge-provider';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { WebView } from 'react-native-webview';

import {
  isSpotifyNativeAppRedirect,
  parseBrowserEvent,
  spotifyAuthProbeScript,
  SPOTIFY_WEBVIEW_ORIGIN_WHITELIST,
} from '@/lib/spotify-browser';
import { requestReloadSpotifyBrowser } from '@/components/lyrics/spotify-browser-fallback';

const SPOTIFY_LOGIN_URL =
  'https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F';

type PlaybackMode = 'desktop' | 'mobile';

type FieldRowProps = {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'decimal-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  secureTextEntry?: boolean;
};

type SettingSectionProps = {
  title: string;
  children: ReactNode;
};

function getConnectionTone(status: ConnectionStatus) {
  if (status === 'connected') {
    return {
      icon: 'checkmark-circle' as const,
      label: 'Connected',
      color: '#8FF0C4',
      tint: 'rgba(111,232,179,0.12)',
    };
  }

  if (status === 'connecting') {
    return {
      icon: 'sync-circle' as const,
      label: 'Connecting',
      color: '#FFD287',
      tint: 'rgba(255,210,135,0.12)',
    };
  }

  return {
    icon: 'alert-circle' as const,
    label: 'Disconnected',
    color: '#FF93A4',
    tint: 'rgba(255,147,164,0.12)',
  };
}

function sanitizeNumberInput(value: string, fallback = 0) {
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function SettingSection({ title, children }: SettingSectionProps) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function FieldRow({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
  autoCapitalize = 'none',
  secureTextEntry = false,
}: FieldRowProps) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        style={styles.input}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor="rgba(255,255,255,0.36)"
        selectionColor="#FFFFFF"
        secureTextEntry={secureTextEntry}
      />
    </View>
  );
}

const ONBOARDING_COMPLETED_KEY = 'kinesync_onboarding_completed';

async function resetOnboardingCompleted(): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_COMPLETED_KEY, 'false');
  } catch {
    // Ignore storage errors
  }
}

export default function BridgeSettingsScreen() {
  const router = useRouter();
  const serverUrl = usePlaybackStore((s) => s.serverUrl);
  const handshakeKey = usePlaybackStore((s) => s.handshakeKey);
  const setServerUrl = usePlaybackStore((s) => s.setServerUrl);
  const setHandshakeKey = usePlaybackStore((s) => s.setHandshakeKey);
  const connectionStatus = usePlaybackStore((s) => s.connectionStatus);
  const simulatedLatencyMs = usePlaybackStore((s) => s.simulatedLatencyMs);
  const packetDropRate = usePlaybackStore((s) => s.packetDropRate);
  const playbackCompensationMs = usePlaybackStore((s) => s.playbackCompensationMs);
  const bridgeTiming = usePlaybackStore((s) => s.bridgeTiming);
  const driftOffset = usePlaybackStore((s) => s.driftOffset);
  const setSimulatedLatencyMs = usePlaybackStore((s) => s.setSimulatedLatencyMs);
  const setPacketDropRate = usePlaybackStore((s) => s.setPacketDropRate);
  const setPlaybackCompensationMs = usePlaybackStore((s) => s.setPlaybackCompensationMs);
  const [urlInput, setUrlInput] = useState(serverUrl);
  const [keyInput, setKeyInput] = useState(handshakeKey);
  const [compensationInput, setCompensationInput] = useState(String(playbackCompensationMs));
  const [latencyInput, setLatencyInput] = useState(String(simulatedLatencyMs));
  const [dropRateInput, setDropRateInput] = useState(String(packetDropRate));
  const [spotifyTokenInput, setSpotifyTokenInput] = useState('');
  const [musixmatchTokenInput, setMusixmatchTokenInput] = useState('');
  const [musixmatchTokenStatus, setMusixmatchTokenStatus] = useState(
    'Anonymous token will be created automatically when first needed.',
  );
  const [geminiKeyInput, setGeminiKeyInput] = useState('');
  const [mobileLyricsSaved, setMobileLyricsSaved] = useState(false);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>(
    serverUrl ? 'desktop' : 'mobile',
  );
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanError, setScanError] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [spotifySignedIn, setSpotifySignedIn] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scanHandledRef = useRef(false);
  const connectionTone = useMemo(
    () => playbackMode === 'mobile'
      ? {
          icon: 'phone-portrait' as const,
          label: 'Mobile-Only',
          color: '#8FF0C4',
          tint: 'rgba(111,232,179,0.12)',
        }
      : getConnectionTone(connectionStatus),
    [connectionStatus, playbackMode],
  );

  useEffect(() => {
    let mounted = true;
    void getBridgeSettings().then((settings) => {
      if (mounted) {
        setPlaybackMode(settings.playbackMode);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const selectPlaybackMode = useCallback(
    (mode: PlaybackMode) => {
      setPlaybackMode(mode);
      if (mode === 'mobile') {
        bridgeClient.disconnect();
        // Keep the bridge credentials so switching modes is reversible.
        void saveBridgeSettings({ playbackMode: 'mobile' });
        return;
      }
      void saveBridgeSettings({ playbackMode: 'desktop' });
      if (urlInput.trim()) {
        setServerUrl(urlInput.trim());
        setHandshakeKey(keyInput.trim());
        bridgeClient.reconnectNow();
      }
    },
    [keyInput, setHandshakeKey, setServerUrl, urlInput],
  );

  const saveAndReconnect = useCallback(() => {
    const url = urlInput.trim();
    const key = keyInput.trim();
    setServerUrl(url);
    setHandshakeKey(key);
    saveBridgeSettings({ serverUrl: url, handshakeKey: key, playbackMode: 'desktop' });
    setPlaybackMode('desktop');
    bridgeClient.reconnectNow();
  }, [keyInput, setHandshakeKey, setServerUrl, urlInput]);
  useEffect(() => {
    let mounted = true;
    void getMobileLyricsSettings().then((settings) => {
      if (!mounted) {
        return;
      }
      setSpotifyTokenInput(settings.spotifyWebToken);
      setMusixmatchTokenInput(settings.musixmatchUserToken);
      const status = getMobileMusixmatchTokenStatus();
      setMusixmatchTokenStatus(
        status.manualOverrideConfigured
          ? 'Using the saved manual override.'
          : status.automaticConfigured
            ? `Anonymous token managed automatically${status.automaticAppId ? ` (${status.automaticAppId})` : ''}.`
            : 'Anonymous token will be created automatically when first needed.',
      );
      setGeminiKeyInput(settings.geminiApiKey);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const saveMobileLyricsApiSettings = useCallback(() => {
    void saveMobileLyricsSettings({
      spotifyWebToken: spotifyTokenInput,
      spotifyWebTokenExpiresAt: 0,
      musixmatchUserToken: musixmatchTokenInput,
      geminiApiKey: geminiKeyInput,
    }).then((settings) => {
      setSpotifyTokenInput(settings.spotifyWebToken);
      setMusixmatchTokenInput(settings.musixmatchUserToken);
      const status = getMobileMusixmatchTokenStatus();
      setMusixmatchTokenStatus(
        status.manualOverrideConfigured
          ? 'Using the saved manual override.'
          : status.automaticConfigured
            ? `Anonymous token managed automatically${status.automaticAppId ? ` (${status.automaticAppId})` : ''}.`
            : 'Anonymous token will be created automatically when first needed.',
      );
      setGeminiKeyInput(settings.geminiApiKey);
      setMobileLyricsSaved(true);
      setTimeout(() => setMobileLyricsSaved(false), 1800);
    });
  }, [geminiKeyInput, musixmatchTokenInput, spotifyTokenInput]);

  const handleBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanHandledRef.current) return;
      try {
        const parsed = JSON.parse(data) as { u?: string; k?: string };
        if (parsed.u && parsed.k) {
          scanHandledRef.current = true;
          setScanError('');
          setServerUrl(parsed.u);
          setHandshakeKey(parsed.k);
          setPlaybackMode('desktop');
          void saveBridgeSettings({
            serverUrl: parsed.u,
            handshakeKey: parsed.k,
            playbackMode: 'desktop',
          });
          bridgeClient.reconnectNow();
          setScannerOpen(false);
          return;
        }
      } catch {
        // Keep scanning until a valid bridge payload is found.
      }
      setScanError('No valid KineSync QR code found');
    },
    [setHandshakeKey, setServerUrl],
  );

  const openScanner = useCallback(async () => {
    scanHandledRef.current = false;
    setScanError('');
    if (cameraPermission?.granted === true) {
      setScannerOpen(true);
      return;
    }
    const { status } = await requestCameraPermission();
    if (status === 'granted') {
      setScannerOpen(true);
    } else {
      setScanError('Camera permission required to scan QR codes');
    }
  }, [cameraPermission?.granted, requestCameraPermission]);

  const completeSpotifySignIn = useCallback(() => {
    setSpotifySignedIn(true);
    setLoginOpen(false);
    requestReloadSpotifyBrowser();
  }, []);

  const returnToLyrics = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/');
  }, [router]);

  const applyBridgeTimingRecommendation = useCallback(() => {
    const recommended = Math.max(
      0,
      Math.round(Number(bridgeTiming.recommendedPhoneCompensationMs || 0)),
    );
    setPlaybackCompensationMs(recommended);
    setCompensationInput(String(recommended));
  }, [bridgeTiming.recommendedPhoneCompensationMs, setPlaybackCompensationMs]);

  const applyDiagnostics = useCallback(() => {
    const compensation = Math.round(sanitizeNumberInput(compensationInput, playbackCompensationMs));
    const latency = Math.max(0, Math.round(sanitizeNumberInput(latencyInput, simulatedLatencyMs)));
    const dropRate = Math.max(0, Math.min(0.9, sanitizeNumberInput(dropRateInput, packetDropRate)));

    setPlaybackCompensationMs(compensation);
    setSimulatedLatencyMs(latency);
    setPacketDropRate(dropRate);
    setCompensationInput(String(compensation));
    setLatencyInput(String(latency));
    setDropRateInput(String(dropRate));
  }, [
    compensationInput,
    dropRateInput,
    latencyInput,
    packetDropRate,
    playbackCompensationMs,
    setPacketDropRate,
    setPlaybackCompensationMs,
    setSimulatedLatencyMs,
    simulatedLatencyMs,
  ]);

  const handleShowOnboarding = useCallback(async () => {
    await resetOnboardingCompleted();
    requestShowOnboarding();
  }, []);

  return (
    <View style={styles.screen}>
      <View style={styles.ambientShapeA} />
      <View style={styles.ambientShapeB} />
      <View style={styles.backgroundTint} />

      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={styles.keyboardAvoider}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back to lyrics"
                hitSlop={10}
                style={({ pressed }) => [
                  styles.backButton,
                  pressed && styles.buttonPressed,
                ]}
                onPress={returnToLyrics}>
                <Ionicons name="chevron-back" size={23} color="#FFFFFF" />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>Sync</Text>
                <Text style={styles.title}>Settings</Text>
              </View>
              <View
                style={[
                  styles.statusChip,
                  { backgroundColor: connectionTone.tint },
                ]}>
                <Ionicons
                  name={connectionTone.icon}
                  size={17}
                  color={connectionTone.color}
                />
                <Text style={[styles.statusText, { color: connectionTone.color }]}>
                  {connectionTone.label}
                </Text>
              </View>
            </View>

            <BlurView intensity={36} tint="dark" style={styles.card}>
              <SettingSection title="Playback source">
                <Text style={styles.onboardingHint}>
                  Choose how KineSync gets Spotify playback. Only settings for the selected mode are shown below.
                </Text>
                <View style={styles.modeChoices}>
                  <Pressable
                    style={({ pressed }) => [
                      styles.modeChoice,
                      playbackMode === 'desktop' && styles.modeChoiceActive,
                      pressed && styles.buttonPressed,
                    ]}
                    onPress={() => selectPlaybackMode('desktop')}>
                    <Ionicons name="desktop-outline" size={20} color="#FFFFFF" />
                    <View style={styles.modeChoiceCopy}>
                      <Text style={styles.modeChoiceTitle}>Desktop Bridge</Text>
                      <Text style={styles.modeChoiceHint}>Best sync; requires the bridge app.</Text>
                    </View>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [
                      styles.modeChoice,
                      playbackMode === 'mobile' && styles.modeChoiceActive,
                      pressed && styles.buttonPressed,
                    ]}
                    onPress={() => selectPlaybackMode('mobile')}>
                    <Ionicons name="phone-portrait-outline" size={20} color="#FFFFFF" />
                    <View style={styles.modeChoiceCopy}>
                      <Text style={styles.modeChoiceTitle}>Mobile-Only</Text>
                      <Text style={styles.modeChoiceHint}>Play Spotify inside KineSync.</Text>
                    </View>
                  </Pressable>
                </View>
              </SettingSection>

              <View style={styles.divider} />

              {playbackMode === 'desktop' ? <SettingSection title="Desktop Bridge">
                <FieldRow
                  label="WebSocket URL"
                  value={urlInput}
                  onChangeText={setUrlInput}
                  placeholder="ws://192.168.x.x:3001 or wss://relay/bridge/id"
                />
                <FieldRow
                  label="Handshake Key"
                  value={keyInput}
                  onChangeText={setKeyInput}
                  placeholder="password123"
                />
                <Pressable
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                  onPress={saveAndReconnect}>
                  <Ionicons name="checkmark" size={18} color="#FFFFFF" />
                  <Text style={styles.primaryButtonText}>Save and reconnect</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
                  onPress={openScanner}>
                  <Ionicons name="qr-code-outline" size={17} color="#FFFFFF" />
                  <Text style={styles.secondaryButtonText}>Scan QR code from Desktop Bridge</Text>
                </Pressable>
              </SettingSection> : null}

              {playbackMode === 'desktop' ? <View style={styles.divider} /> : null}

              {playbackMode === 'mobile' ? <SettingSection title="Mobile-Only">
                <Text style={styles.onboardingHint}>
                  Spotify runs in KineSync on this phone. Sign in to refresh your Spotify session.
                </Text>
                <Pressable
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
                  onPress={() => setLoginOpen(true)}>
                  <Ionicons name="log-in-outline" size={18} color="#FFFFFF" />
                  <Text style={styles.primaryButtonText}>
                    {spotifySignedIn ? 'Spotify signed in' : 'Log in to Spotify'}
                  </Text>
                </Pressable>
              </SettingSection> : null}

              {playbackMode === 'mobile' ? <View style={styles.divider} /> : null}

              {playbackMode === 'mobile' ? <SettingSection title="Mobile Lyrics APIs">
                <FieldRow
                  label="Spotify Bearer Token"
                  value={spotifyTokenInput}
                  onChangeText={setSpotifyTokenInput}
                  placeholder="Auto-filled from Spotify browser"
                  secureTextEntry
                />
                <FieldRow
                  label="Musixmatch User API Token (Manual Override)"
                  value={musixmatchTokenInput}
                  onChangeText={setMusixmatchTokenInput}
                  placeholder="Optional; anonymous access is automatic"
                  secureTextEntry
                />
                <Text style={styles.onboardingHint}>
                  KineSync creates and reuses an anonymous Musixmatch token automatically.
                  A token entered here takes precedence as a manual override.
                </Text>
                <Text style={styles.onboardingHint}>{musixmatchTokenStatus}</Text>
                <FieldRow
                  label="Gemini API Key"
                  value={geminiKeyInput}
                  onChangeText={setGeminiKeyInput}
                  placeholder="Optional translation API key"
                  secureTextEntry
                />
                <Pressable
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                  onPress={saveMobileLyricsApiSettings}>
                  <Ionicons name="key" size={17} color="#FFFFFF" />
                  <Text style={styles.secondaryButtonText}>
                    {mobileLyricsSaved ? 'Saved mobile API settings' : 'Save mobile API settings'}
                  </Text>
                </Pressable>
              </SettingSection> : null}

              <View style={styles.divider} />

              {playbackMode === 'desktop' ? <SettingSection title="Timing">
                <View style={styles.timingDiagnostics}>
                  <Text style={styles.timingDiagnosticsTitle}>Bridge timing (live)</Text>
                  <Text style={styles.timingDiagnosticsLine}>
                    Pipeline: {Math.max(0, Number(bridgeTiming.measuredPipelineMs || 0))} ms
                  </Text>
                  <Text style={styles.timingDiagnosticsLine}>
                    Forward bias: {Math.max(0, Number(bridgeTiming.estimatedForwardBiasMs || 0))} ms
                  </Text>
                  <Text style={styles.timingDiagnosticsLine}>
                    Native extrapolation: {bridgeTiming.nativeExtrapolationEnabled ? 'yes' : 'no'}
                  </Text>
                  <Text style={styles.timingDiagnosticsLine}>
                    Raw GSMTC position: {Math.max(0, Number(bridgeTiming.lastRawGsmtcPositionMs || 0))} ms
                  </Text>
                  <Text style={styles.timingDiagnosticsLine}>
                    Bridge projected: {Math.max(0, Number(bridgeTiming.projectedPositionMs || 0))} ms
                  </Text>
                  <Text style={styles.timingDiagnosticsLine}>
                    Phone network latency: {Math.max(0, Number(driftOffset || 0))} ms
                  </Text>
                  <Text style={styles.timingDiagnosticsHint}>
                    With native extrapolation on, keep playback compensation at 0 —
                    the bridge already advances position. If lyrics run ahead, lower
                    compensation. If native extrap is no, rebuild the addon
                    (npm run build:native-media) and restart DesktopBridge.
                  </Text>
                </View>
                <Pressable
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                  onPress={applyBridgeTimingRecommendation}
                  disabled={connectionStatus !== 'connected'}>
                  <Ionicons name="download-outline" size={17} color="#FFFFFF" />
                  <Text style={styles.secondaryButtonText}>
                    Use bridge compensation hint (
                    {Math.max(0, Number(bridgeTiming.recommendedPhoneCompensationMs || 0))} ms)
                  </Text>
                </Pressable>
                <FieldRow
                  label="Playback Compensation"
                  value={compensationInput}
                  onChangeText={setCompensationInput}
                  keyboardType="numeric"
                  placeholder="0"
                />
                <FieldRow
                  label="Simulated Latency"
                  value={latencyInput}
                  onChangeText={setLatencyInput}
                  keyboardType="numeric"
                  placeholder="0"
                />
                <FieldRow
                  label="Packet Drop Rate"
                  value={dropRateInput}
                  onChangeText={setDropRateInput}
                  keyboardType="decimal-pad"
                  placeholder="0"
                />
                <Pressable
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                  onPress={applyDiagnostics}>
                  <Ionicons name="speedometer" size={17} color="#FFFFFF" />
                  <Text style={styles.secondaryButtonText}>Apply timing</Text>
                </Pressable>
              </SettingSection> : null}
            </BlurView>

            <BlurView intensity={36} tint="dark" style={styles.card}>
              <SettingSection title="Live Activity (device)">
                <LiveActivityDebugPanel />
              </SettingSection>
            </BlurView>

            <BlurView intensity={36} tint="dark" style={styles.card}>
              <SettingSection title="Onboarding">
                <Pressable
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    pressed && styles.buttonPressed,
                  ]}
                  onPress={handleShowOnboarding}>
                  <Ionicons name="school-outline" size={17} color="#FFFFFF" />
                  <Text style={styles.secondaryButtonText}>Show onboarding again</Text>
                </Pressable>
                <Text style={styles.onboardingHint}>
                  Reset the onboarding flow to see the setup guide again
                </Text>
              </SettingSection>
            </BlurView>

            <View style={styles.footerCard}>
              <View style={styles.footerIconWrap}>
                <Ionicons name="wifi" size={18} color="rgba(255,255,255,0.74)" />
              </View>
              <Text style={styles.footerText}>
                {serverUrl || 'No bridge URL saved'}
              </Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      <Modal
        animationType="slide"
        visible={scannerOpen}
        onRequestClose={() => setScannerOpen(false)}>
        <View style={styles.scannerModal}>
          <CameraView style={styles.scannerCamera} onBarcodeScanned={handleBarcodeScanned} />
          <View style={styles.scannerOverlay}>
            <View style={styles.scannerFrame} />
            <Text style={styles.scannerInstruction}>
              Point the camera at the QR code on your Desktop Bridge app
            </Text>
            {!!scanError && <Text style={styles.scannerError}>{scanError}</Text>}
            <Pressable
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
              onPress={() => setScannerOpen(false)}>
              <Ionicons name="close" size={18} color="#FFFFFF" />
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="slide"
        visible={loginOpen}
        onRequestClose={() => setLoginOpen(false)}>
        <View style={styles.loginModal}>
          <SafeAreaView style={styles.loginHeader}>
            <Text style={styles.loginTitle}>Log in to Spotify</Text>
            <Pressable
              hitSlop={10}
              onPress={() => setLoginOpen(false)}
              style={styles.loginCloseButton}>
              <Ionicons name="close" size={21} color="#FFFFFF" />
            </Pressable>
          </SafeAreaView>
          <WebView
            source={{ uri: SPOTIFY_LOGIN_URL }}
            originWhitelist={SPOTIFY_WEBVIEW_ORIGIN_WHITELIST}
            injectedJavaScript={spotifyAuthProbeScript}
            onShouldStartLoadWithRequest={({ url }) => {
              if (!isSpotifyNativeAppRedirect(url)) return true;
              completeSpotifySignIn();
              return false;
            }}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            domStorageEnabled
            javaScriptEnabled
            setSupportMultipleWindows={false}
            style={styles.loginWebView}
            onMessage={({ nativeEvent }) => {
              const event = parseBrowserEvent(nativeEvent.data);
              if (event?.type === 'spotifyToken' && event.token) {
                void saveMobileLyricsSettings({
                  spotifyWebToken: event.token,
                  spotifyWebTokenExpiresAt: Number(event.expiresAt || 0),
                });
              }
              if (event?.type === 'signedIn' && event.signedIn) {
                completeSpotifySignIn();
              }
            }}
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0A0B11',
    overflow: 'hidden',
  },
  ambientShapeA: {
    position: 'absolute',
    top: 52,
    left: -92,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: '#5A6DFF',
    opacity: 0.24,
  },
  ambientShapeB: {
    position: 'absolute',
    right: -108,
    bottom: 132,
    width: 310,
    height: 310,
    borderRadius: 155,
    backgroundColor: '#B668F2',
    opacity: 0.2,
  },
  backgroundTint: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(8, 9, 14, 0.76)',
  },
  safeArea: {
    flex: 1,
  },
  keyboardAvoider: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 34,
    gap: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    paddingHorizontal: 4,
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    color: 'rgba(255,255,255,0.54)',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
    marginTop: 2,
  },
  statusChip: {
    minHeight: 34,
    borderRadius: 18,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '700',
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    paddingVertical: 16,
    overflow: 'hidden',
  },
  section: {
    paddingHorizontal: 16,
    gap: 12,
  },
  sectionTitle: {
    color: 'rgba(248,248,254,0.72)',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  sectionBody: {
    gap: 12,
  },
  modeChoices: {
    gap: 10,
  },
  modeChoice: {
    minHeight: 64,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  modeChoiceActive: {
    backgroundColor: 'rgba(143,240,196,0.13)',
    borderColor: 'rgba(143,240,196,0.5)',
  },
  modeChoiceCopy: {
    flex: 1,
    gap: 2,
  },
  modeChoiceTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  modeChoiceHint: {
    color: 'rgba(255,255,255,0.52)',
    fontSize: 11,
  },
  fieldRow: {
    gap: 7,
  },
  fieldLabel: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 13,
    fontWeight: '600',
  },
  input: {
    minHeight: 46,
    borderRadius: 12,
    paddingHorizontal: 13,
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '500',
  },
  primaryButton: {
    minHeight: 46,
    borderRadius: 999,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  secondaryButton: {
    minHeight: 42,
    borderRadius: 999,
    paddingHorizontal: 15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  buttonPressed: {
    opacity: 0.76,
    transform: [{ scale: 0.98 }],
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    marginVertical: 16,
    backgroundColor: 'rgba(255,255,255,0.09)',
  },
  footerCard: {
    minHeight: 54,
    borderRadius: 18,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  footerIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.09)',
  },
  footerText: {
    flex: 1,
    minWidth: 0,
    color: 'rgba(255,255,255,0.72)',
    fontSize: 13,
    fontWeight: '600',
  },
  timingDiagnostics: {
    gap: 6,
    padding: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  timingDiagnosticsTitle: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  timingDiagnosticsLine: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    lineHeight: 17,
    fontVariant: ['tabular-nums'],
  },
  timingDiagnosticsHint: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 4,
  },
  onboardingHint: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 8,
    marginLeft: 4,
  },
  scannerModal: {
    flex: 1,
    backgroundColor: '#090A11',
  },
  scannerCamera: {
    ...StyleSheet.absoluteFill,
  },
  scannerOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    paddingHorizontal: 28,
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  scannerFrame: {
    width: 248,
    height: 248,
    borderRadius: 22,
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  scannerInstruction: {
    color: '#FFFFFF',
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '600',
  },
  scannerError: {
    color: '#FF93A4',
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
  },
  loginModal: {
    flex: 1,
    backgroundColor: '#090A11',
  },
  loginHeader: {
    minHeight: 58,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#11131C',
  },
  loginTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  loginCloseButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginWebView: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
});
