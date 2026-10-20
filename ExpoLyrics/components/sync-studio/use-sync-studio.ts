import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { StudioProject } from '@/lib/sync-studio/engine';
import { DEFAULT_SYNC_STUDIO_SETTINGS, discardSyncStudioDraft, loadSyncStudioDrafts, loadSyncStudioSettings, saveSyncStudioDraft,
  saveSyncStudioSettings, withDraftId, type SyncStudioSettings } from '@/lib/sync-studio/storage';
import { usePlaybackStore } from '@/store/playback-store';

const MAX_HISTORY = 120;
type History = { project: StudioProject | null; past: StudioProject[]; future: StudioProject[] };

/**
 * Project state with undo/redo. `projectRef` always holds the latest project so
 * gesture handlers never act on a stale copy, and every change re-renders, so
 * the screen always shows the current timings.
 */
export function useSyncStudio() {
  const [history, setHistory] = useState<History>({ project: null, past: [], future: [] });
  const projectRef = useRef<StudioProject | null>(null);
  projectRef.current = history.project;
  const [settings, setSettings] = useState<SyncStudioSettings>(DEFAULT_SYNC_STUDIO_SETTINGS);
  /** Songs in progress for "Continue", newest first (up to five). */
  const [drafts, setDrafts] = useState<StudioProject[]>([]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const remember = useCallback((project: StudioProject) => { void saveSyncStudioDraft(project).then(setDrafts); }, []);
  /**
   * The project as it was when opened, or when last saved to the vault, and
   * whether it was already a draft then. Leaving on purpose can go back to it;
   * edits are still saved as they happen, so a crash or restart keeps them.
   */
  const baseline = useRef<{ project: StudioProject; wasDraft: boolean } | null>(null);

  useEffect(() => {
    void loadSyncStudioSettings().then(setSettings);
    void loadSyncStudioDrafts().then(setDrafts);
    // Save when the app is backgrounded or the screen closes, even mid-slide.
    const save = () => { if (projectRef.current) void saveSyncStudioDraft(projectRef.current); };
    const subscription = AppState.addEventListener('change', (state) => { if (state !== 'active') save(); });
    return () => { subscription.remove(); save(); };
  }, []);

  // Each finished edit is saved to the device. Changes inside a slide pass are
  // `transient` and saved once the finger lifts (`commit`), so sliding never
  // writes to storage. "Continue" opens this latest copy.
  const transient = useRef(false);
  useEffect(() => {
    if (!history.project || transient.current) return;
    remember(history.project);
  }, [history.project, remember]);

  /** Save now: the end of a slide pass. */
  const commit = useCallback(() => {
    transient.current = false;
    if (!projectRef.current) return;
    remember(projectRef.current);
  }, [remember]);

  /** Apply an edit as one undo step. */
  const apply = useCallback((edit: (project: StudioProject) => StudioProject) => {
    const current = projectRef.current;
    if (!current) return current;
    const next = edit(current);
    if (next === current) return current;
    projectRef.current = next;
    transient.current = false;
    setHistory((state) => ({ project: next, past: [...state.past, current].slice(-MAX_HISTORY), future: [] }));
    return next;
  }, []);

  /** Mark the start of a multi-step gesture (a swipe pass) so it undoes in one step. */
  const checkpoint = useCallback(() => {
    const current = projectRef.current;
    if (current) setHistory((state) => ({ ...state, past: [...state.past, current].slice(-MAX_HISTORY), future: [] }));
  }, []);

  /** Change the project without a new undo step. `pass`: inside a slide pass, saved later by `commit`. */
  const replace = useCallback((edit: (project: StudioProject) => StudioProject, { pass = false }: { pass?: boolean } = {}) => {
    const current = projectRef.current;
    if (!current) return current;
    const next = edit(current);
    if (next === current) return current;
    projectRef.current = next;
    transient.current = pass;
    setHistory((state) => ({ ...state, project: next }));
    return next;
  }, []);

  /** Restore the project as it was at the last checkpoint (a cancelled swipe). */
  const revertToCheckpoint = useCallback(() => {
    setHistory((state) => {
      const previous = state.past.at(-1);
      if (!previous) return state;
      projectRef.current = previous;
      transient.current = false;
      return { project: previous, past: state.past.slice(0, -1), future: state.future };
    });
  }, []);

  const open = useCallback((opened: StudioProject) => {
    // Each project keeps its draft id, so its edits update one "Continue" entry.
    const project = withDraftId(opened);
    baseline.current = { project, wasDraft: draftsRef.current.some((draft) => draft.id === project.id) };
    projectRef.current = project;
    transient.current = false;
    setHistory({ project, past: [], future: [] });
  }, []);

  /** Changed since it was opened or last saved to the vault (undoing back to it counts as unchanged). */
  const isDirty = useCallback(() => projectRef.current != null && projectRef.current !== baseline.current?.project, []);
  /** Saved to the vault: that version is the one "Discard" goes back to. */
  const markSaved = useCallback(() => {
    if (projectRef.current) baseline.current = { project: projectRef.current, wasDraft: true };
  }, []);

  /**
   * Leave the project. `keep: false` (chosen on leaving) puts back the version
   * it was opened with, or removes a new project from "Continue".
   */
  const close = useCallback(({ keep = true }: { keep?: boolean } = {}) => {
    const current = projectRef.current;
    const original = baseline.current;
    if (current && keep) remember(current);
    else if (current && original?.wasDraft) remember(original.project);
    else if (current?.id) void discardSyncStudioDraft(current.id).then(setDrafts);
    projectRef.current = null;
    baseline.current = null;
    setHistory({ project: null, past: [], future: [] });
  }, [remember]);

  const discardDraft = useCallback((id: string) => { void discardSyncStudioDraft(id).then(setDrafts); }, []);

  const undo = useCallback(() => setHistory((state) => {
    const previous = state.past.at(-1);
    if (!previous || !state.project) return state;
    projectRef.current = previous;
    transient.current = false;
    return { project: previous, past: state.past.slice(0, -1), future: [state.project, ...state.future] };
  }), []);

  const redo = useCallback(() => setHistory((state) => {
    const [next, ...future] = state.future;
    if (!next || !state.project) return state;
    projectRef.current = next;
    transient.current = false;
    return { project: next, past: [...state.past, state.project], future };
  }), []);

  const updateSettings = useCallback((patch: Partial<SyncStudioSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      void saveSyncStudioSettings(next);
      return next;
    });
  }, []);

  return { project: history.project, projectRef, canUndo: history.past.length > 0, canRedo: history.future.length > 0,
    apply, replace, commit, checkpoint, revertToCheckpoint, open, close, isDirty, markSaved, undo, redo, drafts, discardDraft, settings, updateSettings };
}

/** The song position and play state, refreshed ten times a second while the screen is open. */
export function useSongClock(positionOf: () => number, playingOf: () => boolean) {
  const [clock, setClock] = useState(() => ({ position: positionOf(), isPlaying: playingOf() }));
  const storePlaying = usePlaybackStore((state) => state.isPlaying);
  useEffect(() => {
    const read = () => setClock({ position: positionOf(), isPlaying: playingOf() });
    read();
    const timer = setInterval(read, 100);
    return () => clearInterval(timer);
  }, [playingOf, positionOf, storePlaying]);
  return clock;
}
