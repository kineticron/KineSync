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
  VaultBrowseResultPacket,
  VaultGetResultPacket,
} from "@/types/bridge";
import { isValidBridgeKey, parseBridgeWebSocketUrl } from "@/lib/network";
import { validateInboundBridgePacket } from "@/lib/bridge-validation";
import {
  cancelPlaybackCommands,
  playbackObservationEpoch,
  refreshPlaybackCommands,
  registerPlaybackCommandTransport,
  submitPlaybackCommand,
} from "@/lib/optimistic-playback";
import type { PlaybackCommand, PlaybackCommandResult, PlaybackObservation } from "@/lib/playback-command-queue";

type BridgeClientOptions = {
  onTrackChange?: (packet: PlaybackPacket) => void;
};

function getLyricsPacketSignature(lyrics: LyricsPacket["lyrics"]) {
  if (!Array.isArray(lyrics) || !lyrics.length) {
    return "0";
  }
  // Compare every renderable field. Store enrichment adds graphemes, so omit
  // that derived field when comparing an incoming packet with stored lyrics.
  return JSON.stringify(lyrics, (key, value) => key === "graphemes" ? undefined : value);
}

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.2;
const TRACK_CHANGE_REFETCH_DELAY_MS = 1_000;
const AUTH_TIMEOUT_MS = 10_000;
const PLAYBACK_UPDATE_RESTRICTIONS = { pause: true, resume: true, next: true, previous: true, seek: true, resync: true };

class BridgeClient {
  private vaultRequests = new Map<string, {
    type: 'vault:list:result' | 'vault:get:result';
    resolve: (packet: VaultBrowseResultPacket | VaultGetResultPacket) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private ws: WebSocket | null = null;
  private delayedPackets = new Set<ReturnType<typeof setTimeout>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private trackChangeRefetchTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private options: BridgeClientOptions;
  private pendingLyricsRefetch = false;
  private pendingArtworkRefetch = false;
  private authenticated = false;
  private playbackObservation?: PlaybackObservation | null;
  private playbackTarget?: string;
  private supportsDesiredPlayback = false;
  private playbackUpdateRequired = false;
  private relaySeek?: boolean;
  private supportsGuardedSeek = false;
  private playbackClock = -Infinity;
  private playbackRevision = 0;
  private playbackSocketGeneration = 0;
  private playbackTargetScope?: string;
  private destination?: { serverUrl: string; handshakeKey: string };
  private playbackAuthRejected = false;
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
    registerPlaybackCommandTransport('desktop', {
      read: () => {
        const { serverUrl, handshakeKey } = usePlaybackStore.getState();
        const current = serverUrl === this.destination?.serverUrl && handshakeKey === this.destination?.handshakeKey;
        return current && this.isAuthenticated()
          ? { ready: !this.playbackUpdateRequired, observation: this.playbackObservation, targetId: this.playbackTargetScope,
            blocked: this.playbackUpdateRequired ? PLAYBACK_UPDATE_RESTRICTIONS :
              this.playbackObservation === undefined ? undefined : { seek: !this.canSeek() } }
          : { ready: false };
      },
      canQueue: () => {
        const { serverUrl, handshakeKey } = usePlaybackStore.getState();
        const sameDestination = serverUrl === this.destination?.serverUrl && handshakeKey === this.destination?.handshakeKey;
        return !!parseBridgeWebSocketUrl(serverUrl) && isValidBridgeKey(handshakeKey) &&
          (!sameDestination || !this.playbackAuthRejected);
      },
      send: (command, observation, expiresAt) => this.sendPlaybackCommand(command, observation, expiresAt),
    });
  }

  setOptions(options: BridgeClientOptions) {
    this.options = options;
  }

  connect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const { serverUrl, handshakeKey } = usePlaybackStore.getState();
    const safeServerUrl = parseBridgeWebSocketUrl(serverUrl);
    if (!safeServerUrl) {
      usePlaybackStore.getState().setErrorMessage("Set bridge URL first.");
      return;
    }
    if (!isValidBridgeKey(handshakeKey)) {
      usePlaybackStore
        .getState()
        .setErrorMessage("Scan the desktop pairing QR or enter its bridge key.");
      return;
    }
    if (serverUrl !== this.destination?.serverUrl || handshakeKey !== this.destination?.handshakeKey) {
      this.playbackAuthRejected = false;
      this.playbackClock = -Infinity;
    }
    this.cleanupSocket();
    this.destination = { serverUrl, handshakeKey };
    usePlaybackStore.getState().setConnectionStatus("connecting");

