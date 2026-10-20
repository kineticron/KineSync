import Ionicons from '@react-native-vector-icons/ionicons';
import { File } from 'expo-file-system';
import { useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MotionPressable as Button } from '@/components/ui/motion-pressable';
import { Design } from '@/constants/design';
import { extractTtmlMetadata, parseTtmlToLyrics } from '@/lib/lyrics-ttml-import';
import { MAX_SYNC_STUDIO_DRAFTS } from '@/lib/sync-studio/storage';
import { getMobileVaultEntry, readVaultCatalog, type MobileVaultSummary } from '@/lib/mobile-lyrics-vault';
import { progress, projectFromLyrics, projectFromPlainText, type StudioMeta, type StudioProject } from '@/lib/sync-studio/engine';
import { usePlaybackStore } from '@/store/playback-store';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** "3 min ago", "2 h ago", "4 d ago": when a draft was last edited. */
function ago(time: number) {
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** Choose what to sync: a song in progress (up to five), the song playing now, the vault, a TTML file, or pasted lyrics. */
export function StartPanel({ drafts, onOpen, onDiscardDraft }: {
  drafts: StudioProject[]; onOpen: (project: StudioProject) => void; onDiscardDraft: (id: string) => void;
}) {
  const track = usePlaybackStore((state) => state.currentTrack);
  const lyrics = usePlaybackStore((state) => state.lyrics);
  const source = usePlaybackStore((state) => state.lyricsSource);
  const [vault, setVault] = useState<MobileVaultSummary[] | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [title, setTitle] = useState(track?.title ?? '');
  const [artist, setArtist] = useState(track?.artist ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const songMeta: StudioMeta = { title: track?.title ?? '', artist: track?.artist ?? '', album: track?.album,
    spotifyTrackId: track?.spotifyTrackId, trackId: track?.id, durationMs: track?.durationMs };

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await work(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return <View style={styles.panel}>
    <Text style={styles.intro}>
      Sync lyrics word by word by tapping or swiping along with the song, then save them or export a TTML for Spicy Lyrics.
    </Text>

    {drafts.length ? <View style={styles.card}>
      <Text style={styles.label}>CONTINUE ({drafts.length}/{MAX_SYNC_STUDIO_DRAFTS})</Text>
      {drafts.map((draft, index) => {
        const done = progress(draft);
        return <View key={draft.id ?? index} style={[styles.draft, index > 0 && styles.draftDivider]}>
          <Pressable style={styles.grow} onPress={() => onOpen(draft)} accessibilityRole="button" accessibilityLabel={`Continue ${draft.title || 'Untitled'}`}>
            <Text style={styles.songTitle} numberOfLines={1}>{draft.title || 'Untitled'}</Text>
            <Text style={styles.muted} numberOfLines={1}>{draft.artist ? `${draft.artist} · ` : ''}{done.wordTimed}/{done.lines} lines word-synced · {ago(draft.updatedAt)}</Text>
          </Pressable>
          <Button style={styles.iconPrimary} accessibilityLabel={`Continue ${draft.title || 'Untitled'}`} onPress={() => onOpen(draft)}>
            <Ionicons name="play" size={18} color={Design.accentInk} />
          </Button>
          <Button style={styles.iconSecondary} accessibilityLabel={`Discard ${draft.title || 'Untitled'}`}
            onPress={() => Alert.alert('Discard this draft?', `${draft.title || 'Untitled'}: its sync progress will be deleted.`,
              [{ text: 'Cancel', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => draft.id && onDiscardDraft(draft.id) }])}>
            <Ionicons name="trash-outline" size={17} color="#FF93A4" />
          </Button>
        </View>;
      })}
      {drafts.length >= MAX_SYNC_STUDIO_DRAFTS ? <Text style={styles.muted}>Starting another song replaces the oldest one here.</Text> : null}
    </View> : null}

    <View style={styles.card}>
      <Text style={styles.label}>PLAYING NOW</Text>
      {track ? <>
        <Text style={styles.songTitle}>{track.title}</Text>
        <Text style={styles.muted}>{track.artist}{lyrics.length ? ` · ${lyrics.length} lines from ${source || 'lyrics'}` : ' · no lyrics loaded'}</Text>
        <Button disabled={!lyrics.length} style={[styles.primary, !lyrics.length && styles.disabled]}
          onPress={() => onOpen(projectFromLyrics(lyrics, songMeta))}>
          <Ionicons name="musical-notes-outline" size={19} color={Design.accentInk} /><Text style={styles.primaryText}>Sync these lyrics</Text>
        </Button>
      </> : <Text style={styles.muted}>Play a song in Spotify to sync along with it.</Text>}
    </View>

    <View style={styles.card}>
      <Text style={styles.label}>OR START FROM</Text>
      <Button style={styles.secondary} disabled={busy} onPress={() => void run(async () => setVault(vault ? null : await readVaultCatalog()))}>
        <Ionicons name="archive-outline" size={18} color={Design.text} /><Text style={styles.buttonText}>Saved lyrics (vault)</Text>
      </Button>
      {vault ? vault.length ? vault.map((entry) => <Button key={entry.vaultId} style={styles.vaultRow} disabled={busy}
        onPress={() => void run(async () => {
          const full = await getMobileVaultEntry(entry.vaultId);
          if (!full) throw new Error('These lyrics are no longer in the vault.');
          onOpen(projectFromLyrics(full.lyrics, { title: full.track.title, artist: full.track.artist, album: full.track.album,
            spotifyTrackId: full.track.spotifyTrackId, trackId: full.track.id, durationMs: full.track.durationMs }));
        })}>
        <Text style={styles.vaultTitle} numberOfLines={1}>{entry.track.title}</Text>
        <Text style={styles.muted} numberOfLines={1}>{entry.track.artist} · {entry.lineCount} lines</Text>
      </Button>) : <Text style={styles.muted}>Your vault is empty.</Text> : null}

      <Button style={styles.secondary} disabled={busy} onPress={() => void run(async () => {
        if (Platform.OS === 'web') throw new Error('File import is available in the mobile app.');
        const picked = await File.pickFileAsync({ mimeTypes: ['*/*'] });
        if (picked.canceled) return;
        const file = new File(picked.result.uri);
        if (file.size > MAX_IMPORT_BYTES) throw new Error('This file is too large (maximum 2 MB).');
        const content = await file.text();
        if (!/<(?:\w+:)?tt[\s>]/i.test(content)) throw new Error('This is not a TTML lyrics file.');
        const parsed = parseTtmlToLyrics(content);
        if (!parsed.lyrics.length) throw new Error('This file contains no readable lyrics.');
        const found = extractTtmlMetadata(content);
        const sameSong = track && (!found.title || found.title.toLowerCase() === track.title.toLowerCase());
        onOpen(projectFromLyrics(parsed.lyrics, { ...(sameSong ? songMeta : {}), title: found.title || (sameSong ? songMeta.title : picked.result.name.replace(/\.[^.]+$/, '')),
          artist: found.artist || (sameSong ? songMeta.artist : ''), album: found.album ?? (sameSong ? songMeta.album : undefined),
          spotifyTrackId: found.spotifyTrackId ?? (sameSong ? songMeta.spotifyTrackId : undefined) }));
      })}>
        <Ionicons name="document-text-outline" size={18} color={Design.text} /><Text style={styles.buttonText}>Import a TTML file</Text>
      </Button>

      <Button style={styles.secondary} onPress={() => setPasting(!pasting)}>
        <Ionicons name="clipboard-outline" size={18} color={Design.text} /><Text style={styles.buttonText}>Paste lyrics</Text>
      </Button>
      {pasting ? <View style={styles.paste}>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="Song title" placeholderTextColor={Design.muted} />
        <TextInput style={styles.input} value={artist} onChangeText={setArtist} placeholder="Artist" placeholderTextColor={Design.muted} />
        <TextInput style={[styles.input, styles.multiline]} value={pasted} onChangeText={setPasted} multiline textAlignVertical="top"
          placeholder={'One lyric line per row.\nAd-libs in brackets on their own row:\n(yeah, yeah)\nInstrumental breaks on their own row:\n#INSTRUMENTAL'} placeholderTextColor={Design.muted} />
        <Button disabled={!pasted.trim()} style={[styles.primary, !pasted.trim() && styles.disabled]} onPress={() => {
          const sameSong = track && title.trim().toLowerCase() === track.title.toLowerCase();
          const project = projectFromPlainText(pasted, { ...(sameSong ? songMeta : {}), title: title.trim(), artist: artist.trim() });
          if (project.lines.length) onOpen(project);
        }}>
          <Ionicons name="arrow-forward" size={19} color={Design.accentInk} /><Text style={styles.primaryText}>Start syncing</Text>
        </Button>
      </View> : null}
      {busy ? <ActivityIndicator color={Design.accent} /> : null}
      {message ? <Text style={styles.error}>{message}</Text> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  panel: { gap: 16 },
  intro: { color: Design.muted, fontSize: 15, lineHeight: 22, paddingHorizontal: 4 },
  card: { padding: 18, gap: 12, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: Design.border },
  label: { color: 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600', letterSpacing: 1.4 },
  songTitle: { color: Design.text, fontSize: 19, fontWeight: '700' },
  muted: { color: Design.muted, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: 'row', gap: 10 },
  draft: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  draftDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Design.border },
  iconPrimary: { width: 44, height: 44, borderRadius: 14, backgroundColor: Design.accent, alignItems: 'center', justifyContent: 'center' },
  iconSecondary: { width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: Design.border, alignItems: 'center', justifyContent: 'center' },
  grow: { flex: 1 },
  primary: { minHeight: 50, paddingHorizontal: 16, borderRadius: 16, backgroundColor: Design.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  primaryText: { color: Design.accentInk, fontSize: 15, fontWeight: '700' },
  secondary: { minHeight: 50, paddingHorizontal: 16, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: Design.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  buttonText: { color: Design.text, fontSize: 14, fontWeight: '600' },
  vaultRow: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, backgroundColor: 'rgba(3,8,15,0.35)', gap: 2 },
  vaultTitle: { color: Design.text, fontSize: 15, fontWeight: '600' },
  paste: { gap: 10 },
  input: { minHeight: 48, paddingHorizontal: 13, paddingVertical: 11, color: Design.text, fontSize: 15, backgroundColor: 'rgba(3,8,15,0.4)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  multiline: { minHeight: 180 },
  disabled: { opacity: 0.4 },
  error: { color: '#FF93A4', fontSize: 13, lineHeight: 19 },
});
