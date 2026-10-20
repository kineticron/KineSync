import type { LyricsMetadata } from '@/types/bridge';
type LyricsProvenance = { metadata?: LyricsMetadata & { vault?: { originalSource?: string; savedAt?: number } }; originalSource?: string; source?: string; sourceLabel?: string; savedAt?: number };
export const SPICY_MAX_AGE_MS: number;
export function isSpicyLyricsResponse(entry?: LyricsProvenance): boolean;
export function isSpicyCommunityLyrics(entry?: LyricsProvenance): boolean;
export function spicyLyricsExpiresAt(entry?: LyricsProvenance): number | null;
export function withSpicyFreshness(entry: LyricsProvenance): LyricsMetadata | undefined;
export function assertLyricsExportAllowed(entry?: LyricsProvenance): void;
