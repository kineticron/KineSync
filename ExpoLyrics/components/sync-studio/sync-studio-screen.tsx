import Ionicons from '@react-native-vector-icons/ionicons';
import { impactAsync, ImpactFeedbackStyle, selectionAsync } from 'expo-haptics';
import { File, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import { shareAsync } from 'expo-sharing';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, BackHandler, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeAmllLyricsView } from '@/components/lyrics/native-amll-lyrics-view';
import { NativeSpicyLyricsView } from '@/components/lyrics/native-spicy-lyrics-view';
import { StartPanel } from '@/components/sync-studio/start-panel';
import { useSongClock, useSyncStudio } from '@/components/sync-studio/use-sync-studio';
import { WordPad } from '@/components/sync-studio/word-pad';
import { MotionPressable as Button } from '@/components/ui/motion-pressable';
import { Design } from '@/constants/design';
import { refreshLyricsForCurrentTrack } from '@/lib/lyrics-sync';
import { buildDefaultTtmlFilename, lyricsToTtml } from '@/lib/lyrics-ttml-export';
import { saveMobileVaultLyrics } from '@/lib/mobile-lyrics-vault';
import {
  bracketedWords, clearLineWords, deleteLine, extractAdLib, insertInstrumentalAfter, nextWordRow, insertLineAfter, isLineWordSynced, leadInPosition, lineAtTime, lineText, lyricsFromProject,
  canBeDuet, endLastWord, endUnit, joinWordGroup, restartUnit, setDuet, openUnit, tapEnd, toggleSplit, unitSeparator, wordGroups, markLineEnd, markLineStart, nextIndexToSync, nextUntimedWord, setLineTiming, nudgeFirstWord, parseTimeInput, rowWindows, setFlagged, setWordTiming, shiftWords, applyTimingFromLines, applyTimingToMatchingLines, shiftWordEdges, sameTextLines, setWordTextEverywhere, copySplitsToMatchingLines, matchingLines, previousLeadIndex, progress, rowStart, setBackground, setLineText, shiftAll,
  shiftLine, swipeEnterWord, swipeFinish, swipeRetreat, tapWord, type StudioLine, type StudioProject, type StudioStage,
} from '@/lib/sync-studio/engine';
import { guessLineSyllables, guessSongSyllables, SYLLABLE_LANGUAGES, syllableLanguageLabel, type SyllableLanguage } from '@/lib/sync-studio/syllables';
import { characters } from '@/lib/sync-studio/swipe';
import { closeLocalAudio, hasSongControls, openLocalAudio, playSong, playSongRange, seekSong, setLocalRate, songIsPlaying, songPositionMs,
  toggleSong, useLocalAudio } from '@/lib/sync-studio/playback';
import { usePlaybackStore } from '@/store/playback-store';

const formatTime = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  return `${minutes}:${(total - minutes * 60).toFixed(2).padStart(5, '0')}`;
};
/** A slide that stops early replays the line from this far before it. */
const RETRY_LEAD_IN_MS = 500;
/** With "Rewind" on, moving to the next line plays it from this far before it. */
const NEXT_LINE_LEAD_IN_MS = 500;
const tick = () => { void impactAsync(ImpactFeedbackStyle.Light).catch(() => {}); };

function nextLeadAfter(project: StudioProject, index: number) {
  for (let i = index + 1; i < project.lines.length; i++) if (!project.lines[i].background) return i;
  return -1;
}

/** Is Spotify playing the song this project is for? */
function useSongMatch(project: StudioProject | null) {
  const track = usePlaybackStore((state) => state.currentTrack);
  if (!project) return { ok: true, playing: track?.title ?? '' };
  if (!track) return { ok: false, playing: '' };
  const ok = project.spotifyTrackId && track.spotifyTrackId ? project.spotifyTrackId === track.spotifyTrackId
    : project.trackId && project.trackId === track.id ? true
      : project.title.trim().toLowerCase() === track.title.trim().toLowerCase();
  return { ok, playing: track.title };
}