    this.authenticated = false;
    const ws = new WebSocket(safeServerUrl);
    this.ws = ws;
    const alive = () => this.ws === ws;
    const socketGeneration = ++this.playbackSocketGeneration;
    let firstLegacyClock: number | undefined;

    ws.onopen = () => {
      if (!alive()) return;
      this.reconnectAttempt = 0;
      this.pendingLyricsRefetch = true;
      this.pendingArtworkRefetch = true;
      // The bridge requires authentication even on a private LAN. Do not
      // accept or send app packets until the explicit positive ack arrives.
      this.ws?.send(JSON.stringify({ type: "hello", key: handshakeKey }));
      this.clearAuthTimer();
      this.authTimer = setTimeout(() => {
        if (!alive()) return;
        this.authenticated = false;
        usePlaybackStore
          .getState()
          .setErrorMessage("Bridge authentication timed out. Scan the pairing QR again.");
        this.ws?.close(1008, "Bridge authentication timed out.");
      }, AUTH_TIMEOUT_MS);
    };

    ws.onmessage = (event) => {
      if (!alive()) return;
      try {
        const packet = validateInboundBridgePacket(event.data);
        if (!packet) return;
        if (packet.type === "hello:ack") {
          this.clearAuthTimer();
          if (packet.ok !== true) {
            this.authenticated = false;
            this.playbackAuthRejected = true;
            refreshPlaybackCommands();
            this.ws?.close(1008, "Bridge authentication failed.");
            return;
          }
          this.authenticated = true;
          this.relaySeek = packet.role === 'client' ? packet.guardedSeek === true : undefined;
          this.playbackAuthRejected = false;
          refreshPlaybackCommands();
          usePlaybackStore.getState().setConnectionStatus("connected");
          startPlaybackClock();
          this.requestLyricsRefetch();
          this.requestArtworkRefetch();
          return;
        }
        if (!this.authenticated) return;
        if (packet.type === 'vault:list:result' || packet.type === 'vault:get:result') {
          const request = this.vaultRequests.get(packet.requestId);
          if (!request || request.type !== packet.type) return;
          clearTimeout(request.timer);
          this.vaultRequests.delete(packet.requestId);
          if (packet.ok) request.resolve(packet);
          else request.reject(new Error(packet.error || 'Desktop Bridge vault request failed.'));
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
        const receiptEpoch = playbackObservationEpoch();
        const applyPacket = () => {
          if (!alive() || !this.authenticated) return;
          const state = usePlaybackStore.getState();
          const result = state.ingestPacket(packet, "desktop");
          const clock = packet.capturedAtMs ?? packet.timestamp;
          const legacy = packet.controlSnapshot === undefined;
          // Older bridges do not label their relay join replay. Wait for
          // another advancing frame before granting legacy dispatch authority.
          if (legacy && !packet.playbackCached && result.accepted && Number.isFinite(clock)) firstLegacyClock ??= clock;
          const sourceObserved = !packet.playbackCached &&
            (packet.controlSnapshot === true || (legacy && firstLegacyClock !== undefined && clock > firstLegacyClock));
          // Source loss can come in the same desktop clock tick as the last
          // active read. Revoke authority even when those timestamps tie.
          const becameIdle = packet.controlSnapshot === true && !packet.trackId && !!this.playbackObservation;
          const windowsNative = packet.playbackSource === 'windows-media-session-native';
          const windowsSession = windowsNative && packet.playbackSessionId;
          const newWindowsSession = windowsSession && windowsSession !== this.playbackObservation?.sessionId;
          if (sourceObserved && result.accepted && receiptEpoch === playbackObservationEpoch() &&
              Number.isFinite(clock) && (clock > this.playbackClock ||
                ((becameIdle || newWindowsSession) && clock === this.playbackClock))) {
            this.playbackClock = clock;
            this.playbackUpdateRequired = packet.scopedPlayback === false ||
              (windowsNative && !legacy && (!windowsSession ||
                (packet.scopedPlayback === undefined && packet.guardedSeek !== true)));
            this.supportsDesiredPlayback = !this.playbackUpdateRequired && (packet.scopedPlayback === true || !legacy);
            this.supportsGuardedSeek = !this.playbackUpdateRequired && packet.guardedSeek === true && this.relaySeek !== false;
            this.playbackTarget = typeof packet.activeDeviceId === 'string' && packet.activeDeviceId ? packet.activeDeviceId : undefined;
            this.playbackTargetScope = !packet.trackId ? 'idle' :
              this.playbackUpdateRequired ? 'windows-update-required' :
              windowsSession ? `windows-session:${windowsSession}` :
              this.playbackTarget ? `device:${this.playbackTarget}` : `unidentified:${socketGeneration}:${receiptEpoch}`;
            this.playbackObservation = packet.trackId ? {
              revision: ++this.playbackRevision,
              trackId: packet.trackId,
              sessionId: typeof packet.playbackSessionId === 'string' ? packet.playbackSessionId : undefined,
              playing: packet.isPlaying,
              positionMs: packet.positionMs,
              durationMs: packet.durationMs,
              observedAt: performance.now(),
            } : null;
            refreshPlaybackCommands();
          }
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
          const timer = setTimeout(() => {
            this.delayedPackets.delete(timer);
            applyPacket();
          }, simulatedLatencyMs);
          this.delayedPackets.add(timer);
        } else {
          applyPacket();
        }
      } catch {
        usePlaybackStore
          .getState()
          .setErrorMessage("Failed to decode playback packet.");
      }
    };

    ws.onclose = () => {
      if (!alive()) return;
      this.cleanupSocket();
      usePlaybackStore.getState().setConnectionStatus("disconnected");
      stopPlaybackClock();
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (!alive()) return;
      this.cleanupSocket();
      usePlaybackStore.getState().setErrorMessage("Bridge connection failed.");
      usePlaybackStore.getState().setConnectionStatus("disconnected");
      stopPlaybackClock();
      this.scheduleReconnect();
    };
  }

