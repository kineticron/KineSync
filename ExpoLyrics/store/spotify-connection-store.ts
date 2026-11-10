import { create } from 'zustand';
import { initialSpotifyHealth, type SpotifyHealth } from '@/lib/spotify-detector/health';
// Native health never changes bridge transport routing.
export const useSpotifyConnectionStore = create<{ health: SpotifyHealth }>(() => ({ health: initialSpotifyHealth }));
