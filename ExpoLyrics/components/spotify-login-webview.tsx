import { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewProps } from 'react-native-webview';

import {
  isAllowedSpotifyLoginNavigation,
  isTrustedSpotifyWebViewMessageUrl,
  spotifyAuthProbeScript,
  SPOTIFY_WEBVIEW_ORIGIN_WHITELIST,
} from '@/lib/spotify-browser';

const LOGIN_URL = 'https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F';
const PLAYER_URL = 'https://open.spotify.com/';
const ANDROID_PLAYER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

export function SpotifyLoginWebView({ onMessage }: Pick<WebViewProps, 'onMessage'>) {
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState(false);
  const [playerPhase, setPlayerPhase] = useState(false);
  const documentUrl = useRef(LOGIN_URL);
  const retry = () => {
    documentUrl.current = LOGIN_URL;
    setError(false);
    setPlayerPhase(false);
    setGeneration(value => value + 1);
  };

  return (
    <View style={styles.container}>
      {error && (
        <View style={styles.error}>
          <Text style={styles.message}>Spotify sign-in stopped responding. Retry to open a fresh login page.</Text>
        </View>
      )}
      <WebView
        key={`spotify-login-${generation}-${playerPhase ? 'player' : 'accounts'}`}
        source={{ uri: playerPhase ? PLAYER_URL : LOGIN_URL }}
        originWhitelist={SPOTIFY_WEBVIEW_ORIGIN_WHITELIST}
        // Use the real browser identity for Accounts and its security challenges.
        // Desktop emulation belongs to the playback WebView, not sign-in.
        userAgent={playerPhase ? ANDROID_PLAYER_USER_AGENT : undefined}
        contentMode={playerPhase ? 'desktop' : 'recommended'}
        injectedJavaScript={spotifyAuthProbeScript}
        onShouldStartLoadWithRequest={({ url, isTopFrame }) => {
          const allowed = isAllowedSpotifyLoginNavigation(url, isTopFrame);
          if (allowed && isTopFrame !== false && Platform.OS === 'android' && !playerPhase &&
              /^https:\/\/open\.spotify\.com\//.test(url)) {
            // Accounts cookies are already shared. Remount the player with its
            // desktop identity before Android's unsupported mobile player loads.
            documentUrl.current = PLAYER_URL;
            setPlayerPhase(true);
            return false;
          }
          if (allowed && isTopFrame !== false) documentUrl.current = url;
          return allowed;
        }}
        onNavigationStateChange={({ url }) => {
          documentUrl.current = url;
          if (Platform.OS === 'android' && !playerPhase && /^https:\/\/open\.spotify\.com\//.test(url)) {
            setPlayerPhase(true);
          }
        }}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        domStorageEnabled
        javaScriptEnabled
        setSupportMultipleWindows={false}
        onError={() => setError(true)}
        onHttpError={({ nativeEvent }) => {
          if (nativeEvent.statusCode >= 400) setError(true);
        }}
        onContentProcessDidTerminate={() => setError(true)}
        onRenderProcessGone={() => setError(true)}
        onMessage={event => {
          // iOS may omit the message URL. Challenge pages may navigate here,
          // but only Accounts/the player may report a session or token.
          const url = event.nativeEvent.url || documentUrl.current;
          if (url && isTrustedSpotifyWebViewMessageUrl(url)) onMessage?.(event);
        }}
        style={styles.container}
      />
      <View style={styles.error}>
        <Pressable accessibilityRole="button" onPress={retry} style={styles.retry}>
          <Text style={styles.message}>Retry sign-in</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  error: { padding: 16, backgroundColor: '#242424', gap: 12 },
  message: { color: '#FFFFFF' },
  retry: { alignSelf: 'flex-start', padding: 12, backgroundColor: '#454545', borderRadius: 8 },
});
