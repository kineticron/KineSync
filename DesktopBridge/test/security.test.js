const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  generateBridgeKey,
  isStrongBridgeKey,
  sanitizeBridgeKey,
} = require("../src/bridgeSettingsStore");
const { isAllowedSpotifyUrl } = require("../src/spotifyAuth");
const { createHostedRelayServer } = require("../src/relayServer");
const { createBridgeServer } = require("../src/bridgeServer");
const { WebSocket } = require("ws");

function waitForPacket(socket, expectedType) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}`)), 2_000);
    socket.on("message", function onMessage(raw) {
      const packet = JSON.parse(String(raw));
      if (packet.type !== expectedType) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(packet);
    });
  });
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket) {
  return new Promise((resolve) => socket.once("close", resolve));
}

test("bridge keys are generated strongly and legacy defaults are rejected", () => {
  const key = generateBridgeKey();
  assert.equal(key.length, 64);
  assert.equal(isStrongBridgeKey(key), true);
  assert.equal(isStrongBridgeKey("correct-horse-battery-staple"), true);
  assert.equal(isStrongBridgeKey("password123"), false);
  assert.equal(sanitizeBridgeKey("password123"), "");
});

test("Spotify navigation accepts only exact Spotify origins", () => {
  assert.equal(isAllowedSpotifyUrl("https://accounts.spotify.com/login"), true);
  assert.equal(isAllowedSpotifyUrl("https://open.spotify.com/"), true);
  assert.equal(isAllowedSpotifyUrl("https://accounts.spotify.com.evil.example/"), false);
  assert.equal(isAllowedSpotifyUrl("javascript:alert(1)"), false);
});

test("renderer does not load QR code code from a remote CDN", () => {
  const html = fs.readFileSync(path.join(__dirname, "../src/index.html"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
  assert.doesNotMatch(html, /cdnjs\.cloudflare\.com|jsdelivr\.net/);
  assert.match(html, /bridgeAPI\.renderQrCode/);
  assert.match(html, /createElement\(['"]img['"]\)/);
  assert.match(main, /QRCode\.toDataURL/);
});

test("hosted relay rejects registration takeover and authenticates a paired client", async () => {
  const key = generateBridgeKey();
  const relay = createHostedRelayServer({ port: 0, getRegistrationKey: () => key });
  await new Promise((resolve) => relay.start(resolve));
  const address = relay.address();
  assert(address && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/bridge/security-test`;

  const wrong = new WebSocket(url);
  await waitForOpen(wrong);
  const wrongClosed = waitForClose(wrong);
  wrong.send(JSON.stringify({ type: "relay:register", role: "desktop", bridgeId: "security-test", key: "wrong-key" }));
  await wrongClosed;

  const desktop = new WebSocket(url);
  await waitForOpen(desktop);
  const registered = waitForPacket(desktop, "relay:registered");
  desktop.send(JSON.stringify({ type: "relay:register", role: "desktop", bridgeId: "security-test", key }));
  assert.equal((await registered).ok, true);

  const duplicate = new WebSocket(url);
  await waitForOpen(duplicate);
  const duplicateClosed = waitForClose(duplicate);
  duplicate.send(JSON.stringify({ type: "relay:register", role: "desktop", bridgeId: "security-test", key }));
  await duplicateClosed;

  const client = new WebSocket(url);
  await waitForOpen(client);
  const acknowledged = waitForPacket(client, "hello:ack");
  client.send(JSON.stringify({ type: "hello", key }));
  assert.equal((await acknowledged).ok, true);

  client.close();
  desktop.close();
  await Promise.all([waitForClose(client), waitForClose(desktop)]);
  await new Promise((resolve) => relay.stop(resolve));
});

test("local bridge rejects public HTTP origins and requires a positive handshake", async () => {
  const key = generateBridgeKey();
  const bridge = createBridgeServer({ port: 0, handshakeKey: key });
  await new Promise((resolve) => bridge.once("listening", resolve));
  bridge.start();
  const address = bridge.address();
  assert(address && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}`;

  const hostilePage = new WebSocket(url, { origin: "http://evil.example" });
  await waitForOpen(hostilePage);
  await waitForClose(hostilePage);

  const wrong = new WebSocket(url);
  await waitForOpen(wrong);
  const wrongClosed = waitForClose(wrong);
  wrong.send(JSON.stringify({ type: "hello", key: "wrong-key" }));
  await wrongClosed;

  const client = new WebSocket(url);
  await waitForOpen(client);
  const acknowledged = waitForPacket(client, "hello:ack");
  client.send(JSON.stringify({ type: "hello", key }));
  assert.equal((await acknowledged).ok, true);
  const closed = waitForClose(client);
  client.close();
  await closed;
  bridge.stop();
});
