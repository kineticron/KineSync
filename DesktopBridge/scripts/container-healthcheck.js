#!/usr/bin/env node
const net = require("node:net");

const port = Math.max(1, Number(process.env.BRIDGE_PORT || 3001));
const socket = net.createConnection({ host: "127.0.0.1", port });
const timeout = setTimeout(() => {
  socket.destroy();
  process.exit(1);
}, 2_000);

socket.once("connect", () => {
  clearTimeout(timeout);
  socket.end();
  process.exit(0);
});
socket.once("error", () => {
  clearTimeout(timeout);
  process.exit(1);
});
