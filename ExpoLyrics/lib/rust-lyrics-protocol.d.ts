import type { LyricLine } from '@/types/bridge';
type ClockState = { anchorPositionMs: number; anchorMonotonicMs: number; isPlaying: boolean; currentTrack: { id: string; durationMs: number } | null };
export function buildRustTrack(trackId: string, generation: number, lines: LyricLine[]): string;
export function anchorChanged(state: ClockState, previous: ClockState): boolean;
export function projectPosition(state: ClockState, now: number): number;
export type VisualAnchor = { positionMs: number; nativeMs: number; playing: boolean; rate: number; snap: boolean; source: ClockState; preview: boolean };
export function nextVisualAnchor(state: ClockState, now: number, nativeMs: number, rate: number, previous: VisualAnchor | null, previewPositionMs?: number | null): VisualAnchor;
export function rustViewport(height: number, lyricsTop: number, controlsTop: number | null): { bottom: number; height: number };
