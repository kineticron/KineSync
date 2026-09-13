import { create } from 'zustand';

// Recheck shared WebView cookies each launch. A persisted flag can outlive the
// login, and Spotify's anonymous tokens do not prove a signed-in session.
export const useSpotifySessionStore = create<{
  signedIn: boolean;
  setSignedIn: (signedIn: boolean) => void;
}>((set) => ({
  signedIn: false,
  setSignedIn: (signedIn) => set({ signedIn }),
}));
