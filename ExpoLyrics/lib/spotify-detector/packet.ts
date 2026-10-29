import type { PlaybackPacket } from '../../types/bridge';
import { projectedPosition, type Sample } from './protocol';
import { numericEvidence, recordTiming, tagTimingPacket } from './timing-diagnostics';

/** Normalize the source anchor once, to a local receipt timestamp. Passing an
 * old source epoch to the store would apply transport compensation twice. */
export function detectorPacket(sample: Sample, now = Date.now()): PlaybackPacket {
  const positionMs = projectedPosition(sample, now);
  const spotifyTrackId = /^spotify:track:([a-zA-Z0-9]{22})$/.exec(sample.uri)?.[1] ?? '';
  const packet: PlaybackPacket = {
    type: 'playback', trackId: `spotify-connect:${spotifyTrackId}`, spotifyTrackId,
    title: sample.title, artist: sample.artist, album: sample.album,
    artworkUrl: sample.artworkUrl, durationMs: sample.durationMs,
    positionMs, isPlaying: sample.playing, timestamp: now, capturedAtMs: now,
    timing: { anchorPositionMs: positionMs, projectedPositionMs: positionMs,
      isPlaying: sample.playing, nativeExtrapolationEnabled: true },
  };
  tagTimingPacket(packet, sample.timingProvenance);
  recordTiming('packet', sample.timingProvenance, { positionMs: numericEvidence(positionMs),
    basisMs: numericEvidence(sample.positionTimestampMs ?? sample.receivedAt), normalizedTimestampMs: numericEvidence(now), playing: sample.playing });
  return packet;
}
