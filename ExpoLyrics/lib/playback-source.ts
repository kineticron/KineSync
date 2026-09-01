export type PlaybackMode = 'desktop' | 'mobile';

export function shouldAcceptPlaybackPacket(
  activeMode: PlaybackMode,
  packetSource: PlaybackMode,
) {
  return activeMode === packetSource;
}
