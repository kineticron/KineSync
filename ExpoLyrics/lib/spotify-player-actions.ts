type Actions = { reload: () => void; open: () => void; logout: () => void };
let current: Actions | null = null;
export function registerSpotifyPlayerActions(actions: Actions) {
  current = actions;
  return () => { if (current === actions) current = null; };
}
export function requestReloadSpotifyBrowser() { current?.reload(); }
export function requestOpenSpotifyBrowser() { current?.open(); }
export function requestLogoutSpotifyBrowser() { current?.logout(); }
