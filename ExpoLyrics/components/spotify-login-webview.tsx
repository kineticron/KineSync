import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewProps } from 'react-native-webview';

import {
  isAllowedSpotifyWebViewNavigation,
  spotifyAuthProbeScript,
  SPOTIFY_WEBVIEW_ORIGIN_WHITELIST,
} from '@/lib/spotify-browser';

const LOGIN_URL = 'https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F';

export function SpotifyLoginWebView({ onMessage }: Pick<WebViewProps, 'onMessage'>) {
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState(false);
  const retry = () => {
    setError(false);
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
        key={`spotify-login-${generation}`}
        source={{ uri: LOGIN_URL }}
        originWhitelist={SPOTIFY_WEBVIEW_ORIGIN_WHITELIST}
        // Use the real browser identity for Accounts and its security challenges.
        // Desktop emulation belongs to the playback WebView, not sign-in.
        injectedJavaScript={spotifyAuthProbeScript}
        onShouldStartLoadWithRequest={({ url, isTopFrame }) => isAllowedSpotifyWebViewNavigation(url, isTopFrame)}
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
        onMessage={onMessage}
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
