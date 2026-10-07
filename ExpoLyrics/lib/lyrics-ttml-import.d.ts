import type { LyricLine, LyricsMetadata } from '@/types/bridge';
export function parseTtmlToLyrics(content: string): { lyrics: LyricLine[]; durationMs: number; useKaraokeTiming: boolean; metadata?: LyricsMetadata };
export function extractTtmlMetadata(content: string): { title: string; artist: string; album?: string };
