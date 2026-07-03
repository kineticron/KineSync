const CLIENT_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const DESKTOP_MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MESSAGES = 900;

const CLIENT_TYPES = new Set([
  "hello",
  "lyrics:refresh",
  "lyrics:refetch",
  "vault:save",
  "artwork:refetch",
  "share:gif:request",
  "playback:playPause",
  "playback:resync",
  "playback:next",
  "playback:previous",
  "playback:seek",
]);

const DESKTOP_TYPES = new Set(["playback", "lyrics", "share:gif:result", "vault:save:result"]);

function parseJsonMessage(message, maxBytes = CLIENT_MAX_MESSAGE_BYTES) {
  const byteLength = Buffer.byteLength(String(message || ""));
  if (byteLength > maxBytes) return { ok: false, error: "message-too-large" };
  try {
    const packet = JSON.parse(String(message));
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) return { ok: false, error: "invalid-packet" };
    return { ok: true, packet };
  } catch {
    return { ok: false, error: "invalid-json" };
  }
}

function createRateLimiter({ windowMs = RATE_LIMIT_WINDOW_MS, maxMessages = RATE_LIMIT_MAX_MESSAGES } = {}) {
  let windowStartedAt = Date.now();
  let count = 0;
  return {
    consume() {
      const now = Date.now();
      if (now - windowStartedAt >= windowMs) {
        windowStartedAt = now;
        count = 0;
      }
      return ++count <= maxMessages;
    },
  };
}

function sanitizeClientPacket(packet) {
  if (!packet || typeof packet.type !== "string" || !CLIENT_TYPES.has(packet.type)) return null;
  if (packet.type === "playback:seek") {
    return { type: packet.type, positionMs: Math.max(0, Math.floor(Number(packet.positionMs) || 0)) };
  }
  return packet;
}

function isDesktopPacket(packet) {
  return Boolean(packet && typeof packet.type === "string" && DESKTOP_TYPES.has(packet.type));
}

const handlers = {
  hello: () => true,
  "lyrics:refresh": (e, p) => e.emit("lyricsRefreshRequested", { preferredSource: typeof p.preferredSource === "string" ? p.preferredSource : "auto", immediateTranslation: Boolean(p.immediateTranslation) }) || true,
  "lyrics:refetch": (e) => e.emit("lyricsRefetchRequested") || true,
  "vault:save": (e, p, r) => e.emit("vaultSaveRequested", { includeTranslations: Boolean(p.includeTranslations), reply: r }) || true,
  "artwork:refetch": (e) => e.emit("artworkRefetchRequested") || true,
  "share:gif:request": (e, p) =>
    e.emit("shareGifRequested", {
      requestId: typeof p.requestId === "string" ? p.requestId : "",
      trackId: typeof p.trackId === "string" ? p.trackId : "",
      title: typeof p.title === "string" ? p.title : "",
      artist: typeof p.artist === "string" ? p.artist : "",
      artworkUrl: typeof p.artworkUrl === "string" ? p.artworkUrl : "",
      includeTranslations: Boolean(p.includeTranslations),
      lines: Array.isArray(p.lines) ? p.lines : [],
      reply: r,
    }) || true,
};

function dispatchClientPacket(emitter, packet, reply) {
  const safePacket = sanitizeClientPacket(packet);
  if (!safePacket) return false;
  const handler = handlers[safePacket.type];
  if (handler) return handler(emitter, safePacket, reply);
  if (safePacket.type.startsWith("playback:")) return emitter.emit("playbackCommand", safePacket) || true;
  return false;
}

module.exports = {
  CLIENT_MAX_MESSAGE_BYTES,
  DESKTOP_MAX_MESSAGE_BYTES,
  RATE_LIMIT_MAX_MESSAGES,
  RATE_LIMIT_WINDOW_MS,
  createRateLimiter,
  dispatchClientPacket,
  isDesktopPacket,
  parseJsonMessage,
  sanitizeClientPacket,
};