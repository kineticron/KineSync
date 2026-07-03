import {
  startPlaybackClock,
  stopPlaybackClock,
  usePlaybackStore,
} from "@/store/playback-store";
import type {
  LyricsPacket,
  PlaybackPacket,
  ShareGifRequestPacket,
  ShareGifResultPacket,
  VaultSaveResultPacket,
} from "@/types/bridge";

type BridgeClientOptions = {
  onTrackChange?: (packet: PlaybackPacket) => void;
};

function getLyricsPacketSignature(lyrics: LyricsPacket["lyrics"]) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return "0";
  }
  const first = lyrics[0];
  const last = lyrics[lyrics.length - 1];
  const translatedLineCount = lyrics.reduce(
    (count, line) =>
      count + (String(line?.translatedText || "").trim() ? 1 : 0),
    0,
  );
  const textSample = lyrics
    .slice(0, 3)
    .map((line) =>
      (line?.syllables || []).map((syllable) => syllable.text || "").join(""),
    )
    .join("\u001f");
  return [
    lyrics.length,
    Number(first?.lineStartTime || -1),
    Number(last?.lineEndTime || -1),
    translatedLineCount,
    textSample,
  ].join("|");
}

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.2;
const TRACK_CHANGE_REFETCH_DELAY_MS = 1_000;

class BridgeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private trackChangeRefetchTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private options: BridgeClientOptions;
  private pendingLyricsRefetch = false;
  private pendingArtworkRefetch = false;
  private gifRequests = new Map<
    string,
    {
      resolve: (result: ShareGifResultPacket) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingVaultSave:
    | {
        resolve: (result: VaultSaveResultPacket) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | null = null;

  constructor(options: BridgeClientOptions = {}) {
    this.options = options;
  }

  setOptions(options: BridgeClientOptions) {
    this.options = options;
  }

  connect() {
    const { serverUrl } = usePlaybackStore.getState();
    if (!serverUrl) {
      usePlaybackStore.getState().setErrorMessage("Set bridge URL first.");
      return;
    }
    this.cleanupSocket();
    usePlaybackStore.getState().setConnectionStatus("connecting");

    this.ws = new WebSocket(serverUrl);

    this.ws.onopen = () => {
      const { handshakeKey, setConnectionStatus } = usePlaybackStore.getState();
      setConnectionStatus("connected");
      this.reconnectAttempt = 0;
      startPlaybackClock();
      this.pendingLyricsRefetch = true;
      this.pendingArtworkRefetch = true;
      if (handshakeKey) {
        this.ws?.send(JSON.stringify({ type: "hello", key: handshakeKey }));
      } else {
        this.requestLyricsRefetch();
        this.requestArtworkRefetch();
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const packet = JSON.parse(String(event.data)) as
          | { type: "hello:ack"; ok?: boolean }
          | PlaybackPacket
          | LyricsPacket
          | ShareGifResultPacket
          | VaultSaveResultPacket;
        if (packet.type === "hello:ack") {
          this.requestLyricsRefetch();
          this.requestArtworkRefetch();
          return;
        }
        if (packet.type === "vault:save:result") {
          this.applyVaultSaveResult(packet);
          return;
        }
        if (packet.type === "lyrics") {
          this.applyLyricsPacket(packet);
          return;
        }
        if (packet.type === "share:gif:result") {
          this.applyShareGifResult(packet);
          return;
        }
        if (packet.type !== "playback") {
          return;
        }
        const { simulatedLatencyMs, packetDropRate } =
          usePlaybackStore.getState();
        if (Math.random() < packetDropRate) {
          return;
        }
        const applyPacket = () => {
          const state = usePlaybackStore.getState();
          const result = state.ingestPacket(packet);
          if (result.trackChanged) {
            state.clearLyrics();
            state.setLyricsStatusMessage("Waiting for desktop lyrics...");
            this.scheduleTrackChangeCachedRefetch();
          }
          if (result.trackChanged && this.options.onTrackChange) {
            this.options.onTrackChange(packet);
          }
        };
        if (simulatedLatencyMs > 0) {
          setTimeout(applyPacket, simulatedLatencyMs);
        } else {
          applyPacket();
        }
      } catch {
        usePlaybackStore
          .getState()
          .setErrorMessage("Failed to decode playback packet.");
      }
    };

    this.ws.onclose = () => {
      usePlaybackStore.getState().setConnectionStatus("disconnected");
      stopPlaybackClock();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      usePlaybackStore.getState().setErrorMessage("Bridge connection failed.");
      usePlaybackStore.getState().setConnectionStatus("disconnected");
      stopPlaybackClock();
      this.scheduleReconnect();
    };
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.cleanupSocket();
    this.rejectAllGifRequests("Bridge disconnected during GIF generation.");
    this.rejectPendingVaultSave("Bridge disconnected during vault save.");
    stopPlaybackClock();
    usePlaybackStore.getState().setConnectionStatus("disconnected");
  }

  reconnectNow() {
    this.reconnectAttempt = 0;
    this.disconnect();
    this.connect();
  }

  requestLyricsRefresh(
    preferredSource: string = "auto",
    { immediateTranslation = false }: { immediateTranslation?: boolean } = {},
  ) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "lyrics:refresh",
          preferredSource,
          immediateTranslation: Boolean(immediateTranslation),
        }),
      );
    }
  }

  requestLyricsRefetch() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.pendingLyricsRefetch = false;
      this.ws.send(JSON.stringify({ type: "lyrics:refetch" }));
      return;
    }
    this.pendingLyricsRefetch = true;
  }

  requestArtworkRefetch() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.pendingArtworkRefetch = false;
      this.ws.send(JSON.stringify({ type: "artwork:refetch" }));
      return;
    }
    this.pendingArtworkRefetch = true;
  }

  togglePlayPause() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "playback:playPause" }));
    }
  }

  resyncPlayback() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "playback:resync" }));
    }
  }

  skipNext() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "playback:next" }));
    }
  }

  skipPrevious() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "playback:previous" }));
    }
  }

  seekTo(positionMs: number, _currentPositionMs = 0) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "playback:seek",
          positionMs: Math.max(0, Math.floor(Number(positionMs) || 0)),
        }),
      );
    }
  }

  requestShareGif(
    packet: Omit<ShareGifRequestPacket, "type" | "requestId">,
    timeoutMs = 30_000,
  ) {
    return new Promise<ShareGifResultPacket>((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error("Desktop bridge is not connected."));
        return;
      }

      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
      const timer = setTimeout(() => {
        this.gifRequests.delete(requestId);
        reject(new Error("GIF export timed out on desktop bridge."));
      }, Math.max(5_000, timeoutMs));

      this.gifRequests.set(requestId, { resolve, reject, timer });
      this.ws.send(
        JSON.stringify({
          type: "share:gif:request",
          requestId,
          ...packet,
        }),
      );
    });
  }

  saveCurrentTrackToVault(
    { includeTranslations = false }: { includeTranslations?: boolean } = {},
    timeoutMs = 120_000,
  ) {
    return new Promise<VaultSaveResultPacket>((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error("Desktop bridge is not connected."));
        return;
      }
      if (this.pendingVaultSave) {
        reject(new Error("A vault save is already in progress."));
        return;
      }

      const timer = setTimeout(() => {
        this.pendingVaultSave = null;
        reject(new Error("Vault save timed out on desktop bridge."));
      }, Math.max(10_000, timeoutMs));

      this.pendingVaultSave = { resolve, reject, timer };
      this.ws.send(
        JSON.stringify({
          type: "vault:save",
          includeTranslations: Boolean(includeTranslations),
        }),
      );
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    const backoffMs = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
    );
    const jitterWindow = Math.floor(backoffMs * RECONNECT_JITTER_RATIO);
    const jitter = jitterWindow
      ? Math.floor(Math.random() * (jitterWindow * 2 + 1)) - jitterWindow
      : 0;
    const delayMs = Math.max(RECONNECT_BASE_MS, backoffMs + jitter);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 8);
      this.connect();
    }, delayMs);
  }

  private cleanupSocket() {
    this.clearTrackChangeRefetchTimer();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private applyVaultSaveResult(packet: VaultSaveResultPacket) {
    const entry = this.pendingVaultSave;
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.pendingVaultSave = null;
    if (!packet.ok) {
      entry.reject(new Error(packet.error || "Desktop bridge failed to save lyrics."));
      return;
    }
    entry.resolve(packet);
  }

  private applyShareGifResult(packet: ShareGifResultPacket) {
    const entry = this.gifRequests.get(packet.requestId);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.gifRequests.delete(packet.requestId);
    if (!packet.ok) {
      entry.reject(new Error(packet.error || "Desktop bridge failed to create GIF."));
      return;
    }
    entry.resolve(packet);
  }

  private rejectAllGifRequests(message: string) {
    for (const [requestId, request] of this.gifRequests.entries()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
      this.gifRequests.delete(requestId);
    }
  }

  private rejectPendingVaultSave(message: string) {
    if (!this.pendingVaultSave) {
      return;
    }
    clearTimeout(this.pendingVaultSave.timer);
    this.pendingVaultSave.reject(new Error(message));
    this.pendingVaultSave = null;
  }

  private clearTrackChangeRefetchTimer() {
    if (!this.trackChangeRefetchTimer) {
      return;
    }
    clearTimeout(this.trackChangeRefetchTimer);
    this.trackChangeRefetchTimer = null;
  }

  private scheduleTrackChangeCachedRefetch() {
    this.clearTrackChangeRefetchTimer();
    this.trackChangeRefetchTimer = setTimeout(() => {
      this.trackChangeRefetchTimer = null;
      this.requestLyricsRefetch();
    }, TRACK_CHANGE_REFETCH_DELAY_MS);
  }

  private applyLyricsPacket(packet: LyricsPacket) {
    const receivedAt = Date.now();
    this.pendingLyricsRefetch = false;
    const state = usePlaybackStore.getState();
    const activeTrackId = state.currentTrack?.id ?? "";
    if (packet.trackId && activeTrackId && packet.trackId !== activeTrackId) {
      return;
    }
    const incomingSource = packet.source || "bridge";
    const currentLyricsSignature = getLyricsPacketSignature(state.lyrics);
    const incomingLyricsSignature = getLyricsPacketSignature(packet.lyrics);
    const lyricsChanged =
      currentLyricsSignature !== incomingLyricsSignature ||
      state.lyricsSource !== incomingSource;
    if (lyricsChanged) {
      state.setLyrics(packet.lyrics, incomingSource);
    }
    const frontendProcessingMs = Date.now() - receivedAt;
    state.setLyricsMetadata({
      ...(packet.metadata || {}),
      translation: packet.metadata?.translation
        ? {
            ...packet.metadata.translation,
            frontendProcessingMs,
          }
        : packet.metadata?.translation,
    });
    state.setLyricsStatusMessage(
      packet.statusMessage ||
        (packet.lyrics.length
          ? `Fetched ${packet.lyrics.length} lines from ${packet.source || "bridge"}.`
          : "No synced lyrics available."),
    );
  }
}

export const bridgeClient = new BridgeClient();
