export const ESCAPE_GRACE_MS: number;
export function createLyricsScrollEscape(): {
  begin(offset: number): void;
  move(offset: number, target: number, now: number, input?: boolean): void;
  release(target: number, radius: number, now: number, velocity?: number): boolean;
  reset(offset?: number): void;
};
