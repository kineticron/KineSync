import { Ionicons } from "@expo/vector-icons";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import {
  installBrowserControlPreludeScript,
  installBrowserControlScript,
  makeBrowserCommandScript,
  parseBrowserEvent,
  type BrowserCommand,
  type BrowserEvent,
} from "@/lib/spotify-browser";
import { refreshLyricsForCurrentTrack } from "@/lib/lyrics-sync";
import { saveMobileLyricsSettings } from "@/lib/mobile-lyrics-settings";
import { usePlaybackStore } from "@/store/playback-store";
import type { PlaybackPacket } from "@/types/bridge";

const DESKTOP_WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

const BROWSER_URL = "https://open.spotify.com/";

type PlaybackSample = Extract<BrowserEvent, { type: "playback" }>;
type DiagnosticEvent = Extract<BrowserEvent, { type: "diagnostics" }>;

type BrowserTrackMetadata = {
  title: string;
  artist: string;
  spotifyTrackId?: string;
};

export type SpotifyBrowserFallbackHandle = {
  openBrowser: () => void;
  reload: () => void;
  togglePlayPause: () => void;
  resyncPlayback: () => void;
  skipPrevious: () => void;
  skipNext: () => void;
  seekTo: (positionMs: number) => void;
  runDiagnostics: () => void;
};

function getBrowserTrackId(metadata: BrowserTrackMetadata, durationMs: number) {
  return [
    "spotify-browser",
    metadata.spotifyTrackId || metadata.title.trim().toLowerCase(),
    metadata.artist.trim().toLowerCase(),
    Math.max(0, Math.round(durationMs || 0)),
  ].join(":");
}

function formatDiagnostics(diagnostics: DiagnosticEvent) {
  return [
    `mediaSession: ${diagnostics.mediaSession.playbackState}`,
    `setPositionState calls: ${diagnostics.mediaSession.setPositionStateCalls}`,
    `media elements: ${diagnostics.mediaElements.length}`,
    `slider: ${diagnostics.slider.found ? "found" : "missing"}`,
    `clock: ${diagnostics.playback?.source ?? "none"}`,
    `position: ${diagnostics.playback?.positionMs ?? "n/a"} ms`,
  ].join("\n");
}

