import type { LyricLine } from '@/types/bridge';
type ClockState = { anchorPositionMs: number; anchorMonotonicMs: number; isPlaying: boolean; currentTrack: { id: string; durationMs: number } | null };
export function buildRustTrack(trackId: string, generation: number, lines: LyricLine[]): string;
export function anchorChanged(state: ClockState, previous: ClockState): boolean;
export function projectPosition(state: ClockState, now: number): number;
