export function emitPickerTrace(stage: string, payload?: Record<string, unknown>): void;
export function evaluatePreferAutoCandidate(
  track: unknown,
  current: unknown,
  candidate: unknown,
): { upgrade: boolean; rule: string };
export function shouldPreferAutoCandidate(
  track: unknown,
  current: unknown,
  candidate: unknown,
): boolean;
export function autoCandidateCouldOutrank(
  track: unknown,
  current: unknown,
  source: string,
): boolean;
export function sourcePriority(packetOrSource: unknown): number;
export function isCommunitySpicy(packet: unknown): boolean;
export function pickAutoLyrics(
  lrcPacket: unknown,
  spicyPacket: unknown,
): { result: unknown; reason: string };
export function timingRank(packet: unknown): number;
