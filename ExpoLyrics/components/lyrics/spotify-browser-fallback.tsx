import Ionicons from "@react-native-vector-icons/ionicons";
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
  AppState,
  type AppStateStatus,
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
  isSpotifyNativeAppRedirect,
  makeBrowserCommandScript,
  parseBrowserEvent,
  spotifyAuthProbeScript,
  SPOTIFY_WEBVIEW_ORIGIN_WHITELIST,
  type BrowserCommand,
  type BrowserEvent,
} from "@/lib/spotify-browser";
import { refreshLyricsForCurrentTrack } from "@/lib/lyrics-sync";
import { resolveSpotifyCatalogMatch } from "@/lib/mobile-lyrics-client";
import { saveMobileLyricsSettings } from "@/lib/mobile-lyrics-settings";
import {
  startPlaybackClock,
  usePlaybackStore,
} from "@/store/playback-store";
import type { PlaybackPacket } from "@/types/bridge";

const DESKTOP_WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

const BROWSER_HEARTBEAT_MS = 5_000;
const BROWSER_STALE_MS = 18_000;
const BROWSER_RELOAD_COOLDOWN_MS = 30_000;
const WARM_HANDOFF_TIMEOUT_MS = 15_000;

const BROWSER_URL = "https://open.spotify.com/";

type PlaybackSample = Extract<BrowserEvent, { type: "playback" }>;
type DiagnosticEvent = Extract<BrowserEvent, { type: "diagnostics" }>;
type MetadataEvent = Extract<BrowserEvent, { type: "metadata" }>;
type BrowserSlot = "primary" | "replacement";

type WarmBrowserSnapshot = {
  slot: BrowserSlot;
  generation: number;
  ready: boolean;
  metadata: MetadataEvent | null;
  playback: PlaybackSample | null;
};

type BrowserTrackMetadata = {
  title: string;
  artist: string;
  /** Artist exactly as the player reported it; identity key that survives the
   * catalog merge, which may add featured artists. */
  sourceArtist: string;
  album: string;
  artworkUrl: string;
  spotifyTrackId: string;
  catalogResolved: boolean;
  /** Catalog duration, used only while the player has not reported one. */
  catalogDurationMs: number;
};

// Onboarding signs in through its own WebView; cookies are shared, so this one
// only needs a nudge to pick the session up.
let reloadBrowserCallback: (() => void) | null = null;
let openBrowserCallback: (() => void) | null = null;

export function requestReloadSpotifyBrowser() {
  reloadBrowserCallback?.();
}

export function requestOpenSpotifyBrowser() {
  openBrowserCallback?.();
}

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

