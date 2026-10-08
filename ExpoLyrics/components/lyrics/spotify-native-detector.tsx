import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Button, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { router } from 'expo-router';
import { SpotifyDetector } from '@/lib/spotify-detector/client';
import { bootstrap } from '@/lib/spotify-detector/bootstrap';
import { detectorPacket } from '@/lib/spotify-detector/packet';
import type { Sample } from '@/lib/spotify-detector/protocol';
import { installBrowserControlPreludeScript, installBrowserControlScript, spotifyAuthProbeScript,
  isAllowedSpotifyWebViewNavigation, isTrustedSpotifyWebViewMessageUrl,
  makeBrowserCommandScript, parseBrowserEvent, SPOTIFY_WEBVIEW_ORIGIN_WHITELIST, type BrowserCommand } from '@/lib/spotify-browser';
import { registerSpotifyPlayerActions } from '@/lib/spotify-player-actions';
import { saveMobileLyricsSettings } from '@/lib/mobile-lyrics-settings';
import { refreshLyricsForCurrentTrack } from '@/lib/lyrics-sync';
import { usePlaybackStore } from '@/store/playback-store';
import { useSpotifySessionStore } from '@/store/spotify-session-store';
import { usePlayerTourStore } from '@/store/player-tour-store';
import type { SpotifyBrowserFallbackHandle } from './spotify-browser-fallback';

const PLAYER_URL = 'https://open.spotify.com/';
const CAPTURE_SCRIPT = `${bootstrap}\n${spotifyAuthProbeScript}`;
const CONTROL_SCRIPT = `${installBrowserControlPreludeScript}\n${installBrowserControlScript}\n${makeBrowserCommandScript({ type: 'setMonitoring', enabled: false })}`;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/** iOS mobile-only: WKWebView bootstraps/renews login, Dealer owns detection.
 * Controls and metadata use the captured spclient session directly. */
