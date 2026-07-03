const { EventEmitter } = require("node:events");
const { WebSocket } = require("ws");
const {
  CLIENT_MAX_MESSAGE_BYTES,
  DESKTOP_MAX_MESSAGE_BYTES,
  createRateLimiter,
  dispatchClientPacket,
  parseJsonMessage,
} = require("./bridgeProtocol");

const RELAY_RECONNECT_BASE_MS = 2_000;
const RELAY_RECONNECT_MAX_MS = 30_000;
const MAX_RELAY_BUFFERED_BYTES = 4 * 1024 * 1024;
const RELAY_PLAYBACK_INTERVAL_MS = Number(
  process.env.BRIDGE_RELAY_PLAYBACK_INTERVAL_MS || 500,
);
const RELAY_ARTWORK_REFRESH_MS = Number(
  process.env.BRIDGE_RELAY_ARTWORK_REFRESH_MS || 10 * 60_000,
);
const SEEK_BROADCAST_THRESHOLD_MS = 1_800;

function normalizeRelayUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (!/^wss?:\/\//i.test(raw)) {
    return "";
  }
  return raw;
}

function createBridgeRelayClient({
  getRelayUrl,
  getBridgeId,
  getBridgeKey,
} = {}) {
  const emitter = new EventEmitter();
  let ws = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let started = false;
  let registered = false;
  let lastError = "";
  let connectedClients = 0;
  let activeRelayUrl = "";
  let activeBridgeId = "";
  let rateLimiter = createRateLimiter();
  let latestPlaybackPacket = null;
  let lastPlaybackSentAt = 0;
  let lastPlaybackPositionMs = 0;
  let lastPlaybackTrackId = "";
  let lastPlaybackIsPlaying = false;
  let lastArtworkKey = "";
  let lastKnownArtworkTrackId = "";
  let lastKnownArtworkUrl = "";
  let lastArtworkSentAt = 0;
  let lastClientCount = 0;

  const getConfig = () => ({
    relayUrl: normalizeRelayUrl(
      typeof getRelayUrl === "function" ? getRelayUrl() : "",
    ),
    bridgeId: String(
      typeof getBridgeId === "function" ? getBridgeId() : "",
    ).trim(),
    bridgeKey: String(
      typeof getBridgeKey === "function" ? getBridgeKey() : "",
    ).trim(),
  });

  const emitStatus = () => emitter.emit("clientCountChanged", connectedClients);

  const cleanupSocket = () => {
    if (!ws) {
      return;
    }
    ws.removeAllListeners();
    try {
      ws.close();
    } catch {
      // Ignore close errors during teardown.
    }
    ws = null;
    registered = false;
    connectedClients = 0;
    emitStatus();
  };

  const scheduleReconnect = () => {
    if (!started || reconnectTimer) {
      return;
    }
    const delayMs = Math.min(
      RELAY_RECONNECT_MAX_MS,
      RELAY_RECONNECT_BASE_MS * 2 ** reconnectAttempt,
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
      connect();
    }, delayMs);
  };

  const send = (payload) => {
    if (
      ws?.readyState === WebSocket.OPEN &&
      ws.bufferedAmount <= MAX_RELAY_BUFFERED_BYTES
    ) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  };

  function connect() {
    const { relayUrl, bridgeId, bridgeKey } = getConfig();
    cleanupSocket();
    activeRelayUrl = relayUrl;
    activeBridgeId = bridgeId;
    lastError = "";
    if (!started || !relayUrl || !bridgeId || !bridgeKey) {
      return;
    }
    rateLimiter = createRateLimiter();
    ws = new WebSocket(relayUrl, {
      maxPayload: DESKTOP_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    ws.on("open", () => {
      reconnectAttempt = 0;
      send({
        type: "relay:register",
        role: "desktop",
        bridgeId,
        key: bridgeKey,
      });
    });
    ws.on("message", (message) => {
      if (!rateLimiter.consume()) {
        lastError = "Relay rate limit exceeded.";
        cleanupSocket();
        scheduleReconnect();
        return;
      }
      const parsed = parseJsonMessage(message, CLIENT_MAX_MESSAGE_BYTES);
      if (!parsed.ok) {
        return;
      }
      const { packet } = parsed;
      if (packet.type === "relay:registered") {
        registered = Boolean(packet.ok);
        lastError = registered
          ? ""
          : String(packet.error || "Relay registration failed.");
        emitStatus();
        return;
      }
      if (packet.type === "relay:status") {
        connectedClients = Math.max(0, Math.floor(Number(packet.clients) || 0));
        if (connectedClients > lastClientCount && latestPlaybackPacket) {
          sendPlaybackPacket(latestPlaybackPacket, {
            force: true,
            includeArtwork: true,
          });
        }
        lastClientCount = connectedClients;
        emitStatus();
        return;
      }
      if (!registered) {
        return;
      }
      dispatchClientPacket(emitter, packet, (payload) => {
        send(payload);
      });
    });
    ws.on("error", (error) => {
      lastError = error instanceof Error ? error.message : String(error);
    });
    ws.on("close", () => {
      registered = false;
      connectedClients = 0;
      emitStatus();
      scheduleReconnect();
    });
  }

  function buildRelayPlaybackPacket(packet, { includeArtwork = false } = {}) {
    const outgoing = { type: "playback", ...packet };
    if (includeArtwork && !outgoing.artworkUrl) {
      const trackId = String(outgoing.trackId || "");
      if (trackId && trackId === lastKnownArtworkTrackId && lastKnownArtworkUrl) {
        outgoing.artworkUrl = lastKnownArtworkUrl;
      }
    }
    if (!includeArtwork || !outgoing.artworkUrl) {
      delete outgoing.artworkUrl;
    }
    return outgoing;
  }

  function shouldSendArtwork(packet, now) {
    const trackId = String(packet?.trackId || "");
    const packetArtworkUrl = String(packet?.artworkUrl || "");
    if (packetArtworkUrl) {
      lastKnownArtworkTrackId = trackId;
      lastKnownArtworkUrl = packetArtworkUrl;
    }
    const artworkUrl =
      packetArtworkUrl ||
      (trackId && trackId === lastKnownArtworkTrackId ? lastKnownArtworkUrl : "");
    if (!artworkUrl) {
      return false;
    }
    const artworkKey = `${trackId}|${artworkUrl}`;
    return (
      artworkKey !== lastArtworkKey ||
      now - lastArtworkSentAt >= RELAY_ARTWORK_REFRESH_MS
    );
  }

  function sendPlaybackPacket(packet, { force = false, includeArtwork = false } = {}) {
    const now = Date.now();
    const safePacket = packet || {};
    const trackId = String(safePacket.trackId || "");
    const isPlaying = Boolean(safePacket.isPlaying);
    const positionMs = Math.floor(Number(safePacket.positionMs) || 0);
    const trackChanged = trackId !== lastPlaybackTrackId;
    const playStateChanged = isPlaying !== lastPlaybackIsPlaying;
    const seekDetected =
      !trackChanged &&
      Math.abs(positionMs - lastPlaybackPositionMs) >= SEEK_BROADCAST_THRESHOLD_MS;
    const artworkDue = includeArtwork || shouldSendArtwork(safePacket, now);
    const intervalDue =
      now - lastPlaybackSentAt >= Math.max(100, RELAY_PLAYBACK_INTERVAL_MS);

    if (!force && !trackChanged && !playStateChanged && !seekDetected && !artworkDue && !intervalDue) {
      return false;
    }

    const sent = send(
      buildRelayPlaybackPacket(safePacket, {
        includeArtwork: artworkDue,
      }),
    );
    if (!sent) {
      return false;
    }
    lastPlaybackSentAt = now;
    lastPlaybackTrackId = trackId;
    lastPlaybackIsPlaying = isPlaying;
    lastPlaybackPositionMs = positionMs;
    const sentArtworkUrl =
      String(safePacket.artworkUrl || "") ||
      (trackId && trackId === lastKnownArtworkTrackId ? lastKnownArtworkUrl : "");
    if (artworkDue && sentArtworkUrl) {
      lastArtworkKey = `${trackId}|${sentArtworkUrl}`;
      lastArtworkSentAt = now;
    }
    return true;
  }

  return Object.assign(emitter, {
    start() {
      started = true;
      connect();
    },
    restart() {
      reconnectAttempt = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    },
    stop() {
      started = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      cleanupSocket();
    },
    broadcastPlayback(packet, options = {}) {
      if (registered) {
        latestPlaybackPacket = packet;
        sendPlaybackPacket(packet, options);
      }
    },
    broadcastLyrics(packet) {
      if (registered) {
        send({ type: "lyrics", ...packet });
      }
    },
    getStatus() {
      const relayMobileUrl =
        activeRelayUrl && activeBridgeId
          ? `${activeRelayUrl.replace(/\/+$/, "")}/bridge/${encodeURIComponent(activeBridgeId)}`
          : "";
      return {
        relayConfigured: Boolean(activeRelayUrl && activeBridgeId),
        relayConnected: registered,
        relayUrl: activeRelayUrl,
        relayMobileUrl,
        relayBridgeId: activeBridgeId,
        relayConnectedClients: connectedClients,
        relayError: lastError,
      };
    },
  });
}

module.exports = {
  createBridgeRelayClient,
};
