const { WebSocket } = require("ws");

const DEFAULT_DEBUG_PORT = 43880;
const POLL_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 3_000;
const SESSION_EXPRESSION = `(() => {
  const platform = globalThis.Spicetify?.Platform;
  const session = platform?.Session?.accessToken
    ? platform.Session
    : platform?.AuthorizationAPI?._state?.token ||
      platform?.AuthorizationAPI?._tokenProvider?._token;
  if (!session) return null;
  return {
    accessToken: String(session.accessToken || ""),
    expiresAt: Number(session.accessTokenExpirationTimestampMs || 0),
  };
})()`;

function parseSessionEvaluation(message) {
  const value = message?.result?.result?.value;
  const accessToken = String(value?.accessToken || "").trim();
  const expiresAt = Number(value?.expiresAt || 0);
  if (
    accessToken.length < 20 ||
    accessToken.length > 4096 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() + 30_000
  ) {
    return null;
  }
  return { accessToken, expiresAt };
}

function createContainerSpotifyTokenWatcher({
  onToken,
  port = process.env.KINESYNC_SPOTIFY_DEBUG_PORT || DEFAULT_DEBUG_PORT,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = WebSocket,
} = {}) {
  const debugPort = Math.max(1, Number(port));
  let timer = null;
  let pollInFlight = false;

  const evaluateTarget = (webSocketDebuggerUrl) =>
    new Promise((resolve) => {
      let settled = false;
      const socket = new WebSocketImpl(webSocketDebuggerUrl, {
        origin: `http://127.0.0.1:${debugPort}`,
      });
      const requestId = 1;
      const timeout = setTimeout(() => {
        socket.terminate();
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.close();
        resolve(result);
      };
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            id: requestId,
            method: "Runtime.evaluate",
            params: {
              expression: SESSION_EXPRESSION,
              returnByValue: true,
            },
          }),
        );
      });
      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw));
          if (message.id === requestId) finish(parseSessionEvaluation(message));
        } catch {
          // Ignore unrelated or malformed DevTools events.
        }
      });
      socket.once("error", () => finish(null));
    });

  const poll = async () => {
    if (pollInFlight) return false;
    pollInFlight = true;
    try {
      const response = await fetchImpl(
        `http://127.0.0.1:${debugPort}/json/list`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      if (!response.ok) return false;
      const targets = await response.json();
      const pages = Array.isArray(targets)
        ? targets.filter(
            (target) =>
              target?.type === "page" && target?.webSocketDebuggerUrl,
          )
        : [];
      pages.sort((left, right) => {
        const leftIsSpotify = String(left?.url || "").includes("spotify");
        const rightIsSpotify = String(right?.url || "").includes("spotify");
        return Number(rightIsSpotify) - Number(leftIsSpotify);
      });
      for (const page of pages) {
        const session = await evaluateTarget(page.webSocketDebuggerUrl);
        if (session) {
          if (typeof onToken === "function") {
            onToken(session.accessToken, session.expiresAt);
          }
          return true;
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      pollInFlight = false;
    }
  };

  return {
    start() {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    poll,
  };
}

module.exports = {
  SESSION_EXPRESSION,
  createContainerSpotifyTokenWatcher,
  parseSessionEvaluation,
};