export const SpotifyBrowserFallback = forwardRef<SpotifyBrowserFallbackHandle>(
  function SpotifyBrowserFallback(_props, ref) {
    const webViewRef = useRef<WebView<object>>(null);
    const metadataRef = useRef<BrowserTrackMetadata | null>(null);
    const detectedSpotifyTrackIdRef = useRef("");
    const playbackRef = useRef<PlaybackSample | null>(null);
    const lyricsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const connectionStatusRef = useRef(
      usePlaybackStore.getState().connectionStatus,
    );
    const [browserOpen, setBrowserOpen] = useState(false);
    const [browserReady, setBrowserReady] = useState(false);
    const [browserLoading, setBrowserLoading] = useState(true);
    const [status, setStatus] = useState(
      "Spotify browser is mounted for offline bridge fallback.",
    );
    const [diagnostics, setDiagnostics] = useState<DiagnosticEvent | null>(
      null,
    );

    useEffect(
      () =>
        usePlaybackStore.subscribe((state) => {
          connectionStatusRef.current = state.connectionStatus;
        }),
      [],
    );

    useEffect(
      () => () => {
        if (lyricsRefreshTimerRef.current) {
          clearTimeout(lyricsRefreshTimerRef.current);
        }
      },
      [],
    );

    const ingestBrowserPlayback = useCallback((sample: PlaybackSample) => {
      playbackRef.current = sample;
      if (connectionStatusRef.current === "connected") {
        return;
      }

      const metadata = metadataRef.current;
      if (!metadata?.title || !metadata.artist) {
        setStatus("Spotify browser is active. Start a track to detect metadata.");
        return;
      }

      const packetTrackId = getBrowserTrackId(metadata, sample.durationMs);
      const storeBefore = usePlaybackStore.getState();
      const previousTrack = storeBefore.currentTrack;
      const metadataChanged =
        previousTrack?.id !== packetTrackId ||
        previousTrack?.title !== metadata.title ||
        previousTrack?.artist !== metadata.artist ||
        previousTrack?.spotifyTrackId !== metadata.spotifyTrackId ||
        Math.abs(Number(previousTrack?.durationMs || 0) - Number(sample.durationMs || 0)) > 1000;

      const packet: PlaybackPacket = {
        type: "playback",
        trackId: packetTrackId,
        title: metadata.title,
        artist: metadata.artist,
        spotifyTrackId: metadata.spotifyTrackId,
        ...(metadataChanged ? { artworkUrl: "" } : {}),
        durationMs: sample.durationMs,
        positionMs: sample.positionMs,
        isPlaying: sample.isPlaying,
        timestamp: sample.sampledAtMs || Date.now(),
        capturedAtMs: sample.sampledAtMs || Date.now(),
        timing: {
          anchorPositionMs: sample.positionMs,
          isPlaying: sample.isPlaying,
          nativeExtrapolationEnabled: sample.source !== "player-ui",
          projectedPositionMs: sample.positionMs,
        },
      };

      const store = usePlaybackStore.getState();
      const result = store.ingestPacket(packet);
      if (result.trackChanged || metadataChanged) {
        store.clearLyrics();
        store.setLyricsStatusMessage("Browser playback active. Resolving Spotify track identity...");
        if (lyricsRefreshTimerRef.current) {
          clearTimeout(lyricsRefreshTimerRef.current);
        }
        lyricsRefreshTimerRef.current = setTimeout(() => {
          const activeStore = usePlaybackStore.getState();
          if (
            connectionStatusRef.current === "connected" ||
            activeStore.currentTrack?.id !== packetTrackId
          ) {
            return;
          }
          activeStore.setLyricsStatusMessage("Browser playback active. Loading mobile lyrics sources...");
          void refreshLyricsForCurrentTrack("auto");
        }, 350);
      }
      setStatus(`Browser fallback timing active via ${sample.source}.`);
    }, []);

    const updateMetadata = useCallback(
      (title: string, artist: string, spotifyTrackId = "") => {
        const cleanTitle = title.trim();
        const cleanArtist = artist.trim();
        const previousMetadata = metadataRef.current;
        const metadataIdentityChanged =
          Boolean(previousMetadata) &&
          (previousMetadata?.title !== cleanTitle ||
            previousMetadata?.artist !== cleanArtist);
        if (metadataIdentityChanged && !spotifyTrackId.trim()) {
          detectedSpotifyTrackIdRef.current = "";
        }
        const cleanSpotifyTrackId =
          spotifyTrackId.trim() ||
          (!metadataIdentityChanged
            ? detectedSpotifyTrackIdRef.current ||
              previousMetadata?.spotifyTrackId ||
              ""
            : "");
        if (!cleanTitle || !cleanArtist) {
          return;
        }

        metadataRef.current = {
          title: cleanTitle,
          artist: cleanArtist,
          spotifyTrackId: cleanSpotifyTrackId,
        };

        const playback = playbackRef.current;
        if (playback) {
          ingestBrowserPlayback(playback);
        }
      },
      [ingestBrowserPlayback],
    );

    const sendCommand = useCallback((command: BrowserCommand) => {
      if (!browserReady) {
        setBrowserOpen(true);
        setStatus("Open Spotify browser and wait for it to finish loading.");
        return;
      }
      webViewRef.current?.injectJavaScript(makeBrowserCommandScript(command));
    }, [browserReady]);

    useImperativeHandle(
      ref,
      () => ({
        openBrowser: () => setBrowserOpen(true),
        reload: () => webViewRef.current?.reload(),
        togglePlayPause: () => sendCommand({ type: "toggle" }),
        resyncPlayback: () => {
          sendCommand({ type: "toggle" });
          if (playbackRef.current?.isPlaying) {
            setTimeout(() => sendCommand({ type: "toggle" }), 180);
          }
        },
        skipPrevious: () => sendCommand({ type: "previous" }),
        skipNext: () => sendCommand({ type: "next" }),
        seekTo: (positionMs: number) =>
          sendCommand({ type: "seek", positionMs: Math.max(0, positionMs) }),
        runDiagnostics: () => sendCommand({ type: "diagnostics" }),
      }),
      [sendCommand],
    );

    return (
      <View
        pointerEvents={browserOpen ? "auto" : "none"}
        style={[
          styles.browserOverlay,
          browserOpen ? styles.browserOverlayOpen : styles.browserOverlayClosed,
        ]}
      >
        <SafeAreaView edges={["top", "left", "right"]} style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>Spotify browser</Text>
            <Text style={styles.subtitle} numberOfLines={2}>
              {browserLoading ? "Loading desktop player..." : status}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityLabel="Run Spotify browser diagnostics"
              hitSlop={8}
              onPress={() => sendCommand({ type: "diagnostics" })}
              style={({ pressed }) => [
                styles.iconButton,
                pressed && styles.iconButtonPressed,
              ]}
            >
              <Ionicons name="pulse" size={18} color="#F8F8FE" />
            </Pressable>
            <Pressable
              accessibilityLabel="Reload Spotify browser"
              hitSlop={8}
              onPress={() => webViewRef.current?.reload()}
              style={({ pressed }) => [
                styles.iconButton,
                pressed && styles.iconButtonPressed,
              ]}
            >
              <Ionicons name="refresh" size={18} color="#F8F8FE" />
            </Pressable>
            <Pressable
              accessibilityLabel="Close Spotify browser"
              hitSlop={8}
              onPress={() => setBrowserOpen(false)}
              style={({ pressed }) => [
                styles.iconButton,
                pressed && styles.iconButtonPressed,
              ]}
            >
              <Ionicons name="close" size={19} color="#F8F8FE" />
            </Pressable>
          </View>
        </SafeAreaView>

        {diagnostics ? (
          <ScrollView style={styles.diagnosticsPanel}>
            <Text selectable style={styles.diagnosticsText}>
              {formatDiagnostics(diagnostics)}
            </Text>
          </ScrollView>
        ) : null}

        <WebView<object>
          ref={webViewRef}
          source={{ uri: BROWSER_URL }}
          injectedJavaScriptBeforeContentLoaded={installBrowserControlPreludeScript}
          injectedJavaScript={`${installBrowserControlPreludeScript}\n${installBrowserControlScript}`}
          startInLoadingState
          renderLoading={() => (
            <BrowserMessage loading message="Loading Spotify in desktop mode..." />
          )}
          renderError={(_domain, _code, description) => (
            <BrowserMessage message={description} />
          )}
          onLoadStart={() => {
            setBrowserLoading(true);
            setBrowserReady(false);
            setStatus("Loading Spotify in desktop mode...");
          }}
          onLoad={() => {
            setBrowserLoading(false);
            setStatus("Spotify page loaded. Sign in and start a track.");
          }}
          onHttpError={({ nativeEvent }) => {
            setBrowserLoading(false);
            setStatus(
              `Spotify returned HTTP ${nativeEvent.statusCode}: ${nativeEvent.description}`,
            );
          }}
          onError={({ nativeEvent }) => {
            setBrowserLoading(false);
            setStatus(`Spotify browser error: ${nativeEvent.description}`);
          }}
          onMessage={({ nativeEvent }: WebViewMessageEvent) => {
            const event = parseBrowserEvent(nativeEvent.data);
            if (event?.type === "ready") {
              setBrowserReady(true);
              setStatus("Spotify browser ready. Start playback in the web player.");
              return;
            }
            if (event?.type === "error") {
              setStatus(event.message);
              return;
            }
            if (event?.type === "diagnostics") {
              setDiagnostics(event);
              return;
            }
            if (event?.type === "spotifyToken" && event.token) {
              void saveMobileLyricsSettings({ spotifyWebToken: event.token });
              setStatus("Spotify bearer token captured for Spicy Lyrics.");
              return;
            }
            if (event?.type === "spotifyTrackId" && event.spotifyTrackId) {
              detectedSpotifyTrackIdRef.current = event.spotifyTrackId;
              // Network capture can precede the UI's metadata update. Let the
              // current title/artist settle before attaching this exact ID.
              setTimeout(() => {
                const metadata = metadataRef.current;
                if (metadata && !metadata.spotifyTrackId) {
                  updateMetadata(
                    metadata.title,
                    metadata.artist,
                    event.spotifyTrackId,
                  );
                }
              }, 180);
              return;
            }
            if (event?.type === "metadata" && event.title && event.artist) {
              updateMetadata(event.title, event.artist, event.spotifyTrackId || "");
              return;
            }
            if (event?.type === "playback") {
              ingestBrowserPlayback(event);
            }
          }}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          domStorageEnabled
          javaScriptEnabled
          contentMode="desktop"
          userAgent={DESKTOP_WEB_USER_AGENT}
          style={styles.webView}
        />
      </View>
    );
  },
);

