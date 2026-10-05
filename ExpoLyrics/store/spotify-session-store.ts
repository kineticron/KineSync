import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const LOGGED_OUT_KEY = 'kinesync_spotify_logged_out';
let logoutChanged = false;

// Recheck shared WebView cookies each launch. A persisted flag can outlive the
// login, and Spotify's anonymous tokens do not prove a signed-in session.
export const useSpotifySessionStore = create<{
  signedIn: boolean;
  loggedOut: boolean;
  setLoggedOut: (value: boolean) => void;
  setSignedIn: (signedIn: boolean) => void;
}>((set) => ({
  signedIn: false,
  loggedOut: false,
  setLoggedOut: (loggedOut) => {
    logoutChanged = true;
    set({ loggedOut, ...(loggedOut ? { signedIn: false } : {}) });
    void AsyncStorage.setItem(LOGGED_OUT_KEY, String(loggedOut)).catch(() => {});
  },
  setSignedIn: (signedIn) => set({ signedIn }),
}));

void AsyncStorage.getItem(LOGGED_OUT_KEY).then(value => {
  if (!logoutChanged && value === 'true') useSpotifySessionStore.setState({ loggedOut: true, signedIn: false });
}).catch(() => {});
