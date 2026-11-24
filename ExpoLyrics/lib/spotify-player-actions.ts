import type { TrackMetadata } from './spotify-detector/protocol';

type Actions = {
  reload: () => void;
  open: () => void;
  logout: () => void;
  resolveTrackMetadata?: (spotifyTrackId: string) => Promise<TrackMetadata> | undefined;
};
let current: { actions: Actions } | null = null;
export function registerSpotifyPlayerActions(actions: Actions) {
  const registration = { actions };
  current = registration;
  return () => { if (current === registration) current = null; };
}
export function requestReloadSpotifyBrowser() { current?.actions.reload(); }
export function requestOpenSpotifyBrowser() { current?.actions.open(); }
export function requestLogoutSpotifyBrowser() { current?.actions.logout(); }

type BoundTrackMetadata = TrackMetadata & { spotifyTrackId: string };

export async function resolveSpotifyTrackMetadata(spotifyTrackId: string): Promise<BoundTrackMetadata | undefined> {
  if (spotifyTrackId.length !== 22 || !/^[A-Za-z0-9]{22}$/.test(spotifyTrackId)) return undefined;
  const registration = current;
  try {
    const metadata = await registration?.actions.resolveTrackMetadata?.(spotifyTrackId);
    if (!metadata || current !== registration) return undefined;
    if (metadata.id != null && metadata.id !== spotifyTrackId) return undefined;
    if (metadata.spotifyTrackId != null && metadata.spotifyTrackId !== spotifyTrackId) return undefined;
    return { ...metadata, spotifyTrackId, ...(metadata.artists ? { artists: [...metadata.artists] } : {}) };
  } catch {
    return undefined;
  }
}

export async function resolveSpotifyTrackIsrc(spotifyTrackId: string): Promise<string> {
  const isrc = (await resolveSpotifyTrackMetadata(spotifyTrackId))?.isrc;
  return typeof isrc === 'string' && isrc.length === 12 && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : '';
}
