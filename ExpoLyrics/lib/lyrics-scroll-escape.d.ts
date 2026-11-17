export const ESCAPE_GRACE_MS: number;
export function createLyricsScrollEscape(): {
  readonly graceUntil: number;
  begin(offset: number): void;
  move(offset: number, target: number, now: number, input?: boolean, following?: boolean): void;
  release(target: number, radius: number, now: number, velocity?: number): boolean;
  reset(offset?: number): void;
};
