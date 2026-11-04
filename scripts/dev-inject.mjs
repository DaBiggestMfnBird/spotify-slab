#!/usr/bin/env node
/**
 * Hot-load the built bundle into the running Spotify client over CDP.
 * Spotify must be running with --remote-debugging-port=9222.
 */

import { readFile } from "node:fs/promises";

const CDP = process.env.CDP ?? "http://127.0.0.1:9222";

const targets = await (await fetch(`${CDP}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("xpui"));
if (!page) {
    console.error("No xpui page found. Is Spotify running with --remote-debugging-port=9222?");
    process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();

ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (resolve) {
        pending.delete(message.id);
        resolve(message);
    }
};

await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
});

const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, (message) =>
            message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result),
        );
        ws.send(JSON.stringify({ id, method, params }));
    });

const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
    });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
};

await send("Runtime.enable");

await evaluate(`(() => {
  try { window.SLAB?.destroy?.(); } catch (e) { console.warn("[SLAB] old instance", e); }
  // An equal version stands down by design, so a hot reload drops the claim first.
  window.SLAB = undefined;
  window.__slabClaim = undefined;
  document.querySelectorAll(".slab-chip, .slab-panel, #slab-styles").forEach((n) => n.remove());
  return true;
})()`);

const code = await readFile(new URL("../dist/slab.js", import.meta.url), "utf8");
await evaluate(code);

const status = await evaluate(`(() => ({
  version: window.SLAB?.version ?? null,
  eq: window.SLAB?.eq ?? null,
  chip: !!document.querySelector(".slab-chip"),
  panel: !!document.querySelector(".slab-panel"),
}))()`);

console.log("injected:", JSON.stringify(status));
ws.close();
