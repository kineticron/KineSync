import Ionicons from '@react-native-vector-icons/ionicons';
import { router, useFocusEffect } from 'expo-router';
import { File, Paths } from 'expo-file-system';
import { shareAsync } from 'expo-sharing';
import { BlurView } from 'expo-blur';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MotionPressable as Button } from '@/components/ui/motion-pressable';
import { PromotionalBackdrop } from '@/components/ui/promotional-backdrop';
import { BridgedArtworkImage } from '@/components/lyrics/bridged-artwork-image';
import { DesktopVaultCatalog } from '@/components/lyrics/desktop-vault-catalog';
import { Design } from '@/constants/design';
import { useVaultIncomingShare } from '@/hooks/use-vault-incoming-share';
import { deleteMobileVaultEntry, readVaultEntries, renameMobileVaultEntry, saveMobileVaultLyrics, type MobileVaultEntry } from '@/lib/mobile-lyrics-vault';
import { extractTtmlMetadata, parseTtmlToLyrics } from '@/lib/lyrics-ttml-import';
import { buildDefaultTtmlFilename, lyricsToTtml } from '@/lib/lyrics-ttml-export';
import { usePlaybackStore } from '@/store/playback-store';
import type { LyricLine } from '@/types/bridge';

type ImportDraft = { lyrics: LyricLine[]; durationMs: number; shared: boolean };
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export default function VaultScreen() {
  const [entries, setEntries] = useState<MobileVaultEntry[]>([]);
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const handled = useRef('');
  const { resolvedSharedPayloads, clearSharedPayloads, error } = useVaultIncomingShare();
  const track = usePlaybackStore(s => s.currentTrack);
  const lyrics = usePlaybackStore(s => s.lyrics);
  const reload = useCallback(async () => setEntries(await readVaultEntries()), []);
  useFocusEffect(useCallback(() => { void reload(); }, [reload]));

  const prepareImport = useCallback(async (uri: string, name: string, shared: boolean) => {
    setMessage('');
    if (name && !/\.ttml$/i.test(name)) throw new Error('Choose a .ttml lyrics file.');
    if (!/^(file|content):\/\//i.test(uri)) throw new Error('Share a local .ttml file.');
    const file = new File(uri);
    if (file.size > MAX_IMPORT_BYTES) throw new Error('This file is too large (maximum 2 MB).');
    const content = await file.text();
    if (content.length > MAX_IMPORT_BYTES || !/<(?:\w+:)?tt[\s>]/i.test(content)) throw new Error('This is not a valid TTML document.');
    const parsed = parseTtmlToLyrics(content);
    if (!parsed.lyrics.length) throw new Error('This file contains no readable lyrics.');
    const metadata = extractTtmlMetadata(content);
    setEditing(null);
    if (metadata.title && metadata.artist) {
      await saveMobileVaultLyrics({ track: { id: `import-${Date.now()}`, title: metadata.title, artist: metadata.artist, durationMs: 0 }, lyrics: parsed.lyrics, originalSource: 'ttml-import' });
      setMessage(`Imported ${metadata.title} into your local vault.`);
      if (shared) clearSharedPayloads();
      await reload();
    } else {
      setTitle(metadata.title || name.replace(/\.ttml$/i, ''));
      setArtist(metadata.artist);
      setDraft({ lyrics: parsed.lyrics, durationMs: parsed.durationMs, shared });
    }
  }, [clearSharedPayloads, reload]);

  useEffect(() => {
    if (error) setMessage(error.message);
    const payload = resolvedSharedPayloads[0];
    if (!payload?.contentUri) { handled.current = ""; return; }
    if (handled.current === payload.contentUri) return;
    handled.current = payload.contentUri;
    setBusy(true);
    void prepareImport(payload.contentUri, payload.originalName || '', true)
      .catch(e => setMessage(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [resolvedSharedPayloads, prepareImport, error]);

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await operation(); await reload(); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const closeEditor = () => {
    if (draft?.shared) clearSharedPayloads();
    setDraft(null); setEditing(null);
  };

  const filteredEntries = entries.filter(entry => `${entry.track.title} ${entry.track.artist}`.toLowerCase().includes(query.trim().toLowerCase()));
  const canSaveCurrent = Boolean(track && lyrics.length);

  return <View style={styles.screen}>
    <PromotionalBackdrop />
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={styles.safeArea} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Button accessibilityLabel="Back to lyrics" hitSlop={10} onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={styles.backButton}>
            <Ionicons name="chevron-back" size={23} color={Design.text} />
          </Button>
          <Text style={styles.heading}>Local vault</Text>
          <View style={styles.headerIcon}><Ionicons name="library-outline" size={23} color={Design.accent} /></View>
        </View>

        <View style={styles.summary}>
          <View style={styles.countChip}>
            <Ionicons name="phone-portrait-outline" size={15} color={Design.accent} />
            <Text style={styles.countText}>{entries.length} {entries.length === 1 ? 'song' : 'songs'} saved on this device</Text>
          </View>
          <Text style={styles.summaryText}>Your lyrics, always close. Save a song or bring your own lyrics into KineSync.</Text>
        </View>

        <View style={styles.card}>
          <BlurView pointerEvents="none" intensity={24} tint="dark" style={StyleSheet.absoluteFill} />
          <Text style={styles.sectionLabel}>ADD TO YOUR VAULT</Text>
          <View style={styles.addActions}>
        <Button accessibilityLabel="Import TTML lyrics file" disabled={busy} style={[styles.primaryButton, busy && styles.disabled]} onPress={() => void run(async () => {
          if (Platform.OS === 'web') throw new Error('File import is available in the mobile app.');
          const result = await File.pickFileAsync({ mimeTypes: ['*/*'] });
          if (!result.canceled) await prepareImport(result.result.uri, result.result.name, false);
        })}><Ionicons name="add-circle-outline" size={20} color={Design.accentInk} /><Text style={styles.primaryButtonText}>Import TTML</Text></Button>
        <Button accessibilityLabel="Save current song to vault" disabled={busy || !canSaveCurrent} style={[styles.secondaryButton, (busy || !canSaveCurrent) && styles.disabled]} onPress={() => void run(async () => {
          if (!track || !lyrics.length) return;
          await saveMobileVaultLyrics({ track, lyrics, originalSource: usePlaybackStore.getState().lyricsSource, metadata: usePlaybackStore.getState().lyricsMetadata });
          setMessage('Saved current lyrics, including translations.');
        })}><Ionicons name="download-outline" size={20} color={Design.text} /><Text style={styles.buttonText}>Save current song</Text></Button>
          </View>
          <Text style={styles.hint}>Import a .ttml file, or share one to KineSync from another app.</Text>
        </View>

      {busy && <View style={styles.statusRow} accessibilityLiveRegion="polite"><ActivityIndicator size="small" color={Design.accent} /><Text style={styles.muted}>Updating your vault…</Text></View>}
      {!!message && <View style={styles.messageBox}><Ionicons name="information-circle-outline" size={20} color={Design.accent} /><Text accessibilityRole="alert" style={styles.message}>{message}</Text></View>}

      {(draft || editing) && <View style={styles.card}>
        <BlurView pointerEvents="none" intensity={24} tint="dark" style={StyleSheet.absoluteFill} />
        <Text style={styles.sectionLabel}>{editing ? 'EDIT SONG DETAILS' : 'ADD SONG DETAILS'}</Text>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Song name</Text>
          <TextInput accessibilityLabel="Song name" placeholder="Song name" placeholderTextColor={Design.muted} value={title} onChangeText={setTitle} editable={!busy} selectionColor={Design.accent} onFocus={() => setFocusedField('title')} onBlur={() => setFocusedField(null)} style={[styles.input, focusedField === 'title' && styles.inputFocused]} />
        </View>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Artist</Text>
          <TextInput accessibilityLabel="Artist" placeholder="Artist" placeholderTextColor={Design.muted} value={artist} onChangeText={setArtist} editable={!busy} selectionColor={Design.accent} onFocus={() => setFocusedField('artist')} onBlur={() => setFocusedField(null)} style={[styles.input, focusedField === 'artist' && styles.inputFocused]} />
        </View>
        <View style={styles.actions}>
          <Button disabled={busy} style={[styles.primaryButton, styles.editorButton, busy && styles.disabled]} onPress={() => void run(async () => {
            if (!title.trim() || !artist.trim()) throw new Error('Enter a song name and artist.');
            if (editing) await renameMobileVaultEntry(editing, title, artist);
            else if (draft) await saveMobileVaultLyrics({ track: { id: `import-${Date.now()}`, title: title.trim(), artist: artist.trim(), durationMs: 0 }, lyrics: draft.lyrics, originalSource: 'ttml-import' });
            closeEditor(); setMessage('Saved to local vault.');
          })}><Ionicons name="checkmark" size={19} color={Design.accentInk} /><Text style={styles.primaryButtonText}>Save</Text></Button>
          <Button disabled={busy} style={[styles.secondaryButton, styles.editorButton, busy && styles.disabled]} onPress={closeEditor}><Text style={styles.buttonText}>Cancel</Text></Button>
        </View>
      </View>}

      <DesktopVaultCatalog disabled={busy} onTransferred={reload} />

      <View style={styles.libraryHeader}>
        <Text style={styles.sectionLabel}>SAVED LYRICS</Text>
        <Text style={styles.hint}>{query.trim() ? `${filteredEntries.length} results` : `${entries.length} ${entries.length === 1 ? 'song' : 'songs'}`}</Text>
      </View>
      <View style={[styles.search, focusedField === 'search' && styles.inputFocused]}>
        <Ionicons name="search-outline" size={20} color={Design.muted} />
        <TextInput accessibilityLabel="Search vault" placeholder="Search songs or artists" placeholderTextColor={Design.muted} value={query} onChangeText={setQuery} autoCorrect={false} selectionColor={Design.accent} onFocus={() => setFocusedField('search')} onBlur={() => setFocusedField(null)} style={styles.searchInput} />
        {!!query && <Button accessibilityLabel="Clear search" hitSlop={4} onPress={() => setQuery('')} style={styles.clearSearch}><Ionicons name="close-circle" size={19} color={Design.muted} /></Button>}
      </View>
      {!filteredEntries.length && <View style={[styles.card, styles.emptyState]}>
        <BlurView pointerEvents="none" intensity={24} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={styles.emptyIcon}><Ionicons name={entries.length ? 'search-outline' : 'library-outline'} size={30} color={Design.accent} /></View>
        <Text style={styles.emptyTitle}>{entries.length ? 'No matching songs' : 'Make room for your favorites'}</Text>
        <Text style={styles.emptyText}>{entries.length ? 'Try a different song name or artist.' : 'Import a lyrics file or save your current song to start your collection.'}</Text>
      </View>}
      <View style={styles.songList}>
      {filteredEntries.map(entry => <View key={entry.vaultId} style={styles.songCard}>
        <BlurView pointerEvents="none" intensity={24} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={styles.songRow}>
          {entry.track.artworkUrl ? <BridgedArtworkImage uri={entry.track.artworkUrl} cachePolicy="memory" style={styles.artwork} contentFit="cover" recyclingKey={`vault-${entry.vaultId}`} /> : <View style={[styles.artwork, styles.artworkPlaceholder]}><Ionicons name="musical-notes-outline" size={24} color={Design.accent} /></View>}
          <View style={styles.songCopy}>
            <Text style={styles.songTitle}>{entry.track.title}</Text>
            <Text style={styles.artist}>{entry.track.artist}</Text>
            <Text style={styles.songDetail}>{entry.lyrics.length} {entry.lyrics.length === 1 ? 'line' : 'lines'}{entry.lyrics.some(line => line.translatedText || line.backgroundTranslatedText) ? ' · Translated' : ''}</Text>
          </View>
        </View>
        <View style={styles.songActions}>
          <Button accessibilityLabel={`Edit ${entry.track.title}`} disabled={busy || Boolean(draft)} style={[styles.songAction, (busy || Boolean(draft)) && styles.disabled]} onPress={() => { setEditing(entry.vaultId); setTitle(entry.track.title); setArtist(entry.track.artist); }}><Ionicons name="create-outline" size={17} color={Design.text} /><Text style={styles.actionText}>Edit</Text></Button>
          <Button accessibilityLabel={`Export ${entry.track.title}`} disabled={busy} style={[styles.songAction, busy && styles.disabled]} onPress={() => void run(async () => {
            const file = new File(Paths.cache, buildDefaultTtmlFilename(entry.track));
            file.create({ overwrite: true });
            file.write(lyricsToTtml({ lyrics: entry.lyrics, ...entry.track, source: entry.originalSource }));
            await shareAsync(file.uri, { mimeType: 'application/ttml+xml', UTI: 'public.xml' });
          })}><Ionicons name="share-outline" size={17} color={Design.text} /><Text style={styles.actionText}>Export</Text></Button>
          <Button accessibilityLabel={`Delete ${entry.track.title}`} disabled={busy} style={[styles.songAction, busy && styles.disabled]} onPress={() => Alert.alert('Delete saved lyrics?', `${entry.track.title} will be removed from this device.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => void run(async () => { await deleteMobileVaultEntry(entry.vaultId); }) }])}><Ionicons name="trash-outline" size={17} color="#FF93A4" /><Text style={[styles.actionText, styles.deleteText]}>Delete</Text></Button>
        </View>
      </View>)}
      </View>
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </View>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Design.background, overflow: 'hidden' },
  safeArea: { flex: 1 },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 34, gap: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 4 },
  backButton: { width: 44, height: 44, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' },
  heading: { flex: 1, color: Design.text, fontSize: 32, fontWeight: '700', letterSpacing: -1, marginTop: 2 },
  headerIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(168,240,207,0.1)', alignItems: 'center', justifyContent: 'center' },
  summary: { gap: 12, paddingHorizontal: 4, alignItems: 'flex-start' },
  countChip: { minHeight: 34, borderRadius: 18, paddingHorizontal: 11, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(111,232,179,0.12)' },
  countText: { color: Design.accent, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  summaryText: { color: Design.muted, fontSize: 15, lineHeight: 22 },
  card: { padding: 18, gap: 16, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: Design.border, overflow: 'hidden' },
  sectionLabel: { color: 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600', letterSpacing: 1.4 },
  addActions: { gap: 10 },
  primaryButton: { minHeight: 50, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, backgroundColor: Design.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  primaryButtonText: { color: Design.accentInk, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  secondaryButton: { minHeight: 50, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: Design.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  buttonText: { color: Design.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  hint: { color: Design.muted, fontSize: 12, lineHeight: 18 },
  muted: { color: Design.muted, fontSize: 13, lineHeight: 20 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 },
  messageBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: Design.border, backgroundColor: 'rgba(20,26,36,0.8)' },
  message: { flex: 1, color: Design.text, fontSize: 13, lineHeight: 21 },
  field: { gap: 7 },
  fieldLabel: { color: 'rgba(255,255,255,0.68)', fontSize: 13, fontWeight: '600' },
  input: { minHeight: 50, paddingHorizontal: 13, paddingVertical: 12, color: Design.text, fontSize: 15, fontWeight: '500', backgroundColor: 'rgba(3,8,15,0.4)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  inputFocused: { borderColor: Design.accent, backgroundColor: 'rgba(168,240,207,0.04)' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  editorButton: { flexGrow: 1, flexBasis: 100 },
  libraryHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 4 },
  search: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 4, borderRadius: 16, borderWidth: 1, borderColor: Design.border, backgroundColor: 'rgba(3,8,15,0.55)' },
  searchInput: { flex: 1, minWidth: 0, paddingVertical: 14, color: Design.text, fontSize: 14 },
  clearSearch: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  emptyState: { alignItems: 'center', paddingVertical: 32, gap: 12 },
  emptyIcon: { width: 64, height: 64, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(168,240,207,0.08)', marginBottom: 4 },
  emptyTitle: { color: Design.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  emptyText: { maxWidth: 300, color: Design.muted, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  songList: { gap: 12 },
  songCard: { borderRadius: 24, borderWidth: 1, borderColor: Design.border, backgroundColor: 'rgba(255,255,255,0.04)', overflow: 'hidden' },
  songRow: { padding: 18, flexDirection: 'row', alignItems: 'center', gap: 14 },
  artwork: { width: 56, height: 56, borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.08)' },
  artworkPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  songCopy: { flex: 1, minWidth: 0, gap: 4 },
  songTitle: { color: Design.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.25 },
  artist: { color: Design.muted, fontSize: 13, lineHeight: 18 },
  songDetail: { color: 'rgba(255,255,255,0.48)', fontSize: 11, lineHeight: 16 },
  songActions: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, borderColor: Design.border, padding: 6, gap: 4, backgroundColor: 'rgba(3,8,15,0.18)' },
  songAction: { flexGrow: 1, flexBasis: 76, minHeight: 44, paddingHorizontal: 8, paddingVertical: 10, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  actionText: { color: Design.text, fontSize: 12, fontWeight: '600' },
  deleteText: { color: '#FF93A4' },
  disabled: { opacity: 0.4 },
});
