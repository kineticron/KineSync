export type SpotifyPhase = 'idle' | 'suspended' | 'offline' | 'renewingSession' | 'connecting' | 'registering' | 'ready' | 'retryWait' | 'rateLimited' | 'signInRequired' | 'denied';
export type SpotifyReason = SpotifyPhase | 'disconnected' | 'discoveringRoutes' | 'freshTokenRejected' | 'sessionChallenge' | 'renewalExhausted';
export type SpotifyDisabledReason = SpotifyReason | CommandPhase | 'noActiveDevice' | 'restricted' | 'inactive' | '';
export type Reachability = 'online' | 'offline' | 'unknown';
export type CommandPhase = 'idle' | 'sending' | 'awaitingConfirmation' | 'outcomeUnknown';
export type SpotifyAllowedControls = Readonly<{
  resume: boolean;
  pause: boolean;
  next: boolean;
  previous: boolean;
  seek: boolean;
}>;
export const defaultAllowedControls: SpotifyAllowedControls = Object.freeze({
  resume: false,
  pause: false,
  next: false,
  previous: false,
  seek: false,
});
export type SpotifyHealth = Readonly<{
  source: 'nativeSpotify'; phase: SpotifyPhase; reason: SpotifyReason; generation: number; attempt: number;
  phaseStartedMono: number; nextRetryAtWall: number; retryNotBeforeWall: number;
  reachability: Reachability; appActivity: 'active' | 'inactive' | 'background';
  session: 'unknown' | 'valid' | 'renewing' | 'signInRequired' | 'denied';
  transportConfirmed: boolean; observerConfirmed: boolean; lastContactMono: number;
  lastStateReceiptMono: number; lastStateGeneration: number;
  target: 'unknown' | 'available' | 'absent' | 'restricted'; targetVersion: number;
  command: CommandPhase; controlsEnabled: boolean; disabledReason: SpotifyDisabledReason;
  allowed: SpotifyAllowedControls;
  lastError?: { category: 'transport' | 'timeout' | 'http' | 'rateLimit' | 'denied' | 'authentication'; httpStatus?: number; occurredAtWall: number };
}>;
export const initialSpotifyHealth: SpotifyHealth = { source: 'nativeSpotify', phase: 'idle', reason: 'disconnected', generation: 0,
  attempt: 0, phaseStartedMono: 0, nextRetryAtWall: 0, retryNotBeforeWall: 0, reachability: 'unknown', appActivity: 'active',
  session: 'unknown', transportConfirmed: false, observerConfirmed: false, lastContactMono: 0,
  lastStateReceiptMono: 0, lastStateGeneration: -1, target: 'unknown', targetVersion: 0,
  command: 'idle', controlsEnabled: false, disabledReason: 'disconnected',
  allowed: defaultAllowedControls };
export function spotifyHealthMessage(h: SpotifyHealth): string {
  if (h.command === 'outcomeUnknown' && (h.phase === 'ready' || h.phase === 'retryWait' || h.phase === 'connecting' || h.phase === 'registering')) return 'Playback outcome unknown. Checking Spotify…';
  if (h.command === 'sending') return 'Sending Spotify command…';
  if (h.command === 'awaitingConfirmation') return 'Updating playback status…';
  switch (h.phase) {
    case 'idle': return 'Connect Spotify';
    case 'suspended': return 'Checking Spotify connection…';
    case 'offline': return 'Offline · Spotify controls unavailable';
    case 'renewingSession': return 'Refreshing Spotify session…';
    case 'connecting': return 'Connecting to Spotify…';
    case 'registering': return 'Restoring Spotify connection…';
    case 'retryWait': return 'Connection lost · retrying automatically';
    case 'rateLimited': return 'Spotify is limiting requests · retrying after cooldown';
    case 'signInRequired': return 'Spotify session ended · sign in to reconnect';
    case 'denied': return 'Spotify unavailable for this account · review sign-in';
    case 'ready': return h.target === 'available' ? 'Spotify connected' : h.target === 'restricted' ? 'Spotify playback restricted' : 'Connected · no active Spotify device';
  }
}
