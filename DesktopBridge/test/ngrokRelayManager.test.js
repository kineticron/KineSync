"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createNgrokRelayManager,
  isEndpointAlreadyOnlineError,
  normalizeNgrokDomain,
  toWebSocketUrl,
} = require("../src/ngrokRelayManager");

function createHarness({ forwardResults = [], serverStartError = null } = {}) {
  const events = [];
  let listenerNumber = 0;
  const ngrok = {
    async forward(options) {
      events.push(["forward", options.domain]);
      const result = forwardResults.shift();
      if (result instanceof Error) throw result;
      listenerNumber += 1;
      const url = result || `https://relay-${listenerNumber}.example.test`;
      return {
        url: () => url,
        async close() {
          events.push(["listener.close", url]);
        },
      };
    },
    async disconnect() {
      events.push(["disconnect"]);
    },
    async kill() {
      events.push(["kill"]);
    },
  };
  let serverNumber = 0;
  const createRelayServer = () => {
    serverNumber += 1;
    const id = serverNumber;
    return {
      start(callback) {
        events.push(["server.start", id]);
        callback(serverStartError);
      },
      stop(callback) {
        events.push(["server.stop", id]);
        callback();
      },
    };
  };
  const manager = createNgrokRelayManager({
    ngrok,
    createRelayServer,
    releaseDelaysMs: [10, 20],
    sleep: async (delayMs) => events.push(["sleep", delayMs]),
    logger: { log() {}, warn() {}, error() {} },
    onBeforeStop: () => events.push(["client.stop"]),
    onStarted: (result) => events.push(["client.start", result.relayWsUrl]),
  });
  const options = {
    domain: "relay.example.test",
    authToken: "token",
    bridgeKey: "key",
    bridgeId: "bridge",
  };
  return { events, manager, options };
}

test("normalizes domains and public URLs", () => {
  assert.equal(normalizeNgrokDomain("https://Relay.Example.test/path"), "relay.example.test");
  assert.equal(toWebSocketUrl("https://relay.example.test/"), "wss://relay.example.test");
  assert.equal(isEndpointAlreadyOnlineError(new Error("error_code: ERR_NGROK_334")), true);
});

test("start always tears down the previous relay before opening a new one", async () => {
  const { events, manager, options } = createHarness();
  const first = await manager.start(options);
  const second = await manager.start(options);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const closeIndex = events.findIndex((event) => event[0] === "listener.close");
  const secondServerIndex = events.findLastIndex((event) => event[0] === "server.start");
  const oldServerStopIndex = events.findIndex((event) => event[0] === "server.stop");
  assert.ok(closeIndex >= 0 && closeIndex < secondServerIndex);
  assert.ok(oldServerStopIndex >= 0 && oldServerStopIndex < secondServerIndex);
  assert.deepEqual(manager.getStatus(), {
    ngrokConnected: true,
    ngrokPublicUrl: "wss://relay-2.example.test",
    ngrokError: "",
    ngrokState: "running",
  });
});

test("endpoint release errors are retried after killing the old SDK session", async () => {
  const endpointError = new Error("endpoint already online; ERR_NGROK_334");
  const { events, manager, options } = createHarness({
    forwardResults: [endpointError, "https://relay.example.test"],
  });

  const result = await manager.start(options);

  assert.equal(result.ok, true);
  assert.equal(events.filter((event) => event[0] === "forward").length, 2);
  assert.ok(events.some((event) => event[0] === "sleep" && event[1] === 10));
  assert.ok(events.filter((event) => event[0] === "kill").length >= 2);
});

test("failed starts leave no stale connected URL or local relay server", async () => {
  const endpointError = new Error("endpoint already online; ERR_NGROK_334");
  const { events, manager, options } = createHarness({
    forwardResults: [endpointError, endpointError, endpointError],
  });

  const result = await manager.start(options);

  assert.equal(result.ok, false);
  assert.match(result.error, /ERR_NGROK_334/);
  assert.equal(events.filter((event) => event[0] === "server.stop").length, 1);
  assert.deepEqual(manager.getStatus(), {
    ngrokConnected: false,
    ngrokPublicUrl: "",
    ngrokError: result.error,
    ngrokState: "error",
  });
});

test("local relay port errors are returned without attempting ngrok", async () => {
  const { events, manager, options } = createHarness({
    serverStartError: new Error("listen EADDRINUSE: address already in use 8787"),
  });

  const result = await manager.start(options);

  assert.equal(result.ok, false);
  assert.match(result.error, /EADDRINUSE/);
  assert.equal(events.some((event) => event[0] === "forward"), false);
  assert.equal(manager.getStatus().ngrokConnected, false);
});

test("concurrent starts are serialized", async () => {
  const { events, manager, options } = createHarness();
  const [first, second] = await Promise.all([
    manager.start(options),
    manager.start({ ...options, domain: "second.example.test" }),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(
    events.filter((event) => event[0] === "forward").map((event) => event[1]),
    ["relay.example.test", "second.example.test"],
  );
});
