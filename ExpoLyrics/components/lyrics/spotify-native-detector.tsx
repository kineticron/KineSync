import { useSpotifyConnectionStore } from '@/store/spotify-connection-store';
import { subscribeSpotifyReachability } from '@/lib/spotify-detector/reachability';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Button, Platform, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { router } from 'expo-router';
import { SpotifyControlRejectedError, SpotifyDetector, SpotifyPlaybackUnavailableError } from '@/lib/spotify-detector/client';
import {
  registerPlaybackCommandTransport, schedulePlaybackCommandRefresh, submitPlaybackCommand,
} from '@/lib/optimistic-playback';
import type { PlaybackCommand } from '@/lib/playback-command-queue';
import { bootstrap, bootstrapAndroidObserver } from '@/lib/spotify-detector/bootstrap';
import { logDevelopmentLifecycle, logDevelopmentTiming } from '@/lib/spotify-detector/development-timing-log';
import { detectorPacket } from '@/lib/spotify-detector/packet';
import { clearTimingCapture, startTimingCapture, timingSnapshot } from '@/lib/spotify-detector/timing-diagnostics';
import type { Sample, TrackMetadata } from '@/lib/spotify-detector/protocol';
import { installBrowserControlPreludeScript, installBrowserControlScript, spotifyAuthProbeScript,
  isAllowedSpotifyWebViewNavigation, isTrustedSpotifyWebViewMessageUrl,
  makeBrowserCommandScript, parseBrowserEvent, SPOTIFY_WEBVIEW_ORIGIN_WHITELIST } from '@/lib/spotify-browser';
import { registerSpotifyPlayerActions } from '@/lib/spotify-player-actions';
import { saveMobileLyricsSettings } from '@/lib/mobile-lyrics-settings';
import { refreshLyricsForCurrentTrack } from '@/lib/lyrics-sync';
import { usePlaybackStore } from '@/store/playback-store';
import { useSpotifySessionStore } from '@/store/spotify-session-store';
import { usePlayerTourStore } from '@/store/player-tour-store';
import type { SpotifyBrowserFallbackHandle } from './spotify-browser-fallback';
import { registerNativeRendererReadyResync } from './native/native-renderer-ready-refresh';
import { emitNativeClockDiagnostic, nativeClockCaptureActive, NATIVE_CLOCK_HTTP_TRACE_SCRIPT } from '@/lib/native-clock-diagnostics';

const PLAYER_URL = 'https://open.spotify.com/';

const CAPTURE_SCRIPT = `${bootstrap}\n${Platform.OS === 'android' ? bootstrapAndroidObserver : ''}\n${NATIVE_CLOCK_HTTP_TRACE_SCRIPT}`;
const CONTROL_SCRIPT = `${spotifyAuthProbeScript}\n${installBrowserControlPreludeScript}\n${installBrowserControlScript}\n${makeBrowserCommandScript({ type: 'setMonitoring', enabled: false })}`;
const USER_AGENT = Platform.OS === 'android'
  ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
  : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function hasUsableTitle(title: string) {
  const trimmed = title.trim();
  return !!trimmed && !/^unknown track$/i.test(trimmed);
}

/** Native mobile-only: WebView bootstraps/renews login, Dealer owns detection.
 * Controls and metadata use the captured spclient session directly. */
