const http = require("node:http");
const { spawn } = require("node:child_process");
const { createHostedRelayServer } = require("../src/relayServer");

const relayPort = Number(process.env.BRIDGE_RELAY_PORT || process.env.PORT || 8787);
const ngrokApiUrl = process.env.NGROK_API_URL || "http://127.0.0.1:4040/api/tunnels";
const ngrokBin = process.env.NGROK_BIN || "ngrok";
const rawNgrokUrl = String(process.env.NGROK_URL || "").trim();
if (!rawNgrokUrl) {
  console.error("ERROR: Set NGROK_URL in your .env (e.g. your-subdomain.ngrok-free.app)");
  process.exit(1);
}
const ngrokUrl = /^https?:\/\//i.test(rawNgrokUrl) ? rawNgrokUrl : `https://${rawNgrokUrl}`;
const bridgeId = String(process.env.BRIDGE_RELAY_ID || "ra-windows").trim();
const relay = createHostedRelayServer({ port: relayPort });

let ngrokProcess = null;
let shuttingDown = false;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(1_000, () => {
      req.destroy(new Error("Timed out waiting for ngrok API."));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNgrokUrl() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const payload = await fetchJson(ngrokApiUrl);
      const tunnels = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
      const publicUrl =
        tunnels.find((tunnel) => String(tunnel?.public_url || "").startsWith("https://"))
          ?.public_url ||
        tunnels.find((tunnel) => String(tunnel?.public_url || "").startsWith("http://"))
          ?.public_url ||
        "";
      if (publicUrl) {
        return publicUrl;
      }
    } catch {
      // ngrok's inspection API may take a moment to start.
    }
    await sleep(500);
  }
  return "";
}

function toWebSocketUrl(publicUrl) {
  return String(publicUrl || "")
    .replace(/^https:\/\//i, "wss://")
    .replace(/^http:\/\//i, "ws://")
    .replace(/\/+$/, "");
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (ngrokProcess && !ngrokProcess.killed) {
    ngrokProcess.kill();
  }
  await new Promise((resolve) => relay.stop(resolve));
  process.exit(exitCode);
}

async function main() {
  await new Promise((resolve) => relay.start(resolve));
  console.log(`[bridge-relay] listening on ws://127.0.0.1:${relayPort}`);

  const ngrokArgs = ["http", `--url=${ngrokUrl}`, String(relayPort), "--log=stdout"];
  console.log(`[ngrok] starting tunnel at ${ngrokUrl}`);

  ngrokProcess = spawn(ngrokBin, ngrokArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  ngrokProcess.on("error", (error) => {
    console.error(`[ngrok] failed to start: ${error.message}`);
    console.error("[ngrok] Install and authenticate ngrok, then rerun npm run relay:ngrok.");
    void shutdown(1);
  });

  ngrokProcess.stdout.on("data", (chunk) => {
    const text = String(chunk || "").trim();
    if (text) {
      console.log(`[ngrok] ${text}`);
    }
  });

  ngrokProcess.stderr.on("data", (chunk) => {
    const text = String(chunk || "").trim();
    if (text) {
      console.error(`[ngrok] ${text}`);
    }
  });

  ngrokProcess.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[ngrok] exited with code ${code ?? "unknown"}`);
      void shutdown(code || 1);
    }
  });

  const publicUrl = await waitForNgrokUrl();
  if (!publicUrl) {
    console.error("[ngrok] started, but no public URL was reported by the local ngrok API.");
    await shutdown(1);
    return;
  }

  const relayWsUrl = toWebSocketUrl(publicUrl);
  const localRelayWsUrl = `ws://127.0.0.1:${relayPort}`;
  console.log("");
  console.log("[bridge-relay] ngrok tunnel ready");
  console.log(`[bridge-relay] Desktop Relay WebSocket URL: ${localRelayWsUrl}`);
  console.log(`[bridge-relay] Public Relay WebSocket URL: ${relayWsUrl}`);
  console.log(`[bridge-relay] Expo WebSocket URL: ${relayWsUrl}/bridge/${encodeURIComponent(bridgeId)}`);
  console.log("[bridge-relay] Keep this process running while using remote Expo clients.");
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

void main().catch((error) => {
  console.error(error);
  void shutdown(1);
});
