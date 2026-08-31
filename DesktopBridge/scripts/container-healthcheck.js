#!/usr/bin/env node
const { WebSocket } = require("ws");

const port = Math.max(1, Number(process.env.BRIDGE_PORT || 3001));
const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
  handshakeTimeout: 2_000,
  perMessageDeflate: false,
});
let settled = false;

const finish = (code) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (code === 0) {
    socket.close();
  } else {
    socket.terminate();
  }
  process.exit(code);
};

const timeout = setTimeout(() => {
  finish(1);
}, 3_000);

socket.once("open", () => finish(0));
socket.once("error", () => finish(1));