  disconnect(preservePlaybackIntents = false) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.cleanupSocket();
    if (!preservePlaybackIntents) cancelPlaybackCommands('desktop');
    stopPlaybackClock();
    usePlaybackStore.getState().setConnectionStatus("disconnected");
  }

  reconnectNow() {
    this.reconnectAttempt = 0;
    this.disconnect(true);
    this.playbackAuthRejected = false;
    this.connect();
  }

  requestLyricsRefresh(
    preferredSource: string = "auto",
    { immediateTranslation = false, translationLanguage = "English" }: { immediateTranslation?: boolean; translationLanguage?: string } = {},
  ) {
    const ws = this.getAuthenticatedSocket();
    if (ws) {
      ws.send(
        JSON.stringify({
          type: "lyrics:refresh",
          preferredSource,
          immediateTranslation: Boolean(immediateTranslation),
          translationLanguage,
        }),
      );
    }
  }

  requestLyricsRefetch() {
    const ws = this.getAuthenticatedSocket();
    if (ws) {
      this.pendingLyricsRefetch = false;
      ws.send(JSON.stringify({ type: "lyrics:refetch" }));
      return;
    }
    this.pendingLyricsRefetch = true;
  }

  requestArtworkRefetch() {
    const ws = this.getAuthenticatedSocket();
    if (ws) {
      this.pendingArtworkRefetch = false;
      ws.send(JSON.stringify({ type: "artwork:refetch" }));
      return;
    }
    this.pendingArtworkRefetch = true;
  }

  togglePlayPause() { this.submitDesktopCommand('toggle'); }

  resyncPlayback() { this.submitDesktopCommand({ type: 'resync' }); }

  skipNext() { this.submitDesktopCommand({ type: 'next' }); }

  skipPrevious() { this.submitDesktopCommand({ type: 'previous' }); }

  seekTo(positionMs: number, _currentPositionMs = 0) {
    this.submitDesktopCommand({ type: 'seek', positionMs });
  }

  private submitDesktopCommand(command: PlaybackCommand | 'toggle') {
    if (usePlaybackStore.getState().playbackMode === 'desktop') submitPlaybackCommand(command);
  }

  private canSeek() {
    return !this.playbackUpdateRequired && (this.supportsGuardedSeek || !this.supportsDesiredPlayback);
  }

  private sendPlaybackCommand(command: PlaybackCommand, observation: PlaybackObservation, expiresAt: number): PlaybackCommandResult {
    const ws = this.getAuthenticatedSocket();
    const { serverUrl, handshakeKey } = usePlaybackStore.getState();
    if (!ws || this.playbackUpdateRequired || performance.now() >= expiresAt || this.playbackObservation?.revision !== observation.revision ||
        serverUrl !== this.destination?.serverUrl || handshakeKey !== this.destination?.handshakeKey) return 'rejected';
    if (command.type === 'seek' && !this.canSeek()) return 'rejected';
    const packet = command.type === 'play' ? {
      type: 'playback:playPause',
      ...(this.supportsDesiredPlayback && { desiredPlaying: command.playing }),
    } :
      command.type === 'seek' ? {
        type: this.supportsGuardedSeek ? 'playback:seek:guarded' : 'playback:seek', positionMs: command.positionMs,
      } :
      { type: `playback:${command.type}` };
    const expectedPlayback = this.supportsDesiredPlayback || this.supportsGuardedSeek ? {
      deviceId: this.playbackTarget,
      sessionId: observation.sessionId,
      trackId: observation.trackId,
    } : undefined;
    // Map the mobile deadline to the desktop clock using the same observed
    // packet. Transit time on that observation makes this bound conservative.
    const expiresAtMs = Math.floor(this.playbackClock + expiresAt - observation.observedAt);
    ws.send(JSON.stringify({ ...packet, expectedPlayback, expiresAtMs }));
    return 'sent';
  }

  requestShareGif(
    packet: Omit<ShareGifRequestPacket, "type" | "requestId">,
    timeoutMs = 30_000,
  ) {
    return new Promise<ShareGifResultPacket>((resolve, reject) => {
      if (!this.isAuthenticated()) {
        reject(new Error("Desktop bridge is not connected."));
        return;
      }

      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
      const timer = setTimeout(() => {
        this.gifRequests.delete(requestId);
        reject(new Error("GIF export timed out on desktop bridge."));
      }, Math.max(5_000, timeoutMs));

      this.gifRequests.set(requestId, { resolve, reject, timer });
      const ws = this.getAuthenticatedSocket();
      if (!ws) {
        clearTimeout(timer);
        this.gifRequests.delete(requestId);
        reject(new Error("Desktop bridge is not connected."));
        return;
      }
      ws.send(
        JSON.stringify({
          type: "share:gif:request",
          requestId,
          ...packet,
        }),
      );
    });
  }

  async browseDesktopVault(query = '', offset = 0) {
    return await this.requestDesktopVault('vault:list', { query, offset }) as VaultBrowseResultPacket;
  }

  async getDesktopVaultEntry(vaultId: string) {
    const result = await this.requestDesktopVault('vault:get', { vaultId }) as VaultGetResultPacket;
    if (!result.entry) throw new Error('Desktop Bridge returned no lyrics.');
    return result.entry;
  }

  private requestDesktopVault(type: 'vault:list' | 'vault:get', payload: Record<string, unknown>) {
    return new Promise<VaultBrowseResultPacket | VaultGetResultPacket>((resolve, reject) => {
      const ws = this.getAuthenticatedSocket();
      if (!ws) { reject(new Error('Desktop Bridge is not connected.')); return; }
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      const timer = setTimeout(() => {
        this.vaultRequests.delete(requestId);
        reject(new Error('Desktop Bridge vault request timed out. Check the connection and update the Desktop Bridge if needed.'));
      }, 20_000);
      this.vaultRequests.set(requestId, { type: type === 'vault:list' ? 'vault:list:result' : 'vault:get:result', resolve, reject, timer });
      try { ws.send(JSON.stringify({ type, requestId, ...payload })); }
      catch (error) {
        clearTimeout(timer); this.vaultRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectVaultRequests() {
    for (const request of this.vaultRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Desktop Bridge disconnected during vault request.'));
    }
    this.vaultRequests.clear();
  }

  saveCurrentTrackToVault(
    { includeTranslations = false }: { includeTranslations?: boolean } = {},
    timeoutMs = 120_000,
  ) {
    return new Promise<VaultSaveResultPacket>((resolve, reject) => {
      if (!this.isAuthenticated()) {
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
      const ws = this.getAuthenticatedSocket();
      if (!ws) {
        clearTimeout(timer);
        this.pendingVaultSave = null;
        reject(new Error("Desktop bridge is not connected."));
        return;
      }
      ws.send(
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
    for (const timer of this.delayedPackets) clearTimeout(timer);
    this.delayedPackets.clear();
    this.rejectVaultRequests();
    this.rejectAllGifRequests("Bridge disconnected during GIF generation.");
    this.rejectPendingVaultSave("Bridge disconnected during vault save.");
    this.authenticated = false;
    this.playbackObservation = undefined;
    this.playbackTarget = undefined;
    this.playbackTargetScope = undefined;
    this.supportsDesiredPlayback = false;
    this.playbackUpdateRequired = false;
    this.supportsGuardedSeek = false;
    this.relaySeek = undefined;
    refreshPlaybackCommands();
    this.clearAuthTimer();
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

  private isAuthenticated() {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  private getAuthenticatedSocket(): WebSocket | null {
    return this.isAuthenticated() ? this.ws : null;
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

  private clearAuthTimer() {
    if (!this.authTimer) return;
    clearTimeout(this.authTimer);
    this.authTimer = null;
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
