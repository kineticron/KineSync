const { createHostedRelayServer } = require("../src/relayServer");

const port = Number(process.env.BRIDGE_RELAY_PORT || process.env.PORT || 8787);
const relay = createHostedRelayServer({ port });

relay.start(() => {
  console.log(`[bridge-relay] listening on port ${port}`);
});

process.on("SIGINT", () => {
  relay.stop(() => process.exit(0));
});

process.on("SIGTERM", () => {
  relay.stop(() => process.exit(0));
});
