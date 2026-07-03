import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
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
import { saveBridgeSettings } from '@/lib/bridge-settings';
import { usePlaybackStore } from '@/store/playback-store';
import type { ConnectionStatus } from '@/types/bridge';
import { requestShowOnboarding } from '@/providers/bridge-provider';
import AsyncStorage from '@react-native-async-storage/async-storage';

type FieldRowProps = {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'decimal-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
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
  const connectionTone = useMemo(
    () => getConnectionTone(connectionStatus),
    [connectionStatus],
  );

  const saveAndReconnect = useCallback(() => {
    const url = urlInput.trim();
    const key = keyInput.trim();
    setServerUrl(url);
    setHandshakeKey(key);
    saveBridgeSettings({ serverUrl: url, handshakeKey: key });
    bridgeClient.reconnectNow();
  }, [keyInput, setHandshakeKey, setServerUrl, urlInput]);

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
                <Text style={styles.title}>Bridge Settings</Text>
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
              <SettingSection title="Desktop Bridge">
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
              </SettingSection>

              <View style={styles.divider} />

              <SettingSection title="Timing">
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
              </SettingSection>
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
    ...StyleSheet.absoluteFillObject,
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
});
