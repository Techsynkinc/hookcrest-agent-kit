#!/usr/bin/env node
// One JSON-RPC message per line; stdout is reserved for the protocol.
import readline from "node:readline";
import { handle, failure, events } from "../lib/bridge.js";
const send = (msg) => { if (msg) process.stdout.write(`${JSON.stringify(msg)}\n`); };
// After chat sign-in the hosted tools become available; tell the client to list them again.
let toolsChanged = false;
events.toolsChanged = () => { toolsChanged = true; };
const rl = readline.createInterface({ input: process.stdin });
// Serialize calls so project_use and sign-in complete before the next call.
let pending = Promise.resolve();
rl.on("line", (line) => {
  if (!line.trim()) return;
  pending = pending.then(async () => {
    let msg;
    try { msg = JSON.parse(line); } catch { return send(failure(null, -32700, "Parse error")); }
    send(await handle(msg));
    if (toolsChanged) {
      toolsChanged = false;
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
  }).catch((e) => send(failure(null, -32603, e.message)));
});