function getBrowserTrackId(metadata: BrowserTrackMetadata, _durationMs: number) {
  // Keep the store identity stable as duration and catalog enrichment arrive.
  // spotifyTrackId remains attached as metadata, but switching the primary key
  // to it mid-track would itself look like a track change and clear lyrics.
  return [
    "spotify-browser",
    metadata.title.trim().toLowerCase(),
    (metadata.sourceArtist || metadata.artist).trim().toLowerCase(),
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
    const webViewRefs = useRef<Record<BrowserSlot, WebView<object> | null>>({
      primary: null,
      replacement: null,
    });
    const activeSlotRef = useRef<BrowserSlot>("primary");
    const slotGenerationRef = useRef<Record<BrowserSlot, number>>({
      primary: 0,
      replacement: 0,
    });
    const warmSnapshotRef = useRef<WarmBrowserSnapshot | null>(null);
    const startWarmHandoffRef = useRef<() => void>(() => {});
    const [activeSlot, setActiveSlot] = useState<BrowserSlot>("primary");
    const [warmingSlot, setWarmingSlot] = useState<BrowserSlot | null>(null);
    const [slotGenerations, setSlotGenerations] = useState<
      Record<BrowserSlot, number>
    >({ primary: 0, replacement: 0 });
    const metadataRef = useRef<BrowserTrackMetadata | null>(null);
    const playbackRef = useRef<PlaybackSample | null>(null);
    const lyricsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const enrichRef = useRef({
      inFlightFor: "",
      completedFor: "",
    });
    const ingestRef = useRef<(sample: PlaybackSample) => void>(() => {});
    const connectionStatusRef = useRef(
      usePlaybackStore.getState().connectionStatus,
    );
    const [browserOpen, setBrowserOpen] = useState(false);
    const lastBrowserEventAtRef = useRef(Date.now());
    const lastBrowserReloadAtRef = useRef(0);
    const appStateRef = useRef<AppStateStatus>(AppState.currentState);
    const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const browserReadyRef = useRef(false);
    const [browserReady, setBrowserReady] = useState(false);
    const [browserLoading, setBrowserLoading] = useState(true);
    const [status, setStatus] = useState(
      "Spotify browser is mounted for offline bridge fallback.",
    );
    const [diagnostics, setDiagnostics] = useState<DiagnosticEvent | null>(
      null,
    );

    const getActiveWebView = useCallback(
      () => webViewRefs.current[activeSlotRef.current],
      [],
    );

    const syncBrowserMonitoring = useCallback(() => {
      if (!browserReadyRef.current) return;
      getActiveWebView()?.injectJavaScript(
        makeBrowserCommandScript({
          type: "setMonitoring",
          enabled:
            appStateRef.current === "active" &&
            connectionStatusRef.current !== "connected",
        }),
      );
    }, [getActiveWebView]);

    useEffect(() =>
      usePlaybackStore.subscribe((state) => {
        const changed = connectionStatusRef.current !== state.connectionStatus;
        connectionStatusRef.current = state.connectionStatus;
        if (changed) {
          syncBrowserMonitoring();
          if (state.connectionStatus === "connected" && warmSnapshotRef.current) {
            warmSnapshotRef.current = null;
            setWarmingSlot(null);
            if (recoveryTimerRef.current) {
              clearTimeout(recoveryTimerRef.current);
              recoveryTimerRef.current = null;
            }
          }
        }
      }), [syncBrowserMonitoring]);

    useEffect(() => {
      reloadBrowserCallback = () => getActiveWebView()?.reload();
      openBrowserCallback = () => setBrowserOpen(true);
      return () => {
        reloadBrowserCallback = null;
        openBrowserCallback = null;
        if (lyricsRefreshTimerRef.current) {
          clearTimeout(lyricsRefreshTimerRef.current);
        }
      };
    }, [getActiveWebView]);

    // A locally advancing WebView clock does not prove that Spotify Connect is
    // still authoritative after suspension. On resume, warm a freshly mounted
    // player while the current one continues feeding the visible lyrics UI.
    useEffect(() => {
      const requestSnapshot = () => {
        if (!browserReadyRef.current) return;
        getActiveWebView()?.injectJavaScript(
          makeBrowserCommandScript({ type: "readMetadata" }),
        );
      };

      const subscription = AppState.addEventListener("change", (nextState) => {
        const previousState = appStateRef.current;
        appStateRef.current = nextState;
        syncBrowserMonitoring();
        if (nextState === "active") {
          const playbackState = usePlaybackStore.getState();
          if (playbackState.isPlaying) startPlaybackClock();
          if (previousState !== "active") {
            if (connectionStatusRef.current !== "connected") {
              startWarmHandoffRef.current();
            }
          } else {
            requestSnapshot();
          }
          return;
        }
        // Capture one final anchor before native and WebView timers suspend.
        requestSnapshot();
        if (warmSnapshotRef.current) {
          warmSnapshotRef.current = null;
          setWarmingSlot(null);
          if (recoveryTimerRef.current) {
            clearTimeout(recoveryTimerRef.current);
            recoveryTimerRef.current = null;
          }
        }
      });

      const heartbeat = setInterval(() => {
        if (
          appStateRef.current !== "active" ||
          connectionStatusRef.current === "connected"
        ) return;
        requestSnapshot();
        const now = Date.now();
        if (
          appStateRef.current === "active" &&
          browserReadyRef.current &&
          now - lastBrowserEventAtRef.current > BROWSER_STALE_MS &&
          now - lastBrowserReloadAtRef.current >= BROWSER_RELOAD_COOLDOWN_MS
        ) {
          startWarmHandoffRef.current();
        }
      }, BROWSER_HEARTBEAT_MS);

      return () => {
        subscription.remove();
        clearInterval(heartbeat);
        if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      };
    }, [getActiveWebView, syncBrowserMonitoring]);

    // Mirrors DesktopBridge spotifyDetector.requestCatalogEnrichment(): native
    // metadata gets a stable track id first, then a single catalog enrichment
    // request adds spotifyTrackId/album/artist and re-emits the same track.
    const requestCatalogEnrichment = useCallback(() => {
      const metadata = metadataRef.current;
      if (!metadata?.title || !metadata.artist) {
        return;
      }
      const durationMs = playbackRef.current?.durationMs || metadata.catalogDurationMs || 0;
      const trackId = getBrowserTrackId(metadata, durationMs);
      const hasAlbum = Boolean(String(metadata.album || "").trim());
      if (!trackId) {
        return;
      }
      const state = enrichRef.current;
      if (state.inFlightFor === trackId) {
        return;
      }
      if (state.completedFor === trackId && metadata.spotifyTrackId && hasAlbum) {
        return;
      }
      if (metadata.spotifyTrackId && hasAlbum) {
        return;
      }

      enrichRef.current = { ...state, inFlightFor: trackId };
      setStatus("Browser fallback timing active. Resolving Spotify catalog identity...");
      void (async () => {
        try {
          const match = await resolveSpotifyCatalogMatch({
            title: metadata.title,
            artist: metadata.artist,
            album: metadata.album,
            durationMs,
            spotifyTrackId: metadata.spotifyTrackId,
          });
          const current = metadataRef.current;
          const currentDurationMs =
            playbackRef.current?.durationMs || current?.catalogDurationMs || 0;
          if (!match) {
            setStatus("Spotify catalog enrichment returned no Spotify ID.");
            return;
          }
          if (
            !current ||
            getBrowserTrackId(current, currentDurationMs) !== trackId
          ) {
            return;
          }

          metadataRef.current = {
            ...current,
            spotifyTrackId: match.spotifyTrackId,
            catalogResolved: true,
            artist: match.artist || current.artist,
            album: current.album || match.album,
            catalogDurationMs: match.durationMs,
          };
          enrichRef.current = {
            ...enrichRef.current,
            completedFor: trackId,
          };
          if (playbackRef.current) {
            ingestRef.current(playbackRef.current);
          }
        } catch (error) {
          setStatus(
            `Spotify catalog enrichment failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          if (enrichRef.current.inFlightFor === trackId) {
            enrichRef.current = {
              ...enrichRef.current,
              inFlightFor: "",
            };
          }
        }
      })();
    }, []);
    const scheduleLyricsRefresh = useCallback(
      (packetTrackId: string, attempt = 0) => {
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
          // Wait for catalog enrichment so every source gets album + track id.
          if (enrichRef.current.inFlightFor && attempt < 40) {
            scheduleLyricsRefresh(packetTrackId, attempt + 1);
            return;
          }
          activeStore.setLyricsStatusMessage("Browser playback active. Loading mobile lyrics sources...");
          void refreshLyricsForCurrentTrack("auto");
        }, attempt === 0 ? 350 : 300);
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
      requestCatalogEnrichment();

      // Spotify occasionally exposes no duration until the stream is buffered;
      // the catalog value keeps the search sources' duration matching alive.
      const durationMs = sample.durationMs > 0 ? sample.durationMs : metadata.catalogDurationMs;
      const packetTrackId = getBrowserTrackId(metadata, durationMs);
      const storeBefore = usePlaybackStore.getState();
      const previousTrack = storeBefore.currentTrack;
      const metadataChanged =
        previousTrack?.id !== packetTrackId ||
        previousTrack?.title !== metadata.title ||
        previousTrack?.artist !== metadata.artist ||
        previousTrack?.album !== metadata.album ||
        previousTrack?.spotifyTrackId !== metadata.spotifyTrackId ||
        Math.abs(Number(previousTrack?.durationMs || 0) - Number(durationMs || 0)) > 1000;

      const packet: PlaybackPacket = {
        type: "playback",
        trackId: packetTrackId,
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        spotifyTrackId: metadata.spotifyTrackId,
        // Explicit empty artwork clears the previous track's cover.
        ...(metadataChanged || metadata.artworkUrl
          ? { artworkUrl: metadata.artworkUrl }
          : {}),
        durationMs,
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
      const spotifyIdentityChanged = Boolean(
        previousTrack?.spotifyTrackId &&
          metadata.spotifyTrackId &&
          previousTrack.spotifyTrackId !== metadata.spotifyTrackId,
      );
      // Duration, artwork, album, and late catalog enrichment can all change
      // while the same song remains active. Update those fields in place; only
      // a stable track identity change should clear and search for lyrics.
      if (result.trackChanged || spotifyIdentityChanged) {
        store.clearLyrics();
        store.setLyricsStatusMessage("Browser playback active. Resolving Spotify track identity...");
        scheduleLyricsRefresh(packetTrackId);
      }
      const spotifyIdStatus = metadata.spotifyTrackId
        ? ` Spotify ID ${metadata.spotifyTrackId.slice(0, 7)}… (${metadata.catalogResolved ? "catalog" : "browser"}).`
        : " No Spotify ID yet.";
      setStatus(`Browser fallback timing active via ${sample.source}.${spotifyIdStatus}`);
    }, [requestCatalogEnrichment, scheduleLyricsRefresh]);

    ingestRef.current = ingestBrowserPlayback;

    const commitMetadata = useCallback(
      (next: Partial<BrowserTrackMetadata>) => {
        const cleanTitle = String(next.title || "").trim();
        const cleanArtist = String(next.artist || "").trim();
        if (!cleanTitle || !cleanArtist) {
          return false;
        }
        const previous = metadataRef.current;
        const cleanAlbum = String(next.album || "").trim();
        const previousAlbum = String(previous?.album || "").trim();
        // Keep enriched fields only while the same track is playing. Compared
        // against the reported artist, not the merged one, or every repeat of
        // the same event would look like a track change.
        const kept =
          previous?.title === cleanTitle &&
          previous?.sourceArtist === cleanArtist &&
          (!cleanAlbum || !previousAlbum || cleanAlbum === previousAlbum)
            ? previous
            : null;

        const incomingSpotifyTrackId = String(next.spotifyTrackId || "").trim();
        const keptSpotifyTrackId = String(kept?.spotifyTrackId || "").trim();
        const nextSpotifyTrackId = incomingSpotifyTrackId || keptSpotifyTrackId;
        const keptCatalogResolved = Boolean(
          kept?.catalogResolved &&
            keptSpotifyTrackId &&
            (!incomingSpotifyTrackId || incomingSpotifyTrackId === keptSpotifyTrackId),
        );

        metadataRef.current = {
          title: cleanTitle,
          artist: kept?.artist || cleanArtist,
          sourceArtist: cleanArtist,
          album: cleanAlbum || kept?.album || "",
          artworkUrl:
            String(next.artworkUrl || "").trim() || kept?.artworkUrl || "",
          spotifyTrackId: nextSpotifyTrackId,
          catalogResolved: keptCatalogResolved,
          catalogDurationMs:
            Number(next.catalogDurationMs || 0) || kept?.catalogDurationMs || 0,
        };

        return true;
      },
      [],
    );

    const updateMetadata = useCallback(
      (next: Partial<BrowserTrackMetadata>) => {
        if (!commitMetadata(next)) return;

        const playback = playbackRef.current;
        if (playback) {
          ingestBrowserPlayback(playback);
        } else {
          requestCatalogEnrichment();
        }
      },
      [commitMetadata, ingestBrowserPlayback, requestCatalogEnrichment],
    );

    const promoteWarmBrowser = useCallback(
      (snapshot: WarmBrowserSnapshot, requireCompleteSnapshot = true) => {
        if (
          warmSnapshotRef.current?.slot !== snapshot.slot ||
          warmSnapshotRef.current.generation !== snapshot.generation ||
          !snapshot.ready
        ) {
          return;
        }
        if (requireCompleteSnapshot && (!snapshot.metadata || !snapshot.playback)) {
          return;
        }

        if (recoveryTimerRef.current) {
          clearTimeout(recoveryTimerRef.current);
          recoveryTimerRef.current = null;
        }

        activeSlotRef.current = snapshot.slot;
        browserReadyRef.current = true;
        setBrowserReady(true);
        setBrowserLoading(false);
        setActiveSlot(snapshot.slot);
        setWarmingSlot(null);
        warmSnapshotRef.current = null;
        lastBrowserEventAtRef.current = Date.now();

        if (snapshot.metadata && snapshot.playback) {
          commitMetadata(snapshot.metadata);
          playbackRef.current = snapshot.playback;
          ingestBrowserPlayback(snapshot.playback);
          setStatus("Spotify player reconnected without interrupting lyrics.");
        } else {
          // Keep the visible store intact, but do not combine future samples
          // from the replacement with metadata captured by the retired slot.
          metadataRef.current = null;
          playbackRef.current = null;
          setStatus("Spotify player refreshed. Waiting for its current track...");
        }
        syncBrowserMonitoring();
      },
      [commitMetadata, ingestBrowserPlayback, syncBrowserMonitoring],
    );

    const tryPromoteWarmBrowser = useCallback(
      (slot: BrowserSlot, generation: number) => {
        const snapshot = warmSnapshotRef.current;
        if (
          !snapshot ||
          snapshot.slot !== slot ||
          snapshot.generation !== generation ||
          !snapshot.ready ||
          !snapshot.metadata ||
          !snapshot.playback
        ) {
          return;
        }
        promoteWarmBrowser(snapshot);
      },
      [promoteWarmBrowser],
    );

    const startWarmHandoff = useCallback(() => {
      if (
        appStateRef.current !== "active" ||
        connectionStatusRef.current === "connected"
      ) {
        return;
      }
      const slot: BrowserSlot =
        activeSlotRef.current === "primary" ? "replacement" : "primary";
      const generation = slotGenerationRef.current[slot] + 1;
      slotGenerationRef.current[slot] = generation;
      warmSnapshotRef.current = {
        slot,
        generation,
        ready: false,
        metadata: null,
        playback: null,
      };
      lastBrowserReloadAtRef.current = Date.now();
      setStatus("App resumed. Warming a fresh Spotify player...");
      setSlotGenerations((current) => ({
        ...current,
        [slot]: generation,
      }));
      setWarmingSlot(slot);

      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = setTimeout(() => {
        const snapshot = warmSnapshotRef.current;
        if (!snapshot || snapshot.slot !== slot || snapshot.generation !== generation) {
          return;
        }
        if (snapshot.ready) {
          promoteWarmBrowser(snapshot, false);
          return;
        }
        warmSnapshotRef.current = null;
        setWarmingSlot(null);
        setStatus("Fresh Spotify player did not finish loading; keeping the current player.");
      }, WARM_HANDOFF_TIMEOUT_MS);
    }, [promoteWarmBrowser]);

    startWarmHandoffRef.current = startWarmHandoff;

    const sendCommand = useCallback((command: BrowserCommand) => {
      if (!browserReady) {
        setBrowserOpen(true);
        setStatus("Open Spotify browser and wait for it to finish loading.");
        return;
      }
      getActiveWebView()?.injectJavaScript(makeBrowserCommandScript(command));
    }, [browserReady, getActiveWebView]);

    useImperativeHandle(
      ref,
      () => ({
        openBrowser: () => setBrowserOpen(true),
        reload: () => getActiveWebView()?.reload(),
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
      [getActiveWebView, sendCommand],
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
              onPress={() => getActiveWebView()?.reload()}
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

        <View style={styles.webViewStage}>
          {(["primary", "replacement"] as const).map((slot) => {
            if (slot !== activeSlot && slot !== warmingSlot) return null;
            const generation = slotGenerations[slot];
            const isActive = slot === activeSlot;
            return (
              <View
                key={`${slot}:${generation}`}
                pointerEvents={isActive ? "auto" : "none"}
                style={[
                  styles.webViewSlot,
                  isActive ? styles.webViewSlotActive : styles.webViewSlotWarming,
                ]}
              >
                <WebView<object>
                  ref={(instance) => {
                    webViewRefs.current[slot] = instance;
                  }}
                  source={{ uri: BROWSER_URL }}
                  originWhitelist={SPOTIFY_WEBVIEW_ORIGIN_WHITELIST}
                  onShouldStartLoadWithRequest={({ url }) => {
                    if (!isSpotifyNativeAppRedirect(url)) return true;
                    if (activeSlotRef.current === slot) {
                      setStatus("Kept Spotify open inside KineSync.");
                    }
                    return false;
                  }}
                  injectedJavaScriptBeforeContentLoaded={installBrowserControlPreludeScript}
                  injectedJavaScript={`${installBrowserControlPreludeScript}\n${spotifyAuthProbeScript}\n${installBrowserControlScript}`}
                  startInLoadingState
                  renderLoading={() => (
                    <BrowserMessage loading message="Loading Spotify in desktop mode..." />
                  )}
                  renderError={(_domain, _code, description) => (
                    <BrowserMessage message={description} />
                  )}
                  onLoadStart={() => {
                    if (activeSlotRef.current !== slot) return;
                    setBrowserLoading(true);
                    setBrowserReady(false);
                    browserReadyRef.current = false;
                    lastBrowserReloadAtRef.current = Date.now();
                    setStatus("Loading Spotify in desktop mode...");
                  }}
                  onLoad={() => {
                    if (activeSlotRef.current !== slot) return;
                    setBrowserLoading(false);
                    setStatus("Spotify page loaded. Sign in and start a track.");
                  }}
                  onHttpError={({ nativeEvent }) => {
                    if (activeSlotRef.current !== slot) return;
                    setBrowserLoading(false);
                    setStatus(
                      `Spotify returned HTTP ${nativeEvent.statusCode}: ${nativeEvent.description}`,
                    );
                  }}
                  onError={({ nativeEvent }) => {
                    const warm = warmSnapshotRef.current;
                    if (warm?.slot === slot && warm.generation === generation) {
                      setStatus(`Fresh Spotify player error: ${nativeEvent.description}`);
                      return;
                    }
                    if (activeSlotRef.current !== slot) return;
                    setBrowserLoading(false);
                    setStatus(`Spotify browser error: ${nativeEvent.description}`);
                  }}
                  onMessage={({ nativeEvent }: WebViewMessageEvent) => {
                    const event = parseBrowserEvent(nativeEvent.data);
                    if (!event) return;
                    const warm = warmSnapshotRef.current;
                    const isWarm =
                      warm?.slot === slot && warm.generation === generation;
                    const isCurrentActive = activeSlotRef.current === slot;

                    if (event.type === "spotifyToken" && event.token) {
                      void saveMobileLyricsSettings({
                        spotifyWebToken: event.token,
                        spotifyWebTokenExpiresAt: Number(event.expiresAt || 0),
                      });
                    }

                    if (isWarm && warm) {
                      if (event.type === "ready") warm.ready = true;
                      if (event.type === "metadata" && event.title && event.artist) {
                        warm.metadata = event;
                      }
                      if (event.type === "playback") warm.playback = event;
                      if (event.type === "error") setStatus(event.message);
                      tryPromoteWarmBrowser(slot, generation);
                      return;
                    }
                    if (!isCurrentActive) return;

                    lastBrowserEventAtRef.current = Date.now();
                    if (event.type === "ready") {
                      setBrowserReady(true);
                      browserReadyRef.current = true;
                      syncBrowserMonitoring();
                      setStatus("Spotify browser ready. Start playback in the web player.");
                      return;
                    }
                    if (event.type === "error") {
                      setStatus(event.message);
                      return;
                    }
                    if (event.type === "diagnostics") {
                      setDiagnostics(event);
                      return;
                    }
                    if (event.type === "spotifyToken" && event.token) {
                      setStatus("Spotify access token captured for lyrics lookups.");
                      return;
                    }
                    if (event.type === "signedIn") {
                      setStatus(
                        event.signedIn
                          ? "Signed in to Spotify. Start a track in the web player."
                          : "Not signed in to Spotify — open the browser and log in.",
                      );
                      return;
                    }
                    if (event.type === "metadata" && event.title && event.artist) {
                      updateMetadata(event);
                      return;
                    }
                    if (event.type === "playback") ingestBrowserPlayback(event);
                  }}
                  sharedCookiesEnabled
                  thirdPartyCookiesEnabled
                  domStorageEnabled
                  allowsInlineMediaPlayback
                  mediaPlaybackRequiresUserAction={false}
                  allowsAirPlayForMediaPlayback
                  setSupportMultipleWindows={false}
                  androidLayerType="hardware"
                  javaScriptEnabled
                  contentMode="desktop"
                  userAgent={DESKTOP_WEB_USER_AGENT}
                  style={styles.webView}
                />
              </View>
            );
          })}
        </View>
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
    ...StyleSheet.absoluteFill,
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
  webViewStage: {
    flex: 1,
    position: "relative",
  },
  webViewSlot: {
    ...StyleSheet.absoluteFill,
  },
  webViewSlotActive: {
    opacity: 1,
    zIndex: 1,
  },
  webViewSlotWarming: {
    opacity: 0,
    zIndex: 0,
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
