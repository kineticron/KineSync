import type { LyricLine } from '@/types/bridge';
type ClockState = { anchorPositionMs: number; anchorMonotonicMs: number; isPlaying: boolean; currentTrack: { id: string; durationMs: number } | null };
export type RustPaintVoice = { translation?: string; start: number; end: number; text: string; words: { text: string; offset: number; start: number; end: number; joined: boolean; gap_after: boolean; group: number | null; graphemes: string[]; appearance: { emphasized: boolean; origin: number; rtl: boolean; last: boolean; emphasis: { start: number; end: number; index: number; count: number; last: boolean } | null } }[]; cjk_breaks: number[]; opposite: boolean; duet: boolean };
export type RustCredits = { songwriters?: string[]; attribution?: { provider?: string; community?: boolean; maker?: string; uploader?: string } };
export function buildRustTrack(trackId: string, generation: number, lines: LyricLine[], prepared?: { settings: { style: 'spicy' | 'amll'; font_scale: number; landscape: boolean }; paints: RustPaintVoice[]; backgrounds?: RustPaintVoice[][]; credits?: RustCredits | null }): string;
export function anchorChanged(state: ClockState, previous: ClockState): boolean;
export function projectPosition(state: ClockState, now: number): number;
export type VisualAnchor = { positionMs: number; nativeMs: number; playing: boolean; rate: number; snap: boolean; source: ClockState; preview: boolean };
export function nextVisualAnchor(state: ClockState, now: number, nativeMs: number, rate: number, previous: VisualAnchor | null, previewPositionMs?: number | null): VisualAnchor;
