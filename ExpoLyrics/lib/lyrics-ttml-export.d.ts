import type { LyricLine } from '@/types/bridge';
export function lyricsToTtml(options: { lyrics: LyricLine[]; title: string; artist: string; source?: string; durationMs?: number }): string;
export function buildDefaultTtmlFilename(options: { title: string; artist: string }): string;