function BrowserMessage({
  loading = false,
  message,
}: {
  loading?: boolean;
  message: string;
}) {
  return (
    <View style={styles.webViewMessage}>
      {loading ? (
        <ActivityIndicator color="#8FF0C4" size="large" />
      ) : (
        <Ionicons name="warning-outline" size={24} color="#FFD1D8" />
      )}
      <Text style={styles.webViewMessageText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  browserOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#0A0B11",
    elevation: 40,
    zIndex: 40,
  },
  browserOverlayOpen: {
    transform: [{ translateX: 0 }],
  },
  browserOverlayClosed: {
    transform: [{ translateX: -10000 }],
  },
  header: {
    minHeight: Platform.OS === "ios" ? 82 : 68,
    paddingHorizontal: 14,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(10,11,17,0.98)",
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: "#F8F8FE",
    fontSize: 17,
    fontWeight: "700",
  },
  subtitle: {
    marginTop: 3,
    color: "rgba(248,248,254,0.62)",
    fontSize: 12,
    lineHeight: 16,
  },
  headerActions: {
    flexDirection: "row",
    gap: 8,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  iconButtonPressed: {
    opacity: 0.74,
    transform: [{ scale: 0.96 }],
  },
  diagnosticsPanel: {
    maxHeight: 110,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.1)",
    backgroundColor: "rgba(255,255,255,0.04)",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  diagnosticsText: {
    color: "rgba(248,248,254,0.78)",
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
    fontSize: 11,
    lineHeight: 16,
  },
  webView: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  webViewMessage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#10131A",
    padding: 24,
  },
  webViewMessageText: {
    marginTop: 12,
    color: "rgba(248,248,254,0.76)",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
});
