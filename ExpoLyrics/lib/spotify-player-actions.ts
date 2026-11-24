import type { TrackMetadata } from './spotify-detector/protocol';

type Actions = {
  reload: () => void;
  open: () => void;
  logout: () => void;
  resolveTrackMetadata?: (spotifyTrackId: string) => Promise<TrackMetadata> | undefined;
};
let current: Actions | null = null;
export function registerSpotifyPlayerActions(actions: Actions) {
  current = actions;
  return () => { if (current === actions) current = null; };
}
export function requestReloadSpotifyBrowser() { current?.reload(); }
export function requestOpenSpotifyBrowser() { current?.open(); }
export function requestLogoutSpotifyBrowser() { current?.logout(); }

export async function resolveSpotifyTrackIsrc(spotifyTrackId: string): Promise<string> {
  if (spotifyTrackId.length !== 22 || !/^[A-Za-z0-9]{22}$/.test(spotifyTrackId)) return '';
  const actions = current;
  try {
    const metadata = await actions?.resolveTrackMetadata?.(spotifyTrackId);
    if (current !== actions) return '';
    const isrc = metadata?.isrc;
    return typeof isrc === 'string' && isrc.length === 12 && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : '';
  } catch {
    return '';
  }
}
