import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StudioProject } from '@/lib/sync-studio/engine';
import { SYLLABLE_LANGUAGES, type SyllableLanguage } from '@/lib/sync-studio/syllables';

/** Before drafts were a list: one draft, carried over into the list once. */
const LEGACY_DRAFT_KEY = 'kinesync_sync_studio_draft_v1';
const DRAFTS_KEY = 'kinesync_sync_studio_drafts_v2';
/** How many songs "Continue" keeps. */
export const MAX_SYNC_STUDIO_DRAFTS = 5;
const SETTINGS_KEY = 'kinesync_sync_studio_settings_v1';

export type SyncStudioSettings = {
  /** Subtracted from every tap: your reaction time plus the player's delay. */
  tapOffsetMs: number;
  /** How far before a line playback starts when you tap that line (0–2 s). */
  leadInMs: number;
  wordMethod: 'tap' | 'swipe';
  /** Rewind and play the next line automatically after finishing one. */
  autoRewind: boolean;
  /** The language "Guess syllables" uses, remembered between songs. */
  syllableLanguage: SyllableLanguage;
  /** Tap mode: Commit (G) on a line's last word ends the line, like End, instead of carrying into the next one. */
  lastCommitEnds: boolean;
};
export const DEFAULT_SYNC_STUDIO_SETTINGS: SyncStudioSettings = { tapOffsetMs: 0, leadInMs: 1000, wordMethod: 'tap', autoRewind: true, syllableLanguage: 'en', lastCommitEnds: false };

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const validDraft = (draft: StudioProject | null | undefined): draft is StudioProject =>
  draft?.version === 1 && Array.isArray(draft.lines) && draft.lines.length > 0;
let draftIds = 0;
/** Every draft has an id, so renaming a song keeps it one draft. */
export const withDraftId = (project: StudioProject): StudioProject => project.id ? project
  : { ...project, id: `d${Date.now().toString(36)}${(draftIds++).toString(36)}` };

// The list in memory, so quick saves never read a stale copy; writes go out in order.
let drafts: StudioProject[] | null = null;
let writing: Promise<unknown> = Promise.resolve();

/**
 * The songs in progress, newest first (up to five), so closing the app never
 * loses a sync. The older single draft is carried over the first time.
 */
export async function loadSyncStudioDrafts(): Promise<StudioProject[]> {
  if (drafts) return drafts;
  const stored = await readJson<StudioProject[]>(DRAFTS_KEY);
  if (Array.isArray(stored)) {
    drafts = stored.filter(validDraft).map(withDraftId).slice(0, MAX_SYNC_STUDIO_DRAFTS);
  } else {
    const legacy = await readJson<StudioProject>(LEGACY_DRAFT_KEY);
    drafts = validDraft(legacy) ? [withDraftId(legacy)] : [];
    if (drafts.length) await persist();
    await AsyncStorage.removeItem(LEGACY_DRAFT_KEY).catch(() => {});
  }
  return drafts;
}

function persist() {
  const snapshot = JSON.stringify(drafts ?? []);
  writing = writing.then(() => AsyncStorage.setItem(DRAFTS_KEY, snapshot)).catch(() => {});
  return writing;
}

/** Saved once per finished edit (a line synced, a nudge, a menu action), never during a slide. Moves the song to the top. */
export async function saveSyncStudioDraft(project: StudioProject) {
  const list = await loadSyncStudioDrafts();
  const saved = withDraftId(project);
  drafts = [saved, ...list.filter((draft) => draft.id !== saved.id)].slice(0, MAX_SYNC_STUDIO_DRAFTS);
  await persist();
  return drafts;
}

export async function discardSyncStudioDraft(id: string) {
  const list = await loadSyncStudioDrafts();
  drafts = list.filter((draft) => draft.id !== id);
  await persist();
  return drafts;
}

export async function loadSyncStudioSettings(): Promise<SyncStudioSettings> {
  const settings = { ...DEFAULT_SYNC_STUDIO_SETTINGS, ...(await readJson<Partial<SyncStudioSettings>>(SETTINGS_KEY)) };
  // The lead-in slider runs 0–2 s in 0.25 s steps.
  settings.leadInMs = Math.min(2000, Math.max(0, Math.round(Number(settings.leadInMs) / 250) * 250 || 0));
  if (!SYLLABLE_LANGUAGES.some((entry) => entry.id === settings.syllableLanguage)) settings.syllableLanguage = 'en';
  settings.lastCommitEnds = settings.lastCommitEnds === true;
  return settings;
}
export function saveSyncStudioSettings(settings: SyncStudioSettings) {
  return AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => {});
}
