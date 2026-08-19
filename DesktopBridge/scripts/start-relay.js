const { createHostedRelayServer } = require("../src/relayServer");

const port = Number(process.env.BRIDGE_RELAY_PORT || process.env.PORT || 8787);
const registrationKey = String(
  process.env.BRIDGE_RELAY_REGISTRATION_KEY || process.env.BRIDGE_KEY || "",
).trim();
if (!registrationKey) {
  console.error("ERROR: Set BRIDGE_RELAY_REGISTRATION_KEY (or BRIDGE_KEY) before starting the relay.");
  process.exit(1);
}
const relay = createHostedRelayServer({ port, getRegistrationKey: () => registrationKey });

relay.start(() => {
  console.log(`[bridge-relay] listening on port ${port}`);
});

process.on("SIGINT", () => {
  relay.stop(() => process.exit(0));
});

process.on("SIGTERM", () => {
  relay.stop(() => process.exit(0));
});
