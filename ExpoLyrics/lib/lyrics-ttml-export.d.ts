import type { LyricLine, LyricsMetadata } from '@/types/bridge';
export function lyricsToTtml(options: { lyrics: LyricLine[]; title: string; artist: string; album?: string; source?: string; durationMs?: number; metadata?: LyricsMetadata; preserveOriginal?: boolean }): string;
export function buildDefaultTtmlFilename(options: { title: string; artist: string }): string;
