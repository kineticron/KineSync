import type { LyricLine } from '@/types/bridge';
export function parseTtmlToLyrics(content: string): { lyrics: LyricLine[]; durationMs: number; useKaraokeTiming: boolean };
export function extractTtmlMetadata(content: string): { title: string; artist: string };