export default function SyncStudioScreen() {
  const studio = useSyncStudio();
  const { project, projectRef, apply, replace, commit, checkpoint, revertToCheckpoint, settings, close: closeProject } = studio;
  const [stage, setStage] = useState<StudioStage>('lines');
  const [cursor, setCursor] = useState(0);
  /** The cursor right now, even before React re-renders: quick taps after a line finishes go to the next line. */
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  /**
   * Tap mode: the row the taps since arriving belong to. The first tap on a row
   * with timing starts it over; later taps continue it. Reset the moment the
   * cursor moves (not after the next render, or a quick second tap would
   * restart the row and lag the highlight by a word).
   */
  const tappingRow = useRef(-1);
  /** Tap mode: a unit picked in the pad to resync on its own (Start, then Commit or End). */
  const [focus, setFocus] = useState<number | null>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const moveCursor = useCallback((index: number) => {
    if (index !== cursorRef.current) { tappingRow.current = -1; focusRef.current = null; setFocus(null); }
    cursorRef.current = index;
    setCursor(index);
  }, []);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [lineMenu, setLineMenu] = useState<number | null>(null);
  const [textEdit, setTextEdit] = useState<{ index: number; value: string; insert?: 'line' | 'adlib' } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adLibPicker, setAdLibPicker] = useState<number | null>(null);
  const [similar, setSimilar] = useState<{ index: number; kind: SimilarKind } | null>(null);
  const [wordTimer, setWordTimer] = useState<number | null>(null);
  const [lineTimer, setLineTimer] = useState<number | null>(null);
  /** The local file speed slider stays folded away until asked for. */
  const [speedOpen, setSpeedOpen] = useState(false);
  const [syllables, setSyllables] = useState<number | null>(null);
  const [leadInOpen, setLeadInOpen] = useState(false);
  /** Row to bring into view once the list has laid it out (returning from the preview). */
  const pendingScroll = useRef<number | null>(null);
  const [notice, setNotice] = useState('');
  const { position, isPlaying } = useSongClock(songPositionMs, songIsPlaying);
  const local = useLocalAudio((state) => state.local);
  const tapKeys = stage === 'words' && settings.wordMethod === 'tap';
  const spotifyMatch = useSongMatch(project);
  const match = local ? { ok: true, playing: local.name } : spotifyMatch;
  // A local file only plays while Sync Studio is open.
  useEffect(() => closeLocalAudio, []);
  const listRef = useRef<ScrollView>(null);
  const rowY = useRef<number[]>([]);
  const lyricsStyle = usePlaybackStore((state) => state.lyricsStyle);

  const openProject = useCallback((next: StudioProject) => {
    studio.open(next);
    const needsLines = next.lines.some((row) => !row.background && row.start == null);
    setStage(needsLines ? 'lines' : 'words');
    moveCursor(Math.max(0, needsLines ? next.lines.findIndex((row) => !row.background && row.start == null) : nextIndexToSync(next, -1, 'words')));
    setMode('edit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio.open]);

  // Keep the active row in view.
  useEffect(() => {
    const y = rowY.current[cursor];
    if (y != null) listRef.current?.scrollTo({ y: Math.max(0, y - 140), animated: true });
  }, [cursor, stage]);

  // Keep the cursor on a real row after lines are deleted.
  useEffect(() => {
    if (project && cursor >= project.lines.length) moveCursor(Math.max(0, project.lines.length - 1));
  }, [cursor, moveCursor, project]);

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);

  /** "Apply timing to all similar lines" / "Split similar lines": confirm first, or say there are none. */
  const openSimilar = useCallback((index: number, kind: SimilarKind) => {
    const current = projectRef.current;
    const row = current?.lines[index];
    if (!current || !row) return;
    if (matchingLines(current, index).length) setSimilar({ index, kind });
    else Alert.alert('No similar lines', `No other ${row.background ? 'ad-lib' : 'main line'} has exactly the same words.`);
  }, [projectRef]);

  /** Back from the preview: the editor opens on the line playing now. */
  const backToEdit = useCallback(() => {
    const current = projectRef.current;
    const playing = current ? lineAtTime(current, songPositionMs()) : -1;
    if (playing >= 0) { moveCursor(playing); pendingScroll.current = playing; }
    setMode('edit');
  }, [moveCursor, projectRef]);

  /**
   * Leaving the editor on purpose: with changes since the song was opened (or
   * last saved to the vault), ask whether to keep them. A crash or restart
   * never asks; edits are saved as they happen.
   */
  const leaveProject = useCallback(() => {
    if (!studio.isDirty()) { closeProject(); return; }
    Alert.alert('Keep your changes?',
      'You changed this sync since you opened it (or last saved it to the vault). Discard puts it back the way it was.',
      [{ text: 'Cancel', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => closeProject({ keep: false }) },
        { text: 'Keep', onPress: () => closeProject() }]);
  }, [closeProject, studio]);

  // Android back: preview → editor → song picker → leave. Edits are already saved.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!projectRef.current) return false;
      if (batchRef.current) setBatch(null);
      else if (mode === 'preview') backToEdit(); else leaveProject();
      return true;
    });
    return () => subscription.remove();
  }, [backToEdit, leaveProject, mode, projectRef]);

  const capture = useCallback(() => songPositionMs() - settings.tapOffsetMs, [settings.tapOffsetMs]);

  /** Go to a row; play from a little before it when it has already passed. */
  const goTo = useCallback((index: number, forceSeek = false) => {
    const current = projectRef.current;
    if (!current || index < 0) return;
    moveCursor(index);
    const target = leadInPosition(current, index, settings.leadInMs);
    const start = rowStart(current.lines[index]);
    const passed = (start ?? target + settings.leadInMs) < songPositionMs() - 250;
    // An untimed main line is still ahead: keep playing. An untimed ad-lib sits
    // inside the line before it, so that line is replayed.
    const rewind = start != null || current.lines[index].background;
    if (forceSeek || (settings.autoRewind && passed && rewind)) {
      seekSong(target);
      playSong();
    }
  }, [moveCursor, projectRef, settings.autoRewind, settings.leadInMs]);

  /**
   * After a line: move to the next one. With "Rewind" on, the song jumps to
   * 0.5 s before that line (an untimed ad-lib replays the line it belongs to);
   * with it off, the song keeps playing.
   */
  const advanceWords = useCallback(({ seek = true }: { seek?: boolean } = {}) => {
    const current = projectRef.current;
    if (!current) return;
    // Always the very next line, synced or not: syncing it again overwrites it.
    const next = nextWordRow(current, cursorRef.current);
    if (next < 0) {
      const left = nextIndexToSync(current, -1, 'words');
      setNotice(left < 0 ? 'Every line is word-synced. Open the preview to check it.' : 'That was the last line. Some lines above still need words.');
      return;
    }
    cursorRef.current = next;
    moveCursor(next);
    const row = current.lines[next];
    if (seek && settings.autoRewind && (rowStart(row) != null || row.background)) {
      seekSong(leadInPosition(current, next, NEXT_LINE_LEAD_IN_MS));
      playSong();
    }
  }, [moveCursor, projectRef, settings.autoRewind]);

  // ---- Lines stage ----
  const tapLineStart = useCallback(() => {
    const current = projectRef.current;
    if (!current || !current.lines[cursor] || current.lines[cursor].background) return;
    tick();
    const next = apply((p) => markLineStart(p, cursor, capture()));
    const after = next ? nextLeadAfter(next, cursor) : -1;
    if (after >= 0) moveCursor(after);
    else setNotice('All lines have a start. Next: sync the words.');
  }, [apply, capture, cursor, moveCursor, projectRef]);

  const tapPause = useCallback(() => {
    const current = projectRef.current;
    if (!current) return;
    // The line being sung is the last one tapped before the cursor.
    const index = current.lines[cursor]?.start != null && !current.lines[cursor].background ? cursor : previousLeadIndex(current, cursor);
    if (index < 0) return;
    tick();
    apply((p) => markLineEnd(p, index, capture()));
  }, [apply, capture, cursor, projectRef]);

  // ---- Words stage ----
  /** Tap mode: the line finished last (End with nothing started on the next line re-ends it). */
  const previousRow = useRef(-1);
  const projectOpen = project != null;
  useEffect(() => { previousRow.current = -1; }, [projectOpen, stage, settings.wordMethod]);

  /** Tap a unit in the pad to resync just it; tap it again to let go. */
  const pickUnit = useCallback((unit: number) => {
    const next = focusRef.current === unit ? null : unit;
    focusRef.current = next;
    setFocus(next);
  }, []);
  const dropFocus = useCallback(() => { focusRef.current = null; setFocus(null); }, []);

  /**
   * Tap mode Start (F) and Commit (G). Each starts the next unit and ends the
   * one before. On the last unit they end the line and go straight on into the
   * next line's first unit at the same moment, so one tap per word carries
   * through a whole verse. With "Last G: End" on, Commit on the last unit
   * acts as End instead and the next line waits for its own first tap.
   * With a unit picked in the pad, they resync just it.
   */
  const tapNextWord = useCallback((key: 'start' | 'commit') => {
    const current = projectRef.current;
    const cursor = cursorRef.current;
    const row = current?.lines[cursor];
    if (!current || !row || !row.words.length) return;
    tick();
    const time = capture();
    const picked = focusRef.current;
    if (picked != null && row.words[picked]) {
      tappingRow.current = cursor;
      const word = row.words[picked];
      if (key === 'commit' && word.start != null && word.end == null) {
        apply((p) => endUnit(p, cursor, picked, time, true));
        dropFocus();
      } else apply((p) => restartUnit(p, cursor, picked, time));
      return;
    }
    const timed = row.words.some((word) => word.start != null);
    const complete = nextUntimedWord(row) < 0 && openUnit(row) < 0;
    // The first tap on a line with timing (or on a finished line) starts it over.
    const restart = timed && (tappingRow.current !== cursor || complete);
    tappingRow.current = cursor;
    if (!restart && openUnit(row) === row.words.length - 1) {
      if (key === 'commit' && settings.lastCommitEnds) {
        apply((p) => tapEnd(p, cursor, time).project);
        previousRow.current = cursor;
        advanceWords();
        return;
      }
      const next = nextWordRow(current, cursor);
      const target = next >= 0 ? current.lines[next] : null;
      const carry = target != null && target.words.length > 0 && !target.instrumental;
      // Two undo steps: ending this line, then starting the next one. An
      // accidental Commit onto a synced line is undone by one Undo, which
      // brings that line's sync back and keeps this line finished.
      apply((p) => tapWord(p, cursor, time).project);
      const resyncing = carry && target.words.some((word) => word.start != null);
      if (carry) apply((p) => tapWord(resyncing ? clearLineWords(p, next) : p, next, time).project);
      if (resyncing) setNotice('Syncing this line again. Undo brings back its old timing.');
      previousRow.current = cursor;
      // Carrying on: the song keeps playing (no rewind) and the next line's taps continue it.
      advanceWords({ seek: !carry });
      if (carry) tappingRow.current = next;
      return;
    }
    apply((p) => tapWord(restart ? clearLineWords(p, cursor) : p, cursor, time).project);
    if (restart) setNotice('Syncing this line again. Undo brings back its old timing.');
  }, [advanceWords, apply, capture, dropFocus, projectRef, settings.lastCommitEnds]);
  const tapStartKey = useCallback(() => tapNextWord('start'), [tapNextWord]);
  const tapCommitKey = useCallback(() => tapNextWord('commit'), [tapNextWord]);

  /**
   * Tap mode End (H): the unit being sung ends now, leaving a gap. Ending the
   * last unit finishes the line. With nothing started on this line yet, it ends
   * the line just finished. With a unit picked in the pad, it ends just that one.
   */
  const tapEndKey = useCallback(() => {
    const current = projectRef.current;
    const cursor = cursorRef.current;
    const row = current?.lines[cursor];
    if (!row) return;
    const time = capture();
    const picked = focusRef.current;
    if (picked != null && row.words[picked]?.start != null) {
      tick();
      tappingRow.current = cursor;
      apply((p) => endUnit(p, cursor, picked, time, false));
      dropFocus();
      return;
    }
    if (openUnit(row) >= 0) {
      tick();
      tappingRow.current = cursor;
      let finished = false;
      apply((p) => { const result = tapEnd(p, cursor, time); finished = result.finished; return result.project; });
      if (finished) { previousRow.current = cursor; advanceWords(); }
      return;
    }
    const previous = previousRow.current;
    if (previous < 0 || previous === cursor || !current.lines[previous] || row.words.some((word) => word.start != null)) return;
    tick();
    apply((p) => endLastWord(p, previous, time));
  }, [advanceWords, apply, capture, dropFocus, projectRef]);

  /** Words stage on an instrumental break: tap when it starts, then move on. */
  const tapInstrumental = useCallback(() => {
    const current = projectRef.current;
    const cursor = cursorRef.current;
    if (!current?.lines[cursor]?.instrumental) return;
    tick();
    apply((p) => markLineStart(p, cursor, capture()));
    advanceWords();
  }, [advanceWords, apply, capture, projectRef]);

  /** Tap mode: start this line over from its first word, playing from just before it. */
  const restartTapLine = useCallback(() => {
    const current = projectRef.current;
    if (!current?.lines[cursor]) return;
    tappingRow.current = cursor;
    dropFocus();
    apply((p) => clearLineWords(p, cursor));
    seekSong(leadInPosition(current, cursor, RETRY_LEAD_IN_MS));
    playSong();
  }, [apply, dropFocus, cursor, projectRef]);

  // Slide mode: one pass per line. Letting go before the last word is lit
  // restarts the line from just before it, so the next try starts in time.
  const passStart = useRef<StudioProject | null>(null);
  const swipeBegin = useCallback(() => {
    passStart.current = projectRef.current;
    checkpoint();
    replace((p) => clearLineWords(p, cursor), { pass: true });
  }, [checkpoint, cursor, projectRef, replace]);
  const swipeEnter = useCallback((wordIndex: number, fromIndex: number) => {
    void selectionAsync().catch(() => {});
    replace((p) => swipeEnterWord(p, cursor, wordIndex, fromIndex, capture()), { pass: true });
  }, [capture, cursor, replace]);
  const swipeRetreatTo = useCallback((wordIndex: number) => {
    replace((p) => swipeRetreat(p, cursor, wordIndex), { pass: true });
  }, [cursor, replace]);
  const swipeComplete = useCallback((lastIndex: number) => {
    tick();
    replace((p) => swipeFinish(p, cursor, lastIndex, capture()).project, { pass: true });
  }, [capture, cursor, replace]);
  const swipeEnd = useCallback(({ completed, moved }: { completed: boolean; moved: boolean }) => {
    // The whole line is synced: save it, and lifting the finger moves to the next line.
    if (completed) { commit(); advanceWords(); return; }
    const before = passStart.current;
    revertToCheckpoint();
    if (moved && before) {
      seekSong(leadInPosition(before, cursor, RETRY_LEAD_IN_MS));
      playSong();
    }
  }, [advanceWords, commit, cursor, revertToCheckpoint]);

  // ---- Output ----
  const lyrics = useMemo(() => (project ? lyricsFromProject(project) : []), [project]);
  const windows = useMemo(() => (project ? rowWindows(project) : []), [project]);
  /**
   * Batch "Apply timing to all similar lines": lines are picked right in the
   * lyrics list. Only word-synced lines with a match can be picked.
   */
  const [batch, setBatch] = useState<{ mode: 'timing' | 'duet'; picked: number[]; include: boolean; anchor: number } | null>(null);
  const batchRef = useRef(batch);
  batchRef.current = batch;
  const batchMode = batch?.mode;
  // Timing: word-synced lines with a match can lend their timing. Duet: any main lyric line.
  const pickable = useMemo(() => new Set(batchMode && project ? project.lines.flatMap((line, i) =>
    (batchMode === 'duet' ? canBeDuet(line) : !line.instrumental && isLineWordSynced(line) && matchingLines(project, i).length) ? [i] : []) : []),
  [batchMode, project]);
  const batchPreview = useMemo(() => batch?.mode === 'timing' && project
    ? { off: applyTimingFromLines(project, batch.picked), on: applyTimingFromLines(project, batch.picked, { includeSynced: true }) } : null, [batch, project]);
  /** Picking: hold a line to pick every line from the last one picked to it (a whole verse in two touches). */
  const openLineMenu = useCallback((index: number) => {
    if (!batch) { setLineMenu(index); return; }
    if (!pickable.has(index)) return;
    const [from, to] = [Math.min(batch.anchor, index), Math.max(batch.anchor, index)];
    setBatch((current) => current && ({ ...current, anchor: index, picked: Array.from(new Set([...current.picked,
      ...[...pickable].filter((i) => i >= from && i <= to)])).sort((a, b) => a - b) }));
  }, [batch, pickable, setBatch]);
  const pressRow = useCallback((index: number) => {
    if (!batch) { goTo(index, true); return; }
    if (!pickable.has(index)) return;
    setBatch((current) => current && ({ ...current, anchor: index, picked: current.picked.includes(index)
      ? current.picked.filter((i) => i !== index) : [...current.picked, index].sort((a, b) => a - b) }));
  }, [batch, goTo, pickable, setBatch]);
  const measureRow = useCallback((index: number, y: number) => {
    rowY.current[index] = y;
    if (pendingScroll.current === index) {
      pendingScroll.current = null;
      requestAnimationFrame(() => listRef.current?.scrollTo({ y: Math.max(0, y - 140), animated: false }));
    }
  }, []);
  const stats = project ? progress(project) : null;

  const saveToVault = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    const output = lyricsFromProject(current);
    if (!output.length) { Alert.alert('Nothing to save yet', 'Sync at least one line first.'); return; }
    const playing = usePlaybackStore.getState().currentTrack;
    const track = { id: current.trackId || `sync-studio:${current.title}:${current.artist}`.toLowerCase(), title: current.title || 'Untitled',
      artist: current.artist, album: current.album, durationMs: current.durationMs ?? 0, spotifyTrackId: current.spotifyTrackId };
    await saveMobileVaultLyrics({ track, lyrics: output, originalSource: 'sync-studio' });
    // What is in the vault is now the version leaving can go back to.
    studio.markSaved();
    // Switch the player to this sync only if Spotify is playing this very song.
    if (playing && spotifyMatch.ok) void refreshLyricsForCurrentTrack('local-vault');
    setNotice(playing && spotifyMatch.ok ? 'Saved to your vault. KineSync now plays your sync for this song.' : 'Saved to your vault.');
  }, [projectRef, spotifyMatch.ok, studio]);

  const exportTtml = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    const output = lyricsFromProject(current);
    if (!output.length) { Alert.alert('Nothing to export yet', 'Sync at least one line first.'); return; }
    const file = new File(Paths.cache, buildDefaultTtmlFilename({ title: current.title || 'lyrics', artist: current.artist }));
    file.create({ overwrite: true });
    file.write(lyricsToTtml({ lyrics: output, title: current.title, artist: current.artist, album: current.album,
      durationMs: current.durationMs, spotifyTrackId: current.spotifyTrackId, preserveOriginal: false }));
    await shareAsync(file.uri, { mimeType: 'application/ttml+xml', UTI: 'public.xml', dialogTitle: 'Export TTML' });
  }, [projectRef]);

  const run = (work: () => Promise<void>) => { void work().catch((error) => Alert.alert('Sync Studio', error instanceof Error ? error.message : String(error))); };

  if (!project) {
    return <View style={styles.screen}><SafeAreaView style={styles.flex}>
      <ScrollView contentContainerStyle={styles.startContent} keyboardShouldPersistTaps="handled">
        <Header title="Sync Studio" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StartPanel drafts={studio.drafts} onOpen={openProject} onDiscardDraft={studio.discardDraft} />
      </ScrollView>
    </SafeAreaView></View>;
  }

  const current = project.lines[cursor];
  const playingRow = lineAtTime(project, position);
  const playingLine = playingRow >= 0 ? project.lines[playingRow] : null;
  const unsynced = project.lines.filter((row) => rowStart(row) == null).length;

  return <View style={styles.screen}><SafeAreaView style={styles.flex} edges={['top', 'bottom', 'left', 'right']}>
    <Header title={project.title || 'Untitled'} subtitle={project.artist} onBack={() => { if (mode === 'preview') backToEdit(); else leaveProject(); }}
      actions={<>
        <IconButton icon="arrow-undo" label="Undo" disabled={!studio.canUndo} onPress={studio.undo} />
        <IconButton icon="arrow-redo" label="Redo" disabled={!studio.canRedo} onPress={studio.redo} />
        <IconButton icon="options-outline" label="Settings" onPress={() => setSettingsOpen(true)} />
      </>} />

    {!match.ok ? <View style={styles.banner}>
      <Ionicons name="alert-circle-outline" size={18} color="#FFD27A" />
      <Text style={styles.bannerText}>{match.playing ? `Spotify is playing “${match.playing}”. Play “${project.title}” to sync along with it.` : `Play “${project.title}” in Spotify to sync along with it.`}</Text>
    </View> : !hasSongControls() ? <View style={styles.banner}>
      <Ionicons name="alert-circle-outline" size={18} color="#FFD27A" />
      <Text style={styles.bannerText}>Playback controls are not connected yet. Open the player once, then come back.</Text>
    </View> : null}

    {mode === 'preview' ? <View style={styles.flex}>
      <View style={styles.preview}>
        {lyricsStyle === 'amll'
          ? <NativeAmllLyricsView overrideLyrics={lyrics} clockAnchor={local?.anchor} tapToSeekEnabled onLinePress={(line) => { seekSong(line.lineStartTime); playSong(); }} />
          : <NativeSpicyLyricsView overrideLyrics={lyrics} clockAnchor={local?.anchor} tapToSeekEnabled onLinePress={(line) => { seekSong(line.lineStartTime); playSong(); }} />}
      </View>
      <View style={styles.dock}>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {unsynced ? <Text style={styles.dockHint}>{unsynced} {unsynced === 1 ? 'line is' : 'lines are'} not synced yet and will be left out.</Text> : null}
        {playingLine && playingRow >= 0 ? <View style={styles.fixBox}>
          <Text style={styles.dockHint} numberOfLines={1}>Now: {playingLine.instrumental ? '♪ Instrumental' : lineText(playingLine)}</Text>
          <View style={styles.row}>
            <Chip label="Line −50" onPress={() => apply((p) => shiftLine(p, playingRow, -50))} />
            <Chip label="Line +50" onPress={() => apply((p) => shiftLine(p, playingRow, 50))} />
            {playingLine.words[0]?.start != null ? <>
              <Chip label="1st word −50" onPress={() => apply((p) => nudgeFirstWord(p, playingRow, -50))} />
              <Chip label="1st word +50" onPress={() => apply((p) => nudgeFirstWord(p, playingRow, 50))} />
            </> : null}
            <Button style={[styles.chip, styles.toggle, playingLine.flagged && styles.chipFlagged]}
              onPress={() => apply((p) => setFlagged(p, playingRow, !playingLine.flagged))}>
              <Ionicons name={playingLine.flagged ? 'flag' : 'flag-outline'} size={13} color={playingLine.flagged ? '#FF8A8A' : Design.text} />
              <Text style={styles.chipText}>{playingLine.flagged ? 'Marked' : 'Mark to fix'}</Text>
            </Button>
          </View>
        </View> : null}
        <View style={styles.row}>
          <Text style={styles.dockLabel}>Everything feels</Text>
          <Chip label="Early · +50 ms" onPress={() => apply((p) => shiftAll(p, 50))} />
          <Chip label="Late · −50 ms" onPress={() => apply((p) => shiftAll(p, -50))} />
        </View>
        <Transport position={position} isPlaying={isPlaying} onReplay={() => goTo(Math.max(0, playingRow), true)} />
        <View style={styles.row}>
          <Button style={[styles.secondary, styles.flex]} onPress={backToEdit}><Ionicons name="create-outline" size={18} color={Design.text} /><Text style={styles.buttonText}>Edit</Text></Button>
          <Button style={[styles.secondary, styles.flex]} onPress={() => run(saveToVault)}><Ionicons name="archive-outline" size={18} color={Design.text} /><Text style={styles.buttonText}>Save</Text></Button>
          <Button style={[styles.primary, styles.flex]} onPress={() => run(exportTtml)}><Ionicons name="share-outline" size={18} color={Design.accentInk} /><Text style={styles.primaryText}>Export</Text></Button>
        </View>
      </View>
    </View> : <View style={styles.flex}>
      <View style={styles.toolbar}>
        <Segmented value={stage} options={[['lines', '1 · Lines'], ['words', '2 · Words']]} onChange={(next) => {
          setStage(next);
          const target = next === 'lines' ? project.lines.findIndex((row) => !row.background && row.start == null) : nextIndexToSync(project, -1, 'words');
          if (target >= 0) moveCursor(target);
        }} />
        {stage === 'words' ? <Segmented value={settings.wordMethod} options={[['tap', 'Tap'], ['swipe', 'Slide']]} onChange={(wordMethod) => studio.updateSettings({ wordMethod })} /> : null}
        {stage === 'words' ? <Button style={[styles.chip, styles.toggle, settings.autoRewind && styles.chipActive]} onPress={() => studio.updateSettings({ autoRewind: !settings.autoRewind })}
          accessibilityRole="switch" accessibilityState={{ checked: settings.autoRewind }}
          accessibilityLabel={settings.autoRewind ? 'Next line: rewind to 0.5 seconds before it' : 'Next line: keep playing'}>
          <Ionicons name={settings.autoRewind ? 'play-skip-back' : 'play-forward'} size={14} color={Design.text} />
          <Text style={styles.chipText}>{settings.autoRewind ? 'Rewind 0.5 s' : 'Keep playing'}</Text>
        </Button> : null}
        <Button style={[styles.chip, styles.toggle]} onPress={() => setLeadInOpen(true)} accessibilityLabel="How early a tapped line starts playing">
          <Ionicons name="timer-outline" size={14} color={Design.text} />
          <Text style={styles.chipText}>Lead-in {(settings.leadInMs / 1000).toFixed(2)} s</Text>
        </Button>
        <Button style={styles.previewButton} onPress={() => { setLocalRate(1); setMode('preview'); }} accessibilityLabel="Preview">
          <Ionicons name="eye-outline" size={18} color={Design.accentInk} /><Text style={styles.previewText}>Preview</Text>
        </Button>
      </View>
      {stats ? <Text style={styles.progress}>{stats.lineTimed}/{stats.lines} lines timed · {stats.wordTimed}/{stats.lines} word-synced{stats.adLibs ? ` · ${stats.adLibs} ad-libs` : ''}{stats.instrumentals ? ` · ${stats.instrumentals} instrumental` : ''}</Text> : null}

      <ScrollView ref={listRef} style={styles.flex} contentContainerStyle={styles.list}>
        {project.lines.map((row, index) => {
          const window = windows[index];
          // Only rows being sung get the live position, so the rest skip re-rendering.
          const live = window && position >= window.start && position < window.end ? position : null;
          return <StudioRow key={row.id} row={row} index={index} active={!batch && index === cursor} live={live}
            pick={batch ? pickable.has(index) ? batch.picked.includes(index) ? 'picked' : 'open' : 'off' : undefined}
            onPress={pressRow} onLongPress={openLineMenu} onMeasure={measureRow} />;
        })}
        <Text style={styles.listHint}>Tap a line to jump there. Hold a line to edit it, make it an ad-lib or add one.</Text>
      </ScrollView>

      {batch?.mode === 'duet' ? <View style={styles.dock}>
        <Text style={styles.sheetTitle}>{batch.picked.length} {batch.picked.length === 1 ? 'line' : 'lines'} picked</Text>
        <Text style={styles.dockHint}>Tap lines to pick them; hold a line to pick every line from the last one picked to it. Ad-libs follow their line.</Text>
        <View style={styles.row}>
          <Button style={[styles.secondary, styles.slim]} onPress={() => setBatch(null)}><Text style={styles.buttonText}>Cancel</Text></Button>
          <Button style={[styles.secondary, styles.slim, styles.flex, !batch.picked.length && styles.disabled]} disabled={!batch.picked.length}
            onPress={() => { apply((p) => setDuet(p, batch.picked, false)); setBatch(null); setNotice('Back to the main singer.'); }}>
            <Ionicons name="person-outline" size={16} color={Design.text} /><Text style={styles.buttonText}>Main singer</Text>
          </Button>
          <Button style={[styles.primary, styles.slim, styles.flex, !batch.picked.length && styles.disabled]} disabled={!batch.picked.length}
            onPress={() => { apply((p) => setDuet(p, batch.picked, true)); setBatch(null); setNotice('Marked as duet: the other singer.'); }}>
            <Ionicons name="people" size={16} color={Design.accentInk} /><Text style={styles.primaryText}>Duet</Text>
          </Button>
        </View>
      </View> : batch && batchPreview ? <View style={styles.dock}>
        <Text style={styles.sheetTitle}>Copy timing from {batch.picked.length} {batch.picked.length === 1 ? 'line' : 'lines'}</Text>
        <Text style={styles.dockHint}>Tap synced lines above to pick them (hold one to pick a run). Each copies its rhythm to the lines with exactly its words: main lines to main lines, ad-libs to ad-libs.</Text>
        <Pressable onPress={() => setBatch((current) => current && ({ ...current, include: !current.include }))} style={styles.checkRow}
          accessibilityRole="checkbox" accessibilityState={{ checked: batch.include }}>
          <Ionicons name={batch.include ? 'checkbox' : 'square-outline'} size={22} color={batch.include ? Design.accent : Design.muted} />
          <Text style={[styles.buttonText, styles.flex]}>Include lines that are already synced{batchPreview.off.keptSynced ? ` (${batchPreview.off.keptSynced})` : ''}</Text>
        </Pressable>
        {(() => {
          const result = batch.include ? batchPreview.on : batchPreview.off;
          return <>
            <Text style={styles.dockHint}>{result.applied ? `${result.applied} ${result.applied === 1 ? 'line' : 'lines'} will change.` : 'Nothing to change yet.'}
              {batchPreview.off.skipped ? ` ${batchPreview.off.skipped} with no start yet will be skipped.` : ''}</Text>
            <View style={styles.row}>
              <Button style={[styles.secondary, styles.slim, styles.flex]} onPress={() => setBatch(null)}><Text style={styles.buttonText}>Cancel</Text></Button>
              <Button style={[styles.primary, styles.slim, styles.flex, !result.applied && styles.disabled]} disabled={!result.applied}
                onPress={() => {
                  let applied = 0;
                  apply((p) => { const out = applyTimingFromLines(p, batch.picked, { includeSynced: batch.include }); applied = out.applied; return out.project; });
                  setBatch(null);
                  setNotice(`Timing applied to ${applied} ${applied === 1 ? 'line' : 'lines'}.`);
                }}><Text style={styles.primaryText}>Apply</Text></Button>
            </View>
          </>;
        })()}
      </View> : <View style={styles.dock}>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <Transport position={position} isPlaying={isPlaying} onReplay={() => goTo(cursor, true)} />
        {local || tapKeys ? <View style={styles.row}>
          {local ? <>
            <Ionicons name="musical-note" size={14} color={Design.muted} />
            <Text style={[styles.dockLabel, styles.flex]} numberOfLines={1}>{local.name}</Text>
          </> : <View style={styles.flex} />}
          {tapKeys ? <Button style={[styles.chip, styles.speedChip, settings.lastCommitEnds && styles.chipActive]}
            onPress={() => studio.updateSettings({ lastCommitEnds: !settings.lastCommitEnds })}
            accessibilityRole="switch" accessibilityState={{ checked: settings.lastCommitEnds }}
            accessibilityLabel={settings.lastCommitEnds ? 'Commit on the last word ends the line' : 'Commit on the last word carries into the next line'}>
            <Ionicons name={settings.lastCommitEnds ? 'stop-circle-outline' : 'return-down-forward'} size={14} color={Design.text} />
            <Text style={styles.chipText}>Last G: {settings.lastCommitEnds ? 'End' : 'Carry'}</Text>
          </Button> : null}
          {local ? <Button style={[styles.chip, styles.speedChip, speedOpen && styles.chipActive]} onPress={() => setSpeedOpen((open) => !open)}
            accessibilityRole="button" accessibilityState={{ expanded: speedOpen }} accessibilityLabel={`Speed ${local.rate.toFixed(2)} times. ${speedOpen ? 'Hide' : 'Show'} the speed slider`}>
            <Ionicons name="speedometer-outline" size={14} color={Design.text} />
            <Text style={styles.chipText}>{local.rate.toFixed(2)}×</Text>
            <Ionicons name={speedOpen ? 'chevron-down' : 'chevron-up'} size={13} color={Design.muted} />
          </Button> : null}
        </View> : null}
        {local && speedOpen ? <RateSlider value={local.rate} onChange={setLocalRate} /> : null}
        {stage === 'lines' ? <>
          <Pressable onPressIn={tapLineStart} disabled={!current || current.background}
            style={({ pressed }) => [styles.bigPad, pressed && styles.bigPadPressed]} accessibilityRole="button"
            accessibilityLabel={current?.instrumental ? 'Tap when the instrumental starts' : 'Tap when this line starts'}>
            <Text style={styles.padLabel}>{current?.instrumental ? 'TAP WHEN THE INSTRUMENTAL STARTS' : 'TAP WHEN THIS LINE STARTS'}</Text>
            <Text style={styles.padLine} numberOfLines={2}>{!current || current.background ? 'Choose a main line' : current.instrumental ? '♪  Instrumental' : lineText(current)}</Text>
          </Pressable>
          <View style={styles.row}>
            <Button style={[styles.secondary, styles.flex]} onPress={tapPause}><Ionicons name="pause-outline" size={18} color={Design.text} /><Text style={styles.buttonText}>Singing stops</Text></Button>
            <Button style={[styles.secondary, styles.flex]} onPress={() => { setStage('words'); const target = nextIndexToSync(project, -1, 'words'); if (target >= 0) goTo(target, true); }}>
              <Ionicons name="arrow-forward" size={18} color={Design.text} /><Text style={styles.buttonText}>Sync words</Text>
            </Button>
          </View>
        </> : current?.instrumental ? <>
          <Pressable onPressIn={tapInstrumental} style={({ pressed }) => [styles.bigPad, pressed && styles.bigPadPressed]}
            accessibilityRole="button" accessibilityLabel="Tap when the instrumental starts">
            <Text style={styles.padLabel}>TAP WHEN THE INSTRUMENTAL STARTS</Text>
            <Text style={styles.padLine}>♪  Instrumental</Text>
            <Text style={styles.dockHint}>{current.start != null ? `Starts at ${formatTime(current.start)}. Tap to move it. ` : ''}The line before ends here, which shows the “…” in the player.</Text>
          </Pressable>
          <Button style={styles.secondary} onPress={() => advanceWords()}><Ionicons name="arrow-forward" size={18} color={Design.text} /><Text style={styles.buttonText}>Keep it, next line</Text></Button>
        </> : current ? <>
          <WordPad line={current} method={settings.wordMethod} onStart={tapStartKey} onCommit={tapCommitKey} onEnd={tapEndKey}
            focus={focus} onPickUnit={pickUnit}
            onSwipeBegin={swipeBegin} onSwipeEnter={swipeEnter} onSwipeComplete={swipeComplete} onSwipeRetreat={swipeRetreatTo} onSwipeEnd={swipeEnd} />
          <View style={styles.row}>
            {settings.wordMethod === 'tap' ? <Button style={[styles.secondary, styles.slim, styles.flex]} onPress={restartTapLine} accessibilityLabel="Restart this line">
              <Ionicons name="refresh" size={18} color={Design.text} /><Text style={styles.buttonText}>Restart line</Text>
            </Button> : null}
            <Button style={[styles.secondary, styles.slim, styles.flex]} onPress={() => setSyllables(cursor)} accessibilityLabel="Split words of this line into syllables">
              <Ionicons name="cut-outline" size={18} color={Design.text} /><Text style={styles.buttonText}>Syllables</Text>
            </Button>
          </View>
        </> : null}
      </View>}
    </View>}

    <LineMenu index={lineMenu} project={project} stage={stage} onClose={() => setLineMenu(null)} apply={apply}
      onLineTiming={(index) => setLineTimer(index)}
      onPickDuet={(index) => setBatch({ mode: 'duet', picked: [index], include: false, anchor: index })}
      onSyllables={(index) => setSyllables(index)}
      onEditText={(index) => setTextEdit({ index, value: lineText(project.lines[index]) })}
      onInsert={(index, insert) => setTextEdit({ index, value: '', insert })}
      onPickAdLib={(index) => setAdLibPicker(index)}
      onWordTimes={(index) => setWordTimer(index)}
      onApplySimilar={(index) => openSimilar(index, 'timing')}
      onClear={(index) => { apply((p) => clearLineWords(p, index)); goTo(index, true); setStage('words'); }} />
    <LeadInModal open={leadInOpen} value={settings.leadInMs} onClose={() => setLeadInOpen(false)}
      onChange={(leadInMs) => studio.updateSettings({ leadInMs })} />
    <WordTimingModal index={wordTimer} project={project} apply={apply} onClose={() => setWordTimer(null)} />
    <SyllableModal index={syllables} project={project} apply={apply} onClose={() => setSyllables(null)}
      onSplitSimilar={(index) => { setSyllables(null); openSimilar(index, 'splits'); }}
      language={settings.syllableLanguage} onLanguage={(syllableLanguage) => studio.updateSettings({ syllableLanguage })}
      onGuessSong={() => {
        const language = settings.syllableLanguage;
        const name = syllableLanguageLabel(language).split(' · ')[0];
        Alert.alert(`Guess ${name} syllables for the whole song?`,
          `Every ${name} word that is not split yet gets a guessed split; words in other languages or scripts are left alone. Words you already split stay as they are. Undo takes it all back.`,
          [{ text: 'Cancel', style: 'cancel' }, { text: 'Guess', onPress: () => {
            let words = 0;
            apply((p) => { const out = guessSongSyllables(p, language); words = out.words; return out.project; });
            setNotice(words ? `Split ${words} ${words === 1 ? 'word' : 'words'} into syllables. Fix any in the Syllables menu.` : `No ${name} words to split.`);
          } }]);
      }} />
    <LineTimingModal index={lineTimer} project={project} apply={apply} onClose={() => setLineTimer(null)} />
    <SimilarLinesModal request={similar} project={project} onClose={() => setSimilar(null)}
      onPickInList={(index) => { setSimilar(null); setBatch({ mode: 'timing', picked: [index], include: false, anchor: index }); }}
      onConfirm={({ index, kind }, include) => {
      let applied = 0;
      let skipped = 0;
      apply((p) => {
        const out = kind === 'timing' ? applyTimingToMatchingLines(p, index, { includeSynced: include })
          : copySplitsToMatchingLines(p, index, { includeDifferent: include });
        applied = out.applied;
        skipped = 'skipped' in out ? out.skipped : 0;
        return out.project;
      });
      setSimilar(null);
      const lines = `${applied} ${applied === 1 ? 'line' : 'lines'}`;
      setNotice(kind === 'timing' ? `Timing applied to ${lines}${skipped ? `; ${skipped} with no start yet skipped` : ''}.` : `Split ${lines} like this one.`);
    }} />
    <AdLibPicker index={adLibPicker} project={project} onClose={() => setAdLibPicker(null)}
      onConfirm={(index, from, to) => { apply((p) => extractAdLib(p, index, from, to)); setAdLibPicker(null); setNotice('Moved to an ad-lib below the line. Timing kept.'); }} />
    <TextEditModal edit={textEdit} onClose={() => setTextEdit(null)} onSave={(value) => {
      if (!textEdit) return;
      if (textEdit.insert) apply((p) => insertLineAfter(p, textEdit.index, value, textEdit.insert === 'adlib'));
      else apply((p) => setLineText(p, textEdit.index, value));
      setTextEdit(null);
    }} />
    <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} project={project} settings={settings}
      onSettings={studio.updateSettings} onProject={(patch) => replace((p) => ({ ...p, ...patch }))}
      onShift={(delta) => apply((p) => shiftAll(p, delta))} localName={local?.name ?? null}
      onPickAudio={() => run(async () => {
        const picked = await File.pickFileAsync({ mimeTypes: ['audio/*'] });
        if (picked.canceled) return;
        openLocalAudio(picked.result.uri, picked.result.name);
        setNotice('Playing your audio file. Taps now use its exact position.');
      })} onUseSpotify={() => closeLocalAudio()} />
  </SafeAreaView></View>;
}

