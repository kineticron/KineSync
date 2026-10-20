/**
 * Sync Studio: tap/swipe lyric timing, kept free of React Native so it can be
 * tested directly. Every edit returns a new project (undo keeps old ones).
 *
 * Model: lead lines and ad-lib (background) lines are separate rows. An ad-lib
 * row belongs to the nearest lead row above it and is exported as that lead
 * line's background vocal span, so it may overlap the lead line freely.
 * An instrumental row has no words; it ends the line before it, leaving the
 * gap KineSync shows as "…" (3 s or longer).
 */
import { characters } from '@/lib/sync-studio/swipe';
import type { LyricLine, LyricSyllable } from '@/types/bridge';

/** `joinNext`: this unit continues the same word (a syllable, a CJK character): no space after it. */
export type StudioWord = { text: string; start: number | null; end: number | null; joinNext?: boolean };
export type StudioLine = {
  id: string;
  words: StudioWord[];
  start: number | null;
  end: number | null;
  /** Ad-lib / background vocal, shown small and exported as x-bg spans. */
  background: boolean;
  /** Instrumental break: no words, only a start (and the next line ends it). */
  instrumental?: boolean;
  /** Marked "to fix" from the preview; cleared when the line is synced again. */
  flagged?: boolean;
  /** Duet: sung by the other singer (TTML agent v2), shown on the other side. Main lines only; ad-libs follow their line. */
  oppositeAligned?: boolean;
  translatedText?: string;
};
export type StudioProject = {
  version: 1;
  /** Which saved draft this is (see storage); set when the project is opened. */
  id?: string;
  title: string;
  artist: string;
  album?: string;
  spotifyTrackId?: string;
  trackId?: string;
  durationMs?: number;
  lines: StudioLine[];
  updatedAt: number;
};
export type StudioMeta = Pick<StudioProject, 'title' | 'artist' | 'album' | 'spotifyTrackId' | 'trackId' | 'durationMs'>;

