const DEFAULT_RELAY_PORT = 8787;
const DEFAULT_RELEASE_DELAYS_MS = [750, 1_500, 3_000];

function normalizeNgrokDomain(rawDomain) {
  const value = String(rawDomain || "").trim();
  if (!value) return "";
  try {
    return new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    ).hostname;
  } catch {
    return value.replace(/^https?:\/\//i, "").split("/")[0];
  }
}

function toWebSocketUrl(publicUrl) {
  const parsed = new URL(String(publicUrl || ""));
  if (parsed.protocol !== "https:") {
    throw new Error("ngrok must report a secure HTTPS endpoint");
  }
  parsed.protocol = "wss:";
  return parsed.toString().replace(/\/+$/, "");
}

function isEndpointAlreadyOnlineError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("ERR_NGROK_334") || message.includes("already online");
}

function createNgrokRelayManager({
  ngrok,
  createRelayServer,
  relayPort = DEFAULT_RELAY_PORT,
  releaseDelaysMs = DEFAULT_RELEASE_DELAYS_MS,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  logger = console,
  onBeforeStop = () => {},
  onStarted = () => {},
  onStatusChanged = () => {},
} = {}) {
  if (!ngrok || typeof ngrok.forward !== "function") {
    throw new Error("createNgrokRelayManager requires the ngrok SDK.");
  }
  if (typeof createRelayServer !== "function") {
    throw new Error("createNgrokRelayManager requires createRelayServer.");
  }

  let listener = null;
  let relayServer = null;
  let publicUrl = "";
  let lastError = "";
  let state = "stopped";
  let operationQueue = Promise.resolve();

  const status = () => ({
    ngrokConnected: Boolean(listener && publicUrl),
    ngrokPublicUrl: publicUrl,
    ngrokError: lastError,
    ngrokState: state,
  });

  const emitStatus = () => {
    try {
      onStatusChanged(status());
    } catch {
      // UI status callbacks must not break relay lifecycle operations.
    }
  };

  const serialize = (operation) => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => {});
    return result;
  };

  const stopRelayServer = async () => {
    const currentServer = relayServer;
    relayServer = null;
    if (!currentServer) return;
    await new Promise((resolve) => currentServer.stop(resolve));
  };

  const closeSdkSession = async () => {
    const currentListener = listener;
    listener = null;
    if (currentListener) {
      try {
        await currentListener.close();
      } catch (error) {
        logger.warn?.(`[ngrok] listener close warning: ${error.message || error}`);
      }
    }
    if (typeof ngrok.disconnect === "function") {
      try {
        await ngrok.disconnect();
      } catch {}
    }
    if (typeof ngrok.kill === "function") {
      try {
        await ngrok.kill();
      } catch {}
    }
  };

  const stopInternal = async ({ clearError = true } = {}) => {
    state = "stopping";
    emitStatus();
    await onBeforeStop();
    await closeSdkSession();
    publicUrl = "";
    await stopRelayServer();
    if (clearError) lastError = "";
    state = "stopped";
    emitStatus();
  };

  const failStart = async (error) => {
    lastError = error instanceof Error ? error.message : String(error);
    logger.error?.(`[ngrok] failed to start: ${lastError}`);
    await closeSdkSession();
    await stopRelayServer();
    publicUrl = "";
    state = "error";
    emitStatus();
    return { ok: false, error: lastError };
  };

  const startInternal = async ({ domain, authToken, bridgeKey, bridgeId } = {}) => {
    const ngrokDomain = normalizeNgrokDomain(domain);
    const safeAuthToken = String(authToken || "").trim();
    const safeBridgeKey = String(bridgeKey || "").trim();
    const safeBridgeId = String(bridgeId || "").trim();
    if (!ngrokDomain) return { ok: false, error: "ngrok domain required" };
    if (!safeAuthToken) return { ok: false, error: "ngrok auth token required" };
    if (!safeBridgeKey) return { ok: false, error: "bridge key required" };
    if (!safeBridgeId) return { ok: false, error: "bridge ID required" };

    await stopInternal();
    state = "starting";
    emitStatus();

    relayServer = createRelayServer({
      port: relayPort,
      getRegistrationKey: () => safeBridgeKey,
    });
    try {
      await new Promise((resolve, reject) =>
        relayServer.start((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      return failStart(error);
    }
    logger.log?.(`[bridge-relay] listening on ws://127.0.0.1:${relayPort}`);

    const attemptDelays = [0, ...releaseDelaysMs];
    for (let attempt = 0; attempt < attemptDelays.length; attempt += 1) {
      const delayMs = attemptDelays[attempt];
      if (delayMs > 0) {
        logger.warn?.(
          `[ngrok] endpoint is still releasing; retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
      logger.log?.(
        `[ngrok] starting tunnel at https://${ngrokDomain} (attempt ${attempt + 1}/${attemptDelays.length})`,
      );
      try {
        listener = await ngrok.forward({
          addr: `127.0.0.1:${relayPort}`,
          authtoken: safeAuthToken,
          domain: ngrokDomain,
        });
        break;
      } catch (error) {
        listener = null;
        const canRetry =
          isEndpointAlreadyOnlineError(error) &&
          attempt < attemptDelays.length - 1;
        if (!canRetry) return failStart(error);
        await closeSdkSession();
      }
    }

    const reportedUrl = String(listener?.url?.() || "");
    if (!reportedUrl) {
      return failStart(new Error("ngrok did not report a public URL"));
    }

    let relayWsUrl;
    try {
      const reported = new URL(reportedUrl);
      if (reported.hostname.toLowerCase() !== ngrokDomain.toLowerCase()) {
        throw new Error("ngrok reported an unexpected public domain");
      }
      relayWsUrl = toWebSocketUrl(reportedUrl);
    } catch (error) {
      return failStart(error);
    }
    const mobileUrl = `${relayWsUrl}/bridge/${encodeURIComponent(safeBridgeId)}`;
    publicUrl = relayWsUrl;
    lastError = "";
    state = "running";
    try {
      await onStarted({
        relayWsUrl,
        mobileUrl,
        bridgeId: safeBridgeId,
        bridgeKey: safeBridgeKey,
      });
    } catch (error) {
      return failStart(error);
    }
    emitStatus();

    logger.log?.("[bridge-relay] ngrok tunnel ready");
    logger.log?.(`[bridge-relay] Public Relay WebSocket URL: ${relayWsUrl}`);
    logger.log?.(`[bridge-relay] Expo WebSocket URL: ${mobileUrl}`);
    return {
      ok: true,
      publicUrl: relayWsUrl,
      mobileUrl,
      bridgeId: safeBridgeId,
      bridgeKey: safeBridgeKey,
      connectedClients: true,
    };
  };

  return {
    start(options) {
      return serialize(() => startInternal(options));
    },
    stop(options) {
      return serialize(async () => {
        await stopInternal(options);
        return { ok: true };
      });
    },
    getStatus: status,
  };
}

module.exports = {
  DEFAULT_RELEASE_DELAYS_MS,
  createNgrokRelayManager,
  isEndpointAlreadyOnlineError,
  normalizeNgrokDomain,
  toWebSocketUrl,
};