export const SpotifyNativeDetector = forwardRef<SpotifyBrowserFallbackHandle>(function SpotifyNativeDetector(_props, ref) {
  const mobile = usePlaybackStore(s => s.playbackMode === 'mobile' && s.connectionStatus !== 'connected');
  const loggedOut = useSpotifySessionStore(s => s.loggedOut);
  const bootstrapAllowed = useSpotifyConnectionStore(s => !['rateLimited', 'offline', 'suspended', 'retryWait', 'denied'].includes(s.health.phase));
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserGeneration, setBrowserGeneration] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [status, setStatus] = useState('Connecting your Spotify session…');
  const web = useRef<WebView<object>>(null);
  const mounted = useRef(false);
  const documentUrl = useRef(PLAYER_URL);
  const browserRun = useRef(0);
  const warmDocument = useRef<number | null>(null);
  const captureRequest = useRef<{ id: number; warm: boolean } | null>(null);
  const lastSample = useRef<Sample | null>(null);
  const lyricsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lyricsDispatchedRun = useRef(-1);
  const enriched = useRef(new Map<string, TrackMetadata>());
  const enrichmentRun = useRef(0);
  const metadataPending = useRef('');
  const metadataAttempts = useRef(new Map<string, number>());
  const diagnostics = useRef({ samples: 0, sourceTimestampMs: 0, receivedAtMs: 0, device: '', status: '' });
  const callbacks = useRef({ sample: (_s: Sample) => {}, status: (_s: string) => {}, sessionNeeded: (_id: number) => {}, sessionFinished: (_id: number) => {}, authenticated: (_token: string, _expires: number) => {} });
  const detectorRef = useRef<SpotifyDetector | null>(null);
  if (!detectorRef.current) detectorRef.current = new SpotifyDetector({
    health: health => {
      useSpotifyConnectionStore.setState({ health });
      schedulePlaybackCommandRefresh();
    },
    sample: s => callbacks.current.sample(s), status: s => callbacks.current.status(s),
    sessionNeeded: id => callbacks.current.sessionNeeded(id), sessionFinished: id => callbacks.current.sessionFinished(id), authenticated: (t, e) => callbacks.current.authenticated(t, e),
    ready: () => {},
  });
  const detector = detectorRef.current;
  const canIngest = useCallback(() => AppState.currentState !== 'background' && mounted.current && !usePlayerTourStore.getState().active && !usePlayerTourStore.getState().pending && !useSpotifySessionStore.getState().loggedOut &&
    usePlaybackStore.getState().playbackMode === 'mobile' && usePlaybackStore.getState().connectionStatus !== 'connected', []);
  const publish = (s: Sample, stage: 'sample-publish' | 'metadata-publish' = 'sample-publish') => {
    if (!canIngest()) return;
    logDevelopmentTiming(stage, s);
    const metadata = enriched.current.get(s.uri);
    const packet = detectorPacket(metadata ? { ...s, title: metadata.title || s.title,
      artist: metadata.artist || s.artist, album: metadata.album || s.album,
      artworkUrl: metadata.artworkUrl || s.artworkUrl } : s);
    const store = usePlaybackStore.getState();
    const beforeMono = __DEV__ && nativeClockCaptureActive() ? performance.now() : null;
    const result = store.ingestPacket(packet, 'mobile');
    if (beforeMono !== null) {
      const after = usePlaybackStore.getState();
      const now = performance.now();
      const beforeProjected = store.anchorPositionMs + (store.isPlaying ? Math.max(0, now - store.anchorMonotonicMs) : 0);
      const afterProjected = after.anchorPositionMs + (after.isPlaying ? Math.max(0, now - after.anchorMonotonicMs) : 0);
      emitNativeClockDiagnostic('store-ingest-result', { publication: stage, rawPosition: s.positionMs,
        playerTimestamp: s.positionTimestampMs, serverTimestamp: s.sourceServerTimestampMs,
        receiptWall: s.positionObservedAt?.wallMs, receiptMono: s.positionObservedAt?.monotonicMs,
        normalizedPosition: packet.positionMs, packetWall: packet.capturedAtMs, playing: s.playing,
        beforeAnchorPosition: store.anchorPositionMs, beforeAnchorMono: store.anchorMonotonicMs,
        afterAnchorPosition: after.anchorPositionMs, afterAnchorMono: after.anchorMonotonicMs,
        beforeProjected, afterProjected, sourceCorrectionMs: afterProjected - beforeProjected,
        sourceIdentityComplete: after.sourceAnchorProof !== null,
        sourceAnchorPreserved: store.sourceAnchorProof !== null &&
          store.sourceAnchorProof?.key === after.sourceAnchorProof?.key &&
          store.anchorPositionMs === after.anchorPositionMs && store.anchorMonotonicMs === after.anchorMonotonicMs,
        trackChanged: result.trackChanged, seekDetected: result.seekDetected, ingestMs: now - beforeMono });
    }
    if (result.trackChanged) {
      logDevelopmentTiming('store-track-change', s);
      enrichmentRun.current++;
      metadataPending.current = '';
      if (lyricsTimer.current !== null) clearTimeout(lyricsTimer.current);
      lyricsTimer.current = null;
      store.setLyricsStatusMessage('Spotify detected. Loading mobile lyrics…');
    }
    const run = enrichmentRun.current;
    const uri = s.uri;
    const ownsSample = () => canIngest() && run === enrichmentRun.current && lastSample.current?.uri === uri &&
      usePlaybackStore.getState().currentTrack?.id === packet.trackId;
    const currentTrack = usePlaybackStore.getState().currentTrack;
    // A complete observation can start lyrics while catalog enrichment runs.
    // Sparse observations pass through here again when enrichment is published.
    if (lyricsTimer.current === null && lyricsDispatchedRun.current !== run && ownsSample() &&
        currentTrack && hasUsableTitle(currentTrack.title) && currentTrack.artist.trim()) {
      const timer = setTimeout(() => {
        if (lyricsTimer.current !== timer) return;
        lyricsTimer.current = null;
        const track = usePlaybackStore.getState().currentTrack;
        if (!ownsSample() || !track || !hasUsableTitle(track.title) || !track.artist.trim()) return;
        lyricsDispatchedRun.current = run;
        void refreshLyricsForCurrentTrack('auto');
      }, 100);
      lyricsTimer.current = timer;
    }
    const needsMetadata = !packet.artist.trim() || !packet.album || !hasUsableTitle(packet.title) || !packet.artworkUrl;
    if ((result.trackChanged || (!metadata && needsMetadata)) && metadataPending.current !== s.uri && (metadataAttempts.current.get(s.uri) ?? 0) < 3) {
      metadataPending.current = s.uri;
      if (metadataAttempts.current.size >= 32) metadataAttempts.current.clear();
      metadataAttempts.current.set(s.uri, (metadataAttempts.current.get(s.uri) ?? 0) + 1);
      // This bearer is scoped for spclient, not the public Web API. Resolve
      // the exact track GID, with no artist-dependent search prerequisite.
      void detector.metadata(uri).then(match => {
        if (!match || !ownsSample()) return;
        if (enriched.current.size >= 32) enriched.current.clear();
        enriched.current.set(uri, match);
        if (lastSample.current) publish(lastSample.current, 'metadata-publish');
      }).catch(error => {
        if (ownsSample()) {
          const message = error instanceof Error ? error.message : 'Spotify metadata lookup failed.';
          diagnostics.current.status = message;
          if (!usePlaybackStore.getState().currentTrack?.artist) store.setLyricsStatusMessage(`${message} Reconnect Spotify to retry artist lookup.`);
        }
      }).finally(() => {
        if (run === enrichmentRun.current && metadataPending.current === uri) metadataPending.current = '';
      });
    }
  };
  const remount = useCallback(() => {
    metadataAttempts.current.clear();
    warmDocument.current = null;
    if (captureRequest.current) captureRequest.current.warm = false;
    browserRun.current++; setBrowserGeneration(browserRun.current);
    documentUrl.current = PLAYER_URL;
    setLoggingOut(false);
  }, []);
  callbacks.current = {
    sample: s => {
      if (!canIngest()) return;
      lastSample.current = s;
      diagnostics.current = { ...diagnostics.current, samples: diagnostics.current.samples + 1,
        sourceTimestampMs: s.positionTimestampMs ?? 0, receivedAtMs: s.receivedAt, device: s.device };
      publish(s);
      setStatus(`Spotify detector active · ${s.device || 'Spotify device'}`);
    },
    status: s => {
      if (mounted.current) {
        diagnostics.current.status = s; setStatus(s);
        if (__DEV__) console.debug('[Spotify detector]', s);
      }
    },
    sessionNeeded: id => {
      if (!mounted.current || useSpotifySessionStore.getState().loggedOut) return;
      const warm = warmDocument.current === browserRun.current && web.current !== null;
      captureRequest.current = { id, warm };
      if (!warm) { remount(); return; }
      web.current?.injectJavaScript(`(function () {
        if (location.origin !== 'https://open.spotify.com') return;
        if (window.__startDetectorCapture) window.__startDetectorCapture(${id});
        else window.ReactNativeWebView.postMessage(JSON.stringify({type:'session', state:'unavailable', captureId:${id}}));
      })(); true;`);
    },
    sessionFinished: id => {
      const request = captureRequest.current;
      if (request?.id !== id) return;
      captureRequest.current = null;
      web.current?.injectJavaScript(`window.__cancelDetectorCapture && window.__cancelDetectorCapture(${request.warm ? id : 0}); true;`);
    },
    authenticated: (token, expiresAt) => {
      if (!canIngest()) return;
      useSpotifySessionStore.getState().setSignedIn(true);
      void saveMobileLyricsSettings({ spotifyWebToken: token, spotifyWebTokenExpiresAt: expiresAt });
    },
  };
  const openBrowser = useCallback(() => {
    if (detector.health.phase === 'denied' || detector.health.phase === 'signInRequired') detector.beginSignIn();
    if (!useSpotifySessionStore.getState().signedIn) { router.push({ pathname: '/explore', params: { action: 'login' } }); return; }
    setBrowserOpen(true);
  }, [detector]);
  const runDiagnostics = useCallback(() => {
    if (!__DEV__) return;
    Alert.alert('Spotify timing diagnostics', 'Optional: capture up to 60 seconds and 256 timing records in memory, then share. Device and playback session identities use temporary labels. No playback adjustment is applied.', [
      { text: 'Start capture', onPress: startTimingCapture },
      { text: 'Share capture', onPress: () => { void Share.share({ message: JSON.stringify(timingSnapshot(), null, 2) }).catch(() => {}); } },
      { text: 'Clear', style: 'destructive', onPress: clearTimingCapture },
    ]);
  }, []);
  const sendCommand = useCallback((command: PlaybackCommand | 'toggle') => {
    if (!useSpotifySessionStore.getState().signedIn) { openBrowser(); return; }
    if (canIngest()) submitPlaybackCommand(command);
  }, [canIngest, openBrowser]);
  const resyncPlayback = useCallback(() => { metadataAttempts.current.clear(); detector.refresh(); }, [detector]);
  useImperativeHandle(ref, () => ({ openBrowser, reload: () => { if (detector.health.phase !== 'rateLimited') { detector.refresh(true); if (detector.health.phase === 'denied' || detector.health.phase === 'signInRequired') remount(); } },
    togglePlayPause: () => sendCommand('toggle'), resyncPlayback,
    skipPrevious: () => sendCommand({ type: 'previous' }), skipNext: () => sendCommand({ type: 'next' }),
    seekTo: positionMs => sendCommand({ type: 'seek', positionMs: Math.max(0, positionMs) }), runDiagnostics,
  }), [detector, openBrowser, remount, resyncPlayback, runDiagnostics, sendCommand]);

  useEffect(() => {
    mounted.current = true;
    logDevelopmentLifecycle('cold-mount', { next: AppState.currentState });
    const enrichmentEpoch = enrichmentRun;
    const unregisterTransport = registerPlaybackCommandTransport('mobile', {
      accountVersion: () => detector.playbackAccountVersion,
      canQueue: () => detector.health.session !== 'denied' && detector.health.session !== 'signInRequired',
      read: () => canIngest() ? detector.playbackCommandState : { ready: false },
      requestObservation: () => { if (canIngest()) detector.recheckPlaybackObservation(); },
      send: async command => {
        if (command.type === 'resync') return 'rejected';
        try {
          await detector.control(command, 'queue');
          return 'sent';
        } catch (error) {
          return error instanceof SpotifyControlRejectedError || error instanceof SpotifyPlaybackUnavailableError ? 'rejected' : 'unknown';
        }
      },
    });
    const unregister = registerSpotifyPlayerActions({
      resolveTrackMetadata: id => canIngest() ? detector.metadata(`spotify:track:${id}`) : undefined,
      open: openBrowser, reload: () => { if (detector.health.phase !== 'rateLimited') { detector.refresh(true); if (detector.health.phase === 'denied' || detector.health.phase === 'signInRequired') remount(); } }, logout: () => {
      detector.clear(); enrichmentRun.current++; enriched.current.clear(); lastSample.current = null;
      metadataAttempts.current.clear(); metadataPending.current = '';
      setBrowserOpen(false); setLoggingOut(true);
      browserRun.current++; setBrowserGeneration(browserRun.current);
    } });
    return () => {
      mounted.current = false; unregister(); unregisterTransport(); detector.clear(); enrichmentEpoch.current++;
      if (lyricsTimer.current !== null) clearTimeout(lyricsTimer.current);
      lyricsTimer.current = null;
    };
  }, [canIngest, detector, openBrowser, remount]);
  useEffect(() => registerNativeRendererReadyResync({ canResync: canIngest, resyncPlayback }), [canIngest, resyncPlayback]);
  useEffect(() => {
    if (loggedOut) { detector.clear(); enrichmentRun.current++; metadataAttempts.current.clear(); metadataPending.current = ''; lastSample.current = null; enriched.current.clear(); }
    const update = (activity = AppState.currentState) => {
      const enabled = mobile && !loggedOut && activity !== 'background';
      logDevelopmentLifecycle('observation-policy', { next: activity, enabled, mobile, loggedOut });
      detector.setEnabled(enabled);
    };
    detector.setActivity(AppState.currentState === 'active' ? 'active' : AppState.currentState === 'background' ? 'background' : 'inactive');
    update();
    const unsubscribeNetwork = subscribeSpotifyReachability((hint, path) => detector.setReachability(hint, path));
    let previous = AppState.currentState;
    const sub = AppState.addEventListener('change', next => {
      logDevelopmentLifecycle('app-state', { previous, next });
      previous = next;
      detector.setActivity(next === 'active' ? 'active' : next === 'background' ? 'background' : 'inactive');
      if (next === 'background') detector.setEnabled(false);
      else if (next === 'active') update(next);
    });
    return () => { sub.remove(); unsubscribeNetwork(); detector.setEnabled(false); };
  }, [detector, mobile, loggedOut]);

  const showWebView = loggingOut || (!loggedOut && bootstrapAllowed && (browserOpen || mobile));
  useEffect(() => {
    if (!showWebView) {
      warmDocument.current = null;
      browserRun.current++; setBrowserGeneration(browserRun.current);
    }
  }, [showWebView]);
  useEffect(() => { if (browserOpen && web.current) web.current.injectJavaScript(CONTROL_SCRIPT); }, [browserOpen]);
  if (!showWebView) return null;
  const run = browserGeneration;
  return <View pointerEvents={browserOpen ? 'auto' : 'none'} aria-hidden={!browserOpen}
    style={[styles.root, !browserOpen && styles.hidden]}>
    {browserOpen && <SafeAreaView edges={_stableEdges1} style={styles.header}>
      <Text style={styles.title}>Spotify</Text><Text style={styles.status}>{status}</Text>
      <View style={styles.buttons}><Button title="Reconnect" onPress={() => { if (detector.health.phase !== 'rateLimited') { detector.refresh(true); if (detector.health.phase === 'denied' || detector.health.phase === 'signInRequired') remount(); } }} />
        {__DEV__ && <Button title="Diagnostics" onPress={runDiagnostics} />}<Button title="Close" onPress={() => setBrowserOpen(false)} /></View>
    </SafeAreaView>}
    <WebView<object> key={`spotify-detector-${browserGeneration}`} ref={web}
      source={loggingOut ? LOGOUT_SOURCE : PLAYER_SOURCE}
      originWhitelist={SPOTIFY_WEBVIEW_ORIGIN_WHITELIST}
      userAgent={USER_AGENT} contentMode="desktop" sharedCookiesEnabled thirdPartyCookiesEnabled
      domStorageEnabled javaScriptEnabled setSupportMultipleWindows={false}
      mediaPlaybackRequiresUserAction allowsInlineMediaPlayback
      injectedJavaScriptBeforeContentLoaded={CAPTURE_SCRIPT} injectedJavaScript={CAPTURE_SCRIPT}
      onNavigationStateChange={e => { if (run === browserRun.current) documentUrl.current = e.url; }}
      onShouldStartLoadWithRequest={e => run === browserRun.current && isAllowedSpotifyWebViewNavigation(e.url, e.isTopFrame)}
      onLoadStart={() => { if (run === browserRun.current) warmDocument.current = null; }}
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
        if (__DEV__ && nativeClockCaptureActive()) {
          try {
            const diagnostic = JSON.parse(e.nativeEvent.data);
            if (diagnostic.type === 'nativeClockHttp' && diagnostic.status === 410 &&
              ['browser-device-registration', 'browser-player-state', 'browser-track-playback', 'browser-other'].includes(diagnostic.endpoint)) {
              emitNativeClockDiagnostic('browser-http-410', { endpoint: diagnostic.endpoint, status: 410,
                browserWallMs: typeof diagnostic.wallMs === 'number' ? diagnostic.wallMs : null,
                cacheProvenance: 'browser-response-status-only' });
              return;
            }
          } catch { /* Ignore malformed diagnostic messages; existing parser remains authoritative. */ }
        }
        if (!canIngest()) return;
        try {
          const message = JSON.parse(e.nativeEvent.data);
          if (message.type === 'notice' && message.message === 'Network capture installed.') warmDocument.current = run;
          const request = captureRequest.current;
          if (request && (request.warm ? message.captureId === request.id : message.captureId === undefined)) {
            if (request.warm && message.type === 'session' && message.state === 'unavailable') {
              remount();
              return;
            }
            detector.capture(e.nativeEvent.data, origin, request.id);
          }
        } catch { /* Ignore malformed capture messages. */ }
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
  hidden: Platform.OS === 'android' ? { opacity: 0.01, elevation: 0, zIndex: -1 } : { transform: [{ translateX: -10000 }] },
  header: { padding: 14, backgroundColor: '#0A0B11' },
  title: { color: '#FFF', fontSize: 18, fontWeight: '600' }, status: { color: '#AAB5BB', marginVertical: 8 },
  buttons: { flexDirection: 'row', justifyContent: 'space-between' }, web: { flex: 1 },
});

// Static native props retain their identity across renders.
const _stableEdges1 = ['top'] as const;
const LOGOUT_SOURCE = { uri: 'https://accounts.spotify.com/logout' };
const PLAYER_SOURCE = { uri: PLAYER_URL };
