import Ionicons from '@react-native-vector-icons/ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { MotionPressable as Button } from '@/components/ui/motion-pressable';
import { Design } from '@/constants/design';
import { bridgeClient } from '@/lib/bridge-client';
import { transferDesktopVaultToMobile } from '@/lib/desktop-vault-transfer';
import { usePlaybackStore } from '@/store/playback-store';
import type { DesktopVaultSummary } from '@/types/bridge';

export function DesktopVaultCatalog({ disabled, onTransferred }: { disabled: boolean; onTransferred: () => Promise<void> }) {
  const connected = usePlaybackStore(s => s.connectionStatus === 'connected' && s.playbackMode === 'desktop');
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<DesktopVaultSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const transferLock = useRef(false);
  const pageLock = useRef(false);
  const invalidate = useCallback(() => { generation.current++; }, []);

  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => { setFocused(false); invalidate(); };
  }, [invalidate]));

  const load = useCallback(async (offset: number, version: number) => {
    setLoading(true);
    setCatalogError('');
    try {
      const result = await bridgeClient.browseDesktopVault(query, offset);
      if (version !== generation.current) return;
      setEntries(previous => offset ? [...previous, ...(result.entries || [])].filter((entry, index, all) => all.findIndex(item => item.vaultId === entry.vaultId) === index) : result.entries || []);
      setTotal(result.total || 0);
      setNextOffset(result.nextOffset ?? null);
    } catch (error) {
      if (version === generation.current) setCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === generation.current) { setLoading(false); pageLock.current = false; }
    }
  }, [query]);

  useEffect(() => {
    const version = ++generation.current;
    setEntries([]); setNextOffset(null); setTotal(0); setCatalogError('');
    pageLock.current = false;
    if (!connected || !focused) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => { pageLock.current = true; void load(0, version); }, 300);
    return () => { clearTimeout(timer); invalidate(); };
  }, [connected, focused, load, revision, invalidate]);

  const transfer = async () => {
    if (disabled || transferLock.current) return;
    transferLock.current = true;
    setTransferring(true); setProgress(null); setNotice('');
    try {
      const result = await transferDesktopVaultToMobile((completed, total) => setProgress({ completed, total }));
      setNotice(result.failed
        ? `Transferred ${result.transferred} of ${result.total} songs. ${result.failed} songs could not be transferred. ${result.error || ''}`
        : result.total ? `Transferred all ${result.total} ${result.total === 1 ? 'song' : 'songs'} to this device.` : 'No desktop songs to transfer.');
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally {
      try { await onTransferred(); }
      finally { transferLock.current = false; setTransferring(false); }
    }
  };

  if (!connected) return null;
  const locked = disabled || Boolean(transferring);
  return <View style={styles.card}>
    <View style={styles.header}>
      <Ionicons name="desktop-outline" size={22} color={Design.accent} />
      <Text style={styles.heading}>Desktop Bridge catalog</Text>
      <Button accessibilityLabel="Refresh Desktop Bridge catalog" disabled={loading || locked} style={[styles.refresh, (loading || locked) && styles.disabled]} onPress={() => setRevision(value => value + 1)}>
        <Ionicons name="refresh-outline" size={21} color={Design.accent} />
      </Button>
    </View>
    <Text style={styles.hint}>Browse lyrics saved on your desktop and transfer songs to your local vault, including translations.</Text>
    <Button accessibilityLabel="Transfer all Desktop Bridge songs to mobile" disabled={locked} style={[styles.transfer, locked && styles.disabled]} onPress={() => void transfer()}>
      {transferring ? <ActivityIndicator color={Design.accentInk} size="small" /> : <Ionicons name="download-outline" size={18} color={Design.accentInk} />}
      <Text style={styles.buttonText}>{transferring ? progress ? `Transferring ${progress.completed} of ${progress.total}…` : 'Preparing transfer…' : 'Transfer to Mobile'}</Text>
    </Button>
    <Text style={styles.hint}>Transfers all desktop songs, including songs outside your search. Existing copies on this device are updated.</Text>
    {!!notice && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
    <View style={styles.search}>
      <Ionicons name="search-outline" size={19} color={Design.muted} />
      <TextInput accessibilityLabel="Search Desktop Bridge catalog" placeholder="Search desktop songs or artists" placeholderTextColor={Design.muted} value={query} onChangeText={setQuery} autoCorrect={false} selectionColor={Design.accent} style={styles.input} />
      {!!query && <Button accessibilityLabel="Clear desktop search" style={styles.refresh} onPress={() => setQuery('')}><Ionicons name="close-circle" size={19} color={Design.muted} /></Button>}
    </View>
    {loading && <View style={styles.status}><ActivityIndicator color={Design.accent} size="small" /><Text style={styles.hint}>Loading desktop lyrics…</Text></View>}
    {!!catalogError && <Text accessibilityRole="alert" style={styles.notice}>{catalogError}</Text>}
    {!loading && !catalogError && !entries.length && <Text style={styles.hint}>{query.trim() ? 'No desktop songs match your search.' : 'No lyrics saved on the Desktop Bridge yet.'}</Text>}
    {!!entries.length && <Text style={styles.hint}>{entries.length} of {total} {total === 1 ? 'song' : 'songs'}</Text>}
    {entries.map(entry => <View key={entry.vaultId} style={styles.song}>
      <Text style={styles.title}>{entry.title}</Text>
      <Text style={styles.hint}>{entry.artist}</Text>
      <Text style={styles.hint}>{entry.lineCount} lines{entry.translatedLineCount ? ' · Translated' : ''}</Text>
    </View>)}
    {nextOffset !== null && <Button disabled={loading || locked} style={[styles.more, (loading || locked) && styles.disabled]} onPress={() => {
      if (pageLock.current) return;
      pageLock.current = true;
      void load(nextOffset, generation.current);
    }}><Text style={styles.notice}>Load more songs</Text></Button>}
  </View>;
}

const styles = StyleSheet.create({
  card: { padding: 18, gap: 14, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: Design.border },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heading: { flex: 1, color: Design.text, fontSize: 18, fontWeight: '700' },
  refresh: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  hint: { color: Design.muted, fontSize: 12, lineHeight: 18 },
  search: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12, borderRadius: 16, borderWidth: 1, borderColor: Design.border, backgroundColor: 'rgba(3,8,15,0.55)' },
  input: { flex: 1, minWidth: 0, paddingVertical: 14, color: Design.text, fontSize: 14 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  notice: { color: Design.text, fontSize: 13, lineHeight: 20 },
  song: { gap: 5, paddingTop: 14, borderTopWidth: 1, borderColor: Design.border },
  title: { color: Design.text, fontSize: 16, fontWeight: '700' },
  transfer: { minHeight: 44, marginTop: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: Design.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  buttonText: { color: Design.accentInk, fontSize: 13, fontWeight: '700' },
  more: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)' },
  disabled: { opacity: 0.4 },
});
