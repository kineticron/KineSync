import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

import {
  getCachedMobileLyricsSettings,
  saveMobileLyricsSettings,
} from "@/lib/mobile-lyrics-settings";
import {
  notifySpotifyTokenRefreshed,
  refreshNotificationAccess,
  resyncSpotifyApp,
  startSpotifyAppTracking,
  useSpotifyTokenRequest,
} from "@/lib/spotify-app";
import {
  installBrowserControlPreludeScript,
  isAllowedSpotifyWebViewNavigation,
  isTrustedSpotifyWebViewMessageUrl,
  parseBrowserEvent,
  spotifyAuthProbeScript,
  SPOTIFY_WEBVIEW_ORIGIN_WHITELIST,
} from "@/lib/spotify-browser";
import { useSpotifySessionStore } from "@/store/spotify-session-store";

const TOKEN_PAGE_URL = "https://open.spotify.com/";
const TOKEN_PAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
// Refresh shortly before Spotify's one-hour web token expires.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
// Tokens captured from request headers carry no expiry; assume a short life.
const ASSUMED_TOKEN_LIFETIME_MS = 50 * 60_000;
const TOKEN_PAGE_TIMEOUT_MS = 30_000;
const TOKEN_RETRY_DELAY_MS = 2 * 60_000;
const TOKEN_CHECK_INTERVAL_MS = 60_000;

function hasValidToken() {
  const settings = getCachedMobileLyricsSettings();
  if (!settings.spotifyWebToken) return false;
  const expiresAt = settings.spotifyWebTokenExpiresAt;
  return !expiresAt || expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now();
}

/**
 * Phone-only playback that follows the Spotify app. The Spotify web player is
 * not kept running: a hidden page opens only to sign-in check and refresh the
 * Spotify token used by id-based lyric sources, then closes again.
 */
export function SpotifyAppTracker() {
  const [tokenPageOpen, setTokenPageOpen] = useState(false);
  const lastAttemptRef = useRef(0);
  // Once Spotify reports no session, wait for a sign-in instead of retrying.
  const signedOutRef = useRef(false);
  const loggedOut = useSpotifySessionStore((s) => s.loggedOut);
  const tokenRequestedAt = useSpotifyTokenRequest((s) => s.requestedAt);

  useEffect(() => startSpotifyAppTracking(hasValidToken), []);

  // Pick up a notification-access grant and Spotify's latest state on return.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      refreshNotificationAccess();
      resyncSpotifyApp(hasValidToken);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => useSpotifySessionStore.subscribe((state) => {
    if (state.signedIn) signedOutRef.current = false;
  }), []);

  const maybeOpenTokenPage = useCallback((force = false) => {
    if (loggedOut || signedOutRef.current || AppState.currentState !== "active") return;
    // Run once per launch even with a stored token, to confirm the sign-in.
    const signedIn = useSpotifySessionStore.getState().signedIn;
    if (!force && signedIn && hasValidToken()) return;
    if (Date.now() - lastAttemptRef.current < TOKEN_RETRY_DELAY_MS && !force) return;
    lastAttemptRef.current = Date.now();
    setTokenPageOpen(true);
  }, [loggedOut]);

  useEffect(() => {
    maybeOpenTokenPage();
    const timer = setInterval(() => maybeOpenTokenPage(), TOKEN_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [maybeOpenTokenPage]);

  // A lyrics lookup asked for a token: open the page now if it is missing.
  useEffect(() => {
    if (!tokenRequestedAt) return;
    if (hasValidToken() || loggedOut || signedOutRef.current) notifySpotifyTokenRefreshed();
    else maybeOpenTokenPage(true);
  }, [loggedOut, maybeOpenTokenPage, tokenRequestedAt]);

  useEffect(() => {
    if (!tokenPageOpen) return;
    const timer = setTimeout(() => {
      setTokenPageOpen(false);
      notifySpotifyTokenRefreshed();
    }, TOKEN_PAGE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [tokenPageOpen]);

  if (!tokenPageOpen) return null;
  return (
    <View pointerEvents="none" style={styles.hidden} importantForAccessibility="no-hide-descendants">
      <WebView
        source={{ uri: TOKEN_PAGE_URL }}
        originWhitelist={SPOTIFY_WEBVIEW_ORIGIN_WHITELIST}
        injectedJavaScriptBeforeContentLoaded={installBrowserControlPreludeScript}
        injectedJavaScript={spotifyAuthProbeScript}
        onShouldStartLoadWithRequest={({ url, isTopFrame }) =>
          isAllowedSpotifyWebViewNavigation(url, isTopFrame)}
        onMessage={(event) => {
          const url = event.nativeEvent.url || TOKEN_PAGE_URL;
          if (!isTrustedSpotifyWebViewMessageUrl(url)) return;
          const message = parseBrowserEvent(event.nativeEvent.data);
          if (!message) return;
          if (message.type === "signedIn") {
            useSpotifySessionStore.getState().setSignedIn(message.signedIn);
            if (!message.signedIn) {
              signedOutRef.current = true;
              setTokenPageOpen(false);
              notifySpotifyTokenRefreshed();
            }
            return;
          }
          if (message.type === "spotifyToken" && message.token) {
            const expiresAt = Number(message.expiresAt || 0) || Date.now() + ASSUMED_TOKEN_LIFETIME_MS;
            void saveMobileLyricsSettings({
              spotifyWebToken: message.token,
              spotifyWebTokenExpiresAt: expiresAt,
            }).finally(() => {
              setTokenPageOpen(false);
              notifySpotifyTokenRefreshed();
            });
          }
        }}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        domStorageEnabled
        javaScriptEnabled
        // The page is only used for its sign-in session and token, never audio.
        mediaPlaybackRequiresUserAction
        setSupportMultipleWindows={false}
        userAgent={TOKEN_PAGE_USER_AGENT}
        style={styles.webView}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden", left: -10, top: -10 },
  webView: { width: 1, height: 1 },
});
