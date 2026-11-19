import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { AppState, Pressable, ScrollView, Share, StyleSheet, Text, type AppStateStatus } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Design } from '@/constants/design';
import { carPlaySpike, type CarPlaySpikeStatus } from '@/lib/live-activity';

export default function CarPlaySpikeScreen() {
  const [status, setStatus] = useState<CarPlaySpikeStatus>();
  const [error, setError] = useState('');
  const [log, setLog] = useState<string>();

  useFocusEffect(useCallback(() => {
    const spike = carPlaySpike;
    if (!spike) return;

    let timer: ReturnType<typeof setInterval> | undefined;
    let reading = false;
    let focused = true;
    async function refresh() {
      if (reading || !spike) return;
      reading = true;
      try {
        const next = await spike.getStatus();
        if (focused && AppState.currentState === 'active') setStatus(next);
      } catch (cause) {
        if (focused && AppState.currentState === 'active') setError(errorMessage(cause));
      } finally {
        reading = false;
      }
    }
    function onAppState(state: AppStateStatus | null) {
      clearInterval(timer);
      if (state === 'active') {
        void refresh();
        timer = setInterval(() => void refresh(), 1_000);
      }
    }
    onAppState(AppState.currentState);
    const lifecycle = AppState.addEventListener('change', onAppState);
    return () => {
      focused = false;
      clearInterval(timer);
      lifecycle.remove();
    };
  }, []));

  async function act(action: () => Promise<void>) {
    setError('');
    try {
      await action();
      if (carPlaySpike && AppState.currentState === 'active') setStatus(await carPlaySpike.getStatus());
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const active = status?.state === 'starting' || status?.state === 'running';
  const stopping = status?.state === 'stopping';
  const spike = carPlaySpike;

  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right', 'bottom']}>
      <Stack.Screen options={{ title: 'CarPlay Live Activity' }} />
      <ScrollView contentContainerStyle={styles.content}>
        {spike ? <>
          <Text style={styles.body}>
            Start with KineSync open, then lock the phone or switch to Spotify. Compare the sample number and UTC time on CarPlay with the host log.
          </Text>
          <Text style={styles.body}>
            The spike plays silent audio for up to 15 minutes. Return here and tap Stop when finished. iOS controls when a frame appears.
          </Text>
          <Text accessibilityLiveRegion="polite" style={styles.body}>{status?.message ?? 'Reading native status…'}</Text>
          {status?.lyric && (
            <Text selectable style={styles.sample}>
              {status.lyric}{'\n'}#{status.sequence} · {status.timestamp}
            </Text>
          )}
          {status?.lifecycle && <Text style={styles.body}>App lifecycle · {status.lifecycle}</Text>}
          <SpikeButton label="Start" disabled={active || stopping} onPress={() => void act(spike.start)} />
          <SpikeButton label="Stop" disabled={stopping} onPress={() => void act(spike.stop)} />
          <SpikeButton label="View recent log" onPress={() => void act(async () => {
            const jsonl = await spike.getLog();
            setLog(jsonl.trimEnd().split('\n').slice(-12).join('\n'));
          })} />
          <SpikeButton label="Share log" onPress={() => void act(async () => {
            const message = await spike.getLog();
            if (!message) throw new Error('No log entries yet. Start a spike first.');
            await Share.share({ title: 'carplay-spike.jsonl', message });
          })} />
          {status?.logError && <Text style={styles.body}>{status.logError}</Text>}
          {log !== undefined && <Text selectable style={styles.log}>{log || 'No log entries yet.'}</Text>}
        </> : <Text style={styles.body}>Install a custom iOS development build with the CarPlay spike native module.</Text>}
        {error ? <Text accessibilityLiveRegion="polite" style={styles.body}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function SpikeButton({ label, disabled = false, onPress }: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, (disabled || pressed) && styles.dimmed]}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Design.background },
  content: { padding: 20, gap: 12 },
  body: { color: Design.text, fontSize: 16, lineHeight: 23 },
  sample: { color: Design.accent, fontSize: 17, lineHeight: 25, fontWeight: '600' },
  button: { minHeight: 48, justifyContent: 'center', alignItems: 'center', padding: 10, borderRadius: 16, backgroundColor: Design.surface },
  buttonText: { color: Design.accent, fontSize: 16, fontWeight: '600' },
  dimmed: { opacity: 0.55 },
  log: { color: Design.text, fontFamily: 'Menlo', fontSize: 12 },
});
