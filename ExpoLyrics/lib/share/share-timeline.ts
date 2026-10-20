/**
 * Lyric sharing: which lines go on the card and how they move in a video.
 * Everything here is a pure function of the song time, so every video frame
 * can be drawn on its own, in any order, at any speed, and always looks the
 * same.
 */
import { lyricTextWithRanges } from '@/lib/active-lyric-line';
import type { LyricLine, LyricSyllable } from '@/types/bridge';

export type ShareWord = { start: number; end: number; from: number; to: number };
export type ShareLine = {
  text: string;
  /** Character ranges of each timed unit in `text`, for the word-by-word fill. */
  words: ShareWord[];
  start: number;
  end: number;
  /** Timed word by word; otherwise the whole line lights at once. */
  wordSynced: boolean;
  /** The ad-lib (background vocals), shown smaller under the line. */
  adLib?: string;
  translation?: string;
  /** The source timing, for the Spicy-style animated words. */
  syllables: LyricSyllable[];
  adLibSyllables?: LyricSyllable[];
};

/** The longest video the share sheet makes. */
export const MAX_VIDEO_MS = 60_000;
/** The video starts a little before the first line and holds after the last. */
export const VIDEO_LEAD_IN_MS = 700;
export const VIDEO_TAIL_MS = 1200;
export const VIDEO_FPS = 30;

const finite = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export function shareLineFrom(line: LyricLine, { translation = false }: { translation?: boolean } = {}): ShareLine | null {
  const { text, ranges } = lyricTextWithRanges(line.syllables || []);
  if (!text) return null;
  const start = finite(line.lineStartTime, 0);
  const end = Math.max(start + 1, finite(line.lineEndTime, start + 3000));
  const words = (line.syllables || []).map((syllable, i) => ({
    start: finite(syllable.startTime, start), end: Math.max(finite(syllable.startTime, start) + 1, finite(syllable.endTime, end)),
    from: ranges[i][0], to: ranges[i][1],
  })).filter((word) => word.to > word.from);
  const adLib = lyricTextWithRanges(line.backgroundSyllables || []).text.replace(/^\(+|\)+$/g, '').trim();
  return {
    text, words, start, end,
    wordSynced: words.length > 1,
    syllables: line.syllables || [],
    ...(adLib ? { adLib: `(${adLib})`, adLibSyllables: line.backgroundSyllables } : {}),
    ...(translation && line.translatedText?.trim() ? { translation: line.translatedText.trim() } : {}),
  };
}

/** The picked lines, in order, without empty or instrumental ones. */
export function shareLines(lyrics: LyricLine[], from: number, to: number, options: { translation?: boolean } = {}) {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(lyrics.length - 1, Math.max(from, to));
  const out: ShareLine[] = [];
  for (let i = lo; i <= hi; i++) {
    const line = shareLineFrom(lyrics[i], options);
    if (line && !/^[♪….\s]+$/.test(line.text)) out.push(line);
  }
  return out;
}

/** When the video starts and ends in song time. */
export function videoWindow(lines: ShareLine[]) {
  if (!lines.length) return { start: 0, end: 0, durationMs: 0 };
  const start = Math.max(0, lines[0].start - VIDEO_LEAD_IN_MS);
  const end = Math.max(...lines.map((line) => line.end)) + VIDEO_TAIL_MS;
  return { start, end, durationMs: end - start };
}

export const frameCount = (durationMs: number, fps = VIDEO_FPS) => Math.max(1, Math.ceil((durationMs / 1000) * fps));

/** The line being sung at `time`: the last one started (the first before any). */
export function activeLineAt(lines: ShareLine[], time: number) {
  let active = 0;
  lines.forEach((line, i) => { if (line.start <= time) active = i; });
  return active;
}

/** How much of a word is sung at `time`, 0..1. */
export const wordProgress = (word: ShareWord, time: number) => Math.max(0, Math.min(1, (time - word.start) / Math.max(1, word.end - word.start)));

/** How lit a line is at `time`: 1 while sung, fading in as it starts and out after it ends. */
export function lineGlow(line: ShareLine, time: number) {
  if (time < line.start) return Math.max(0, 1 - (line.start - time) / 250) * 0.15;
  if (time <= line.end) return 1;
  return Math.max(0, 1 - (time - line.end) / 400);
}