export const SpotifyNativeDetector = forwardRef<SpotifyBrowserFallbackHandle>(function SpotifyNativeDetector(_props, ref) {
  const mobile = usePlaybackStore(s => s.playbackMode === 'mobile' && s.connectionStatus !== 'connected');
  const loggedOut = useSpotifySessionStore(s => s.loggedOut);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [sessionNeeded, setSessionNeeded] = useState(true);
  const [browserGeneration, setBrowserGeneration] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [status, setStatus] = useState('Connecting your Spotify session…');
  const web = useRef<WebView<object>>(null);
  const mounted = useRef(false);
  const documentUrl = useRef(PLAYER_URL);
  const browserRun = useRef(0);
  const lastSample = useRef<Sample | null>(null);
  const lyricsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enriched = useRef(new Map<string, { artist: string; album: string }>());
  const enrichmentRun = useRef(0);
  const metadataPending = useRef('');
  const metadataAttempts = useRef(new Map<string, number>());
  const diagnostics = useRef({ samples: 0, sourceTimestampMs: 0, receivedAtMs: 0, device: '', status: '' });
  const callbacks = useRef({ sample: (_s: Sample) => {}, status: (_s: string) => {}, sessionNeeded: () => {}, authenticated: (_token: string, _expires: number) => {}, ready: () => {} });
  const detectorRef = useRef<SpotifyDetector | null>(null);
  if (!detectorRef.current) detectorRef.current = new SpotifyDetector({
    sample: s => callbacks.current.sample(s), status: s => callbacks.current.status(s),
    sessionNeeded: () => callbacks.current.sessionNeeded(), authenticated: (t, e) => callbacks.current.authenticated(t, e),
    ready: () => callbacks.current.ready(),
  });
  const detector = detectorRef.current;
  const canIngest = () => mounted.current && !usePlayerTourStore.getState().active && !usePlayerTourStore.getState().pending && !useSpotifySessionStore.getState().loggedOut &&
    usePlaybackStore.getState().playbackMode === 'mobile' && usePlaybackStore.getState().connectionStatus !== 'connected';
  const publish = (s: Sample) => {
    if (!canIngest()) return;
    const metadata = enriched.current.get(s.uri);
    const packet = detectorPacket(metadata ? { ...s, artist: metadata.artist || s.artist, album: metadata.album || s.album } : s);
    const store = usePlaybackStore.getState();
    const result = store.ingestPacket(packet, 'mobile');
    if (result.trackChanged) {
      enrichmentRun.current++;
      metadataPending.current = '';
      if (lyricsTimer.current) clearTimeout(lyricsTimer.current);
      store.setLyricsStatusMessage('Spotify detected. Loading mobile lyrics…');
    }
    const needsMetadata = !packet.artist.trim() || !packet.album;
    if ((result.trackChanged || needsMetadata) && metadataPending.current !== s.uri && (metadataAttempts.current.get(s.uri) ?? 0) < 3) {
      metadataPending.current = s.uri;
      if (metadataAttempts.current.size >= 32) metadataAttempts.current.clear();
      metadataAttempts.current.set(s.uri, (metadataAttempts.current.get(s.uri) ?? 0) + 1);
      const run = enrichmentRun.current;
      const uri = s.uri;
      // This bearer is scoped for spclient, not the public Web API. Resolve
      // the exact track GID, with no artist-dependent search prerequisite.
      void detector.metadata(uri).then(match => {
        if (!match || !canIngest() || run !== enrichmentRun.current || lastSample.current?.uri !== uri) return;
        if (enriched.current.size >= 32) enriched.current.clear();
        enriched.current.set(uri, { artist: match.artist, album: match.album });
        if (lastSample.current) publish(lastSample.current);
      }).catch(error => {
        if (canIngest() && run === enrichmentRun.current) {
          const message = error instanceof Error ? error.message : 'Spotify metadata lookup failed.';
          diagnostics.current.status = message;
          if (!usePlaybackStore.getState().currentTrack?.artist) store.setLyricsStatusMessage(`${message} Reconnect Spotify to retry artist lookup.`);
        }
      }).finally(() => {
        if (run === enrichmentRun.current && metadataPending.current === uri) metadataPending.current = '';
        if (!canIngest() || run !== enrichmentRun.current) return;
        // Artist-less title searches can pick the wrong song or fail entirely.
        // Keep detection running, but wait for metadata before lyrics search.
        if (!usePlaybackStore.getState().currentTrack?.artist?.trim()) return;
        lyricsTimer.current = setTimeout(() => {
          lyricsTimer.current = null;
          if (canIngest() && usePlaybackStore.getState().currentTrack?.id === packet.trackId) void refreshLyricsForCurrentTrack('auto');
        }, 100);
      });
    }
  };
  callbacks.current = {
    ready: () => { if (canIngest()) setSessionNeeded(false); },
    sample: s => {
      if (!canIngest()) return;
      lastSample.current = s;
      diagnostics.current = { ...diagnostics.current, samples: diagnostics.current.samples + 1,
        sourceTimestampMs: s.positionTimestampMs ?? 0, receivedAtMs: s.receivedAt, device: s.device };
      publish(s);
      setStatus(`Spotify detector active · ${s.device || 'Spotify device'}`);
    },
    status: s => { if (mounted.current) { diagnostics.current.status = s; setStatus(s); } },
    sessionNeeded: () => { if (mounted.current && !useSpotifySessionStore.getState().loggedOut) setSessionNeeded(true); },
    authenticated: (token, expiresAt) => {
      if (!mounted.current || useSpotifySessionStore.getState().loggedOut) return;
      useSpotifySessionStore.getState().setSignedIn(true);
      void saveMobileLyricsSettings({ spotifyWebToken: token, spotifyWebTokenExpiresAt: expiresAt });
    },
  };
  const remount = useCallback(() => {
    metadataAttempts.current.clear();
    browserRun.current++; setBrowserGeneration(browserRun.current);
    documentUrl.current = PLAYER_URL;
    setSessionNeeded(true); setLoggingOut(false);
  }, []);
  const openBrowser = useCallback(() => {
    if (!useSpotifySessionStore.getState().signedIn) { router.push({ pathname: '/explore', params: { action: 'login' } }); return; }
    setBrowserOpen(true);
  }, []);
  const runDiagnostics = useCallback(() => {
    void Share.share({ message: JSON.stringify({ detector: diagnostics.current,
      browserMounted: !!web.current, mobileOnly: usePlaybackStore.getState().playbackMode === 'mobile',
      positionMs: usePlaybackStore.getState().playbackPosition }, null, 2) }).catch(() => {});
  }, []);
  const sendCommand = useCallback((command: BrowserCommand) => {
    if (!useSpotifySessionStore.getState().signedIn) { openBrowser(); return; }
    if (!['toggle', 'previous', 'next', 'seek'].includes(command.type)) return;
    void detector.control(command as { type: 'toggle' | 'previous' | 'next' | 'seek'; positionMs?: number }).catch(error => {
      if (!canIngest()) return;
      const message = error instanceof Error ? error.message : 'Spotify command failed.';
      diagnostics.current.status = message; setStatus(message);
      Alert.alert('Spotify control', message);
      // A refused seek must replace the screen's optimistic scrub anchor.
      if (command.type === 'seek' && !message.includes('429')) detector.refresh();
    });
  }, [detector, openBrowser]);
  useImperativeHandle(ref, () => ({ openBrowser, reload: () => { remount(); detector.refresh(); },
    togglePlayPause: () => sendCommand({ type: 'toggle' }), resyncPlayback: () => { metadataAttempts.current.clear(); detector.refresh(); },
    skipPrevious: () => sendCommand({ type: 'previous' }), skipNext: () => sendCommand({ type: 'next' }),
    seekTo: positionMs => sendCommand({ type: 'seek', positionMs: Math.max(0, positionMs) }), runDiagnostics,
  }), [detector, openBrowser, remount, runDiagnostics, sendCommand]);

  useEffect(() => {
    mounted.current = true;
    const enrichmentEpoch = enrichmentRun;
    const unregister = registerSpotifyPlayerActions({ open: openBrowser, reload: () => { remount(); detector.refresh(); }, logout: () => {
      detector.clear(); enrichmentRun.current++; enriched.current.clear(); lastSample.current = null;
      metadataAttempts.current.clear(); metadataPending.current = '';
      setBrowserOpen(false); setLoggingOut(true);
      browserRun.current++; setBrowserGeneration(browserRun.current);
    } });
    return () => {
      mounted.current = false; unregister(); detector.clear(); enrichmentEpoch.current++;
      if (lyricsTimer.current) clearTimeout(lyricsTimer.current);
    };
  }, [detector, openBrowser, remount]);
  useEffect(() => {
    if (loggedOut) { detector.clear(); enrichmentRun.current++; metadataAttempts.current.clear(); metadataPending.current = ''; lastSample.current = null; enriched.current.clear(); }
    const update = () => detector.setEnabled(mobile && !loggedOut && AppState.currentState !== 'background');
    update();
    const sub = AppState.addEventListener('change', next => {
      if (next === 'background') detector.setEnabled(false);
      else if (next === 'active') update();
    });
    return () => { sub.remove(); detector.setEnabled(false); };
  }, [detector, mobile, loggedOut]);

  const showWebView = loggingOut || (!loggedOut && (browserOpen || (mobile && sessionNeeded)));
  useEffect(() => {
    if (!showWebView) {
      browserRun.current++; setBrowserGeneration(browserRun.current);
    }
  }, [showWebView]);
  useEffect(() => { if (browserOpen && web.current) web.current.injectJavaScript(CONTROL_SCRIPT); }, [browserOpen]);
  if (!showWebView) return null;
  const run = browserGeneration;
  return <View pointerEvents={browserOpen ? 'auto' : 'none'} aria-hidden={!browserOpen}
    style={[styles.root, !browserOpen && styles.hidden]}>
    {browserOpen && <SafeAreaView edges={['top']} style={styles.header}>
      <Text style={styles.title}>Spotify</Text><Text style={styles.status}>{status}</Text>
      <View style={styles.buttons}><Button title="Reconnect" onPress={() => { remount(); detector.refresh(); }} />
        <Button title="Diagnostics" onPress={runDiagnostics} /><Button title="Close" onPress={() => setBrowserOpen(false)} /></View>
    </SafeAreaView>}
    <WebView<object> key={`spotify-detector-${browserGeneration}`} ref={web}
      source={{ uri: loggingOut ? 'https://accounts.spotify.com/logout' : PLAYER_URL }}
      originWhitelist={SPOTIFY_WEBVIEW_ORIGIN_WHITELIST}
      userAgent={USER_AGENT} contentMode="desktop" sharedCookiesEnabled thirdPartyCookiesEnabled
      domStorageEnabled javaScriptEnabled setSupportMultipleWindows={false}
      mediaPlaybackRequiresUserAction allowsInlineMediaPlayback
      injectedJavaScriptBeforeContentLoaded={CAPTURE_SCRIPT} injectedJavaScript={CAPTURE_SCRIPT}
      onNavigationStateChange={e => { if (run === browserRun.current) documentUrl.current = e.url; }}
      onShouldStartLoadWithRequest={e => run === browserRun.current && isAllowedSpotifyWebViewNavigation(e.url, e.isTopFrame)}
      onLoadEnd={() => {
        if (run !== browserRun.current) return;
        if (loggingOut) { setLoggingOut(false); return; }
        web.current?.injectJavaScript(CAPTURE_SCRIPT);
        if (browserOpen) web.current?.injectJavaScript(CONTROL_SCRIPT);
      }}
      onMessage={e => {
        if (run !== browserRun.current || loggedOut || !mounted.current) return;
        const origin = e.nativeEvent.url || documentUrl.current;
        if (!isTrustedSpotifyWebViewMessageUrl(origin)) return;
        detector.capture(e.nativeEvent.data, origin);
        const event = parseBrowserEvent(e.nativeEvent.data);
        if (event?.type === 'signedIn') useSpotifySessionStore.getState().setSignedIn(event.signedIn);
        if (event?.type === 'ready') {
          web.current?.injectJavaScript(makeBrowserCommandScript({ type: 'setMonitoring', enabled: false }));
        }
        if (event?.type === 'error') setStatus(event.message);
      }}
      onError={() => setStatus('Spotify could not load. Open Spotify and reconnect.')}
      onContentProcessDidTerminate={() => { if (run === browserRun.current) remount(); }}
      startInLoadingState renderLoading={() => <ActivityIndicator color="#8FF0C4" />}
      style={styles.web} />
  </View>;
});
const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, backgroundColor: '#0A0B11', zIndex: 40 },
  hidden: { transform: [{ translateX: -10000 }] },
  header: { padding: 14, backgroundColor: '#0A0B11' },
  title: { color: '#FFF', fontSize: 18, fontWeight: '600' }, status: { color: '#AAB5BB', marginVertical: 8 },
  buttons: { flexDirection: 'row', justifyContent: 'space-between' }, web: { flex: 1 },
});