/**
 * One row in the editor list. While its line is being sung it gets the live
 * position and lights each word (main lines and ad-libs) as it is sung.
 */
const StudioRow = memo(function StudioRow({ row, index, active, live, pick, onPress, onLongPress, onMeasure }: {
  row: StudioLine; index: number; active: boolean; live: number | null;
  /** Picking lines for a batch timing copy: 'picked', 'open' (can be picked) or 'off' (cannot). */
  pick?: 'picked' | 'open' | 'off';
  onPress: (index: number) => void; onLongPress: (index: number) => void; onMeasure: (index: number, y: number) => void;
}) {
  const synced = isLineWordSynced(row);
  const start = rowStart(row);
  const wordTimed = row.words.some((word) => word.start != null);
  const textStyle = [styles.rowText, row.background && styles.rowTextAdLib, row.instrumental && styles.rowInstrumental,
    live != null && (!wordTimed || row.instrumental) && styles.rowPlaying];
  return <Pressable onLayout={(event) => onMeasure(index, event.nativeEvent.layout.y)}
    onPress={() => onPress(index)} onLongPress={() => onLongPress(index)} delayLongPress={350}
    style={[styles.rowItem, row.background && styles.rowAdLib, active && styles.rowActive, row.flagged && styles.rowFlagged,
      pick === 'picked' && styles.rowActive, pick === 'off' && styles.rowUnpickable]}
    accessibilityState={pick ? { checked: pick === 'picked', disabled: pick === 'off' } : undefined}>
    <View style={[styles.rowMain, row.oppositeAligned && styles.rowDuet]}>
      {row.instrumental ? <Text style={textStyle}>♪  Instrumental  · · ·</Text>
        : <Text style={textStyle}>
          {row.background ? '(' : ''}
          {row.words.map((word, i) => {
            const sung = live != null && word.start != null && word.start <= live;
            const now = sung && (word.end == null ? true : live! < word.end);
            return <Text key={i}><Text style={sung ? (now ? styles.wordNow : styles.wordSung) : undefined}>{word.text.trimEnd()}</Text>{unitSeparator(row, i)}</Text>;
          })}
          {row.background ? ')' : ''}
        </Text>}
      <Text style={styles.rowTime}>{row.oppositeAligned ? 'DUET  ·  ' : ''}{formatTime(start)}{row.end != null ? ` → ${formatTime(row.end)}` : ''}{row.flagged ? '  ·  marked to fix' : ''}</Text>
    </View>
    {pick && pick !== 'off' ? <Ionicons name={pick === 'picked' ? 'checkbox' : 'square-outline'} size={20} color={pick === 'picked' ? Design.accent : Design.muted} />
      : <Ionicons name={row.flagged ? 'flag' : synced ? 'checkmark-circle' : start != null ? 'time-outline' : 'ellipse-outline'} size={18}
        color={row.flagged ? '#FF8A8A' : synced ? Design.accent : start != null ? Design.muted : 'rgba(255,255,255,0.25)'} />}
  </Pressable>;
});

