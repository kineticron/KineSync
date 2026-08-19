const http = require("node:http");
const crypto = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");
const {
  CLIENT_MAX_MESSAGE_BYTES,
  DESKTOP_MAX_MESSAGE_BYTES,
  createRateLimiter,
  isDesktopPacket,
  parseJsonMessage,
  sanitizeClientPacket,
} = require("./bridgeProtocol");

const DEFAULT_RELAY_PORT = Number(process.env.BRIDGE_RELAY_PORT || 8787);
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_ROOMS = 256;
const MAX_CONNECTIONS = 512;
const MAX_CLIENTS_PER_ROOM = 32;
const PREAUTH_MAX_MESSAGE_BYTES = 64 * 1024;
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 15_000;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const parts = parsed.hostname.split(".").map((part) => Number(part));
    const privateIpv4 =
      parts.length === 4 &&
      parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
      (parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168));
    return (
      parsed.protocol === "https:" ||
      ((parsed.protocol === "http:") &&
        (parsed.hostname === "localhost" ||
          parsed.hostname === "127.0.0.1" ||
          parsed.hostname === "[::1]" ||
          parsed.hostname.endsWith(".local") ||
          privateIpv4))
    );
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function normalizeBridgeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 64);
}

function getBridgeIdFromRequest(req) {
  try {
    const url = new URL(req.url || "/", "http://relay.local");
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts[0] === "bridge" && pathParts[1]) {
      return normalizeBridgeId(pathParts[1]);
    }
    return normalizeBridgeId(url.searchParams.get("bridgeId"));
  } catch {
    return "";
  }
}

