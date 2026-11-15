export const LONG_PRESS_MS: number;
export const DRAG_SLOP: number;
export type RustLyricsGesture = {
  grant(y: number): void;
  move(dy: number): void;
  release(): void;
  terminate(): void;
  isActive(): boolean;
  readonly token: number;
};
export function createRustLyricsGesture(options: {
  hitTest: (y: number) => number | Promise<number>;
  scrollBy: (dy: number) => void;
  setFollowing: (following: boolean) => void;
  tapEnabled: () => boolean;
  onLinePress: (index: number) => void;
  onLineLongPress: (index: number) => void;
  onAutoFollowChange: (enabled: boolean) => void;
  onUserInteraction: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): RustLyricsGesture;