/** Shortest word or line the engine writes, so exported spans never collapse. */
export const MIN_WORD_MS = 60;
/** KineSync shows the "…" interlude for gaps at least this long. */
export const INSTRUMENTAL_GAP_MS = 3000;
/** Pasted markers for an instrumental break: #INSTRUMENTAL, [Instrumental], (instrumental), ♪ or "...". */
const INSTRUMENTAL_RE = /^\s*(?:#\s*instrumental|\[\s*instrumental\s*\]|\(\s*instrumental\s*\)|♪+|…|\.{3})\s*$/i;
export const isInstrumentalText = (text: string) => INSTRUMENTAL_RE.test(String(text || ''));
const CJK_RE = /[぀-ヿ㐀-鿿가-힯豈-﫿]/u;
let idCounter = 0;
const newId = () => `l${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** Split a lyric line into timing units. Units keep their trailing space. */
export function splitWords(text: string): StudioWord[] {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = /\s/.test(clean) ? clean.match(/\S+\s*/g) ?? [clean]
    : CJK_RE.test(clean) ? Array.from(clean) : [clean];
  const joined = !/\s/.test(clean) && parts.length > 1;
  return parts.map((part, index) => ({ text: index === parts.length - 1 ? part.trimEnd() : part, start: null, end: null,
    ...(joined && index < parts.length - 1 ? { joinNext: true } : {}) }));
}

export const lineText = (line: Pick<StudioLine, 'words'>) => line.words.map((word) => word.text).join('').trim();

function line(words: StudioWord[], extra: Partial<StudioLine> = {}): StudioLine {
  return { id: newId(), words, start: null, end: null, background: false, ...extra };
}
const instrumentalRow = (extra: Partial<StudioLine> = {}) => line([], { ...extra, instrumental: true, background: false });

/** A line written fully in parentheses is an ad-lib: "(yeah, yeah)". */
function parseAdLib(text: string) {
  const match = /^\s*\((.*)\)\s*$/.exec(text);
  return match ? { text: match[1], background: true } : { text, background: false };
}

export function projectFromPlainText(text: string, meta: StudioMeta): StudioProject {
  const lines = String(text || '').split(/\r?\n/)
    .map((raw) => {
      if (isInstrumentalText(raw)) return instrumentalRow();
      const { text: lineTextValue, background } = parseAdLib(raw);
      return line(splitWords(lineTextValue), { background });
    })
    .filter((entry) => entry.words.length || entry.instrumental);
  return { version: 1, ...meta, lines, updatedAt: Date.now() };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function wordsFromSyllables(syllables: LyricSyllable[], start: number | null, end: number | null) {
  const usable = syllables.filter((syllable) => String(syllable?.text || '').trim());
  if (usable.length > 1) {
    // Already word-timed: keep the timings so they can be fixed, not redone.
    // Sources that flag word boundaries (Spicy's isPartOfWord) carry no spaces
    // in the text; the boundary becomes a real space here.
    const flagged = usable.some((syllable) => typeof syllable.isPartOfWord === 'boolean');
    return usable.map((syllable, index) => {
      const last = index === usable.length - 1;
      let text = String(syllable.text);
      if (flagged && syllable.isPartOfWord === false && !last && !/\s$/.test(text)) text += ' ';
      if (last) text = text.trimEnd();
      return { text, start: finite(syllable.startTime) ? syllable.startTime : null,
        end: finite(syllable.endTime) ? syllable.endTime : null, ...(!last && !/\s$/.test(text) ? { joinNext: true } : {}) };
    });
  }
  const words = splitWords(usable.map((syllable) => syllable.text).join(''));
  if (words.length === 1 && finite(start) && finite(end)) return [{ ...words[0], start, end }];
  return words;
}

/** Start from lyrics KineSync already has; line timing from line-synced sources is kept. */
export function projectFromLyrics(lyrics: LyricLine[], meta: StudioMeta): StudioProject {
  const lines: StudioLine[] = [];
  let coveredEnd: number | null = null;
  for (const source of lyrics) {
    const start = finite(source.lineStartTime) ? source.lineStartTime : null;
    const end = finite(source.lineEndTime) && source.lineEndTime > (start ?? -1) ? source.lineEndTime : null;
    const words = wordsFromSyllables(source.syllables || [], start, end);
    const background = source.backgroundSyllables || [];
    const hasAdLib = background.some((syllable) => String(syllable?.text || '').trim());
    // An empty or "♪" line is an instrumental break; so is a long gap between
    // lines. A line with only an ad-lib (a song opening on one) is not.
    if ((!words.length && !hasAdLib) || (words.length && isInstrumentalText(words.map((word) => word.text).join('')))) {
      if (start != null) { lines.push(instrumentalRow({ start })); coveredEnd = start; }
      continue;
    }
    if (start != null && coveredEnd != null && start - coveredEnd >= INSTRUMENTAL_GAP_MS && !lines.at(-1)?.instrumental) {
      lines.push(instrumentalRow({ start: coveredEnd }));
    }
    if (start != null) coveredEnd = Math.max(coveredEnd ?? 0, end ?? start);
    if (words.length) {
      lines.push(line(words, { start, end, oppositeAligned: source.oppositeAligned || undefined,
        translatedText: source.translatedText || undefined }));
    }
    if (hasAdLib) {
      const bgStart = finite(background[0]?.startTime) ? background[0].startTime : null;
      const bgEnd = finite(background.at(-1)?.endTime) ? background.at(-1)!.endTime : null;
      const bgWords = wordsFromSyllables(background, bgStart, bgEnd)
        .map((word, index, all) => ({ ...word, text: word.text
          .replace(index === 0 ? /^\(/ : /$^/, '').replace(index === all.length - 1 ? /\)(\s*)$/ : /$^/, '$1') }))
        .filter((word) => word.text.trim());
      if (bgWords.length) lines.push(line(bgWords, { background: true, start: bgStart, end: bgEnd }));
      if (bgEnd != null) coveredEnd = Math.max(coveredEnd ?? 0, bgEnd);
    }
  }
  return { version: 1, ...meta, lines, updatedAt: Date.now() };
}

// ---- Edits -------------------------------------------------------------------

const touch = (project: StudioProject, lines: StudioLine[]): StudioProject => ({ ...project, lines, updatedAt: Date.now() });
const at = (project: StudioProject, index: number) => project.lines[index];
function replaceLine(project: StudioProject, index: number, next: StudioLine) {
  const lines = project.lines.slice();
  lines[index] = next;
  return touch(project, lines);
}
const clampTime = (value: number) => Math.max(0, Math.round(value));

/** The nearest lead (non ad-lib) row above index, or -1. */
export function previousLeadIndex(project: StudioProject, index: number) {
  for (let i = index - 1; i >= 0; i--) if (!project.lines[i].background) return i;
  return -1;
}

/** Lines stage: this row starts now. The lead line before it ends here unless it already ended earlier. */
export function markLineStart(project: StudioProject, index: number, time: number) {
  const target = at(project, index);
  if (!target) return project;
  const t = clampTime(time);
  const lines = project.lines.slice();
  // A word-synced line shows its first word's time, so the whole line moves
  // with the new start (rhythm kept); otherwise the start alone changes.
  const anchor = target.words[0]?.start;
  lines[index] = anchor != null ? { ...shiftLine(project, index, t - anchor).lines[index], start: t }
    : { ...target, start: t, end: target.end != null && target.end > t ? target.end : null };
  const previous = target.background ? -1 : previousLeadIndex(project, index);
  const before = lines[previous];
  if (before && before.start != null && before.start < t && (before.end == null || before.end > t)) {
    lines[previous] = { ...before, end: t };
  }
  return touch(project, lines);
}

/** Lines stage: the singing stops here (a pause before the next line). */
export function markLineEnd(project: StudioProject, index: number, time: number) {
  const target = at(project, index);
  if (!target || target.start == null) return project;
  return replaceLine(project, index, { ...target, end: Math.max(target.start + MIN_WORD_MS, clampTime(time)) });
}

export function nextUntimedWord(lineValue: StudioLine) {
  return lineValue.words.findIndex((word) => word.start == null);
}

/** A line is done when every word has a start and the line has an end. */
export function isLineWordSynced(lineValue: StudioLine) {
  if (lineValue.instrumental) return lineValue.start != null;
  return lineValue.words.length > 0 && lineValue.words.every((word) => word.start != null && word.end != null);
}

/**
 * Tap mode (Start/Commit). Each tap starts the next unit and ends the one
 * before it. The last unit stays open (being sung) until a tap ends it, which
 * finishes the line; the screen then carries on into the next line.
 */
export function tapWord(project: StudioProject, index: number, time: number): { project: StudioProject; finished: boolean } {
  const target = at(project, index);
  if (!target || !target.words.length) return { project, finished: false };
  const t = clampTime(time);
  const words = target.words.slice();
  const next = nextUntimedWord(target);
  const last = words.length - 1;
  if (next < 0) {
    // The last unit is being sung: this tap ends it, and the line.
    if (words[last].end != null) return { project, finished: true };
    return { project: endLastWord(project, index, t), finished: true };
  }
  const previousStart = next > 0 ? words[next - 1].start ?? 0 : -Infinity;
  const start = Math.max(t, previousStart + MIN_WORD_MS);
  words[next] = { ...words[next], start, end: null };
  // The unit before ends here, unless "End" already ended it (a gap).
  if (next > 0 && words[next - 1].end == null) words[next - 1] = { ...words[next - 1], end: start };
  // The first word's tap is more precise than a line-stage tap: it becomes the line start.
  const updated = { ...target, words, start: next === 0 ? start : target.start ?? start };
  return { project: replaceLine(project, index, updated), finished: false };
}

/** The unit being sung: started, not ended yet (-1 if none). */
export function openUnit(lineValue: StudioLine) {
  for (let i = lineValue.words.length - 1; i >= 0; i--) {
    const word = lineValue.words[i];
    if (word.start != null) return word.end == null ? i : -1;
  }
  return -1;
}

/**
 * Tap mode "End" (H): the unit being sung ends now, leaving a gap before the
 * next one. Ending the last unit finishes the line. `ended` is false when no
 * unit of this line is open.
 */
export function tapEnd(project: StudioProject, index: number, time: number): { project: StudioProject; ended: boolean; finished: boolean } {
  const target = at(project, index);
  const open = target ? openUnit(target) : -1;
  if (!target || open < 0) return { project, ended: false, finished: false };
  const last = open === target.words.length - 1;
  if (last) return { project: endLastWord(project, index, time), ended: true, finished: true };
  const words = target.words.slice();
  words[open] = { ...words[open], end: Math.max(words[open].start! + MIN_WORD_MS, clampTime(time)) };
  return { project: replaceLine(project, index, { ...target, words }), ended: true, finished: false };
}

// ---- Syllables ------------------------------------------------------------------

/** Whole words of a line as runs of units: a unit with `joinNext` continues into the next one. */
export function wordGroups(lineValue: StudioLine): { from: number; to: number }[] {
  const groups: { from: number; to: number }[] = [];
  let from = 0;
  lineValue.words.forEach((word, i) => {
    if (!word.joinNext || i === lineValue.words.length - 1) { groups.push({ from, to: i }); from = i + 1; }
  });
  return groups;
}

/** What goes after a unit on screen: a space, "·" between syllables, nothing between CJK characters. */
export function unitSeparator(lineValue: StudioLine, i: number) {
  const word = lineValue.words[i];
  const next = lineValue.words[i + 1];
  if (!next) return '';
  if (!word.joinNext) return ' ';
  return CJK_RE.test(word.text.slice(-1)) || CJK_RE.test(next.text.charAt(0)) ? '' : '·';
}

/**
 * Split unit `unitIndex` into two syllables after `at` characters. A timed
 * unit's time is shared by letter count, so the line stays synced.
 */
export function splitUnit(project: StudioProject, index: number, unitIndex: number, at: number) {
  const target = project.lines[index];
  const word = target?.words[unitIndex];
  if (!target || !word) return project;
  const letters = characters(word.text);
  if (at <= 0 || at >= letters.length) return project;
  const trailing = /\s*$/.exec(word.text)?.[0] ?? '';
  let middle: number | null = null;
  if (word.start != null && word.end != null) middle = clampTime(word.start + ((word.end - word.start) * at) / letters.length);
  const first: StudioWord = { text: letters.slice(0, at).join(''), start: word.start, end: middle, joinNext: true };
  const second: StudioWord = { text: letters.slice(at).join('') + trailing, start: middle, end: middle != null ? word.end : null,
    ...(word.joinNext ? { joinNext: true } : {}) };
  const words = [...target.words.slice(0, unitIndex), first, second, ...target.words.slice(unitIndex + 1)];
  return replaceLine(project, index, { ...target, words });
}

/** Undo a split: unit `unitIndex` and the syllable after it become one unit again. */
export function joinUnits(project: StudioProject, index: number, unitIndex: number) {
  const target = project.lines[index];
  const a = target?.words[unitIndex];
  const b = target?.words[unitIndex + 1];
  if (!target || !a || !b || !a.joinNext) return project;
  const merged: StudioWord = { text: a.text + b.text, start: a.start ?? b.start, end: b.end ?? a.end, ...(b.joinNext ? { joinNext: true } : {}) };
  const words = [...target.words.slice(0, unitIndex), merged, ...target.words.slice(unitIndex + 2)];
  return replaceLine(project, index, { ...target, words });
}

/**
 * "Remove all splits" for one word: its syllables become one unit again,
 * from the first syllable's start to the last one's end.
 */
export function joinWordGroup(project: StudioProject, index: number, group: { from: number; to: number }) {
  let next = project;
  for (let u = group.to - 1; u >= group.from; u--) next = joinUnits(next, index, u);
  return next;
}

/**
 * The syllable menu: toggle a split `caret` letters into word group `group`.
 * On an existing split it joins the syllables; inside a syllable it splits it.
 */
export function toggleSplit(project: StudioProject, index: number, group: { from: number; to: number }, caret: number) {
  const target = project.lines[index];
  if (!target) return project;
  let before = 0;
  for (let u = group.from; u <= group.to; u++) {
    const count = characters(target.words[u].text).length;
    if (caret === before + count && u < group.to) return joinUnits(project, index, u);
    if (caret > before && caret < before + count) return splitUnit(project, index, u, caret - before);
    before += count;
  }
  return project;
}

/**
 * Tap mode, a unit picked in the pad to resync: it starts now. Its end opens
 * until Commit or End; the unit before it ends here if it ran on to here.
 */
export function restartUnit(project: StudioProject, index: number, unit: number, time: number) {
  const target = at(project, index);
  const word = target?.words[unit];
  if (!target || !word) return project;
  const t = clampTime(time);
  const words = target.words.slice();
  const previous = words[unit - 1];
  const start = previous?.start != null ? Math.max(t, previous.start + MIN_WORD_MS) : t;
  words[unit] = { ...word, start, end: null };
  if (previous?.end != null && (previous.end > start || previous.end === word.start)) words[unit - 1] = { ...previous, end: start };
  return replaceLine(project, index, { ...target, words, start: unit === 0 ? start : target.start });
}

/**
 * A picked unit ends now. With `commit`, the unit after it starts here too
 * (keeping its own end), so the two stay joined.
 */
export function endUnit(project: StudioProject, index: number, unit: number, time: number, commit: boolean) {
  const target = at(project, index);
  const word = target?.words[unit];
  if (!target || !word || word.start == null) return project;
  const end = Math.max(word.start + MIN_WORD_MS, clampTime(time));
  const words = target.words.slice();
  words[unit] = { ...word, end };
  const following = words[unit + 1];
  if (commit && following) {
    words[unit + 1] = { ...following, start: end,
      end: following.end != null ? Math.max(following.end, end + MIN_WORD_MS) : null };
  }
  const last = words.length - 1;
  return replaceLine(project, index, { ...target, words, end: unit === last ? end : target.end, flagged: unit === last ? false : target.flagged });
}

/** The line's last word (and so the line) ends here: "Mark end of previous", or the next line starting. */
export function endLastWord(project: StudioProject, index: number, time: number) {
  const target = at(project, index);
  const lastWord = target?.words.at(-1);
  if (!target || !lastWord || lastWord.start == null) return project;
  const end = Math.max(lastWord.start + MIN_WORD_MS, clampTime(time));
  const words = target.words.slice();
  words[words.length - 1] = { ...lastWord, end };
  return replaceLine(project, index, { ...target, words, end, flagged: false });
}

/** Lines stage "Adjust timing": set a line's start and end by hand. */
export function setLineTiming(project: StudioProject, index: number, timing: { start?: number | null; end?: number | null }) {
  const target = at(project, index);
  if (!target) return project;
  if ('start' in timing && timing.start != null && Number.isFinite(timing.start)) {
    const t = clampTime(timing.start);
    // Word-synced: the whole line moves (rhythm and end too), like re-tapping its start.
    const anchor = target.words[0]?.start;
    if (anchor != null) return replaceLine(project, index, { ...shiftLine(project, index, t - anchor).lines[index], start: t });
    return replaceLine(project, index, { ...target, start: t, end: target.end != null && target.end >= t + MIN_WORD_MS ? target.end : null });
  }
  if ('end' in timing) {
    const start = rowStart(target);
    if (timing.end == null || !Number.isFinite(timing.end)) return replaceLine(project, index, { ...target, end: null });
    if (start == null) return project;
    const lastWord = target.words.at(-1);
    const floor = Math.max(start, lastWord?.start ?? start) + MIN_WORD_MS;
    const end = Math.max(floor, clampTime(timing.end));
    const words = lastWord?.end != null ? [...target.words.slice(0, -1), { ...lastWord, end }] : target.words;
    return replaceLine(project, index, { ...target, words, end });
  }
  return project;
}

/** Swipe mode: forget the line's word timings before a new pass. */
export function clearLineWords(project: StudioProject, index: number) {
  const target = at(project, index);
  if (!target) return project;
  return replaceLine(project, index, { ...target, words: target.words.map((word) => ({ ...word, start: null, end: null })) });
}

/**
 * Swipe mode: the finger entered word `wordIndex` (it starts now). Words the
 * finger skipped over since `fromIndex` share the time evenly, and every
 * earlier word ends where the next one starts.
 */
export function swipeEnterWord(project: StudioProject, index: number, wordIndex: number, fromIndex: number, time: number) {
  const target = at(project, index);
  if (!target || wordIndex <= fromIndex || wordIndex >= target.words.length) return project;
  const t = clampTime(time);
  const words = target.words.slice();
  const anchor = fromIndex >= 0 ? words[fromIndex].start ?? t : t;
  const span = Math.max(0, t - anchor);
  const steps = wordIndex - fromIndex;
  for (let i = fromIndex + 1; i <= wordIndex; i++) {
    const start = fromIndex < 0 ? t : clampTime(anchor + (span * (i - fromIndex)) / steps);
    words[i] = { ...words[i], start: Math.max(start, (i > 0 ? words[i - 1].start ?? 0 : 0) + (i > 0 ? MIN_WORD_MS : 0)), end: null };
  }
  for (let i = Math.max(0, fromIndex); i < wordIndex; i++) words[i] = { ...words[i], end: words[i + 1].start };
  return replaceLine(project, index, { ...target, words, start: fromIndex < 0 ? words[0].start : target.start ?? words[0].start });
}

/**
 * Swipe mode, finger lifted. Reaching the last word counts as the whole line,
 * even if the finger stopped before the word's right edge.
 */
export function swipeFinish(project: StudioProject, index: number, lastIndex: number, time: number) {
  const target = at(project, index);
  if (!target || lastIndex !== target.words.length - 1) return { project, finished: false };
  const words = target.words.slice();
  const end = Math.max((words[lastIndex].start ?? 0) + MIN_WORD_MS, clampTime(time));
  words[lastIndex] = { ...words[lastIndex], end };
  return { project: replaceLine(project, index, { ...target, words, end, flagged: false }), finished: true };
}

/**
 * Slide mode, sliding back: words after `wordIndex` lose their timing (the
 * highlighter left all their letters) and `wordIndex` is open again, so
 * sliding forward re-times them. -1 clears the whole line.
 */
export function swipeRetreat(project: StudioProject, index: number, wordIndex: number) {
  const target = at(project, index);
  if (!target) return project;
  const words = target.words.map((word, i) => (i > wordIndex ? { ...word, start: null, end: null } : i === wordIndex ? { ...word, end: null } : word));
  return replaceLine(project, index, { ...target, words, end: null, start: wordIndex < 0 ? null : target.start });
}

/**
 * Set one word's start and/or end by hand. The end stays after the start, the
 * line's start/end follow its first/last word, and other words are untouched.
 */
export function setWordTiming(project: StudioProject, index: number, wordIndex: number, timing: { start?: number | null; end?: number | null }) {
  const target = at(project, index);
  const word = target?.words[wordIndex];
  if (!target || !word) return project;
  const clean = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? null : clampTime(value));
  let start = 'start' in timing ? clean(timing.start) : word.start;
  let end = 'end' in timing ? clean(timing.end) : word.end;
  if (start != null && end != null && end < start + MIN_WORD_MS) {
    if ('end' in timing && !('start' in timing)) start = Math.max(0, end - MIN_WORD_MS);
    else end = start + MIN_WORD_MS;
  }
  const words = target.words.slice();
  words[wordIndex] = { ...word, start, end };
  const last = words.length - 1;
  return replaceLine(project, index, { ...target, words,
    start: wordIndex === 0 && start != null ? start : target.start,
    end: wordIndex === last && end != null ? end : target.end });
}

/** Fix one word's spelling. Its timing, spacing and the rest of the line stay as they are. */
export function setWordText(project: StudioProject, index: number, wordIndex: number, text: string) {
  const target = at(project, index);
  const word = target?.words[wordIndex];
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!target || !word || !clean) return project;
  const trailing = /\s+$/.exec(word.text)?.[0] ?? '';
  if (clean + trailing === word.text) return project;
  const words = target.words.slice();
  words[wordIndex] = { ...word, text: clean + trailing };
  return replaceLine(project, index, { ...target, words });
}

/** Other lines with exactly this line's text (main lines and ad-libs alike): where a spelling fix may also apply. */
export function sameTextLines(project: StudioProject, index: number) {
  const source = at(project, index);
  if (!source || source.instrumental || !source.words.length) return [];
  const text = lineText(source);
  return project.lines.flatMap((row, i) => (i !== index && !row.instrumental && lineText(row) === text ? [i] : []));
}

/**
 * Fix one unit's spelling here and, with `alsoIn`, in the same place of those
 * lines (found by its position in the text, so lines split differently still
 * match). Timing is kept everywhere.
 */
export function setWordTextEverywhere(project: StudioProject, index: number, wordIndex: number, text: string, alsoIn: number[] = []) {
  const source = at(project, index);
  const word = source?.words[wordIndex];
  if (!source || !word) return project;
  const offset = source.words.slice(0, wordIndex).reduce((sum, unit) => sum + unit.text.length, 0);
  let next = setWordText(project, index, wordIndex, text);
  for (const i of alsoIn) {
    const row = next.lines[i];
    if (!row) continue;
    let at = 0;
    const unit = row.words.findIndex((candidate) => { const here = at === offset && candidate.text.trim() === word.text.trim(); at += candidate.text.length; return here; });
    if (unit >= 0) next = setWordText(next, i, unit, text);
  }
  return next;
}

/** Move several words of one line together (start and end), e.g. to fix a phrase sung early. */
export function shiftWords(project: StudioProject, index: number, wordIndices: number[], deltaMs: number) {
  const target = at(project, index);
  if (!target || !wordIndices.length || !deltaMs) return project;
  const picked = new Set(wordIndices);
  const move = (value: number | null) => (value == null ? null : clampTime(value + deltaMs));
  const words = target.words.map((word, i) => (picked.has(i) ? { ...word, start: move(word.start), end: move(word.end) } : word));
  const last = words.length - 1;
  return replaceLine(project, index, { ...target, words,
    start: picked.has(0) && words[0].start != null ? words[0].start : target.start,
    end: picked.has(last) && words[last].end != null ? words[last].end : target.end });
}

/** The same units (and so the same syllable splits), word for word. */
/**
 * Move only the starts or only the ends of several units (the link in Adjust
 * words is off). Each unit keeps at least MIN_WORD_MS; the line start/end
 * follow the first/last unit.
 */
export function shiftWordEdges(project: StudioProject, index: number, wordIndices: number[], deltaMs: number, edge: 'start' | 'end') {
  const target = at(project, index);
  if (!target || !wordIndices.length || !deltaMs) return project;
  const picked = new Set(wordIndices);
  const words = target.words.map((word, i) => {
    if (!picked.has(i)) return word;
    if (edge === 'start' && word.start != null) {
      const start = clampTime(Math.min(word.start + deltaMs, word.end != null ? word.end - MIN_WORD_MS : Infinity));
      return { ...word, start };
    }
    if (edge === 'end' && word.end != null) {
      return { ...word, end: Math.max(clampTime(word.end + deltaMs), (word.start ?? 0) + MIN_WORD_MS) };
    }
    return word;
  });
  const last = words.length - 1;
  return replaceLine(project, index, { ...target, words,
    start: edge === 'start' && picked.has(0) && words[0].start != null ? words[0].start : target.start,
    end: edge === 'end' && picked.has(last) && words[last].end != null ? words[last].end : target.end });
}

const sameSplits = (a: StudioLine, b: StudioLine) => a.words.length === b.words.length &&
  a.words.every((word, i) => word.text.trim() === b.words[i].text.trim());

/** No syllable splits: the units are what the plain text would give. */
export const isUnsplit = (lineValue: StudioLine) => sameSplits(lineValue, { ...lineValue, words: splitWords(lineText(lineValue)) });

/**
 * Lines with exactly the same words as this one, however each is split into
 * syllables, and of the same kind (main lines with main lines, ad-libs with
 * ad-libs).
 */
export function matchingLines(project: StudioProject, index: number) {
  const source = at(project, index);
  if (!source || source.instrumental || !source.words.length) return [];
  const text = lineText(source);
  return project.lines.flatMap((row, i) => (i !== index && !row.instrumental && row.background === source.background &&
    lineText(row) === text ? [i] : []));
}

/**
 * Re-split a line into `units` (same text, other syllable splits). Timing is
 * kept letter by letter: a timed unit's span is shared among the letters, so
 * a new unit starts and ends where its letters were sung.
 */
function resplitLine(lineValue: StudioLine, units: StudioWord[]): StudioLine {
  const timeline: { start: number | null; end: number | null }[] = [];
  for (const word of lineValue.words) {
    const count = Math.max(1, characters(word.text).length);
    for (let k = 0; k < count; k++) {
      const span = word.start != null && word.end != null ? word.end - word.start : null;
      timeline.push({
        start: k === 0 ? word.start : span != null ? clampTime(word.start! + (span * k) / count) : null,
        end: k === count - 1 ? word.end : span != null ? clampTime(word.start! + (span * (k + 1)) / count) : null,
      });
    }
  }
  let cursor = 0;
  const words = units.map((unit) => {
    const count = Math.max(1, characters(unit.text).length);
    const first = timeline[cursor];
    const last = timeline[cursor + count - 1];
    cursor += count;
    return { text: unit.text, start: first?.start ?? null, end: last?.end ?? null, ...(unit.joinNext ? { joinNext: true } : {}) };
  });
  return { ...lineValue, words };
}

/**
 * "Split similar lines": give every match this line's syllable splits.
 * Matches split some other way keep their splits unless `includeDifferent`.
 */
export function copySplitsToMatchingLines(project: StudioProject, index: number, { includeDifferent = false }: { includeDifferent?: boolean } = {}) {
  const source = at(project, index);
  if (!source) return { project, applied: 0, same: 0, keptDifferent: 0 };
  let next = project;
  let applied = 0;
  let same = 0;
  let keptDifferent = 0;
  for (const i of matchingLines(project, index)) {
    const row = next.lines[i];
    if (sameSplits(row, source)) { same += 1; continue; }
    if (!includeDifferent && !isUnsplit(row)) { keptDifferent += 1; continue; }
    next = replaceLine(next, i, resplitLine(row, source.words));
    applied += 1;
  }
  return { project: next, applied, same, keptDifferent };
}

/**
 * Copy this line's word-by-word rhythm (and its syllable splits) to every
 * exact match of the same kind. Each match keeps its own place in the song
 * (its first word, or its line start); its words get the same spacing as this
 * line. Matches with no timing at all are skipped, since there is nowhere to
 * put them.
 */
export function applyTimingToMatchingLines(project: StudioProject, index: number,
  { includeSynced = false, exclude = [] }: { includeSynced?: boolean; exclude?: number[] } = {}) {
  const source = at(project, index);
  if (!source || !isLineWordSynced(source)) return { project, applied: 0, skipped: 0, keptSynced: 0 };
  const origin = source.words[0].start!;
  const sourceEnd = source.end ?? source.words.at(-1)!.end!;
  let next = project;
  let applied = 0;
  let skipped = 0;
  let keptSynced = 0;
  for (const i of matchingLines(project, index)) {
    if (exclude.includes(i)) continue;
    const row = next.lines[i];
    // Already word-synced lines keep their own timing unless asked to include them.
    if (!includeSynced && isLineWordSynced(row)) { keptSynced += 1; continue; }
    const anchor = row.words[0]?.start ?? row.start;
    if (anchor == null) { skipped += 1; continue; }
    const words = source.words.map((word) => ({ text: word.text, start: clampTime(anchor + word.start! - origin),
      end: clampTime(anchor + word.end! - origin), ...(word.joinNext ? { joinNext: true } : {}) }));
    next = replaceLine(next, i, { ...row, words, start: anchor, end: clampTime(anchor + sourceEnd - origin), flagged: false });
    applied += 1;
  }
  return { project: next, applied, skipped, keptSynced };
}

/**
 * Batch "Apply timing to all similar lines": each picked line copies its
 * timing to its own matches. Main lines only reach main lines and ad-libs
 * only ad-libs, so picking both kinds never mixes them; a picked line is
 * never overwritten by another picked line.
 */
export function applyTimingFromLines(project: StudioProject, sources: number[], options: { includeSynced?: boolean } = {}) {
  let next = project;
  let applied = 0;
  let skipped = 0;
  let keptSynced = 0;
  const changed = new Set<number>();
  for (const index of sources) {
    const before = next;
    const out = applyTimingToMatchingLines(next, index, { ...options, exclude: sources });
    next = out.project;
    skipped += out.skipped;
    keptSynced += out.keptSynced;
    next.lines.forEach((row, i) => { if (row !== before.lines[i]) changed.add(i); });
  }
  applied = changed.size;
  return { project: next, applied, skipped, keptSynced };
}

/** Read a typed time: "1:23.45", "83.45", "83.45s" or "83450ms". */
export function parseTimeInput(text: string): number | null {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?ms$/.test(value)) return Math.round(Number(value.slice(0, -2)));
  const clock = /^(?:(\d+):)?(\d+(?:\.\d+)?)s?$/.exec(value);
  if (!clock) return null;
  const ms = (Number(clock[1] || 0) * 60 + Number(clock[2])) * 1000;
  return Number.isFinite(ms) ? Math.round(ms) : null;
}

export function shiftLine(project: StudioProject, index: number, deltaMs: number) {
  const target = at(project, index);
  if (!target) return project;
  const move = (value: number | null) => (value == null ? null : clampTime(value + deltaMs));
  return replaceLine(project, index, { ...target, start: move(target.start), end: move(target.end),
    words: target.words.map((word) => ({ ...word, start: move(word.start), end: move(word.end) })) });
}

/**
 * Move only the first word's start (slide syncing often catches the first word
 * a little late). Its end and the rest of the line stay put.
 */
export function nudgeFirstWord(project: StudioProject, index: number, deltaMs: number) {
  const target = at(project, index);
  const first = target?.words[0];
  if (!target || !first || first.start == null) return project;
  const limit = first.end != null ? first.end - MIN_WORD_MS : Infinity;
  const start = Math.max(0, Math.min(limit, Math.round(first.start + deltaMs)));
  const words = target.words.slice();
  words[0] = { ...first, start };
  const lineStart = target.start == null || target.start === first.start || target.start > start ? start : target.start;
  return replaceLine(project, index, { ...target, words, start: lineStart });
}

export function setFlagged(project: StudioProject, index: number, flagged: boolean) {
  const target = at(project, index);
  return target && Boolean(target.flagged) !== flagged ? replaceLine(project, index, { ...target, flagged }) : project;
}

/** Move every timing earlier (negative) or later (positive). */
export function shiftAll(project: StudioProject, deltaMs: number) {
  return project.lines.reduce((next, _line, index) => shiftLine(next, index, deltaMs), project);
}

export function setLineText(project: StudioProject, index: number, text: string) {
  const target = at(project, index);
  if (!target) return project;
  if (isInstrumentalText(text)) return replaceLine(project, index, { ...target, words: [], instrumental: true, background: false });
  const parsed = parseAdLib(text);
  const words = splitWords(parsed.text);
  if (!words.length) return project;
  return replaceLine(project, index, { ...target, words, instrumental: false, background: target.background || parsed.background });
}

export function setBackground(project: StudioProject, index: number, background: boolean) {
  const target = at(project, index);
  return target ? replaceLine(project, index, { ...target, background }) : project;
}

/** Lines that can be a duet line: main lyric lines (ad-libs follow the line they belong to). */
export const canBeDuet = (lineValue: StudioLine | undefined) => Boolean(lineValue && !lineValue.background && !lineValue.instrumental);

/** Mark lines as sung by the other singer (duet) or back to the main singer. */
export function setDuet(project: StudioProject, indices: number[], duet: boolean) {
  let changed = false;
  const lines = project.lines.map((row, i) => {
    if (!indices.includes(i) || !canBeDuet(row) || Boolean(row.oppositeAligned) === duet) return row;
    changed = true;
    const { oppositeAligned: _previous, ...rest } = row;
    return duet ? { ...rest, oppositeAligned: true } : rest;
  });
  return changed ? touch(project, lines) : project;
}

export function deleteLine(project: StudioProject, index: number) {
  return at(project, index) ? touch(project, project.lines.filter((_, i) => i !== index)) : project;
}

export function insertLineAfter(project: StudioProject, index: number, text: string, background = false) {
  if (isInstrumentalText(text)) return insertInstrumentalAfter(project, index);
  const words = splitWords(parseAdLib(text).text);
  if (!words.length) return project;
  const lines = project.lines.slice();
  const adLib = background || parseAdLib(text).background;
  // A new main line below a duet line is sung by the same singer.
  const duet = !adLib && project.lines[previousLeadIndex(project, index + 1)]?.oppositeAligned;
  lines.splice(index + 1, 0, line(words, { background: adLib, ...(duet ? { oppositeAligned: true } : {}) }));
  return touch(project, lines);
}

/** Words `from`..`to` of a main line written in "(...)": the usual way ad-libs sit inside a line. */
export function bracketedWords(lineValue: StudioLine): { from: number; to: number } | null {
  const from = lineValue.words.findIndex((word) => /^\s*\(/.test(word.text));
  if (from < 0) return null;
  for (let to = from; to < lineValue.words.length; to++) if (/\)\s*$/.test(lineValue.words[to].text)) return { from, to };
  return null;
}

/**
 * Move words `from`..`to` of a main line into a new ad-lib row right below it.
 * Every word keeps its timing (all stay adjustable). Words on either side stay
 * on the main line with their timing, so an ad-lib from the middle works too.
 */
export function extractAdLib(project: StudioProject, index: number, from: number, to: number) {
  const target = at(project, index);
  if (!target || target.background || target.instrumental) return project;
  const first = Math.max(0, Math.min(from, to));
  const last = Math.min(target.words.length - 1, Math.max(from, to));
  if (last < first || last - first + 1 >= target.words.length) return project;
  const moved = target.words.slice(first, last + 1).map((word, i, all) => {
    let text = word.text;
    if (i === 0) text = text.replace(/^(\s*)\(/, '$1');
    if (i === all.length - 1) text = text.replace(/\)(\s*)$/, '$1').trimEnd();
    return { ...word, text, ...(i === all.length - 1 ? { joinNext: undefined } : {}) };
  }).filter((word) => word.text.trim());
  if (!moved.length) return project;
  const kept = [...target.words.slice(0, first), ...target.words.slice(last + 1)];
  // The word now ending the main line loses its trailing space.
  const lastKept = kept.length - 1;
  kept[lastKept] = { ...kept[lastKept], text: kept[lastKept].text.trimEnd(), joinNext: undefined };
  const main: StudioLine = {
    ...target, words: kept,
    start: first === 0 ? kept[0].start ?? target.start : target.start,
    end: last === target.words.length - 1 ? kept[lastKept].end ?? target.end : target.end,
  };
  const adLib = line(moved, { background: true, start: moved[0].start, end: moved[moved.length - 1].end });
  const lines = project.lines.slice();
  lines.splice(index, 1, main, adLib);
  return touch(project, lines);
}

/** Add a missing instrumental break; tap its start in the Lines stage. */
export function insertInstrumentalAfter(project: StudioProject, index: number) {
  const lines = project.lines.slice();
  lines.splice(index + 1, 0, instrumentalRow());
  return touch(project, lines);
}

// ---- Navigation ----------------------------------------------------------------

export type StudioStage = 'lines' | 'words';

/** Next row to work on: lead rows without a start (lines stage) or rows not fully word-timed (words stage). */
export function nextIndexToSync(project: StudioProject, from: number, stage: StudioStage) {
  const n = project.lines.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    const candidate = project.lines[i];
    if (stage === 'lines' ? !candidate.background && candidate.start == null : !isLineWordSynced(candidate)) return i;
  }
  return -1;
}

/** The row after `from` in the Words stage, synced already or not (instrumental breaks included: tap their start). */
export function nextWordRow(project: StudioProject, from: number) {
  return from + 1 < project.lines.length ? from + 1 : -1;
}

/** When each row is sung: its start until its end (or the next main row), for live highlighting. */
export function rowWindows(project: StudioProject): ({ start: number; end: number } | null)[] {
  const starts = project.lines.map(rowStart);
  return project.lines.map((row, index) => {
    const start = starts[index];
    if (start == null) return null;
    let next: number | null = null;
    for (let i = index + 1; i < project.lines.length && next == null; i++) if (!project.lines[i].background) next = starts[i];
    const end = row.end ?? row.words.at(-1)?.end ?? next ?? start + 4000;
    return { start, end: Math.max(start + MIN_WORD_MS, end) };
  });
}

/** Where to seek so the line is heard from a little before it starts (an untimed row uses the row before it). */
export function leadInPosition(project: StudioProject, index: number, leadInMs: number) {
  for (let i = index; i >= 0; i--) {
    const candidate = project.lines[i];
    const start = candidate.words[0]?.start ?? candidate.start;
    if (start != null) return Math.max(0, start - leadInMs);
  }
  return 0;
}

/** Row index playing at `time` (latest started lead row), or -1. */
/** The row's start if known: its first word or its line mark. */
export const rowStart = (lineValue: StudioLine) => lineValue.words[0]?.start ?? lineValue.start;

export function lineAtTime(project: StudioProject, time: number) {
  let found = -1;
  project.lines.forEach((candidate, index) => {
    const start = candidate.start ?? candidate.words[0]?.start;
    if (!candidate.background && start != null && start <= time) found = index;
  });
  return found;
}

export type StudioProgress = { lines: number; lineTimed: number; wordTimed: number; adLibs: number; instrumentals: number };
export function progress(project: StudioProject): StudioProgress {
  const sung = project.lines.filter((entry) => !entry.instrumental);
  return {
    lines: sung.length,
    lineTimed: sung.filter((entry) => rowStart(entry) != null).length,
    wordTimed: sung.filter(isLineWordSynced).length,
    adLibs: sung.filter((entry) => entry.background).length,
    instrumentals: project.lines.length - sung.length,
  };
}

// ---- Output ----------------------------------------------------------------------

/** Every word gets a start and end: untimed words share the gaps between timed ones evenly. */
function fillWordTimes(lineValue: StudioLine, fallbackEnd: number): LyricSyllable[] | null {
  const words = lineValue.words;
  const known = words.map((word) => word.start);
  if (!known.some((value) => value != null) && lineValue.start == null) return null;
  const lineStart = lineValue.start ?? known.find((value): value is number => value != null)!;
  const lastEnd = words.at(-1)?.end;
  const lineEnd = Math.max(lineStart + MIN_WORD_MS, lineValue.end ?? lastEnd ?? fallbackEnd);
  const starts: number[] = [];
  for (let i = 0; i < words.length; i++) {
    if (known[i] != null) { starts[i] = known[i]!; continue; }
    let j = i;
    while (j < words.length && known[j] == null) j++;
    const from = i === 0 ? lineStart : starts[i - 1];
    const to = j < words.length ? known[j]! : lineEnd;
    const step = (to - from) / (j - i + (i === 0 ? 0 : 1));
    for (let k = i; k < j; k++) starts[k] = Math.round(i === 0 ? from + step * (k - i) : from + step * (k - i + 1));
    i = j - 1;
  }
  return words.map((word, i) => {
    const start = starts[i];
    const nextStart = i + 1 < words.length ? starts[i + 1] : lineEnd;
    const end = word.end != null && word.end > start ? word.end : Math.max(start + MIN_WORD_MS, nextStart);
    return { text: i === words.length - 1 ? word.text.trimEnd() : word.text, startTime: start, endTime: end,
      isPartOfWord: Boolean(word.joinNext) && i < words.length - 1 };
  });
}

function wordTimed(lineValue: StudioLine) {
  return lineValue.words.some((word) => word.start != null);
}

/**
 * KineSync lyrics for preview, vault and TTML export. Rows that are not synced
 * at all are left out. Lead rows without word timing stay line-synced.
 */
export function lyricsFromProject(project: StudioProject): LyricLine[] {
  const leadStarts = project.lines.map((entry) => (entry.background ? null : entry.start ?? entry.words[0]?.start ?? null));
  const nextLeadStart = (index: number) => {
    for (let i = index + 1; i < leadStarts.length; i++) if (leadStarts[i] != null) return leadStarts[i]!;
    return null;
  };
  /** An instrumental row right after a line ends that line at the break. */
  const instrumentalAfter = (index: number) => {
    for (let i = index + 1; i < project.lines.length; i++) {
      if (project.lines[i].background) continue;
      return project.lines[i].instrumental ? project.lines[i].start : null;
    }
    return null;
  };
  const output: LyricLine[] = [];
  const outputIndexForRow: number[] = [];
  project.lines.forEach((entry, index) => {
    if (entry.background || entry.instrumental) return;
    const start = leadStarts[index];
    if (start == null) return;
    const fallbackEnd = nextLeadStart(index) ?? start + Math.max(1500, entry.words.length * 450);
    const text = lineText(entry);
    const cap = instrumentalAfter(index);
    let syllables = wordTimed(entry) ? fillWordTimes(entry, fallbackEnd)!
      : [{ text, startTime: start, endTime: Math.max(start + MIN_WORD_MS, entry.end ?? fallbackEnd) }];
    if (cap != null && cap > start) {
      syllables = syllables.map((syllable) => ({ ...syllable, startTime: Math.min(syllable.startTime, cap - MIN_WORD_MS),
        endTime: Math.min(syllable.endTime, cap) }));
    }
    output.push({
      lineStartTime: Math.min(start, syllables[0].startTime),
      lineEndTime: cap != null && cap > start ? Math.min(Math.max(entry.end ?? 0, syllables.at(-1)!.endTime), cap)
        : Math.max(entry.end ?? 0, syllables.at(-1)!.endTime),
      syllables,
      ...(entry.oppositeAligned ? { oppositeAligned: true } : {}),
      ...(entry.translatedText ? { translatedText: entry.translatedText } : {}),
    });
    outputIndexForRow[index] = output.length - 1;
  });
  project.lines.forEach((entry, index) => {
    if (!entry.background) return;
    const start = entry.start ?? entry.words[0]?.start ?? null;
    if (start == null) return;
    let owner = -1;
    for (let i = index - 1; i >= 0 && owner < 0; i--) if (outputIndexForRow[i] != null) owner = outputIndexForRow[i];
    if (owner < 0) owner = outputIndexForRow.find((value) => value != null) ?? -1;
    if (owner < 0) return;
    const syllables = wordTimed(entry)
      ? fillWordTimes(entry, start + Math.max(800, entry.words.length * 400))!
      : [{ text: lineText(entry), startTime: start, endTime: Math.max(start + MIN_WORD_MS, entry.end ?? start + 1500) }];
    const target = output[owner];
    const earlier = target.backgroundSyllables ?? [];
    // Two ad-libs under one line: keep a space between them.
    if (earlier.length) earlier[earlier.length - 1] = { ...earlier.at(-1)!, text: `${earlier.at(-1)!.text.trimEnd()} ` };
    target.backgroundSyllables = [...earlier, ...syllables];
    // A line lasts until its ad-lib ends (as in Apple/Spicy TTML); otherwise the
    // player sees a gap after the main words and skips ahead to "…" mid-ad-lib.
    target.lineEndTime = Math.max(target.lineEndTime, ...syllables.map((syllable) => syllable.endTime));
    // An ad-lib before the first line (a song opening on one) starts that line early.
    target.lineStartTime = Math.min(target.lineStartTime, ...syllables.map((syllable) => syllable.startTime));
  });
  return output;
}