const RATE_MIN = 0.25;
const RATE_MAX = 1.5;
const RATE_STEP = 0.05;

/** Local file speed, 0.25×–1.5× in 0.05 steps; tap 1× to go back to normal. */
function RateSlider({ value, onChange }: { value: number; onChange: (rate: number) => void }) {
  const width = useRef(0);
  const pick = (x: number) => {
    const fraction = Math.max(0, Math.min(1, x / Math.max(1, width.current)));
    const rate = Math.round((RATE_MIN + fraction * (RATE_MAX - RATE_MIN)) / RATE_STEP) * RATE_STEP;
    const next = Number(Math.max(RATE_MIN, Math.min(RATE_MAX, rate)).toFixed(2));
    if (next !== value) onChange(next);
  };
  const fraction = (value - RATE_MIN) / (RATE_MAX - RATE_MIN);
  return <View style={styles.row}>
    <Text style={[styles.dockLabel, styles.rateValue]}>{value.toFixed(2)}×</Text>
    <View style={[styles.slider, styles.flex]} onLayout={(event) => { width.current = event.nativeEvent.layout.width; }}
      onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderTerminationRequest={() => false}
      onResponderGrant={(event) => pick(event.nativeEvent.locationX)} onResponderMove={(event) => pick(event.nativeEvent.locationX)}
      accessibilityRole="adjustable" accessibilityLabel={`Speed ${value.toFixed(2)} times`}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => onChange(Number(Math.max(RATE_MIN, Math.min(RATE_MAX,
        value + (event.nativeEvent.actionName === 'increment' ? RATE_STEP : -RATE_STEP))).toFixed(2)))}>
      <View pointerEvents="none" style={styles.sliderTrack} />
      <View pointerEvents="none" style={[styles.sliderFill, { width: `${fraction * 100}%` }]} />
      <View pointerEvents="none" style={[styles.sliderThumb, { left: `${fraction * 100}%` }]} />
    </View>
    <Button style={[styles.chip, value === 1 && styles.chipActive]} onPress={() => onChange(1)} accessibilityLabel="Normal speed">
      <Text style={styles.chipText}>1×</Text>
    </Button>
  </View>;
}

const LEAD_IN_MAX_MS = 2000;
const LEAD_IN_STEP_MS = 250;

