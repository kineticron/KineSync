const { EventEmitter } = require("node:events");
const os = require("node:os");
const { WebSocket, WebSocketServer } = require("ws");
const {
  CLIENT_MAX_MESSAGE_BYTES,
  createRateLimiter,
  dispatchClientPacket,
  parseJsonMessage,
} = require("./bridgeProtocol");
const { DEFAULT_BRIDGE_KEY } = require("./bridgeSettingsStore");

const LOCAL_IP_CACHE_TTL_MS = 5_000;
const MAX_CLIENT_BUFFERED_BYTES = 256 * 1024;

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const values of Object.values(interfaces)) {
    if (!values) {
      continue;
    }
    for (const iface of values) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

function normalizeRemoteAddress(remoteAddress) {
  if (typeof remoteAddress !== "string" || !remoteAddress) {
    return "";
  }
  if (remoteAddress === "::1") {
    return "127.0.0.1";
  }
  if (remoteAddress.startsWith("::ffff:")) {
    return remoteAddress.slice("::ffff:".length);
  }
  return remoteAddress;
}

function isAllowedClientAddress(address) {
  if (!address) {
    return false;
  }
  if (address === "127.0.0.1") {
    return true;
  }

  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  const isIpv4 =
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  if (isIpv4) {
    const [a, b] = octets;
    const isPrivateLan =
      a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    const isTailscaleIpv4 = a === 100 && b >= 64 && b <= 127;
    return isPrivateLan || isTailscaleIpv4;
  }

  // Tailscale IPv6 ULA range starts with fd7a:115c:a1e0::/48.
  return address.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function createBridgeServer({
  port = 3001,
  handshakeKey = process.env.BRIDGE_KEY || DEFAULT_BRIDGE_KEY,
  getHandshakeKey,
} = {}) {
  const emitter = new EventEmitter();
  const wss = new WebSocketServer({
    host: "0.0.0.0",
    maxPayload: CLIENT_MAX_MESSAGE_BYTES,
    port,
    perMessageDeflate: false,
  });
  let isStarted = false;
  let localIpCache = "127.0.0.1";
  let localIpCacheAt = 0;

  const getCachedLocalIp = () => {
    const now = Date.now();
    if (now - localIpCacheAt > LOCAL_IP_CACHE_TTL_MS) {
      localIpCache = getLocalIp();
      localIpCacheAt = now;
    }
    return localIpCache;
  };

  const getCurrentHandshakeKey = () => {
    const value =
      typeof getHandshakeKey === "function" ? getHandshakeKey() : handshakeKey;
    return String(value || "").trim() || DEFAULT_BRIDGE_KEY;
  };

  const broadcast = (payload) => {
    if (wss.clients.size === 0) {
      return;
    }
    const message = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (
        client.readyState === WebSocket.OPEN &&
        client.isAuthorized &&
        client.bufferedAmount <= MAX_CLIENT_BUFFERED_BYTES
      ) {
        client.send(message);
      }
    }
  };

  const updateClientCount = () => {
    const count = [...wss.clients].filter(
      (client) => client.isAuthorized,
    ).length;
    emitter.emit("clientCountChanged", count);
  };

  wss.on("connection", (socket, req) => {
    const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress);
    if (!isAllowedClientAddress(remoteAddress)) {
      socket.close(
        1008,
        "Only local network or Tailscale connections are allowed.",
      );
      return;
    }

    req.socket.setNoDelay(true);
    socket.isAlive = true;
    socket.isAuthorized = false;
    socket.rateLimiter = createRateLimiter();
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("message", (message) => {
      if (!socket.rateLimiter.consume()) {
        socket.close(1008, "Rate limit exceeded.");
        return;
      }
      const parsed = parseJsonMessage(message, CLIENT_MAX_MESSAGE_BYTES);
      if (!parsed.ok) {
        return;
      }
      const { packet } = parsed;
      if (packet.type === "hello") {
        if (packet.key === getCurrentHandshakeKey()) {
          socket.isAuthorized = true;
          socket.send(JSON.stringify({ type: "hello:ack", ok: true }));
          updateClientCount();
        } else {
          socket.close(1008, "Invalid bridge key.");
        }
        return;
      }
      if (!socket.isAuthorized) {
        socket.close(1008, "Bridge key required.");
        return;
      }
      dispatchClientPacket(emitter, packet, (payload) => {
        if (
          socket.readyState === WebSocket.OPEN &&
          socket.isAuthorized &&
          socket.bufferedAmount <= MAX_CLIENT_BUFFERED_BYTES
        ) {
          socket.send(JSON.stringify(payload));
        }
      });
    });
    socket.on("close", updateClientCount);
    updateClientCount();
  });

  const heartbeatTimer = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 10_000);

  return Object.assign(emitter, {
    start() {
      isStarted = true;
    },
    stop() {
      clearInterval(heartbeatTimer);
      wss.close();
      isStarted = false;
    },
    broadcastPlayback(packet, _options = {}) {
      broadcast({ type: "playback", ...packet });
    },
    broadcastLyrics(packet) {
      broadcast({ type: "lyrics", ...packet });
    },
    getStatus() {
      const authorizedClients = [...wss.clients].filter(
        (client) => client.isAuthorized,
      ).length;
      const localIp = getCachedLocalIp();
      return {
        serverStarted: isStarted,
        localIp,
        wsUrl: `ws://${localIp}:${port}`,
        connectedClients: authorizedClients,
        requiresHandshake: true,
      };
    },
  });
}

module.exports = {
  createBridgeServer,
};
