import type { Track } from '@/types/bridge';

/** TTML duration is the last vocal timestamp, not the recording's duration. */
export async function resolveImportedVaultTrack(track: Track): Promise<Track> {
  if (track.spotifyTrackId || !track.title || !track.artist) return track;
  try {
    // Load only for imports: the lyrics client itself depends on vault lookup.
    const { resolveSpotifyImportMatch } = await import('@/lib/mobile-lyrics-client');
    const match = await resolveSpotifyImportMatch(track);
    return match ? { ...track, spotifyTrackId: match.id } : track;
  } catch {
    // Offline, expired tokens, ambiguous matches and provider failures must not
    // prevent ownership of an imported document. Title/artist lookup still works.
    return track;
  }
}