function createHostedRelayServer({
  port = DEFAULT_RELAY_PORT,
  getRegistrationKey = () => process.env.BRIDGE_RELAY_REGISTRATION_KEY || process.env.BRIDGE_KEY || "",
} = {}) {
  const rooms = new Map();
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Bridge relay is running.");
  });
  const wss = new WebSocketServer({
    server,
    maxPayload: DESKTOP_MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  const getRoom = (bridgeId) => {
    if (!rooms.has(bridgeId)) {
      rooms.set(bridgeId, {
        bridgeId,
        key: "",
        desktop: null,
        clients: new Set(),
      });
    }
    return rooms.get(bridgeId);
  };

  const send = (socket, payload) => {
    if (
      socket?.readyState === WebSocket.OPEN &&
      socket.bufferedAmount <= MAX_BUFFERED_BYTES
    ) {
      socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  };

  const sendRoomStatus = (room) => {
    if (!room?.desktop) {
      return;
    }
    send(room.desktop, {
      type: "relay:status",
      clients: room.clients.size,
    });
  };

  const detach = (socket) => {
    const room = socket.bridgeId ? rooms.get(socket.bridgeId) : null;
    if (!room) {
      return;
    }
    if (socket.role === "desktop" && room.desktop === socket) {
      room.desktop = null;
      for (const client of room.clients) {
        client.close(1012, "Desktop bridge disconnected.");
      }
      room.clients.clear();
    } else if (socket.role === "client") {
      room.clients.delete(socket);
      sendRoomStatus(room);
    }
    if (!room.desktop && room.clients.size === 0) {
      rooms.delete(room.bridgeId);
    }
  };

  wss.on("connection", (socket, req) => {
    if (wss.clients.size >= MAX_CONNECTIONS) {
      socket.close(1013, "Relay is busy.");
      return;
    }
    if (!isAllowedOrigin(String(req.headers.origin || ""))) {
      socket.close(1008, "Origin is not allowed.");
      return;
    }
    socket.isAuthorized = false;
    socket.role = "";
    socket.bridgeId = getBridgeIdFromRequest(req);
    socket.rateLimiter = createRateLimiter();
    socket.isAlive = true;
    socket.authTimer = setTimeout(() => {
      if (!socket.isAuthorized) socket.close(1008, "Authentication timeout.");
    }, AUTH_TIMEOUT_MS);
    socket.on("pong", () => { socket.isAlive = true; });

    socket.on("message", (message) => {
      if (!socket.rateLimiter.consume()) {
        socket.close(1008, "Rate limit exceeded.");
        return;
      }
      const maxBytes =
        !socket.isAuthorized
          ? PREAUTH_MAX_MESSAGE_BYTES
          : socket.role === "desktop"
          ? DESKTOP_MAX_MESSAGE_BYTES
          : CLIENT_MAX_MESSAGE_BYTES;
      if (!socket.isAuthorized && Buffer.byteLength(String(message || "")) > PREAUTH_MAX_MESSAGE_BYTES) {
        socket.close(1009, "Pre-authentication message is too large.");
        return;
      }
      const parsed = parseJsonMessage(message, maxBytes);
      if (!parsed.ok) {
        return;
      }
      const { packet } = parsed;

      if (!socket.isAuthorized && packet.type === "relay:register") {
        const bridgeId = normalizeBridgeId(packet.bridgeId);
        const key = String(packet.key || "").trim();
        if (packet.role !== "desktop" || !bridgeId || !key) {
          socket.close(1008, "Invalid relay registration.");
          return;
        }
        if (!rooms.has(bridgeId) && rooms.size >= MAX_ROOMS) {
          socket.close(1013, "Relay room limit reached.");
          return;
        }
        const expectedRegistrationKey = String(
          typeof getRegistrationKey === "function"
            ? getRegistrationKey(bridgeId)
            : "",
        ).trim();
        if (!expectedRegistrationKey || !safeEqual(key, expectedRegistrationKey)) {
          socket.close(1008, "Invalid desktop registration credential.");
          return;
        }
        const room = getRoom(bridgeId);
        if (room.desktop && room.desktop !== socket) {
          socket.close(1008, "A desktop bridge is already registered for this ID.");
          return;
        }
        room.desktop = socket;
        room.key = key;
        socket.bridgeId = bridgeId;
        socket.role = "desktop";
        socket.isAuthorized = true;
        clearTimeout(socket.authTimer);
        send(socket, { type: "relay:registered", ok: true, authenticated: true, role: "desktop", bridgeId });
        sendRoomStatus(room);
        return;
      }

      if (!socket.isAuthorized && packet.type === "hello") {
        const bridgeId = socket.bridgeId || normalizeBridgeId(packet.bridgeId);
        const room = bridgeId ? rooms.get(bridgeId) : null;
        if (!room?.desktop || !room.key || !safeEqual(packet.key, room.key)) {
          socket.close(1008, "Invalid bridge key.");
          return;
        }
        if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
          socket.close(1013, "Room client limit reached.");
          return;
        }
        socket.bridgeId = bridgeId;
        socket.role = "client";
        socket.isAuthorized = true;
        clearTimeout(socket.authTimer);
        room.clients.add(socket);
        send(socket, { type: "hello:ack", ok: true, authenticated: true, role: "client", bridgeId });
        sendRoomStatus(room);
        return;
      }

      if (!socket.isAuthorized) {
        socket.close(1008, "Authentication required.");
        return;
      }

      const room = socket.bridgeId ? rooms.get(socket.bridgeId) : null;
      if (!room) {
        socket.close(1011, "Relay room not found.");
        return;
      }

      if (socket.role === "desktop" && isDesktopPacket(packet)) {
        for (const client of room.clients) {
          send(client, packet);
        }
        return;
      }

      if (socket.role === "client") {
        const safePacket = sanitizeClientPacket(packet);
        if (safePacket && room.desktop?.readyState === WebSocket.OPEN) {
          send(room.desktop, safePacket);
        }
      }
    });

    socket.on("close", () => { clearTimeout(socket.authTimer); detach(socket); });
    socket.on("error", () => { clearTimeout(socket.authTimer); detach(socket); });
  });

  const heartbeatTimer = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);

  return {
    start(callback) {
      const onError = (error) => callback?.(error);
      server.once("error", onError);
      server.listen(port, () => {
        server.off("error", onError);
        callback?.();
      });
    },
    address() {
      return server.address();
    },
    stop(callback) {
      clearInterval(heartbeatTimer);
      for (const socket of wss.clients) {
        socket.terminate();
      }
      if (!server.listening) {
        callback?.();
        return;
      }
      wss.close(() => {
        server.close(callback);
      });
    },
  };
}

module.exports = {
  createHostedRelayServer,
};