/** How far before a line it starts playing when you tap it: 0–2 s in 0.25 s steps. */
function LeadInModal({ open, value, onClose, onChange }: { open: boolean; value: number; onClose: () => void; onChange: (value: number) => void }) {
  const width = useRef(0);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (open) setDraft(value); }, [open, value]);
  const steps = LEAD_IN_MAX_MS / LEAD_IN_STEP_MS;
  const pick = useCallback((x: number) => {
    const next = Math.round(Math.max(0, Math.min(1, x / Math.max(1, width.current))) * steps) * LEAD_IN_STEP_MS;
    setDraft(next);
    onChange(next);
  }, [onChange, steps]);
  const fraction = draft / LEAD_IN_MAX_MS;
  return <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.sheet}>
        <Text style={styles.sheetTitle}>Lead-in: {(draft / 1000).toFixed(2)} s</Text>
        <Text style={styles.dockHint}>When you tap a line, it starts playing this long before the line, so you can check how it starts or get ready to sync it.</Text>
        {/* React Native's own touch responder: gesture-handler gestures get no touches inside a Modal on Android. */}
        <View style={styles.slider} onLayout={(event) => { width.current = event.nativeEvent.layout.width; }}
          onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={(event) => pick(event.nativeEvent.locationX)}
          onResponderMove={(event) => pick(event.nativeEvent.locationX)}
          accessibilityRole="adjustable" accessibilityValue={{ min: 0, max: LEAD_IN_MAX_MS, now: draft }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => {
            const next = Math.max(0, Math.min(LEAD_IN_MAX_MS, draft + (event.nativeEvent.actionName === 'increment' ? 1 : -1) * LEAD_IN_STEP_MS));
            setDraft(next); onChange(next);
          }}>
            <View pointerEvents="none" style={styles.sliderTrack} />
            <View pointerEvents="none" style={[styles.sliderFill, { width: `${fraction * 100}%` }]} />
            {Array.from({ length: steps + 1 }, (_, i) => <View key={i} pointerEvents="none"
              style={[styles.sliderTick, { left: `${(i / steps) * 100}%` }, i / steps <= fraction && styles.sliderTickLit]} />)}
            <View pointerEvents="none" style={[styles.sliderThumb, { left: `${fraction * 100}%` }]} />
        </View>
        <View style={styles.sliderLabels}>
          {['0 s', '0.5 s', '1 s', '1.5 s', '2 s'].map((label) => <Text key={label} style={styles.sliderLabel}>{label}</Text>)}
        </View>
        <Button style={styles.primary} onPress={onClose}><Text style={styles.primaryText}>Done</Text></Button>
      </Pressable>
    </Pressable>
  </Modal>;
}

function Header({ title, subtitle, onBack, actions }: { title: string; subtitle?: string; onBack: () => void; actions?: React.ReactNode }) {
  return <View style={styles.header}>
    <Button accessibilityLabel="Back" hitSlop={10} onPress={onBack} style={styles.iconButton}><Ionicons name="chevron-back" size={22} color={Design.text} /></Button>
    <View style={styles.headerCopy}>
      <Text style={styles.heading} numberOfLines={1}>{title}</Text>
      {subtitle ? <Text style={styles.subheading} numberOfLines={1}>{subtitle}</Text> : null}
    </View>
    {actions}
  </View>;
}

function IconButton({ icon, label, onPress, disabled }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; disabled?: boolean }) {
  return <Button accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[styles.iconButton, disabled && styles.disabled]}>
    <Ionicons name={icon} size={20} color={Design.text} />
  </Button>;
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return <View style={styles.segmented}>
    {options.map(([key, label]) => <Pressable key={key} onPress={() => onChange(key)} style={[styles.segment, value === key && styles.segmentActive]}
      accessibilityRole="tab" accessibilityState={{ selected: value === key }}>
      <Text style={[styles.segmentText, value === key && styles.segmentTextActive]}>{label}</Text>
    </Pressable>)}
  </View>;
}

function Chip({ label, onPress }: { label: string; onPress: () => void }) {
  return <Button style={styles.chip} onPress={onPress}><Text style={styles.chipText}>{label}</Text></Button>;
}

function Transport({ position, isPlaying, onReplay }: { position: number; isPlaying: boolean; onReplay: () => void }) {
  return <View style={styles.transport}>
    <Text style={styles.clock}>{formatTime(position)}</Text>
    <View style={styles.row}>
      <IconButton icon="play-skip-back-outline" label="Replay this line" onPress={onReplay} />
      <IconButton icon="play-back-outline" label="Back 5 seconds" onPress={() => seekSong(songPositionMs() - 5000)} />
      <Button accessibilityLabel={isPlaying ? 'Pause' : 'Play'} onPress={toggleSong} style={styles.playButton}>
        <Ionicons name={isPlaying ? 'pause' : 'play'} size={24} color={Design.accentInk} />
      </Button>
      <IconButton icon="play-forward-outline" label="Forward 5 seconds" onPress={() => seekSong(songPositionMs() + 5000)} />
    </View>
  </View>;
}

function LineMenu({ index, project, stage, onClose, apply, onEditText, onInsert, onClear, onPickAdLib, onWordTimes, onLineTiming, onSyllables, onApplySimilar, onPickDuet }: {
  index: number | null; project: StudioProject; stage: StudioStage; onClose: () => void; onLineTiming: (index: number) => void;
  onSyllables: (index: number) => void; apply: (edit: (p: StudioProject) => StudioProject) => unknown;
  onEditText: (index: number) => void; onInsert: (index: number, kind: 'line' | 'adlib') => void; onClear: (index: number) => void;
  onPickAdLib: (index: number) => void; onWordTimes: (index: number) => void; onApplySimilar: (index: number) => void;
  /** Mark several lines as duet at once, picked in the lyrics list. */
  onPickDuet: (index: number) => void;
}) {
  const instrumental = index != null && Boolean(project.lines[index]?.instrumental);
  const row = index != null ? project.lines[index] : null;
  const act = (work: () => void) => () => { onClose(); work(); };
  /** "Add below…" opens its three choices in place. */
  const [adding, setAdding] = useState(false);
  useEffect(() => { setAdding(false); }, [index]);
  return <Modal visible={row != null} transparent animationType="fade" onRequestClose={onClose}>
    <Pressable style={styles.backdrop} onPress={onClose}>
      {row && index != null ? <Pressable style={styles.sheet}>
        <Text style={styles.sheetTitle} numberOfLines={2}>{instrumental ? '♪ Instrumental' : lineText(row)}</Text>
        <View style={styles.row}>
          <Chip label="Line −50 ms" onPress={() => apply((p) => shiftLine(p, index, -50))} />
          <Chip label="Line +50 ms" onPress={() => apply((p) => shiftLine(p, index, 50))} />
        </View>
        <MenuItem icon="create-outline" label={instrumental ? 'Turn into a lyric line' : 'Edit text'} onPress={act(() => onEditText(index))} />
        {canBeDuet(row) ? <MenuItem icon={row.oppositeAligned ? 'person-outline' : 'people-outline'}
          label={row.oppositeAligned ? 'Back to the main singer' : 'Duet: sung by the other singer'}
          onPress={act(() => apply((p) => setDuet(p, [index], !row.oppositeAligned)))} /> : null}
        {canBeDuet(row) ? <MenuItem icon="list-outline" label="Mark several lines as duet…" onPress={act(() => onPickDuet(index))} /> : null}
        {instrumental ? null : <MenuItem icon={row.background ? 'person-outline' : 'chatbubble-ellipses-outline'} label={row.background ? 'Make it a main line' : 'Make it an ad-lib (small, background)'}
          onPress={act(() => apply((p) => setBackground(p, index, !row.background)))} />}
        {stage === 'lines'
          ? <MenuItem icon="time-outline" label="Adjust timing" onPress={act(() => onLineTiming(index))} />
          : !instrumental && row.words.length ? <MenuItem icon="time-outline" label="Adjust words (timing, spelling)" onPress={act(() => onWordTimes(index))} /> : null}
        {!instrumental && row.words.length ? <MenuItem icon="cut-outline" label="Split syllables" onPress={act(() => onSyllables(index))} /> : null}
        {!instrumental && isLineWordSynced(row) ? <MenuItem icon="copy-outline" label="Apply timing to all similar lines" onPress={act(() => onApplySimilar(index))} /> : null}
        {!instrumental && !row.background && row.words.length > 1
          ? <MenuItem icon="cut-outline" label="Turn some words into an ad-lib" onPress={act(() => onPickAdLib(index))} /> : null}
        <MenuItem icon={adding ? 'remove-outline' : 'add-outline'} label="Add a line, ad-lib or instrumental below" onPress={() => setAdding((open) => !open)} />
        {adding ? <View style={styles.subMenu}>
          <MenuItem icon="reorder-two-outline" label="Line" onPress={act(() => onInsert(index, 'line'))} />
          <MenuItem icon="chatbubble-outline" label="Ad-lib" onPress={act(() => onInsert(index, 'adlib'))} />
          <MenuItem icon="musical-notes-outline" label="Instrumental break" onPress={act(() => apply((p) => insertInstrumentalAfter(p, index)))} />
        </View> : null}
        {row.flagged ? <MenuItem icon="flag-outline" label="Clear the fix mark" onPress={act(() => apply((p) => setFlagged(p, index, false)))} /> : null}
        {instrumental ? null : <MenuItem icon="refresh-outline" label="Redo this line's words" onPress={act(() => onClear(index))} />}
        <MenuItem icon="trash-outline" label="Delete line" danger onPress={act(() => apply((p) => deleteLine(p, index)))} />
      </Pressable> : null}
    </Pressable>
  </Modal>;
}

const WORD_NUDGE_MS = 250;
/** The Adjust words link toggle, remembered between words and lines while the app is open. */
let wordTimingLinked = false;
const WORD_FINE_NUDGE_MS = 100;

