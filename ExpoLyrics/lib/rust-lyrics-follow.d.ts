export type FollowCommand = { value: boolean; epoch: number; generation: number; gesture: boolean };
export type RustLyricsFollow = {
  sync(trackId: string, followEnabled: boolean): void;
  readonly epoch: number;
  readonly desired: boolean;
  readonly resetPending: boolean;
  issue(value: boolean, generation: number, gesture?: boolean): FollowCommand;
  reconcile(generation: number): FollowCommand | null;
  reassert(generation: number): FollowCommand;
  accept(ownershipEpoch: number, generation: number): boolean;
};
export function createRustLyricsFollow(): RustLyricsFollow;