/** One time: −0.25 s, the time (tap it to type a value), +0.25 s. */
function TimeField({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  const [typing, setTyping] = useState<string | null>(null);
  const commit = () => {
    if (typing == null) return;
    const parsed = parseTimeInput(typing);
    setTyping(null);
    if (parsed != null) onChange(parsed);
  };
  return <View style={styles.timeField}>
    <Text style={styles.timeLabel}>{label}</Text>
    <View style={styles.timeRow}>
      <NudgeChips value={value} steps={[-WORD_NUDGE_MS, -WORD_FINE_NUDGE_MS]} onChange={onChange} />
      {typing != null
        ? <TextInput autoFocus value={typing} onChangeText={setTyping} onSubmitEditing={commit} onBlur={commit}
            keyboardType="numbers-and-punctuation" returnKeyType="done" selectTextOnFocus
            style={[styles.input, styles.timeInput]} placeholder="1:23.45" placeholderTextColor={Design.muted} />
        : <Pressable onPress={() => setTyping(value != null ? formatTime(value) : '')} style={styles.timeValue}
            accessibilityRole="button" accessibilityLabel={`${label} ${formatTime(value)}, tap to type a time`}>
            <Text style={styles.timeValueText}>{formatTime(value)}</Text>
          </Pressable>}
      <NudgeChips value={value} steps={[WORD_FINE_NUDGE_MS, WORD_NUDGE_MS]} onChange={onChange} />
    </View>
  </View>;
}

const nudgeLabel = (ms: number) => `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(2)}`;

function NudgeChips({ value, steps, onChange }: { value: number | null; steps: number[]; onChange: (value: number) => void }) {
  return <>{steps.map((step) => <Button key={step} style={[styles.chip, styles.nudgeChip, value == null && styles.disabled]} disabled={value == null}
    accessibilityLabel={`${step < 0 ? 'Earlier' : 'Later'} by ${Math.abs(step) / 1000} seconds`}
    onPress={() => value != null && onChange(Math.max(0, value + step))}><Text style={styles.chipText}>{nudgeLabel(step)}</Text></Button>)}</>;
}

/** Fix one word's spelling; saved when you press done on the keyboard or leave the field. */
/** Fix one word's spelling: saved on Enter, on leaving the field, or with the sheet's Done (via `onDraft`). */
function SpellingField({ value, onChange, onDraft }: { value: string; onChange: (value: string) => void; onDraft: (value: string) => void }) {
  const [text, setText] = useState(value);
  const commit = () => { if (text.trim()) onChange(text); else setText(value); };
  return <View style={styles.timeField}>
    <Text style={styles.timeLabel}>Word</Text>
    <TextInput value={text} onChangeText={(next) => { setText(next); onDraft(next); }} onSubmitEditing={commit} onBlur={commit} returnKeyType="done"
      autoCapitalize="none" autoCorrect={false} style={styles.input} accessibilityLabel="Word spelling" />
  </View>;
}

/** Hold a line → "Adjust word timings": pick a word, then nudge or type its start and end. */
function WordTimingModal({ index, project, apply, onClose }: {
  index: number | null; project: StudioProject; apply: (edit: (p: StudioProject) => StudioProject) => unknown; onClose: () => void;
}) {
  const row = index != null ? project.lines[index] : null;
  const [selected, setSelected] = useState<number[]>([0]);
  const [several, setSeveral] = useState(false);
  /** Linked: moving a start moves the end by the same amount, and the other way round. Kept while the app is open. */
  const [linked, setLinked] = useState(wordTimingLinked);
  useEffect(() => { setSelected([0]); setSeveral(false); }, [index]);
  /** A typed spelling not saved yet, the question being asked, and whether to close once it is answered. */
  const draft = useRef<{ unit: number; text: string } | null>(null);
  const asking = useRef<string | null>(null);
  const closeAfter = useRef(false);
  if (!row || index == null) return null;
  const finish = () => {
    asking.current = null;
    if (closeAfter.current) { closeAfter.current = false; onClose(); }
  };
  /**
   * Save a spelling fix. When the same line appears elsewhere, ask whether to
   * fix it there too (the same word in each, timing kept).
   */
  const saveSpelling = (unit: number, text: string) => {
    const current = row.words[unit];
    const clean = text.replace(/\s+/g, ' ').trim();
    draft.current = null;
    if (!current || !clean || clean === current.text.trim()) { if (!asking.current) finish(); return; }
    const key = `${unit}:${clean}`;
    if (asking.current === key) return;
    const others = sameTextLines(project, index);
    if (!others.length) { apply((p) => setWordTextEverywhere(p, index, unit, clean)); finish(); return; }
    asking.current = key;
    Alert.alert('Fix it in the matching lines too?',
      `“${current.text.trim()}” → “${clean}”. This line appears ${others.length} more ${others.length === 1 ? 'time' : 'times'}.`,
      [{ text: 'Only this line', onPress: () => { apply((p) => setWordTextEverywhere(p, index, unit, clean)); finish(); } },
        { text: `All ${others.length + 1} lines`, onPress: () => { apply((p) => setWordTextEverywhere(p, index, unit, clean, others)); finish(); } }],
      { cancelable: false });
  };
  /** Done, back or tapping outside: save a spelling still being typed first. */
  const done = () => {
    closeAfter.current = true;
    if (asking.current) return;
    const pending = draft.current;
    if (pending) saveSpelling(pending.unit, pending.text); else finish();
  };
  const picked = selected.filter((i) => i < row.words.length);
  const wordIndex = picked[0] ?? 0;
  const word = row.words[wordIndex];
  const choose = (i: number) => {
    // Picking another word saves a spelling still being typed.
    if (draft.current) saveSpelling(draft.current.unit, draft.current.text);
    pickUnit(i);
  };
  const pickUnit = (i: number) => setSelected((current) => !several ? [i]
    : current.includes(i) ? (current.length > 1 ? current.filter((x) => x !== i) : current) : [...current, i].sort((a, b) => a - b));
  const earliest = picked.map((i) => row.words[i].start).filter((v): v is number => v != null).sort((a, b) => a - b)[0] ?? null;
  // Hear exactly the picked words: an open end runs to the next word's start, or the line's end.
  const endOf = (i: number) => row.words[i].end ?? row.words[i + 1]?.start ?? row.end ?? (row.words[i].start ?? 0) + 1000;
  const latest = picked.filter((i) => row.words[i].start != null).map(endOf).sort((a, b) => b - a)[0] ?? null;
  return <Modal visible transparent animationType="fade" onRequestClose={done}>
    <KeyboardAvoidingView style={[styles.backdrop, styles.backdropTop]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Pressable style={StyleSheet.absoluteFill} onPress={done} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <Text style={[styles.sheetTitle, styles.flex]}>Adjust words</Text>
          <Button style={[styles.chip, several && styles.chipActive]} onPress={() => { setSeveral(!several); if (several) setSelected([wordIndex]); }}
            accessibilityRole="switch" accessibilityState={{ checked: several }}>
            <Text style={styles.chipText}>{several ? 'Selecting several' : 'Select several'}</Text>
          </Button>
          <Button style={[styles.chip, styles.linkChip, linked && styles.chipActive]} onPress={() => { wordTimingLinked = !linked; setLinked(!linked); }}
            accessibilityRole="switch" accessibilityState={{ checked: linked }}
            accessibilityLabel={linked ? 'Start and end move together' : 'Start and end move separately'}>
            <Ionicons name={linked ? 'link' : 'unlink-outline'} size={16} color={Design.text} />
          </Button>
        </View>
        <View style={styles.pickWords}>
          {/* One pill per word; a split word shows its syllables inside it, each still picked on its own. */}
          {wordGroups(row).map((group) => <View key={group.from} style={[styles.pickWord, styles.wordPill]}>
            {row.words.slice(group.from, group.to + 1).map((entry, k) => {
              const i = group.from + k;
              return <View key={i} style={styles.syllableCell}>
                {k > 0 ? <Text style={styles.syllableDot}>·</Text> : null}
                <Pressable onPress={() => choose(i)} hitSlop={4}
                  style={[styles.syllablePick, picked.includes(i) && styles.pickWordSelected]} accessibilityRole="button"
                  accessibilityLabel={group.to > group.from ? `${entry.text.trim()}, syllable ${k + 1} of ${lineText({ words: row.words.slice(group.from, group.to + 1) })}` : entry.text.trim()}
                  accessibilityState={{ selected: picked.includes(i) }}>
                  <Text style={[styles.pickWordText, picked.includes(i) && styles.pickWordTextSelected, entry.start == null && styles.untimedWord]}>{entry.text.trim()}</Text>
                </Pressable>
              </View>;
            })}
          </View>)}
        </View>
        {picked.length > 1 ? linked ? <>
          <Text style={styles.timeLabel}>{picked.length} words selected: move them together</Text>
          <View style={styles.timeRow}>
            {[-WORD_NUDGE_MS, -WORD_FINE_NUDGE_MS, WORD_FINE_NUDGE_MS, WORD_NUDGE_MS].map((step) => <Button key={step} style={[styles.chip, styles.nudgeChip, styles.flex]}
              onPress={() => apply((p) => shiftWords(p, index, picked, step))}><Text style={styles.chipText}>{nudgeLabel(step)} s</Text></Button>)}
          </View>
          <Text style={styles.dockHint}>Linked: each selected word&apos;s start and end move by the same amount. Other words stay put.</Text>
        </> : <>
          {(['start', 'end'] as const).map((edge) => <View key={edge}>
            <Text style={styles.timeLabel}>{picked.length} words: {edge === 'start' ? 'starts' : 'ends'}</Text>
            <View style={styles.timeRow}>
              {[-WORD_NUDGE_MS, -WORD_FINE_NUDGE_MS, WORD_FINE_NUDGE_MS, WORD_NUDGE_MS].map((step) => <Button key={step} style={[styles.chip, styles.nudgeChip, styles.flex]}
                onPress={() => apply((p) => shiftWordEdges(p, index, picked, step, edge))}><Text style={styles.chipText}>{nudgeLabel(step)} s</Text></Button>)}
            </View>
          </View>)}
          <Text style={styles.dockHint}>Unlinked: move just the starts or just the ends of the selected words.</Text>
        </> : word ? <>
          <SpellingField key={`${wordIndex}-text`} value={word.text.trim()} onChange={(text) => saveSpelling(wordIndex, text)}
            onDraft={(text) => { draft.current = { unit: wordIndex, text }; }} />
          {/* Linked: a new start or end moves the whole word by the difference. */}
          <TimeField key={`${wordIndex}-start`} label="Starts" value={word.start} onChange={(start) => apply((p) => linked && start != null && word.start != null
            ? shiftWords(p, index, [wordIndex], start - word.start) : setWordTiming(p, index, wordIndex, { start }))} />
          <TimeField key={`${wordIndex}-end`} label="Ends" value={word.end} onChange={(end) => apply((p) => linked && end != null && word.end != null
            ? shiftWords(p, index, [wordIndex], end - word.end) : setWordTiming(p, index, wordIndex, { end }))} />
          <Text style={styles.dockHint}>{linked ? 'Linked: start and end move together, so the word keeps its length.' : 'Only this word changes.'} Tap a time to type one (like 1:23.45). Fixing the spelling keeps its timing.</Text>
        </> : null}
        <View style={styles.row}>
          <Button style={[styles.secondary, styles.flex, earliest == null && styles.disabled]} disabled={earliest == null}
            onPress={() => { if (earliest != null && latest != null) playSongRange(earliest, Math.max(earliest + 100, latest)); }}>
            <Ionicons name="play" size={16} color={Design.text} /><Text style={styles.buttonText}>Hear it</Text>
          </Button>
          <Button style={[styles.primary, styles.flex]} onPress={done}><Text style={styles.primaryText}>Done</Text></Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

/**
 * "Split syllables": pick a word, move the cursor through it with the arrows
 * (or tap a letter) and split it there, as some·thing. Each part is synced on
 * its own and exported as one word.
 */
function SyllableModal({ index, project, apply, onClose, onSplitSimilar, onGuessSong, language, onLanguage }: {
  index: number | null; project: StudioProject; apply: (edit: (p: StudioProject) => StudioProject) => unknown; onClose: () => void;
  onSplitSimilar: (index: number) => void; onGuessSong: () => void;
  language: SyllableLanguage; onLanguage: (language: SyllableLanguage) => void;
}) {
  const [picking, setPicking] = useState(false);
  const row = index != null ? project.lines[index] : null;
  const groups = useMemo(() => (row ? wordGroups(row) : []), [row]);
  const [picked, setPicked] = useState(0);
  const [caret, setCaret] = useState(1);
  useEffect(() => {
    if (index == null || !row) return;
    const first = wordGroups(row).findIndex((group) => group.to > group.from || characters(row.words[group.from].text).length > 1);
    setPicked(Math.max(0, first));
    setCaret(1);
    // Only when a new line opens; edits keep the place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);
  if (!row || index == null) return null;
  const group = groups[Math.min(picked, groups.length - 1)];
  if (!group) return null;
  const units = row.words.slice(group.from, group.to + 1).map((word) => characters(word.text));
  const letters = units.flat();
  const splits = new Set<number>();
  units.reduce((sum, unit, k) => { if (k < units.length - 1) splits.add(sum + unit.length); return sum + unit.length; }, 0);
  const at = Math.max(1, Math.min(letters.length - 1, caret));
  const canSplit = letters.length > 1;
  const choose = (g: number) => {
    setPicked(g);
    const word = groups[g];
    setCaret(Math.max(1, characters(row.words[word.from].text).length));
  };
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.sheet}>
        <Text style={styles.sheetTitle}>Split syllables</Text>
        <View style={styles.pickWords}>
          {groups.map((entry, g) => {
            const text = row.words.slice(entry.from, entry.to + 1).map((word, k) => word.text.trimEnd() + (k < entry.to - entry.from ? unitSeparator(row, entry.from + k) : '')).join('');
            return <Pressable key={g} onPress={() => choose(g)} style={[styles.pickWord, g === picked && styles.pickWordSelected]}
              accessibilityRole="button" accessibilityState={{ selected: g === picked }}>
              <Text style={[styles.pickWordText, g === picked && styles.pickWordTextSelected]}>{text}</Text>
            </Pressable>;
          })}
        </View>
        <View style={styles.splitWord}>
          {letters.map((letter, k) => <View key={k} style={styles.splitCell}>
            {k > 0 ? <View style={styles.splitGap}>
              {splits.has(k) ? <Text style={styles.splitDot}>·</Text> : null}
              {canSplit && at === k ? <View style={styles.splitCaret} /> : null}
            </View> : null}
            <Pressable onPress={() => setCaret(Math.min(letters.length - 1, k + 1))} accessibilityLabel={`Put the cursor after ${letter}`}>
              <Text style={styles.splitLetter}>{letter}</Text>
            </Pressable>
          </View>)}
        </View>
        <View style={styles.row}>
          <Button style={[styles.secondary, !canSplit && styles.disabled]} disabled={!canSplit} onPress={() => setCaret(Math.max(1, at - 1))} accessibilityLabel="Move left">
            <Ionicons name="chevron-back" size={20} color={Design.text} />
          </Button>
          <Button style={[styles.primary, styles.flex, !canSplit && styles.disabled]} disabled={!canSplit}
            onPress={() => apply((p) => toggleSplit(p, index, group, at))}>
            <Text style={styles.primaryText}>{splits.has(at) ? 'Remove split' : 'Split here'}</Text>
          </Button>
          <Button style={[styles.secondary, !canSplit && styles.disabled]} disabled={!canSplit} onPress={() => setCaret(Math.min(letters.length - 1, at + 1))} accessibilityLabel="Move right">
            <Ionicons name="chevron-forward" size={20} color={Design.text} />
          </Button>
        </View>
        <Button style={[styles.secondary, group.to === group.from && styles.disabled]} disabled={group.to === group.from}
          onPress={() => { apply((p) => joinWordGroup(p, index, group)); setCaret(1); }} accessibilityLabel="Remove all splits from this word">
          <Ionicons name="close-circle-outline" size={17} color={Design.text} />
          <Text style={styles.buttonText}>Remove all splits{group.to > group.from ? ` (${group.to - group.from})` : ''}</Text>
        </Button>
        <Text style={styles.dockHint}>Move the cursor with the arrows or tap a letter to put it after that letter. Each part is synced on its own (tap or slide) and still exported as one word. A synced word keeps its time, shared between the parts.</Text>
        <Pressable onPress={() => setPicking((open) => !open)} style={styles.languagePicker} accessibilityRole="button"
          accessibilityLabel={`Guess syllables in ${syllableLanguageLabel(language)}. Change language`} accessibilityState={{ expanded: picking }}>
          <Ionicons name="language-outline" size={18} color={Design.text} />
          <Text style={[styles.buttonText, styles.flex]} numberOfLines={1}>Guess in: {syllableLanguageLabel(language)}</Text>
          <Ionicons name={picking ? 'chevron-up' : 'chevron-down'} size={18} color={Design.muted} />
        </Pressable>
        {picking ? <ScrollView style={styles.languageList} nestedScrollEnabled>
          {SYLLABLE_LANGUAGES.map((entry) => <Pressable key={entry.id} onPress={() => { onLanguage(entry.id); setPicking(false); }}
            style={[styles.languageItem, entry.id === language && styles.languageItemActive]} accessibilityRole="radio" accessibilityState={{ checked: entry.id === language }}>
            <Text style={[styles.buttonText, styles.flex]}>{entry.label}</Text>
            {entry.id === language ? <Ionicons name="checkmark" size={18} color={Design.accent} /> : null}
          </Pressable>)}
        </ScrollView> : null}
        <View style={styles.row}>
          <Button style={[styles.secondary, styles.flex]} onPress={() => apply((p) => guessLineSyllables(p, index, language).project)}
            accessibilityLabel="Guess syllable splits for the words of this line that are not split yet">
            <Ionicons name="sparkles-outline" size={16} color={Design.text} /><Text style={styles.buttonText}>Guess this line</Text>
          </Button>
          <Button style={[styles.secondary, styles.flex]} onPress={onGuessSong}>
            <Ionicons name="sparkles" size={16} color={Design.text} /><Text style={styles.buttonText}>Whole song</Text>
          </Button>
        </View>
        <View style={styles.row}>
          <Button style={[styles.secondary, styles.flex]} onPress={() => onSplitSimilar(index)}>
            <Ionicons name="copy-outline" size={16} color={Design.text} /><Text style={styles.buttonText}>Split similar lines</Text>
          </Button>
          <Button style={[styles.primary, styles.flex]} onPress={onClose}><Text style={styles.primaryText}>Done</Text></Button>
        </View>
      </Pressable>
    </Pressable>
  </Modal>;
}

/** Lines stage → "Adjust timing": type or nudge the line's start and end, and hear just that line. */
function LineTimingModal({ index, project, apply, onClose }: {
  index: number | null; project: StudioProject; apply: (edit: (p: StudioProject) => StudioProject) => unknown; onClose: () => void;
}) {
  const row = index != null ? project.lines[index] : null;
  if (!row || index == null) return null;
  const start = rowStart(row);
  const end = row.end ?? row.words.at(-1)?.end ?? null;
  const wordSynced = row.words.some((word) => word.start != null);
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <KeyboardAvoidingView style={[styles.backdrop, styles.backdropTop]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle} numberOfLines={2}>{row.instrumental ? '♪ Instrumental' : lineText(row)}</Text>
        <TimeField key={`${index}-start`} label="Starts" value={start} onChange={(value) => apply((p) => setLineTiming(p, index, { start: value }))} />
        {row.instrumental ? null : <TimeField key={`${index}-end`} label="Ends" value={end} onChange={(value) => apply((p) => setLineTiming(p, index, { end: value }))} />}
        <Text style={styles.dockHint}>{wordSynced
          ? 'This line is word-synced: a new start moves the whole line, keeping its word rhythm. Tap a time to type one (like 2:08.00).'
          : 'Tap a time to type one (like 2:08.00), or nudge it.'}</Text>
        <View style={styles.row}>
          <Button style={[styles.secondary, styles.flex, start == null && styles.disabled]} disabled={start == null}
            onPress={() => { if (start != null) playSongRange(start, end ?? start + 4000); }}>
            <Ionicons name="play" size={16} color={Design.text} /><Text style={styles.buttonText}>Hear it</Text>
          </Button>
          <Button style={[styles.primary, styles.flex]} onPress={onClose}><Text style={styles.primaryText}>Done</Text></Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

/** Pick a run of words on a main line (tap the first and the last) and move them to an ad-lib. */
function AdLibPicker({ index, project, onClose, onConfirm }: {
  index: number | null; project: StudioProject; onClose: () => void; onConfirm: (index: number, from: number, to: number) => void;
}) {
  const row = index != null ? project.lines[index] : null;
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => { setRange(row ? bracketedWords(row) : null); }, [row]);
  if (!row || index == null) return null;
  const choose = (i: number) => setRange((current) => !current ? { from: i, to: i }
    : i < current.from ? { ...current, from: i } : i > current.to ? { ...current, to: i } : { from: i, to: i });
  const all = range != null && range.to - range.from + 1 >= row.words.length;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.sheet}>
        <Text style={styles.sheetTitle}>Which words are the ad-lib?</Text>
        <Text style={styles.dockHint}>Tap the first and the last word. They move to an ad-lib under this line and keep their timing; the rest of the line keeps its timing too.</Text>
        <View style={styles.pickWords}>
          {row.words.map((word, i) => {
            const selected = range != null && i >= range.from && i <= range.to;
            return <Pressable key={i} onPress={() => choose(i)} style={[styles.pickWord, selected && styles.pickWordSelected]}
              accessibilityRole="checkbox" accessibilityState={{ checked: selected }}>
              <Text style={[styles.pickWordText, selected && styles.pickWordTextSelected]}>{word.text.trim()}</Text>
            </Pressable>;
          })}
        </View>
        {all ? <Text style={styles.dockHint}>Leave at least one word on the main line, or use “Make it an ad-lib” for the whole line.</Text> : null}
        <View style={styles.row}>
          <Button style={[styles.secondary, styles.flex]} onPress={onClose}><Text style={styles.buttonText}>Cancel</Text></Button>
          <Button style={[styles.primary, styles.flex, (!range || all) && styles.disabled]} disabled={!range || all}
            onPress={() => range && onConfirm(index, range.from, range.to)}><Text style={styles.primaryText}>Make ad-lib</Text></Button>
        </View>
      </Pressable>
    </Pressable>
  </Modal>;
}

type SimilarKind = 'timing' | 'splits';

/**
 * Confirm copying a line's word timing ("Apply timing to all similar lines")
 * or its syllable splits ("Split similar lines") to every line with exactly
 * the same words. The checkbox brings in lines that already have their own:
 * synced lines for timing, lines split differently for splits.
 */
function SimilarLinesModal({ request, project, onClose, onConfirm, onPickInList }: {
  request: { index: number; kind: SimilarKind } | null; project: StudioProject; onClose: () => void;
  onConfirm: (request: { index: number; kind: SimilarKind }, include: boolean) => void;
  /** Timing only: pick several lines right in the lyrics list instead. */
  onPickInList: (index: number) => void;
}) {
  const [include, setInclude] = useState(false);
  useEffect(() => { if (request) setInclude(false); }, [request]);
  const row = request ? project.lines[request.index] : null;
  if (!row || !request) return null;
  const { index, kind } = request;
  const matches = matchingLines(project, index).length;
  const noun = (count: number) => row.background ? (count === 1 ? 'ad-lib' : 'ad-libs') : (count === 1 ? 'line' : 'lines');
  // Dry runs give the counts for both checkbox states.
  let changing: number;
  let own: number;
  let notes = '';
  if (kind === 'timing') {
    const base = applyTimingToMatchingLines(project, index);
    own = base.keptSynced;
    changing = include ? applyTimingToMatchingLines(project, index, { includeSynced: true }).applied : base.applied;
    if (base.skipped) notes = ` ${base.skipped} with no start yet will be skipped (give them a start in the Lines stage first).`;
  } else {
    const base = copySplitsToMatchingLines(project, index);
    own = base.keptDifferent;
    changing = include ? copySplitsToMatchingLines(project, index, { includeDifferent: true }).applied : base.applied;
    if (base.same) notes = ` ${base.same} already split this way.`;
  }
  const copy = kind === 'timing' ? {
    title: 'Apply word-by-word timing to all lines with the same words',
    summary: `${matches} other ${noun(matches)} with exactly “${lineText(row)}”. Each keeps its own start and gets this line's word rhythm and syllable splits.`,
    check: 'Include lines that are already synced',
    allOwn: 'every match is already synced. Tick the box to overwrite them',
  } : {
    title: 'Split all lines with the same words like this one',
    summary: `${matches} other ${noun(matches)} with exactly “${lineText(row)}”. They get this line's syllable splits; synced ones keep their timing, shared between the parts.`,
    check: 'Include lines already split differently',
    allOwn: 'the other matches are split differently. Tick the box to replace their splits',
  };
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.sheet}>
        <Text style={styles.sheetTitle}>{copy.title}</Text>
        <Text style={styles.dockHint}>{copy.summary}</Text>
        {kind === 'timing' ? <Button style={[styles.chip, styles.selectMany]} onPress={() => onPickInList(index)}>
          <Ionicons name="list-outline" size={15} color={Design.text} />
          <Text style={styles.chipText}>Select multiple lines</Text>
        </Button> : null}
        <Pressable onPress={() => setInclude((value) => !value)} style={styles.checkRow}
          accessibilityRole="checkbox" accessibilityState={{ checked: include }}>
          <Ionicons name={include ? 'checkbox' : 'square-outline'} size={22} color={include ? Design.accent : Design.muted} />
          <Text style={[styles.buttonText, styles.flex]}>{copy.check}{own ? ` (${own})` : ''}</Text>
        </Pressable>
        <Text style={styles.dockHint}>{changing ? `${changing} ${noun(changing)} will change.`
          : `Nothing to change${own && !include ? `: ${copy.allOwn}` : ''}.`}{notes}</Text>
        <View style={styles.row}>
          <Button style={[styles.secondary, styles.flex]} onPress={onClose}><Text style={styles.buttonText}>Cancel</Text></Button>
          <Button style={[styles.primary, styles.flex, !changing && styles.disabled]} disabled={!changing}
            onPress={() => onConfirm(request, include)}><Text style={styles.primaryText}>Apply</Text></Button>
        </View>
      </Pressable>
    </Pressable>
  </Modal>;
}

function MenuItem({ icon, label, onPress, danger }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; danger?: boolean }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}>
    <Ionicons name={icon} size={19} color={danger ? '#FF93A4' : Design.text} />
    <Text style={[styles.menuText, danger && styles.danger]}>{label}</Text>
  </Pressable>;
}

function TextEditModal({ edit, onClose, onSave }: { edit: { value: string; insert?: 'line' | 'adlib' } | null; onClose: () => void; onSave: (value: string) => void }) {
  const [value, setValue] = useState('');
  useEffect(() => { setValue(edit?.value ?? ''); }, [edit]);
  // The sheet sits at the top so the keyboard never covers what is being typed.
  return <Modal visible={edit != null} transparent animationType="fade" onRequestClose={onClose}>
    <KeyboardAvoidingView style={[styles.backdrop, styles.backdropTop]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle}>{edit?.insert === 'adlib' ? 'New ad-lib' : edit?.insert ? 'New line' : 'Edit line'}</Text>
        <TextInput autoFocus value={value} onChangeText={setValue} style={styles.input} placeholderTextColor={Design.muted}
          placeholder={edit?.insert === 'adlib' ? 'yeah, yeah' : 'Lyric line'} />
        <Text style={styles.dockHint}>Changing the words resets that line&apos;s word timing.</Text>
        <View style={styles.row}>
          <Button style={[styles.secondary, styles.flex]} onPress={onClose}><Text style={styles.buttonText}>Cancel</Text></Button>
          <Button style={[styles.primary, styles.flex]} disabled={!value.trim()} onPress={() => onSave(value)}><Text style={styles.primaryText}>Save</Text></Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

function Stepper({ label, value, onChange, step, min, max, format }: {
  label: string; value: number; onChange: (value: number) => void; step: number; min: number; max: number; format: (value: number) => string;
}) {
  return <View style={styles.stepper}>
    <Text style={styles.stepperLabel}>{label}</Text>
    <View style={styles.row}>
      <IconButton icon="remove" label={`Less ${label}`} onPress={() => onChange(Math.max(min, value - step))} />
      <Text style={styles.stepperValue}>{format(value)}</Text>
      <IconButton icon="add" label={`More ${label}`} onPress={() => onChange(Math.min(max, value + step))} />
    </View>
  </View>;
}

function SettingsModal({ open, onClose, project, settings, onSettings, onProject, onShift, localName, onPickAudio, onUseSpotify }: {
  open: boolean; onClose: () => void; project: StudioProject; localName: string | null; onPickAudio: () => void; onUseSpotify: () => void;
  settings: ReturnType<typeof useSyncStudio>['settings']; onSettings: ReturnType<typeof useSyncStudio>['updateSettings'];
  onProject: (patch: Partial<StudioProject>) => void; onShift: (delta: number) => void;
}) {
  return <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView style={styles.settingsSheet} contentContainerStyle={styles.settingsContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.sheetTitle}>Sync settings</Text>
        <Text style={styles.stepperLabel}>Audio</Text>
        <Text style={styles.dockHint}>{localName
          ? `Syncing to “${localName}”. Taps use the file's exact position, and you can slow it down.`
          : 'Syncing to Spotify. For the most precise word timing, use the same song as an audio file on your phone.'}</Text>
        {localName
          ? <Button style={styles.secondary} onPress={onUseSpotify}><Ionicons name="radio-outline" size={18} color={Design.text} /><Text style={styles.buttonText}>Use Spotify instead</Text></Button>
          : <Button style={styles.secondary} onPress={onPickAudio}><Ionicons name="musical-note-outline" size={18} color={Design.text} /><Text style={styles.buttonText}>Use an audio file</Text></Button>}
        <Stepper label="Tap delay correction" value={settings.tapOffsetMs} step={10} min={-500} max={1000}
          format={(value) => `${value} ms`} onChange={(tapOffsetMs) => onSettings({ tapOffsetMs })} />
        <Text style={styles.dockHint}>If words light up late in the preview, raise this. It is taken off every tap (your reaction time plus Spotify&apos;s delay).</Text>
        <View style={styles.switchRow}>
          <Text style={styles.stepperLabel}>After each line, rewind to 0.5 s before the next one (off: keep playing)</Text>
          <Switch value={settings.autoRewind} onValueChange={(autoRewind) => onSettings({ autoRewind })} />
        </View>
        <Text style={styles.stepperLabel}>Move all timing</Text>
        <View style={styles.row}>
          <Chip label="−100 ms" onPress={() => onShift(-100)} /><Chip label="−10 ms" onPress={() => onShift(-10)} />
          <Chip label="+10 ms" onPress={() => onShift(10)} /><Chip label="+100 ms" onPress={() => onShift(100)} />
        </View>
        <Text style={styles.stepperLabel}>Song details (used in the exported TTML)</Text>
        <TextInput style={styles.input} value={project.title} onChangeText={(title) => onProject({ title })} placeholder="Title" placeholderTextColor={Design.muted} />
        <TextInput style={styles.input} value={project.artist} onChangeText={(artist) => onProject({ artist })} placeholder="Artist" placeholderTextColor={Design.muted} />
        <TextInput style={styles.input} value={project.spotifyTrackId ?? ''} autoCapitalize="none" autoCorrect={false}
          onChangeText={(value) => onProject({ spotifyTrackId: value.replace(/^.*track[/:]/, '').split('?')[0].trim() || undefined })}
          placeholder="Spotify track ID or link" placeholderTextColor={Design.muted} />
        <Button style={styles.primary} onPress={onClose}><Text style={styles.primaryText}>Done</Text></Button>
      </ScrollView>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Design.background },
  flex: { flex: 1 },
  startContent: { width: '100%', maxWidth: 680, alignSelf: 'center', padding: 20, gap: 18 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  headerCopy: { flex: 1, minWidth: 0 },
  heading: { color: Design.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  subheading: { color: Design.muted, fontSize: 13 },
  iconButton: { width: 42, height: 42, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.35 },
  banner: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginHorizontal: 16, marginBottom: 6, padding: 10, borderRadius: 14, backgroundColor: 'rgba(255,210,122,0.1)' },
  bannerText: { flex: 1, color: '#FFE3AE', fontSize: 13, lineHeight: 18 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', paddingHorizontal: 16, paddingVertical: 6 },
  segmented: { flexDirection: 'row', padding: 3, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.07)' },
  segment: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 11 },
  segmentActive: { backgroundColor: 'rgba(255,255,255,0.16)' },
  segmentText: { color: Design.muted, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: Design.text },
  previewButton: { marginLeft: 'auto', flexDirection: 'row', gap: 6, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 9, borderRadius: 14, backgroundColor: Design.accent },
  previewText: { color: Design.accentInk, fontSize: 13, fontWeight: '700' },
  progress: { color: Design.muted, fontSize: 12, paddingHorizontal: 20, paddingBottom: 4 },
  list: { paddingHorizontal: 12, paddingBottom: 24, gap: 4 },
  listHint: { color: 'rgba(255,255,255,0.4)', fontSize: 12, textAlign: 'center', paddingTop: 12 },
  rowItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14, borderWidth: 1, borderColor: 'transparent' },
  rowAdLib: { marginLeft: 22, paddingVertical: 6 },
  rowUnpickable: { opacity: 0.35 },
  /** Duet lines sit on the other side, like the player shows them. */
  rowDuet: { alignItems: 'flex-end' },
  rowActive: { backgroundColor: 'rgba(168,240,207,0.09)', borderColor: 'rgba(168,240,207,0.45)' },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowText: { color: Design.text, fontSize: 17, fontWeight: '700' },
  rowTextAdLib: { fontSize: 14, fontWeight: '500', fontStyle: 'italic', color: 'rgba(245,247,252,0.72)' },
  rowPlaying: { color: Design.accent },
  rowFlagged: { backgroundColor: 'rgba(255,90,90,0.13)', borderColor: 'rgba(255,120,120,0.6)' },
  wordSung: { color: Design.accent },
  wordNow: { color: Design.accent, textDecorationLine: 'underline' },
  fixBox: { gap: 6, padding: 10, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.04)' },
  chipFlagged: { backgroundColor: 'rgba(255,90,90,0.22)' },
  slider: { height: 44, justifyContent: 'center', marginHorizontal: 10 },
  speedChip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  rateValue: { minWidth: 46, fontVariant: ['tabular-nums'] },
  sliderTrack: { position: 'absolute', left: 0, right: 0, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.12)' },
  sliderFill: { position: 'absolute', left: 0, height: 6, borderRadius: 3, backgroundColor: Design.accent },
  sliderTick: { position: 'absolute', width: 4, height: 4, marginLeft: -2, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)' },
  sliderTickLit: { backgroundColor: Design.accentInk },
  sliderThumb: { position: 'absolute', width: 24, height: 24, marginLeft: -12, borderRadius: 12, backgroundColor: Design.accent },
  sliderLabels: { flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: 0 },
  sliderLabel: { color: Design.muted, fontSize: 11 },
  rowInstrumental: { fontSize: 14, fontWeight: '600', fontStyle: 'italic', color: Design.muted },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowTime: { color: Design.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  slim: { minHeight: 38, borderRadius: 13 },
  dock: { gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8, borderTopWidth: 1, borderColor: Design.border, backgroundColor: 'rgba(9,12,19,0.96)' },
  dockHint: { color: Design.muted, fontSize: 12, lineHeight: 17 },
  dockLabel: { color: Design.muted, fontSize: 12, alignSelf: 'center' },
  notice: { color: Design.accent, fontSize: 13, textAlign: 'center' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  clock: { color: Design.text, fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  playButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: Design.accent, alignItems: 'center', justifyContent: 'center' },
  bigPad: { minHeight: 132, borderRadius: 24, padding: 18, justifyContent: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: Design.border },
  bigPadPressed: { backgroundColor: 'rgba(168,240,207,0.14)', borderColor: Design.accent },
  padLabel: { color: Design.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1.3 },
  padLine: { color: Design.text, fontSize: 24, fontWeight: '800' },
  primary: { minHeight: 48, paddingHorizontal: 14, borderRadius: 16, backgroundColor: Design.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primaryText: { color: Design.accentInk, fontSize: 14, fontWeight: '700' },
  secondary: { minHeight: 48, paddingHorizontal: 14, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: Design.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  buttonText: { color: Design.text, fontSize: 14, fontWeight: '600' },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.08)' },
  chipText: { color: Design.text, fontSize: 12, fontWeight: '600' },
  chipActive: { backgroundColor: 'rgba(168,240,207,0.25)' },
  preview: { flex: 1 },
  backdropTop: { justifyContent: 'flex-start', paddingTop: 48 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { margin: 12, padding: 16, gap: 6, borderRadius: 24, backgroundColor: Design.surface, borderWidth: 1, borderColor: Design.border },
  sheetTitle: { color: Design.text, fontSize: 17, fontWeight: '700', marginBottom: 6 },
  languagePicker: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, paddingHorizontal: 12, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: Design.border },
  languageList: { maxHeight: 240, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.04)' },
  languageItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11 },
  languageItemActive: { backgroundColor: 'rgba(168,240,207,0.14)' },
  splitWord: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', paddingVertical: 14 },
  splitCell: { flexDirection: 'row', alignItems: 'center' },
  splitGap: { width: 14, height: 44, alignItems: 'center', justifyContent: 'center' },
  splitDot: { color: Design.accent, fontSize: 28, fontWeight: '900', position: 'absolute' },
  splitCaret: { width: 2, height: 40, borderRadius: 1, backgroundColor: '#8EC5FF' },
  splitLetter: { color: Design.text, fontSize: 34, fontWeight: '800', paddingHorizontal: 2 },
  subMenu: { marginLeft: 26, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: Design.border },
  selectMany: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  linkChip: { paddingHorizontal: 10 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nudgeChip: { paddingHorizontal: 8, alignItems: 'center' },
  timeField: { gap: 6, paddingVertical: 4 },
  timeLabel: { color: Design.muted, fontSize: 12, fontWeight: '600' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timeValue: { flex: 1, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(3,8,15,0.4)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  timeValueText: { color: Design.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  timeInput: { flex: 1, textAlign: 'center', fontSize: 18 },
  untimedWord: { opacity: 0.5 },
  pickWords: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 8 },
  pickWord: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.07)' },
  wordPill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 4 },
  syllableCell: { flexDirection: 'row', alignItems: 'center' },
  syllableDot: { color: Design.muted, fontSize: 16, fontWeight: '800', marginHorizontal: 1 },
  syllablePick: { paddingHorizontal: 6, paddingVertical: 4, borderRadius: 9 },
  pickWordSelected: { backgroundColor: 'rgba(168,240,207,0.22)' },
  pickWordText: { color: Design.text, fontSize: 16, fontWeight: '600' },
  pickWordTextSelected: { color: Design.accent, fontStyle: 'italic' },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 12, borderRadius: 12 },
  menuItemPressed: { backgroundColor: 'rgba(255,255,255,0.06)' },
  menuText: { color: Design.text, fontSize: 15 },
  danger: { color: '#FF93A4' },
  input: { minHeight: 48, paddingHorizontal: 13, paddingVertical: 11, color: Design.text, fontSize: 15, backgroundColor: 'rgba(3,8,15,0.4)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  settingsSheet: { maxHeight: '85%', margin: 12, borderRadius: 24, backgroundColor: Design.surface, borderWidth: 1, borderColor: Design.border },
  settingsContent: { padding: 18, gap: 12 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  stepperLabel: { color: Design.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  stepperValue: { color: Design.text, fontSize: 15, fontWeight: '700', minWidth: 64, textAlign: 'center', fontVariant: ['tabular-nums'] },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
});
